package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/webhooks"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// TDM-38 — the inbound status API. Two things are being defended here:
//
//  1. AUTH. The canvas is named by a {code} in a URL a human pastes into a
//     workflow file, so the token must be checked AGAINST that code. A token for
//     another canvas replayed at this URL is the failure mode that matters.
//  2. TRANSITION IDENTITY. A curl from CI must go through the same claim and the
//     same terminal transition as an MCP tool call — same 409s, same webhooks. A
//     regression that quietly forked the two paths would show up as a fleet that
//     double-executes work, which is precisely what the atomic claim exists to
//     prevent.

// ── Fake store ───────────────────────────────────────────────────────────────

// statusFakeStore implements only what this endpoint touches, and models
// ClaimAction's REAL semantics (idempotent for the same named claimant, 409 for
// a rival) — the whole idempotent-retry contract is meaningless against a fake
// that always says yes.
type statusFakeStore struct {
	store.Store
	mu sync.Mutex

	canvas  *store.Canvas
	actions map[uuid.UUID]*store.Action

	// role is what ResolveCanvasRole reports for a PAT/OAuth caller.
	role string
	// patUsers maps a token HASH to its owner, mirroring the real PAT lookup.
	patUsers map[string]uuid.UUID
	// claimOutcome is what a successful claim reports (set ExpiredClaimBy to
	// simulate a TTL takeover).
	claimOutcome store.ClaimOutcome

	payloadWrites int
}

func (f *statusFakeStore) GetCanvasByCode(_ context.Context, code string) (*store.Canvas, error) {
	if f.canvas != nil && f.canvas.Code == code {
		return f.canvas, nil
	}
	return nil, store.ErrCanvasNotFound
}

func (f *statusFakeStore) ResolveCanvasRole(_ context.Context, _ *store.Canvas, _ *uuid.UUID) (string, error) {
	return f.role, nil
}

func (f *statusFakeStore) UserIDByTokenHash(_ context.Context, hash string) (uuid.UUID, error) {
	if uid, ok := f.patUsers[hash]; ok {
		return uid, nil
	}
	return uuid.Nil, store.ErrInvalidToken
}

func (f *statusFakeStore) GetAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if a, ok := f.actions[id]; ok {
		copy := *a
		return &copy, nil
	}
	return nil, fmt.Errorf("action %s not found", id)
}

func (f *statusFakeStore) ClaimAction(_ context.Context, _ uuid.UUID, id uuid.UUID, claimedBy string) (*store.Action, store.ClaimOutcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ClaimOutcome{}, store.ErrActionNotFound
	}
	if a.Type != "task" {
		return nil, store.ClaimOutcome{}, fmt.Errorf("%w: only tasks can be claimed", store.ErrIllegalActionState)
	}
	switch a.State {
	case "approved":
		a.State = "executing"
		holder := claimedBy
		now := time.Now().UTC()
		a.ClaimedBy = &holder
		a.ClaimedAt = &now
		copy := *a
		return &copy, f.claimOutcome, nil
	case "executing":
		holder := ""
		if a.ClaimedBy != nil {
			holder = *a.ClaimedBy
		}
		// The store's rule: a NAMED claimant retrying its own claim gets it back.
		if holder != "" && holder != "agent" && holder == claimedBy {
			copy := *a
			return &copy, store.ClaimOutcome{}, nil
		}
		return nil, store.ClaimOutcome{}, &store.AlreadyClaimedError{ClaimedBy: holder}
	default:
		return nil, store.ClaimOutcome{}, fmt.Errorf("%w: cannot claim task in state %q", store.ErrIllegalActionState, a.State)
	}
}

func (f *statusFakeStore) UpdateActionState(_ context.Context, _ uuid.UUID, id uuid.UUID, patch store.ActionStatePatch) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return 0, fmt.Errorf("action %s not found", id)
	}
	a.State = patch.State
	if patch.Result != nil {
		a.Result = patch.Result
	}
	if patch.Error != nil {
		a.Error = patch.Error
	}
	if len(patch.Payload) > 0 {
		a.Payload = patch.Payload
		f.payloadWrites++
	}
	return 1, nil
}

// Runs the REAL content gate (store.DecideContentUpdate). That is the point for
// this file specifically: the status API's whole promise is that a progress
// report is ADDITIVE, and "additive" now means "does not trip the gate". If a
// change ever made mergeTaskStatusPayload touch title/body, every status test
// here would start reverting tasks to 'proposed' and fail loudly.
func (f *statusFakeStore) UpdateActionPayload(_ context.Context, _ uuid.UUID, id uuid.UUID, payload json.RawMessage, actor string) (*store.ContentUpdate, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ErrActionNotFound
	}
	next, out, err := store.DecideContentUpdate(a, payload, actor, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	a.Payload = next
	if out.Reverted {
		a.State = "proposed"
		a.ClaimedBy, a.ClaimedAt, a.ApprovedBy = nil, nil, nil
		out.Action = a
	}
	f.payloadWrites++
	out.Version = 1
	return out, nil
}

func (f *statusFakeStore) TouchOrCreateAgent(_ context.Context, _ uuid.UUID, _ string) error {
	return nil
}

// GetCanvasState backs the async post-write broadcast; erroring makes it a no-op.
func (f *statusFakeStore) GetCanvasState(_ context.Context, _ uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in tests")
}

// stored reads a task back out of the fake (post-write assertions).
func (f *statusFakeStore) stored(id uuid.UUID) *store.Action {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.actions[id]
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const statusCanvasCode = "TEGLQFXR"

func statusTask(state string, claimedBy string) *store.Action {
	a := &store.Action{
		ID: uuid.New(), Kind: "action", Type: "task", State: state,
		Ticket:  ticketPtr(38),
		Payload: json.RawMessage(`{"title":"ship the thing","assignee":"agent"}`),
	}
	if claimedBy != "" {
		holder := claimedBy
		now := time.Now().UTC()
		a.ClaimedBy = &holder
		a.ClaimedAt = &now
	}
	return a
}

func newStatusHarness(t *testing.T, tasks ...*store.Action) (*Handler, *statusFakeStore, *recordingEmitter, uuid.UUID) {
	t.Helper()
	canvasID := uuid.New()
	fake := &statusFakeStore{
		canvas:  &store.Canvas{ID: canvasID, Code: statusCanvasCode, Visibility: "public", PublicRole: "write"},
		actions: map[uuid.UUID]*store.Action{},
		role:    "write",
	}
	for _, a := range tasks {
		fake.actions[a.ID] = a
	}
	em := &recordingEmitter{}
	return NewHandler(fake, nil, nil, WithTaskEvents(em)), fake, em, canvasID
}

// statusRequest builds a direct-to-handler request: claims in context (as the
// middleware would leave them) and the {id} path param bound.
func statusRequest(t *testing.T, canvasID, id uuid.UUID, body map[string]any) *http.Request {
	t.Helper()
	return canvasRequest(t, "POST", "/api/canvas/"+statusCanvasCode+"/tasks/"+id.String()+"/status", body, canvasID, id.String())
}

func postStatus(t *testing.T, h *Handler, canvasID, id uuid.UUID, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.ReportTaskStatus(w, statusRequest(t, canvasID, id, body))
	return w
}

// decodeStatus reads the JSON body of a status response.
func decodeStatus(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON (%d): %s", w.Code, w.Body)
	}
	return out
}

// ── Transitions ──────────────────────────────────────────────────────────────

// The whole state machine as a table, each row asserting the status code, the
// resulting stored state, AND the complete webhook list — the negative half
// (progress and started fire nothing) is as much the contract as the positive.
func TestReportTaskStatusTransitions(t *testing.T) {
	tests := []struct {
		name string
		// from/heldBy describe the task as it exists before the call.
		from     string
		heldBy   string
		body     map[string]any
		wantCode int
		// wantState is the stored state afterwards ("" = unchanged).
		wantState string
		wantEvent []string
		// wantErr is the `error` code in the response body, when it's an error.
		wantErr string
	}{
		{
			name:     "started claims an approved task",
			from:     "approved",
			body:     map[string]any{"state": "started", "agent": "ci-github"},
			wantCode: http.StatusOK, wantState: "executing",
		},
		{
			name:     "started defaults the agent to external",
			from:     "approved",
			body:     map[string]any{"state": "started"},
			wantCode: http.StatusOK, wantState: "executing",
		},
		{
			name: "started again by the SAME agent is an idempotent 200",
			from: "executing", heldBy: "ci-github",
			body:     map[string]any{"state": "started", "agent": "ci-github"},
			wantCode: http.StatusOK, wantState: "executing",
		},
		{
			name: "started by a RIVAL agent is 409 already_claimed",
			from: "executing", heldBy: "agent-a",
			body:     map[string]any{"state": "started", "agent": "ci-github"},
			wantCode: http.StatusConflict, wantState: "executing", wantErr: "already_claimed",
		},
		{
			name:     "started on a proposed task is 409 illegal_state",
			from:     "proposed",
			body:     map[string]any{"state": "started", "agent": "ci-github"},
			wantCode: http.StatusConflict, wantState: "proposed", wantErr: "illegal_state",
		},
		{
			name: "progress on an executing task the agent holds",
			from: "executing", heldBy: "ci-github",
			body:     map[string]any{"state": "progress", "agent": "ci-github", "summary": "tests green"},
			wantCode: http.StatusOK, wantState: "executing",
		},
		{
			name:     "progress on an unclaimed (approved) task is 409 not_executing",
			from:     "approved",
			body:     map[string]any{"state": "progress", "agent": "ci-github", "summary": "tests green"},
			wantCode: http.StatusConflict, wantState: "approved", wantErr: "not_executing",
		},
		{
			name: "progress on a rival's task is 409 claimed_by_other",
			from: "executing", heldBy: "agent-a",
			body:     map[string]any{"state": "progress", "agent": "ci-github", "summary": "tests green"},
			wantCode: http.StatusConflict, wantState: "executing", wantErr: "claimed_by_other",
		},
		{
			name: "progress with neither summary nor links is 400",
			from: "executing", heldBy: "ci-github",
			body:     map[string]any{"state": "progress", "agent": "ci-github"},
			wantCode: http.StatusBadRequest, wantState: "executing", wantErr: "nothing_to_report",
		},
		{
			name: "completed fires task.completed",
			from: "executing", heldBy: "ci-github",
			body:     map[string]any{"state": "completed", "agent": "ci-github", "summary": "deployed"},
			wantCode: http.StatusOK, wantState: "done",
			wantEvent: []string{webhooks.EventTaskCompleted},
		},
		{
			name: "completed again is an idempotent 200 with no second event",
			from: "done", heldBy: "ci-github",
			body:     map[string]any{"state": "completed", "agent": "ci-github", "summary": "deployed"},
			wantCode: http.StatusOK, wantState: "done",
		},
		{
			name:     "completed on a task never started is 409 not_executing",
			from:     "approved",
			body:     map[string]any{"state": "completed", "agent": "ci-github", "summary": "deployed"},
			wantCode: http.StatusConflict, wantState: "approved", wantErr: "not_executing",
		},
		{
			name: "completed on a rival's task is 409 claimed_by_other",
			from: "executing", heldBy: "agent-a",
			body:     map[string]any{"state": "completed", "agent": "ci-github", "summary": "deployed"},
			wantCode: http.StatusConflict, wantState: "executing", wantErr: "claimed_by_other",
		},
		{
			name: "failed fires task.completed too — terminal is terminal",
			from: "executing", heldBy: "ci-github",
			body:     map[string]any{"state": "failed", "agent": "ci-github", "error": "build broke"},
			wantCode: http.StatusOK, wantState: "failed",
			wantEvent: []string{webhooks.EventTaskCompleted},
		},
		{
			name: "failed accepts summary as the reason when error is absent",
			from: "executing", heldBy: "ci-github",
			body:     map[string]any{"state": "failed", "agent": "ci-github", "summary": "flaky infra"},
			wantCode: http.StatusOK, wantState: "failed",
			wantEvent: []string{webhooks.EventTaskCompleted},
		},
		{
			name: "an unknown state is 400",
			from: "executing", heldBy: "ci-github",
			body:     map[string]any{"state": "in_progress", "agent": "ci-github"},
			wantCode: http.StatusBadRequest, wantState: "executing", wantErr: "invalid_state",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			task := statusTask(tc.from, tc.heldBy)
			h, fake, em, canvasID := newStatusHarness(t, task)

			w := postStatus(t, h, canvasID, task.ID, tc.body)
			if w.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d: %s", w.Code, tc.wantCode, w.Body)
			}
			if got := fake.stored(task.ID).State; got != tc.wantState {
				t.Errorf("stored state = %q, want %q", got, tc.wantState)
			}
			if tc.wantErr != "" {
				body := decodeStatus(t, w)
				if body["error"] != tc.wantErr {
					t.Errorf("error = %v, want %q (body %s)", body["error"], tc.wantErr, w.Body)
				}
				if body["message"] == nil || body["message"] == "" {
					t.Errorf("error %q carries no actionable message: %s", tc.wantErr, w.Body)
				}
			}
			em.settleTypes(t, tc.wantEvent...)
		})
	}
}

// A rival 409 must NAME the holder — a CI job that can't tell who has the task
// has no way to decide whether to wait or move on.
func TestReportTaskStatusConflictsNameTheHolder(t *testing.T) {
	for _, state := range []string{"started", "progress", "completed"} {
		t.Run(state, func(t *testing.T) {
			task := statusTask("executing", "agent-a")
			h, _, _, canvasID := newStatusHarness(t, task)
			w := postStatus(t, h, canvasID, task.ID, map[string]any{
				"state": state, "agent": "ci-github", "summary": "x",
			})
			if w.Code != http.StatusConflict {
				t.Fatalf("status = %d, want 409: %s", w.Code, w.Body)
			}
			if got := decodeStatus(t, w)["claimedBy"]; got != "agent-a" {
				t.Errorf("claimedBy = %v, want agent-a (body %s)", got, w.Body)
			}
		})
	}
}

// The generic "agent" holder (the anonymous MCP/web path) is not an exclusive
// identity — a CI job may report on a task it holds, matching UpdateActionState.
func TestReportTaskStatusGenericHolderIsNotExclusive(t *testing.T) {
	task := statusTask("executing", "agent")
	h, fake, _, canvasID := newStatusHarness(t, task)
	w := postStatus(t, h, canvasID, task.ID, map[string]any{
		"state": "completed", "agent": "ci-github", "summary": "done",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	if got := fake.stored(task.ID).State; got != "done" {
		t.Errorf("stored state = %q, want done", got)
	}
}

// ── links[] and progress[] land in the payload ───────────────────────────────

func TestReportTaskStatusLinksLandInPayload(t *testing.T) {
	task := statusTask("executing", "ci-github")
	h, fake, _, canvasID := newStatusHarness(t, task)

	w := postStatus(t, h, canvasID, task.ID, map[string]any{
		"state": "completed", "agent": "ci-github", "summary": "shipped",
		"links": []string{"https://github.com/o/r/commit/abc", "https://github.com/o/r/pull/7"},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body)
	}
	stored := fake.stored(task.ID)
	var p struct {
		Title string   `json:"title"`
		Links []string `json:"links"`
	}
	if err := json.Unmarshal(stored.Payload, &p); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if len(p.Links) != 2 || p.Links[0] != "https://github.com/o/r/commit/abc" {
		t.Errorf("links = %v, want both evidence URLs", p.Links)
	}
	// Additive: the task's own content survives the report untouched.
	if p.Title != "ship the thing" {
		t.Errorf("title = %q, want the original — the status API must not edit task content", p.Title)
	}
	if stored.Result == nil || *stored.Result != "shipped" {
		t.Errorf("result = %v, want the summary", stored.Result)
	}
}

// Links accumulate across reports and dedupe — a job that posts its run URL at
// start and its commit URL at the end ends up with both, once each.
func TestReportTaskStatusLinksAccumulateAndDedupe(t *testing.T) {
	task := statusTask("approved", "")
	h, fake, _, canvasID := newStatusHarness(t, task)

	run := "https://github.com/o/r/actions/runs/1"
	commit := "https://github.com/o/r/commit/abc"

	if w := postStatus(t, h, canvasID, task.ID, map[string]any{
		"state": "started", "agent": "ci-github", "summary": "run started", "links": []string{run},
	}); w.Code != http.StatusOK {
		t.Fatalf("started = %d: %s", w.Code, w.Body)
	}
	if w := postStatus(t, h, canvasID, task.ID, map[string]any{
		"state": "completed", "agent": "ci-github", "summary": "green",
		"links": []string{run, commit},
	}); w.Code != http.StatusOK {
		t.Fatalf("completed = %d: %s", w.Code, w.Body)
	}

	var p struct {
		Links    []string `json:"links"`
		Progress []struct {
			Agent string `json:"agent"`
			Note  string `json:"note"`
			At    string `json:"at"`
		} `json:"progress"`
	}
	if err := json.Unmarshal(fake.stored(task.ID).Payload, &p); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if len(p.Links) != 2 || p.Links[0] != run || p.Links[1] != commit {
		t.Errorf("links = %v, want [run, commit] once each", p.Links)
	}
	if len(p.Progress) != 1 || p.Progress[0].Note != "run started" || p.Progress[0].Agent != "ci-github" {
		t.Errorf("progress = %+v, want the start note attributed to ci-github", p.Progress)
	}
	if p.Progress[0].At == "" {
		t.Error("progress entry has no timestamp")
	}
}

func TestReportTaskStatusProgressAppends(t *testing.T) {
	task := statusTask("executing", "ci-github")
	h, fake, em, canvasID := newStatusHarness(t, task)

	for _, note := range []string{"step 1", "step 2", "step 3"} {
		w := postStatus(t, h, canvasID, task.ID, map[string]any{
			"state": "progress", "agent": "ci-github", "summary": note,
		})
		if w.Code != http.StatusOK {
			t.Fatalf("progress %q = %d: %s", note, w.Code, w.Body)
		}
	}
	var p struct {
		Progress []map[string]any `json:"progress"`
	}
	if err := json.Unmarshal(fake.stored(task.ID).Payload, &p); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if len(p.Progress) != 3 || p.Progress[2]["note"] != "step 3" {
		t.Fatalf("progress = %v, want three entries in order", p.Progress)
	}
	// A heartbeat is not a queue transition: nothing may reach a webhook receiver.
	em.settleTypes(t)
}

// The progress log is capped so a looping CI job can't grow the row (and every
// state broadcast on the canvas) without bound.
func TestMergeTaskStatusPayloadCapsProgress(t *testing.T) {
	payload := json.RawMessage(`{"title":"t"}`)
	for i := 0; i < maxProgressEntries+10; i++ {
		var err error
		var changed bool
		payload, changed, err = mergeTaskStatusPayload(payload, "ci", fmt.Sprintf("note %d", i), nil, time.Now().UTC())
		if err != nil || !changed {
			t.Fatalf("merge %d: changed=%v err=%v", i, changed, err)
		}
	}
	var p struct {
		Title    string           `json:"title"`
		Progress []map[string]any `json:"progress"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if len(p.Progress) != maxProgressEntries {
		t.Errorf("progress kept %d entries, want the cap of %d", len(p.Progress), maxProgressEntries)
	}
	// The cap drops the OLDEST — the recent history is the useful half.
	if p.Progress[len(p.Progress)-1]["note"] != fmt.Sprintf("note %d", maxProgressEntries+9) {
		t.Errorf("last entry = %v, want the newest note", p.Progress[len(p.Progress)-1]["note"])
	}
	if p.Title != "t" {
		t.Errorf("title = %q, want it preserved through every merge", p.Title)
	}
}

// A malformed body must fail loudly at the boundary rather than land junk in a
// payload the board then has to render.
func TestReportTaskStatusRejectsBadInput(t *testing.T) {
	tests := []struct {
		name string
		body map[string]any
	}{
		{"empty link", map[string]any{"state": "completed", "links": []string{""}}},
		{"too many links", map[string]any{"state": "completed", "links": make([]string, maxStatusLinks+1)}},
		{"oversized link", map[string]any{"state": "completed", "links": []string{strings.Repeat("x", maxStatusLinkLen+1)}}},
		{"oversized summary", map[string]any{"state": "completed", "summary": strings.Repeat("x", maxStatusSummary+1)}},
		{"oversized agent", map[string]any{"state": "completed", "agent": strings.Repeat("a", maxStatusAgentLen+1)}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			task := statusTask("executing", "ci-github")
			h, fake, _, canvasID := newStatusHarness(t, task)
			w := postStatus(t, h, canvasID, task.ID, tc.body)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", w.Code, w.Body)
			}
			if fake.payloadWrites != 0 {
				t.Errorf("a rejected report wrote to the payload %d times", fake.payloadWrites)
			}
		})
	}
}

func TestReportTaskStatusUnknownTask(t *testing.T) {
	h, _, _, canvasID := newStatusHarness(t)
	for _, state := range []string{"started", "progress", "completed"} {
		w := postStatus(t, h, canvasID, uuid.New(), map[string]any{
			"state": state, "agent": "ci-github", "summary": "x",
		})
		if w.Code != http.StatusNotFound {
			t.Errorf("%s on unknown id = %d, want 404: %s", state, w.Code, w.Body)
		}
	}
}

// A takeover of a lapsed claim is the ONE claim-time event, and it must fire
// from the curl path exactly as it does from MCP — it is the fleet's only signal
// that a member went dark.
func TestReportTaskStatusStartedEmitsClaimExpired(t *testing.T) {
	task := statusTask("approved", "")
	h, fake, em, canvasID := newStatusHarness(t, task)
	fake.claimOutcome = store.ClaimOutcome{ExpiredClaimBy: "agent-a", ExpiredClaimAt: time.Now().UTC().Add(-time.Hour)}

	if w := postStatus(t, h, canvasID, task.ID, map[string]any{
		"state": "started", "agent": "ci-github",
	}); w.Code != http.StatusOK {
		t.Fatalf("started = %d: %s", w.Code, w.Body)
	}
	em.settleTypes(t, webhooks.EventTaskClaimExpired)
	ev := em.recorded()[0]
	expired, _ := ev.body["expired_claim"].(map[string]any)
	if expired == nil || expired["claimed_by"] != "agent-a" {
		t.Errorf("expired_claim = %v, want the lapsed holder", ev.body["expired_claim"])
	}
}

// The webhook a receiver actually gets must carry the completion facts — a
// receiver that has to re-read the canvas to learn the result isn't being told
// anything.
func TestReportTaskStatusCompletedEventBody(t *testing.T) {
	task := statusTask("executing", "ci-github")
	h, _, em, canvasID := newStatusHarness(t, task)

	if w := postStatus(t, h, canvasID, task.ID, map[string]any{
		"state": "completed", "agent": "ci-github", "summary": "deployed to prod",
	}); w.Code != http.StatusOK {
		t.Fatalf("completed = %d: %s", w.Code, w.Body)
	}
	em.settleTypes(t, webhooks.EventTaskCompleted)
	ev := em.recorded()[0]
	if ev.canvasID != canvasID {
		t.Errorf("event canvas = %s, want %s", ev.canvasID, canvasID)
	}
	taskBody, _ := ev.body["task"].(map[string]any)
	if taskBody == nil {
		t.Fatalf("event has no task: %v", ev.body)
	}
	if taskBody["state"] != "done" {
		t.Errorf("task.state = %v, want done", taskBody["state"])
	}
	if taskBody["result"] != "deployed to prod" {
		t.Errorf("task.result = %v, want the summary", taskBody["result"])
	}
	if taskBody["claimedBy"] != "ci-github" {
		t.Errorf("task.claimedBy = %v, want the CI agent — the board has to show who did it", taskBody["claimedBy"])
	}
	if taskBody["ticketId"] != "TDM-38" {
		t.Errorf("task.ticketId = %v, want TDM-38", taskBody["ticketId"])
	}
}

// ── Auth, through the real router ────────────────────────────────────────────

// newStatusRouter builds the REAL router over the fake store, so these tests
// exercise the actual middleware chain and the actual chi route — including
// that /api/canvas/{code}/… doesn't collide with the static /api/canvas/…
// routes registered alongside it.
func newStatusRouter(t *testing.T, task *store.Action) (http.Handler, *statusFakeStore, *auth.Service, uuid.UUID) {
	t.Helper()
	canvasID := uuid.New()
	fake := &statusFakeStore{
		canvas:   &store.Canvas{ID: canvasID, Code: statusCanvasCode, Visibility: "public", PublicRole: "write"},
		actions:  map[uuid.UUID]*store.Action{task.ID: task},
		role:     "write",
		patUsers: map[string]uuid.UUID{},
	}
	authSvc := auth.NewService("test-secret-for-tdm-38", time.Hour)
	r := NewRouter(fake, nil, authSvc, nil, false, nil, "", t.TempDir(), "", false, nil)
	return r, fake, authSvc, canvasID
}

func statusURL(id uuid.UUID) string {
	return "/api/canvas/" + statusCanvasCode + "/tasks/" + id.String() + "/status"
}

func doStatus(t *testing.T, r http.Handler, url, bearer string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest("POST", url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// The advertised two-curl flow, end to end: exchange the canvas code for a
// token at /api/mcp/auth, then post a status with it. If this breaks, the curl
// in the handler doc comment is a lie.
func TestStatusAPICanvasTokenFlow(t *testing.T) {
	task := statusTask("approved", "")
	r, fake, _, _ := newStatusRouter(t, task)

	authReq := httptest.NewRequest("POST", "/api/mcp/auth",
		strings.NewReader(`{"code":"`+statusCanvasCode+`"}`))
	authReq.Header.Set("Content-Type", "application/json")
	aw := httptest.NewRecorder()
	r.ServeHTTP(aw, authReq)
	if aw.Code != http.StatusOK {
		t.Fatalf("/api/mcp/auth = %d: %s", aw.Code, aw.Body)
	}
	var exchanged struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(aw.Body.Bytes(), &exchanged); err != nil || exchanged.Token == "" {
		t.Fatalf("no token in exchange response: %s", aw.Body)
	}

	w := doStatus(t, r, statusURL(task.ID), exchanged.Token, map[string]any{
		"state": "started", "agent": "ci-github",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	if got := fake.stored(task.ID).State; got != "executing" {
		t.Errorf("stored state = %q, want executing — the board didn't move", got)
	}
	if holder := fake.stored(task.ID).ClaimedBy; holder == nil || *holder != "ci-github" {
		t.Errorf("claimedBy = %v, want ci-github", holder)
	}
}

// The one-curl flow: a long-lived PAT straight out of CI secrets.
func TestStatusAPIPersonalAccessTokenFlow(t *testing.T) {
	task := statusTask("approved", "")
	r, fake, _, _ := newStatusRouter(t, task)
	pat := store.PATPrefix + "deadbeefdeadbeef"
	fake.patUsers[store.HashToken(pat)] = uuid.New()

	w := doStatus(t, r, statusURL(task.ID), pat, map[string]any{"state": "started", "agent": "ci-github"})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	if got := fake.stored(task.ID).State; got != "executing" {
		t.Errorf("stored state = %q, want executing", got)
	}
}

// A PAT whose owner has only read access on the canvas can watch the board, not
// move it — the same RequireWrite gate every other mutation sits behind.
func TestStatusAPIReadOnlyRoleIsRejected(t *testing.T) {
	task := statusTask("approved", "")
	r, fake, _, _ := newStatusRouter(t, task)
	fake.role = "read"
	pat := store.PATPrefix + "deadbeefdeadbeef"
	fake.patUsers[store.HashToken(pat)] = uuid.New()

	w := doStatus(t, r, statusURL(task.ID), pat, map[string]any{"state": "started"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", w.Code, w.Body)
	}
	if got := fake.stored(task.ID).State; got != "approved" {
		t.Errorf("stored state = %q — a read-only caller moved the board", got)
	}
}

// A PAT with no access at all to a private canvas: 403, and the task is untouched.
func TestStatusAPINoAccessIsRejected(t *testing.T) {
	task := statusTask("approved", "")
	r, fake, _, _ := newStatusRouter(t, task)
	fake.role = "none"
	pat := store.PATPrefix + "deadbeefdeadbeef"
	fake.patUsers[store.HashToken(pat)] = uuid.New()

	w := doStatus(t, r, statusURL(task.ID), pat, map[string]any{"state": "started"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", w.Code, w.Body)
	}
}

func TestStatusAPIAuthFailures(t *testing.T) {
	task := statusTask("approved", "")

	// A token minted for a DIFFERENT canvas, replayed against this canvas's URL.
	// This is the attack the {code}-in-the-path design has to stop.
	t.Run("token for another canvas is 403", func(t *testing.T) {
		r, fake, authSvc, _ := newStatusRouter(t, task)
		other, err := authSvc.Issue(uuid.New(), "write", nil)
		if err != nil {
			t.Fatalf("issue: %v", err)
		}
		w := doStatus(t, r, statusURL(task.ID), other, map[string]any{"state": "started"})
		if w.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403: %s", w.Code, w.Body)
		}
		if got := fake.stored(task.ID).State; got != "approved" {
			t.Errorf("stored state = %q — a foreign token moved this canvas", got)
		}
	})

	t.Run("no Authorization header is 401", func(t *testing.T) {
		r, _, _, _ := newStatusRouter(t, task)
		w := doStatus(t, r, statusURL(task.ID), "", map[string]any{"state": "started"})
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401: %s", w.Code, w.Body)
		}
	})

	t.Run("expired canvas token is 401", func(t *testing.T) {
		r, _, _, canvasID := newStatusRouter(t, task)
		// Negative TTL → already expired at issue time.
		expiredSvc := auth.NewService("test-secret-for-tdm-38", -time.Minute)
		expired, err := expiredSvc.Issue(canvasID, "write", nil)
		if err != nil {
			t.Fatalf("issue: %v", err)
		}
		w := doStatus(t, r, statusURL(task.ID), expired, map[string]any{"state": "started"})
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401: %s", w.Code, w.Body)
		}
	})

	t.Run("garbage bearer is 401", func(t *testing.T) {
		r, _, _, _ := newStatusRouter(t, task)
		w := doStatus(t, r, statusURL(task.ID), "not-a-token", map[string]any{"state": "started"})
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401: %s", w.Code, w.Body)
		}
	})

	t.Run("unknown PAT is 401", func(t *testing.T) {
		r, _, _, _ := newStatusRouter(t, task)
		w := doStatus(t, r, statusURL(task.ID), store.PATPrefix+"nope", map[string]any{"state": "started"})
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401: %s", w.Code, w.Body)
		}
	})

	t.Run("unknown canvas code is 404", func(t *testing.T) {
		r, _, authSvc, canvasID := newStatusRouter(t, task)
		tok, err := authSvc.Issue(canvasID, "write", nil)
		if err != nil {
			t.Fatalf("issue: %v", err)
		}
		w := doStatus(t, r, "/api/canvas/NOSUCHCV/tasks/"+task.ID.String()+"/status", tok,
			map[string]any{"state": "started"})
		if w.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404: %s", w.Code, w.Body)
		}
	})
}

// The status route must not shadow (or be shadowed by) the static
// /api/canvas/<thing> routes registered on the same prefix. chi prefers static
// segments, but that's a property worth pinning: a regression here silently
// reroutes half the canvas API.
func TestStatusRouteDoesNotShadowStaticCanvasRoutes(t *testing.T) {
	task := statusTask("approved", "")
	r, _, _, _ := newStatusRouter(t, task)

	// No Authorization → the state route's RequireJWT answers, proving the
	// request reached the static route rather than RequireCanvasByCode's
	// "canvas not found" for a code of "actions"/"state".
	req := httptest.NewRequest("GET", "/api/canvas/state", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("GET /api/canvas/state = %d, want 401 from RequireJWT: %s", w.Code, w.Body)
	}
}

// chi binds {code} and {id} independently; a regression that dropped either
// param would 400/404 instead of transitioning. Assert both are readable.
func TestStatusRouteBindsBothPathParams(t *testing.T) {
	var gotCode, gotID string
	r := chi.NewRouter()
	r.Post("/api/canvas/{code}/tasks/{id}/status", func(w http.ResponseWriter, req *http.Request) {
		gotCode = chi.URLParam(req, "code")
		gotID = chi.URLParam(req, "id")
		w.WriteHeader(http.StatusOK)
	})
	id := uuid.New()
	req := httptest.NewRequest("POST", statusURL(id), nil)
	r.ServeHTTP(httptest.NewRecorder(), req)
	if gotCode != statusCanvasCode || gotID != id.String() {
		t.Fatalf("bound code=%q id=%q, want %q / %q", gotCode, gotID, statusCanvasCode, id)
	}
}
