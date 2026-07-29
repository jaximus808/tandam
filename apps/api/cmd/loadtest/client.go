package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ── HTTP client ───────────────────────────────────────────────────────────────

// errUnavailable is returned when the server answered a request for an endpoint
// it does not serve. Tandem's router falls through to the SPA for unknown paths,
// so a missing API endpoint returns 200 text/html in a few milliseconds. Without
// this check a benchmark run against a server that predates (say) the context
// endpoint would report context_get p95 ≈ 5ms and PASS the 250ms target while
// measuring nothing but static-file service.
var errUnavailable = errors.New("endpoint not served by this build (SPA fallback / 404)")

type client struct {
	base  string
	token string
	http  *http.Client
	// agent is this session's identity: the claim owner, and the value the
	// status API records. One client per simulated agent.
	agent string
}

type resp struct {
	status int
	body   []byte
	ctype  string
	dur    time.Duration
}

func (r resp) isJSON() bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(r.ctype)), "application/json")
}

// do issues one request and times it. A 2xx/4xx that is NOT JSON means the
// request fell through to the SPA — reported as errUnavailable rather than
// decoded as a fast success.
func (c *client) do(method, path string, body any) (resp, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return resp{}, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rdr)
	if err != nil {
		return resp{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	t0 := time.Now()
	httpResp, err := c.http.Do(req)
	dur := time.Since(t0)
	if err != nil {
		return resp{dur: dur}, err
	}
	defer httpResp.Body.Close()
	data, err := io.ReadAll(httpResp.Body)
	out := resp{status: httpResp.StatusCode, body: data, ctype: httpResp.Header.Get("Content-Type"), dur: dur}
	if err != nil {
		return out, err
	}
	if !out.isJSON() {
		return out, errUnavailable
	}
	return out, nil
}

// ── Canvas lifecycle (harness, not measured as agent ops) ─────────────────────

type canvasInfo struct {
	ID   string `json:"id"`
	Code string `json:"code"`
	Name string `json:"name"`
}

// createCanvas makes a fresh, anonymous scratch canvas. Every benchmark run gets
// its own so a run can never touch a canvas anyone cares about.
func (c *client) createCanvas(name string) (canvasInfo, error) {
	r, err := c.do("POST", "/api/canvases", map[string]string{"name": name})
	if err != nil {
		return canvasInfo{}, err
	}
	if r.status != http.StatusCreated {
		return canvasInfo{}, fmt.Errorf("status %d: %s", r.status, truncate(r.body))
	}
	var out canvasInfo
	if err := json.Unmarshal(r.body, &out); err != nil {
		return canvasInfo{}, err
	}
	if out.Code == "" {
		return canvasInfo{}, fmt.Errorf("no code in create response: %s", truncate(r.body))
	}
	return out, nil
}

// connect mirrors the MCP gateway's connectWithCode: POST /api/mcp/auth {code}
// → {token}. Each simulated agent does this ONCE, then reuses the token — the
// same shape as a real session.
func (c *client) connect(code string) (time.Duration, error) {
	r, err := c.do("POST", "/api/mcp/auth", map[string]string{"code": code})
	if err != nil {
		return r.dur, err
	}
	if r.status != http.StatusOK {
		return r.dur, fmt.Errorf("status %d: %s", r.status, truncate(r.body))
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(r.body, &out); err != nil || out.Token == "" {
		return r.dur, fmt.Errorf("no token in auth response: %s", truncate(r.body))
	}
	c.token = out.Token
	return r.dur, nil
}

const seedBatchSize = 100

// seedTasks creates n born-approved tasks (a human may create state "approved"
// directly) via POST /api/canvas/actions/batch, chunked. Titles carry this run's
// prefix so an agent only ever claims this run's seeds.
func (c *client) seedTasks(prefix string, from, n int, rec *recorder) ([]string, error) {
	type actionIn struct {
		Type       string         `json:"type"`
		State      string         `json:"state"`
		ProposedBy string         `json:"proposedBy"`
		Payload    map[string]any `json:"payload"`
	}
	ids := make([]string, 0, n)
	for off := 0; off < n; off += seedBatchSize {
		end := off + seedBatchSize
		if end > n {
			end = n
		}
		batch := make([]actionIn, 0, end-off)
		for i := off; i < end; i++ {
			batch = append(batch, actionIn{
				Type: "task", State: "approved", ProposedBy: "human",
				Payload: map[string]any{
					"title":    fmt.Sprintf("%s%d", prefix, from+i),
					"assignee": "agent",
				},
			})
		}
		r, err := c.do("POST", "/api/canvas/actions/batch", map[string]any{"actions": batch})
		if err != nil {
			return ids, err
		}
		if r.status != http.StatusCreated {
			return ids, fmt.Errorf("status %d: %s", r.status, truncate(r.body))
		}
		rec.observe(opSeedBatch, r.dur)
		var out struct {
			Actions []struct {
				ID    string `json:"id"`
				State string `json:"state"`
			} `json:"actions"`
		}
		if err := json.Unmarshal(r.body, &out); err != nil {
			return ids, fmt.Errorf("decoding batch response: %w", err)
		}
		for _, a := range out.Actions {
			if a.State != "approved" {
				return ids, fmt.Errorf("seeded task %s landed %q, expected approved", a.ID, a.State)
			}
			ids = append(ids, a.ID)
		}
	}
	if len(ids) != n {
		return ids, fmt.Errorf("seeded %d tasks, expected %d", len(ids), n)
	}
	return ids, nil
}

// deleteTasks removes the seeded tasks via the batch-delete endpoint, chunked.
func (c *client) deleteTasks(ids []string) error {
	for off := 0; off < len(ids); off += seedBatchSize {
		end := off + seedBatchSize
		if end > len(ids) {
			end = len(ids)
		}
		r, err := c.do("POST", "/api/canvas/actions/batch-delete", map[string]any{"ids": ids[off:end]})
		if err != nil {
			return err
		}
		if r.status != http.StatusOK {
			return fmt.Errorf("batch-delete status %d: %s", r.status, truncate(r.body))
		}
	}
	return nil
}

// ── Agent ops (measured) ──────────────────────────────────────────────────────

type listedTask struct {
	ID    string
	Title string
}

// listQueue is the queue read: the approved-task queue, exactly as an agent's
// task_list sees it.
func (c *client) listQueue() ([]listedTask, time.Duration, error) {
	r, err := c.do("GET", "/api/canvas/actions?type=task&state=approved", nil)
	if err != nil {
		return nil, r.dur, err
	}
	if r.status != http.StatusOK {
		return nil, r.dur, fmt.Errorf("list status %d: %s", r.status, truncate(r.body))
	}
	out, err := decodeActionList(r.body)
	if err != nil {
		return nil, r.dur, err
	}
	tasks := make([]listedTask, 0, len(out))
	for _, a := range out {
		tasks = append(tasks, listedTask{ID: a.ID, Title: a.title()})
	}
	return tasks, r.dur, nil
}

// getTask is task_get: one hydrated task (the read an agent does before
// deciding whether to claim).
func (c *client) getTask(id string) (time.Duration, error) {
	r, err := c.do("GET", "/api/canvas/actions/"+id, nil)
	if err != nil {
		return r.dur, err
	}
	if r.status != http.StatusOK {
		return r.dur, fmt.Errorf("task_get status %d: %s", r.status, truncate(r.body))
	}
	return r.dur, nil
}

// getContext is the one-call connect bundle: GET /api/canvas/context.
func (c *client) getContext(taskID string) (time.Duration, error) {
	path := "/api/canvas/context"
	if taskID != "" {
		path += "?taskId=" + taskID
	}
	r, err := c.do("GET", path, nil)
	if err != nil {
		return r.dur, err
	}
	if r.status != http.StatusOK {
		return r.dur, fmt.Errorf("context_get status %d: %s", r.status, truncate(r.body))
	}
	return r.dur, nil
}

// claimOutcome is which side of the atomic claim this attempt landed on.
type claimOutcome int

const (
	claimWon   claimOutcome = iota // 200 — we hold the task
	claimLost                      // 409 already_claimed — another agent won the race
	claimStale                     // 400 illegal state — the task already left approved
)

// claim races for a task: PATCH /api/canvas/actions/{id}
// {state:"executing", agentName}. The server decides the winner atomically
// (conditional UPDATE ... WHERE state='approved').
func (c *client) claim(id string) (claimOutcome, time.Duration, error) {
	r, err := c.do("PATCH", "/api/canvas/actions/"+id,
		map[string]string{"state": "executing", "agentName": c.agent})
	if err != nil {
		return claimStale, r.dur, err
	}
	switch r.status {
	case http.StatusOK:
		return claimWon, r.dur, nil
	case http.StatusConflict:
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(r.body, &e)
		if e.Error != "already_claimed" {
			return claimStale, r.dur, fmt.Errorf("claim %s: unexpected 409 body: %s", id, truncate(r.body))
		}
		return claimLost, r.dur, nil
	case http.StatusBadRequest:
		// The task left "approved" between the listing and this claim (typically
		// the winner already completed it). A lost race, just later in its life.
		return claimStale, r.dur, nil
	default:
		return claimStale, r.dur, fmt.Errorf("claim %s: status %d: %s", id, r.status, truncate(r.body))
	}
}

// reportStatus is the inbound status API (TDM-38) — the CI surface: one POST
// per status change, the call a GitHub Actions job or a Modal function makes.
// Used here for progress updates on a held task.
func (c *client) reportStatus(code, id, state, summary string) (time.Duration, error) {
	r, err := c.do("POST", "/api/canvas/"+code+"/tasks/"+id+"/status",
		map[string]any{"state": state, "agent": c.agent, "summary": summary})
	if err != nil {
		return r.dur, err
	}
	if r.status != http.StatusOK {
		return r.dur, fmt.Errorf("status_post status %d: %s", r.status, truncate(r.body))
	}
	return r.dur, nil
}

// complete finishes a held task: PATCH {state:"done", result, agentName}.
// A 409 is a DEFINED outcome, not an error: the claim was released and taken by
// somebody else mid-run, so this agent drops the win.
func (c *client) complete(id, result string) (bool, time.Duration, error) {
	r, err := c.do("PATCH", "/api/canvas/actions/"+id,
		map[string]string{"state": "done", "result": result, "agentName": c.agent})
	if err != nil {
		return false, r.dur, err
	}
	if r.status == http.StatusConflict {
		return false, r.dur, nil
	}
	if r.status != http.StatusOK {
		return false, r.dur, fmt.Errorf("complete %s: status %d: %s", id, r.status, truncate(r.body))
	}
	return true, r.dur, nil
}

// ── Verification reads (harness; deliberately NOT recorded as agent ops) ──────

type listedAction struct {
	ID        string          `json:"id"`
	State     string          `json:"state"`
	ClaimedBy *string         `json:"claimedBy"`
	Payload   json.RawMessage `json:"payload"`
}

func (a listedAction) title() string {
	var p struct {
		Title string `json:"title"`
	}
	_ = json.Unmarshal(a.Payload, &p)
	return p.Title
}

func decodeActionList(body []byte) ([]listedAction, error) {
	var out struct {
		Actions []listedAction `json:"actions"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decoding action list: %w", err)
	}
	return out.Actions, nil
}

// finalStates reads back EVERY task on the scratch canvas in one call, which is
// the evidence the double-claim invariant is checked against. One list rather
// than one GET per task: it is a single consistent read, it is cheap, and it
// cannot itself distort the numbers (it runs after the metrics scrape).
func (c *client) finalStates(prefix string) (map[string]serverTaskState, error) {
	r, err := c.do("GET", "/api/canvas/actions?type=task", nil)
	if err != nil {
		return nil, err
	}
	if r.status != http.StatusOK {
		return nil, fmt.Errorf("final-state list status %d: %s", r.status, truncate(r.body))
	}
	actions, err := decodeActionList(r.body)
	if err != nil {
		return nil, err
	}
	out := make(map[string]serverTaskState, len(actions))
	for _, a := range actions {
		if !strings.HasPrefix(a.title(), prefix) {
			continue
		}
		st := serverTaskState{State: a.State}
		if a.ClaimedBy != nil {
			st.ClaimedBy = *a.ClaimedBy
		}
		out[a.ID] = st
	}
	return out, nil
}

// randomHex is the per-run id that scopes a run's scratch canvas names and task
// title prefixes. Uniqueness per run is all that is needed.
func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func truncate(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}
