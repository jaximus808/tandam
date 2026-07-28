// Command loadtest benchmarks Tandem's task-claim path: N parallel "agent
// sessions" drain a queue of M seeded tasks, racing on the atomic claim
// (PATCH state:"executing"), and then the tool PROVES no task was ever
// claimed by two workers. It reports claims/sec plus per-op latency
// percentiles, and exits non-zero if the zero-double-claim promise is
// violated.
//
// Usage (against the local docker API on :7891):
//
//	go run ./cmd/loadtest -api http://localhost:7891 -code ABCD1234 -sessions 8 -tasks 100
//	go run ./cmd/loadtest -api http://localhost:7891 -code ABCD1234 -json   # machine-readable
//	go run ./cmd/loadtest -api http://localhost:7891 -code ABCD1234 -keep   # leave seeds behind
//
// Example output:
//
//	tandem loadtest — 8 sessions × 100 tasks against http://localhost:7891
//	  seeded 100 tasks (prefix loadtest-1a2b3c4d-)
//	  drained in 4.21s — 23.8 claims/sec
//	  counts: claims_won=100 claims_lost_409=214 claims_lost_stale=12 completed=100 lists=131
//	  latency (ms):        p50     p95     p99   count
//	    list              38.1    72.4    98.0     131
//	    claim_win         41.7    80.2   103.5     100
//	    claim_loss_409    39.9    78.8    99.1     214
//	    complete          40.3    79.0   101.2     100
//	  reconciliation: OK — all 100 tasks done exactly once, zero double-claims
//
// WARNING: do NOT point this at a canvas with real tasks. The tool DELETES
// everything it seeds during cleanup, and while workers only ever claim tasks
// whose title carries this run's "loadtest-<run>-" prefix (so pre-existing
// approved tasks are left alone), a benchmark run still floods the canvas
// with churn and WS broadcasts. Use a throwaway canvas.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

func main() {
	var (
		apiURL   = flag.String("api", "", "base URL of the Tandem API (required), e.g. http://localhost:7891")
		code     = flag.String("code", "", "canvas code to run against (required — use a THROWAWAY canvas)")
		sessions = flag.Int("sessions", 8, "number of parallel agent sessions (workers)")
		tasks    = flag.Int("tasks", 100, "number of tasks to seed and drain")
		jsonOut  = flag.Bool("json", false, "emit a machine-readable JSON result on stdout")
		keep     = flag.Bool("keep", false, "skip cleanup (leave the seeded tasks on the canvas)")
	)
	flag.Parse()

	if *apiURL == "" || *code == "" {
		fmt.Fprintln(os.Stderr, "usage: loadtest -api <base-url> -code <canvas-code> [-sessions N] [-tasks M] [-json] [-keep]")
		os.Exit(2)
	}
	if *sessions < 1 || *tasks < 1 {
		fmt.Fprintln(os.Stderr, "loadtest: -sessions and -tasks must be >= 1")
		os.Exit(2)
	}

	if err := run(*apiURL, *code, *sessions, *tasks, *jsonOut, *keep); err != nil {
		fmt.Fprintf(os.Stderr, "loadtest: %v\n", err)
		os.Exit(1)
	}
}

// logf writes human progress to stderr so -json keeps stdout clean.
func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

func run(apiURL, code string, sessions, tasks int, jsonOut, keep bool) error {
	c := &client{
		base: strings.TrimRight(apiURL, "/"),
		http: &http.Client{Timeout: 30 * time.Second},
	}

	// ── Auth: exchange the canvas code for a JWT (mirrors the MCP gateway's
	// connectWithCode → POST /api/mcp/auth). ─────────────────────────────────
	if err := c.connect(code); err != nil {
		return fmt.Errorf("auth (POST /api/mcp/auth): %w", err)
	}
	logf("tandem loadtest — %d sessions × %d tasks against %s", sessions, tasks, c.base)

	// ── Seed M born-approved tasks via the batch endpoint. Titles carry a
	// per-run prefix; workers ONLY claim tasks with this prefix, so a stray
	// real approved task on the canvas is never touched. ─────────────────────
	runID := randomHex(4)
	prefix := "loadtest-" + runID + "-"
	seeded, err := c.seedTasks(prefix, tasks)
	if err != nil {
		return fmt.Errorf("seeding: %w", err)
	}
	logf("  seeded %d tasks (prefix %s)", len(seeded), prefix)

	cleanup := func() {
		if keep {
			logf("  -keep: leaving %d seeded tasks on the canvas", len(seeded))
			return
		}
		if err := c.deleteTasks(seeded); err != nil {
			logf("  cleanup WARNING: %v (seeded tasks may remain, prefix %s)", err, prefix)
			return
		}
		logf("  cleaned up %d seeded tasks", len(seeded))
	}

	// ── Drain: N workers race list → claim → complete until empty. ───────────
	rec := newRecorder()
	winsByWorker := make(map[string][]string, sessions)
	var winsMu sync.Mutex
	workerErrs := make([]error, sessions)

	start := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < sessions; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			name := fmt.Sprintf("loadtest-w%d", i)
			wins, err := c.drain(name, prefix, rec)
			winsMu.Lock()
			winsByWorker[name] = wins
			winsMu.Unlock()
			workerErrs[i] = err
		}(i)
	}
	wg.Wait()
	wall := time.Since(start)

	for i, err := range workerErrs {
		if err != nil {
			cleanup()
			return fmt.Errorf("worker %d: %w", i, err)
		}
	}

	// ── Reconciliation: the correctness assertion. ───────────────────────────
	counts := rec.counts()
	states := make(map[string]serverTaskState, len(seeded))
	for _, id := range seeded {
		st, err := c.fetchTaskState(id)
		if err != nil {
			cleanup()
			return fmt.Errorf("reconciliation fetch %s: %w", id, err)
		}
		states[id] = st
	}
	recon := reconcile(seeded, winsByWorker, states, counts)

	// ── Cleanup before reporting the verdict, so a FAIL doesn't strand seeds.
	cleanup()

	report := buildReport(c.base, sessions, tasks, wall, counts, rec, recon)
	if jsonOut {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(report); err != nil {
			return err
		}
	} else {
		printHuman(report)
	}

	if !recon.OK {
		if len(recon.DoubleClaims) > 0 {
			fmt.Fprintln(os.Stderr, "")
			fmt.Fprintln(os.Stderr, "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!")
			fmt.Fprintln(os.Stderr, "!!! DOUBLE-CLAIM DETECTED — the atomic-claim promise is  !!!")
			fmt.Fprintln(os.Stderr, "!!! BROKEN. Two workers won the same task:               !!!")
			for _, d := range recon.DoubleClaims {
				fmt.Fprintf(os.Stderr, "!!!   task %s won by %s\n", d.TaskID, strings.Join(d.Workers, " AND "))
			}
			fmt.Fprintln(os.Stderr, "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!")
		}
		return fmt.Errorf("reconciliation FAILED: %s", strings.Join(recon.Violations, "; "))
	}
	logf("  reconciliation: OK — all %d tasks done exactly once, zero double-claims", tasks)
	return nil
}

// ── HTTP client ───────────────────────────────────────────────────────────────

type client struct {
	base  string
	token string
	http  *http.Client
}

func (c *client) do(method, path string, body any) (int, []byte, time.Duration, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, 0, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rdr)
	if err != nil {
		return 0, nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	t0 := time.Now()
	resp, err := c.http.Do(req)
	dur := time.Since(t0)
	if err != nil {
		return 0, nil, dur, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, dur, err
	}
	return resp.StatusCode, data, dur, nil
}

// connect mirrors the MCP gateway's connectWithCode: POST /api/mcp/auth
// {code} → {token, canvasId, ...}; the token authenticates everything after.
func (c *client) connect(code string) error {
	status, data, _, err := c.do("POST", "/api/mcp/auth", map[string]string{"code": code})
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("status %d: %s", status, truncate(data))
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(data, &out); err != nil || out.Token == "" {
		return fmt.Errorf("no token in auth response: %s", truncate(data))
	}
	c.token = out.Token
	return nil
}

const seedBatchSize = 100

// seedTasks creates n born-approved tasks (humans may create state "approved"
// directly) via POST /api/canvas/actions/batch, chunked. Returns their ids.
func (c *client) seedTasks(prefix string, n int) ([]string, error) {
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
					"title":    fmt.Sprintf("%s%d", prefix, i),
					"assignee": "agent",
				},
			})
		}
		status, data, _, err := c.do("POST", "/api/canvas/actions/batch", map[string]any{"actions": batch})
		if err != nil {
			return ids, err
		}
		if status != http.StatusCreated {
			return ids, fmt.Errorf("status %d: %s", status, truncate(data))
		}
		var out struct {
			Actions []struct {
				ID    string `json:"id"`
				State string `json:"state"`
			} `json:"actions"`
		}
		if err := json.Unmarshal(data, &out); err != nil {
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

type listedTask struct {
	ID    string
	Title string
}

// listApproved fetches the approved-task queue and records list latency.
func (c *client) listApproved(rec *recorder) ([]listedTask, error) {
	status, data, dur, err := c.do("GET", "/api/canvas/actions?type=task&state=approved", nil)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("list status %d: %s", status, truncate(data))
	}
	rec.observe(opList, dur)
	var out struct {
		Actions []struct {
			ID      string          `json:"id"`
			Payload json.RawMessage `json:"payload"`
		} `json:"actions"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("decoding list: %w", err)
	}
	tasksOut := make([]listedTask, 0, len(out.Actions))
	for _, a := range out.Actions {
		var p struct {
			Title string `json:"title"`
		}
		_ = json.Unmarshal(a.Payload, &p)
		tasksOut = append(tasksOut, listedTask{ID: a.ID, Title: p.Title})
	}
	return tasksOut, nil
}

// claim outcomes
type claimOutcome int

const (
	claimWon   claimOutcome = iota // 200 — we hold the task
	claimLost                      // 409 already_claimed — another worker won the race
	claimStale                     // 400 illegal state — task already left approved (e.g. done)
)

// claim races for a task: PATCH /api/canvas/actions/{id}
// {state:"executing", agentName}. The server decides the winner atomically
// (conditional UPDATE ... WHERE state='approved').
func (c *client) claim(id, agentName string, rec *recorder) (claimOutcome, error) {
	status, data, dur, err := c.do("PATCH", "/api/canvas/actions/"+id,
		map[string]string{"state": "executing", "agentName": agentName})
	if err != nil {
		return claimStale, err
	}
	switch status {
	case http.StatusOK:
		rec.observe(opClaimWin, dur)
		return claimWon, nil
	case http.StatusConflict:
		var e struct {
			Error     string `json:"error"`
			ClaimedBy string `json:"claimedBy"`
		}
		_ = json.Unmarshal(data, &e)
		if e.Error != "already_claimed" {
			return claimStale, fmt.Errorf("claim %s: unexpected 409 body: %s", id, truncate(data))
		}
		rec.observe(opClaimLoss, dur)
		return claimLost, nil
	case http.StatusBadRequest:
		// The task left "approved" between our list and our claim (typically the
		// winner already completed it). A lost race, just later in its life.
		return claimStale, nil
	default:
		return claimStale, fmt.Errorf("claim %s: status %d: %s", id, status, truncate(data))
	}
}

// complete finishes a held task: PATCH {state:"done", result, agentName}.
// complete finishes a won task. Returns (completed=false, nil) on the
// ownership 409 — a DEFINED outcome since the claim guard: the task was
// released by a human and re-claimed by another worker mid-run. That is not a
// benchmark failure; the worker just moves on (and drops the win, since the
// task is no longer ours for reconciliation purposes).
func (c *client) complete(id, agentName, result string, rec *recorder) (bool, error) {
	status, data, dur, err := c.do("PATCH", "/api/canvas/actions/"+id,
		map[string]string{"state": "done", "result": result, "agentName": agentName})
	if err != nil {
		return false, err
	}
	if status == http.StatusConflict {
		rec.attempt(claimStale)
		return false, nil
	}
	if status != http.StatusOK {
		return false, fmt.Errorf("complete %s: status %d: %s", id, status, truncate(data))
	}
	rec.observe(opComplete, dur)
	return true, nil
}

// drain is one agent session's loop: list the approved queue, try to claim
// this run's tasks in order (racing every other session), complete each win,
// re-list; exit when no seeded tasks remain approved. Returns the ids of the
// tasks this worker won — the client-side evidence for reconciliation.
func (c *client) drain(agentName, prefix string, rec *recorder) ([]string, error) {
	var wins []string
	for {
		listed, err := c.listApproved(rec)
		if err != nil {
			return wins, fmt.Errorf("%s: %w", agentName, err)
		}
		mine := listed[:0:0]
		for _, t := range listed {
			// ONLY ever claim this run's seeds — a real approved task on the
			// canvas must never be picked up by the benchmark.
			if strings.HasPrefix(t.Title, prefix) {
				mine = append(mine, t)
			}
		}
		if len(mine) == 0 {
			return wins, nil // queue drained
		}
		for _, t := range mine {
			outcome, err := c.claim(t.ID, agentName, rec)
			if err != nil {
				return wins, fmt.Errorf("%s: %w", agentName, err)
			}
			rec.attempt(outcome)
			if outcome != claimWon {
				continue // move on to the next task in this listing
			}
			done, err := c.complete(t.ID, agentName, "loadtest "+agentName, rec)
			if err != nil {
				return wins, fmt.Errorf("%s: %w", agentName, err)
			}
			if done {
				// Only completed wins count for reconciliation — a 409'd
				// complete means the task was released and re-claimed away.
				wins = append(wins, t.ID)
			}
			break // re-list after a win, like a real session would
		}
	}
}

// fetchTaskState reads one action back for reconciliation.
func (c *client) fetchTaskState(id string) (serverTaskState, error) {
	status, data, _, err := c.do("GET", "/api/canvas/actions/"+id, nil)
	if err != nil {
		return serverTaskState{}, err
	}
	if status != http.StatusOK {
		return serverTaskState{}, fmt.Errorf("status %d: %s", status, truncate(data))
	}
	var out struct {
		Action struct {
			State     string  `json:"state"`
			ClaimedBy *string `json:"claimedBy"`
		} `json:"action"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return serverTaskState{}, fmt.Errorf("decoding action: %w", err)
	}
	st := serverTaskState{State: out.Action.State}
	if out.Action.ClaimedBy != nil {
		st.ClaimedBy = *out.Action.ClaimedBy
	}
	return st, nil
}

// deleteTasks removes the seeded tasks via the batch-delete endpoint, chunked.
func (c *client) deleteTasks(ids []string) error {
	for off := 0; off < len(ids); off += seedBatchSize {
		end := off + seedBatchSize
		if end > len(ids) {
			end = len(ids)
		}
		status, data, _, err := c.do("POST", "/api/canvas/actions/batch-delete",
			map[string]any{"ids": ids[off:end]})
		if err != nil {
			return err
		}
		if status != http.StatusOK {
			return fmt.Errorf("batch-delete status %d: %s", status, truncate(data))
		}
	}
	return nil
}

// ── Report ────────────────────────────────────────────────────────────────────

type latencySummary struct {
	P50ms float64 `json:"p50"`
	P95ms float64 `json:"p95"`
	P99ms float64 `json:"p99"`
	Count int     `json:"count"`
}

type report struct {
	API          string                    `json:"api"`
	Sessions     int                       `json:"sessions"`
	Tasks        int                       `json:"tasks"`
	WallSeconds  float64                   `json:"wall_seconds"`
	ClaimsPerSec float64                   `json:"claims_per_sec"`
	Counts       opCounts                  `json:"counts"`
	LatencyMs    map[string]latencySummary `json:"latency_ms"`
	Recon        reconResult               `json:"reconciliation"`
}

func buildReport(api string, sessions, tasks int, wall time.Duration, counts opCounts, rec *recorder, recon reconResult) report {
	lat := make(map[string]latencySummary, 4)
	for op, name := range opNames {
		samples := rec.samples(op)
		lat[name] = latencySummary{
			P50ms: durMs(percentile(samples, 50)),
			P95ms: durMs(percentile(samples, 95)),
			P99ms: durMs(percentile(samples, 99)),
			Count: len(samples),
		}
	}
	cps := 0.0
	if wall > 0 {
		cps = float64(counts.ClaimsWon) / wall.Seconds()
	}
	return report{
		API: api, Sessions: sessions, Tasks: tasks,
		WallSeconds:  wall.Seconds(),
		ClaimsPerSec: cps,
		Counts:       counts,
		LatencyMs:    lat,
		Recon:        recon,
	}
}

func printHuman(r report) {
	fmt.Printf("  drained in %.2fs — %.1f claims/sec\n", r.WallSeconds, r.ClaimsPerSec)
	fmt.Printf("  counts: claims_won=%d claims_lost_409=%d claims_lost_stale=%d completed=%d lists=%d\n",
		r.Counts.ClaimsWon, r.Counts.ClaimsLost409, r.Counts.ClaimsLostStale, r.Counts.Completed, r.Counts.Lists)
	fmt.Printf("  latency (ms): %14s %7s %7s %7s\n", "p50", "p95", "p99", "count")
	for _, name := range []string{"list", "claim_win", "claim_loss_409", "complete"} {
		s := r.LatencyMs[name]
		fmt.Printf("    %-16s %7.1f %7.1f %7.1f %7d\n", name, s.P50ms, s.P95ms, s.P99ms, s.Count)
	}
	if r.Recon.OK {
		fmt.Printf("  reconciliation: OK — %d tasks done exactly once, zero double-claims\n", r.Tasks)
	} else {
		fmt.Printf("  reconciliation: FAILED — %s\n", strings.Join(r.Recon.Violations, "; "))
	}
}

// ── Small helpers ─────────────────────────────────────────────────────────────

func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		// Fall back to a time-derived id — uniqueness per run is all we need.
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func truncate(b []byte) string {
	s := string(b)
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}

func durMs(d time.Duration) float64 {
	return float64(d) / float64(time.Millisecond)
}

// sortDurations returns a sorted copy (used by percentile via stats.go).
func sortDurations(in []time.Duration) []time.Duration {
	out := make([]time.Duration, len(in))
	copy(out, in)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
