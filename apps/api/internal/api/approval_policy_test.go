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
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// ── policyApproval: the pure cascade rule ────────────────────────────────────

func TestPolicyApproval(t *testing.T) {
	approvedEpic := uuid.New()
	proposedEpic := uuid.New()
	epicApproved := func(id uuid.UUID) bool { return id == approvedEpic }

	payload := func(fields map[string]any) json.RawMessage {
		b, _ := json.Marshal(fields)
		return b
	}

	tests := []struct {
		name    string
		policy  string
		payload json.RawMessage
		want    string
	}{
		// strict: everything lands proposed.
		{"strict no epic", "strict", payload(map[string]any{"title": "t"}), ""},
		{"strict approved epic", "strict", payload(map[string]any{"title": "t", "epicId": approvedEpic.String()}), ""},

		// auto: everything born approved.
		{"auto no epic", "auto", payload(map[string]any{"title": "t"}), "policy:auto"},
		{"auto approved epic", "auto", payload(map[string]any{"title": "t", "epicId": approvedEpic.String()}), "policy:auto"},

		// epic (default): only tasks under an APPROVED epic flow.
		{"epic approved epic", "epic", payload(map[string]any{"title": "t", "epicId": approvedEpic.String()}), "policy:epic"},
		{"epic proposed epic", "epic", payload(map[string]any{"title": "t", "epicId": proposedEpic.String()}), ""},
		{"epic no epicId", "epic", payload(map[string]any{"title": "t"}), ""},
		{"epic malformed epicId", "epic", payload(map[string]any{"title": "t", "epicId": "not-a-uuid"}), ""},
		// Legacy canvases (column empty pre-migration) behave as the 'epic' default.
		{"empty policy = epic", "", payload(map[string]any{"title": "t", "epicId": approvedEpic.String()}), "policy:epic"},

		// requiresApproval:true forces proposed REGARDLESS of policy.
		{"auto requiresApproval", "auto", payload(map[string]any{"title": "t", "requiresApproval": true}), ""},
		{"epic requiresApproval", "epic", payload(map[string]any{"title": "t", "epicId": approvedEpic.String(), "requiresApproval": true}), ""},
		{"strict requiresApproval", "strict", payload(map[string]any{"title": "t", "requiresApproval": true}), ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := policyApproval(tc.policy, tc.payload, epicApproved); got != tc.want {
				t.Fatalf("policyApproval(%q) = %q, want %q", tc.policy, got, tc.want)
			}
		})
	}
}

// ── Handler-level cascade (fake store) ───────────────────────────────────────

// policyFakeStore stubs just the methods the action create/approve paths touch.
// Every other Store method panics via the embedded nil interface — a test
// reaching one is a test bug.
type policyFakeStore struct {
	store.Store
	policy  string
	actions map[uuid.UUID]*store.Action

	created []*store.Action
	// epic batch-approve call record
	epicMu         sync.Mutex // cascade now runs in a detached goroutine
	epicApprovedID uuid.UUID
	epicApprovedBy string
	epicCalls      int
	// epicTasks overrides what the cascade reports as flipped.
	epicTasks []*store.Action
}

func (f *policyFakeStore) GetCanvasByID(_ context.Context, id uuid.UUID) (*store.Canvas, error) {
	return &store.Canvas{ID: id, ApprovalPolicy: f.policy}, nil
}

func (f *policyFakeStore) GetAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, error) {
	if a, ok := f.actions[id]; ok {
		return a, nil
	}
	return nil, fmt.Errorf("action %s not found", id)
}

func (f *policyFakeStore) CreateAction(_ context.Context, _ uuid.UUID, a *store.Action) (int, error) {
	f.created = append(f.created, a)
	return 1, nil
}

func (f *policyFakeStore) CreateActions(_ context.Context, _ uuid.UUID, actions []*store.Action) (int, error) {
	f.created = append(f.created, actions...)
	return 1, nil
}

func (f *policyFakeStore) UpdateActionState(_ context.Context, _ uuid.UUID, id uuid.UUID, patch store.ActionStatePatch) (int, error) {
	if a, ok := f.actions[id]; ok {
		a.State = patch.State
		if patch.ApprovedBy != nil {
			a.ApprovedBy = patch.ApprovedBy
		}
	}
	return 1, nil
}


// epicCascade reads the cascade record under the lock.
func (f *policyFakeStore) epicCascade() (int, uuid.UUID, string) {
	f.epicMu.Lock()
	defer f.epicMu.Unlock()
	return f.epicCalls, f.epicApprovedID, f.epicApprovedBy
}

// waitEpicCalls polls until the detached cascade goroutine has run `want`
// times (or fails after 2s). For want-zero assertions use settleEpicCalls.
func waitEpicCalls(t *testing.T, f *policyFakeStore, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		calls, _, _ := f.epicCascade()
		if calls == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("ApproveEpicTasks called %d times, want %d", calls, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// settleEpicCalls gives the (possibly never-spawned) cascade goroutine a beat,
// then asserts the exact call count — the only way to check a negative.
func settleEpicCalls(t *testing.T, f *policyFakeStore, want int) {
	t.Helper()
	time.Sleep(100 * time.Millisecond)
	calls, _, _ := f.epicCascade()
	if calls != want {
		t.Fatalf("ApproveEpicTasks called %d times, want %d", calls, want)
	}
}

func (f *policyFakeStore) ReserveTaskTickets(_ context.Context, _ uuid.UUID, n int) (int, error) {
	// Tickets are orthogonal to the cascade under test; hand out a fixed range.
	return 1, nil
}

// ApproveActionsBatch mirrors the store semantics: only ids that exist AND are
// still 'proposed' flip; everything else is silently skipped. Returns the
// flipped rows so the handler can diff.
func (f *policyFakeStore) ApproveActionsBatch(_ context.Context, _ uuid.UUID, ids []uuid.UUID, approvedBy string) ([]*store.Action, error) {
	out := []*store.Action{}
	for _, id := range ids {
		a, ok := f.actions[id]
		if !ok || a.State != "proposed" {
			continue
		}
		a.State = "approved"
		stamp := approvedBy
		a.ApprovedBy = &stamp
		out = append(out, a)
	}
	return out, nil
}

// ApproveEpicTasks records the cascade call and returns the tasks that "flipped".
// epicTasks lets a test control that fan-out (the webhook tests assert one
// task.approved per returned task); unset, it returns a single synthetic task so
// the cascade still counts as having changed something.
func (f *policyFakeStore) ApproveEpicTasks(_ context.Context, _ uuid.UUID, epicID uuid.UUID, approvedBy string) ([]*store.Action, error) {
	f.epicMu.Lock()
	defer f.epicMu.Unlock()
	f.epicCalls++
	f.epicApprovedID = epicID
	f.epicApprovedBy = approvedBy
	if f.epicTasks != nil {
		return f.epicTasks, nil
	}
	return []*store.Action{{ID: uuid.New(), Type: "task", State: "approved",
		Payload: json.RawMessage(`{"title":"cascaded"}`)}}, nil
}

// GetCanvasState backs the async post-write broadcast; erroring makes it a no-op.
func (f *policyFakeStore) GetCanvasState(_ context.Context, _ uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in tests")
}

// TouchOrCreateAgent is the best-effort liveness heartbeat on claim/complete —
// irrelevant to the policy cascade under test.
func (f *policyFakeStore) TouchOrCreateAgent(_ context.Context, _ uuid.UUID, _ string) error {
	return nil
}

// canvasRequest builds a request carrying canvas JWT claims (and an optional
// chi {id} URL param) the way the middleware would.
func canvasRequest(t *testing.T, method, path string, body any, canvasID uuid.UUID, urlID string) *http.Request {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	ctx := context.WithValue(r.Context(), claimsKey, &auth.Claims{CanvasID: canvasID, Role: "write"})
	// In production every action route sits behind the Provenance middleware, and
	// the human board is the caller for approve / reject / born-approved. Stamp a
	// human author by default so these handler-level tests exercise the same
	// context (TDM-129 gates approval on AuthorFromCtx==human). Tests that need an
	// agent or anonymous caller override the author on the returned request.
	ctx = WithAuthor(ctx, AuthorHuman)
	if urlID != "" {
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", urlID)
		ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	}
	return r.WithContext(ctx)
}

func taskBody(payload map[string]any) map[string]any {
	return map[string]any{"type": "task", "payload": payload}
}

func TestProposeTaskApprovalCascade(t *testing.T) {
	canvasID := uuid.New()
	approvedEpic := uuid.New()
	proposedEpic := uuid.New()
	epics := map[uuid.UUID]*store.Action{
		approvedEpic: {ID: approvedEpic, Type: "epic", State: "approved"},
		proposedEpic: {ID: proposedEpic, Type: "epic", State: "proposed"},
	}

	tests := []struct {
		name           string
		policy         string
		payload        map[string]any
		wantState      string
		wantApprovedBy string // "" = nil
	}{
		{"strict lands proposed", "strict", map[string]any{"title": "t"}, "proposed", ""},
		{"strict ignores approved epic", "strict", map[string]any{"title": "t", "epicId": approvedEpic.String()}, "proposed", ""},
		{"auto born approved", "auto", map[string]any{"title": "t"}, "approved", "policy:auto"},
		{"epic under approved epic", "epic", map[string]any{"title": "t", "epicId": approvedEpic.String()}, "approved", "policy:epic"},
		{"epic under proposed epic", "epic", map[string]any{"title": "t", "epicId": proposedEpic.String()}, "proposed", ""},
		{"epic without epicId", "epic", map[string]any{"title": "t"}, "proposed", ""},
		{"requiresApproval overrides auto", "auto", map[string]any{"title": "t", "requiresApproval": true}, "proposed", ""},
		{"requiresApproval overrides epic", "epic", map[string]any{"title": "t", "epicId": approvedEpic.String(), "requiresApproval": true}, "proposed", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fake := &policyFakeStore{policy: tc.policy, actions: epics}
			h := NewHandler(fake, nil, nil)
			w := httptest.NewRecorder()
			h.ProposeAction(w, canvasRequest(t, "POST", "/api/canvas/actions", taskBody(tc.payload), canvasID, ""))
			if w.Code != http.StatusCreated {
				t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
			}
			if len(fake.created) != 1 {
				t.Fatalf("created %d actions, want 1", len(fake.created))
			}
			got := fake.created[0]
			if got.State != tc.wantState {
				t.Fatalf("state = %q, want %q", got.State, tc.wantState)
			}
			switch {
			case tc.wantApprovedBy == "" && got.ApprovedBy != nil:
				t.Fatalf("approvedBy = %q, want nil", *got.ApprovedBy)
			case tc.wantApprovedBy != "" && (got.ApprovedBy == nil || *got.ApprovedBy != tc.wantApprovedBy):
				t.Fatalf("approvedBy = %v, want %q", got.ApprovedBy, tc.wantApprovedBy)
			}
		})
	}
}

// The batch path applies the same cascade per item (one resolver for the batch).
func TestProposeTasksBatchApprovalCascade(t *testing.T) {
	canvasID := uuid.New()
	approvedEpic := uuid.New()
	fake := &policyFakeStore{
		policy:  "epic",
		actions: map[uuid.UUID]*store.Action{approvedEpic: {ID: approvedEpic, Type: "epic", State: "approved"}},
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	body := map[string]any{"actions": []map[string]any{
		taskBody(map[string]any{"title": "flows", "epicId": approvedEpic.String()}),
		taskBody(map[string]any{"title": "gated"}),
		taskBody(map[string]any{"title": "self-flagged", "epicId": approvedEpic.String(), "requiresApproval": true}),
	}}
	h.ProposeActionsBatch(w, canvasRequest(t, "POST", "/api/canvas/actions/batch", body, canvasID, ""))
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	if len(fake.created) != 3 {
		t.Fatalf("created %d actions, want 3", len(fake.created))
	}
	wantStates := []string{"approved", "proposed", "proposed"}
	for i, want := range wantStates {
		if fake.created[i].State != want {
			t.Fatalf("task %d state = %q, want %q", i, fake.created[i].State, want)
		}
	}
	if got := fake.created[0].ApprovedBy; got == nil || *got != "policy:epic" {
		t.Fatalf("task 0 approvedBy = %v, want policy:epic", got)
	}
}

// Approving an epic batch-approves its currently-proposed tasks in one bulk
// update, stamped 'policy:epic'.
func TestApproveEpicBatchApprovesTasks(t *testing.T) {
	canvasID := uuid.New()
	epicID := uuid.New()
	fake := &policyFakeStore{
		policy:  "epic",
		actions: map[uuid.UUID]*store.Action{epicID: {ID: epicID, Type: "epic", State: "proposed"}},
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ApproveAction(w, canvasRequest(t, "POST", "/api/canvas/actions/"+epicID.String()+"/approve",
		map[string]any{"approvedBy": "human"}, canvasID, epicID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	waitEpicCalls(t, fake, 1)
	_, gotID, gotBy := fake.epicCascade()
	if gotID != epicID {
		t.Fatalf("cascade targeted epic %s, want %s", gotID, epicID)
	}
	if gotBy != "policy:epic" {
		t.Fatalf("cascade stamped %q, want policy:epic", gotBy)
	}
}

// Approving a plain TASK must not trigger the epic cascade.
func TestApproveTaskDoesNotCascade(t *testing.T) {
	canvasID := uuid.New()
	taskID := uuid.New()
	fake := &policyFakeStore{
		policy:  "epic",
		actions: map[uuid.UUID]*store.Action{taskID: {ID: taskID, Type: "task", State: "proposed"}},
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ApproveAction(w, canvasRequest(t, "POST", "/api/canvas/actions/"+taskID.String()+"/approve",
		map[string]any{}, canvasID, taskID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	settleEpicCalls(t, fake, 0)
}

// Under 'strict' policy the epic cascade must NOT fire: approving an epic is
// bookkeeping, every task keeps its individual human gate.
func TestApproveEpicStrictPolicySkipsCascade(t *testing.T) {
	canvasID := uuid.New()
	epicID := uuid.New()
	fake := &policyFakeStore{
		policy:  "strict",
		actions: map[uuid.UUID]*store.Action{epicID: {ID: epicID, Type: "epic", State: "proposed"}},
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ApproveAction(w, canvasRequest(t, "POST", "/api/canvas/actions/"+epicID.String()+"/approve",
		map[string]any{"approvedBy": "human"}, canvasID, epicID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	settleEpicCalls(t, fake, 0)
}

// Re-approving an already-approved epic re-fires the (idempotent) cascade, so a
// transiently-failed batch approve is repairable by clicking Approve again
// instead of stranding the tasks in proposed forever.
func TestApproveEpicRetryRefiresCascade(t *testing.T) {
	canvasID := uuid.New()
	epicID := uuid.New()
	fake := &policyFakeStore{
		policy:  "epic",
		actions: map[uuid.UUID]*store.Action{epicID: {ID: epicID, Type: "epic", State: "proposed"}},
	}
	h := NewHandler(fake, nil, nil)
	for i := 1; i <= 2; i++ {
		w := httptest.NewRecorder()
		h.ApproveAction(w, canvasRequest(t, "POST", "/api/canvas/actions/"+epicID.String()+"/approve",
			map[string]any{"approvedBy": "human"}, canvasID, epicID.String()))
		if w.Code != http.StatusOK {
			t.Fatalf("approve #%d: status = %d, body %s", i, w.Code, w.Body.String())
		}
	}
	waitEpicCalls(t, fake, 2)
}

// ── Bulk approve (POST /api/canvas/actions/approve-batch) ────────────────────

func approveBatchResponse(t *testing.T, w *httptest.ResponseRecorder) (approved, skipped []uuid.UUID) {
	t.Helper()
	var resp struct {
		Approved []uuid.UUID `json:"approved"`
		Skipped  []uuid.UUID `json:"skipped"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response %q: %v", w.Body.String(), err)
	}
	return resp.Approved, resp.Skipped
}

// The bulk endpoint approves only rows still in 'proposed' and reports every
// other requested id (already moved on, or missing entirely) as skipped.
func TestApproveBatchApprovesOnlyProposed(t *testing.T) {
	canvasID := uuid.New()
	proposedA := uuid.New()
	proposedB := uuid.New()
	alreadyApproved := uuid.New()
	doneTask := uuid.New()
	missing := uuid.New()
	fake := &policyFakeStore{
		policy: "epic",
		actions: map[uuid.UUID]*store.Action{
			proposedA:       {ID: proposedA, Type: "task", State: "proposed"},
			proposedB:       {ID: proposedB, Type: "task", State: "proposed"},
			alreadyApproved: {ID: alreadyApproved, Type: "task", State: "approved"},
			doneTask:        {ID: doneTask, Type: "task", State: "done"},
		},
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ApproveActionsBatch(w, canvasRequest(t, "POST", "/api/canvas/actions/approve-batch",
		map[string]any{"ids": []string{
			proposedA.String(), proposedB.String(), alreadyApproved.String(), doneTask.String(), missing.String(),
		}}, canvasID, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	approved, skipped := approveBatchResponse(t, w)
	if len(approved) != 2 || approved[0] != proposedA || approved[1] != proposedB {
		t.Fatalf("approved = %v, want [%s %s]", approved, proposedA, proposedB)
	}
	if len(skipped) != 3 {
		t.Fatalf("skipped = %v, want the 3 non-proposed/missing ids", skipped)
	}
	wantSkipped := map[uuid.UUID]bool{alreadyApproved: true, doneTask: true, missing: true}
	for _, id := range skipped {
		if !wantSkipped[id] {
			t.Fatalf("unexpected skipped id %s", id)
		}
	}
	for _, id := range []uuid.UUID{proposedA, proposedB} {
		got := fake.actions[id]
		if got.State != "approved" {
			t.Fatalf("task %s state = %q, want approved", id, got.State)
		}
		if got.ApprovedBy == nil || *got.ApprovedBy != "human" {
			t.Fatalf("task %s approvedBy = %v, want human (the default)", id, got.ApprovedBy)
		}
	}
	if fake.actions[doneTask].State != "done" {
		t.Fatalf("done task mutated to %q", fake.actions[doneTask].State)
	}
	settleEpicCalls(t, fake, 0)
}

// An epic approved via the batch runs the same post-approve cascade as the
// single-approve path under the 'epic' policy.
func TestApproveBatchEpicCascadesUnderEpicPolicy(t *testing.T) {
	canvasID := uuid.New()
	epicID := uuid.New()
	taskID := uuid.New()
	fake := &policyFakeStore{
		policy: "epic",
		actions: map[uuid.UUID]*store.Action{
			epicID: {ID: epicID, Type: "epic", State: "proposed"},
			taskID: {ID: taskID, Type: "task", State: "proposed"},
		},
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ApproveActionsBatch(w, canvasRequest(t, "POST", "/api/canvas/actions/approve-batch",
		map[string]any{"ids": []string{epicID.String(), taskID.String()}}, canvasID, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	approved, skipped := approveBatchResponse(t, w)
	if len(approved) != 2 || len(skipped) != 0 {
		t.Fatalf("approved/skipped = %v / %v, want both ids approved", approved, skipped)
	}
	// approvedBy is stamped from server-derived provenance (human), never from the
	// request body (TDM-129) — canvasRequest stamps a human author.
	if got := fake.actions[epicID].ApprovedBy; got == nil || *got != AuthorHuman {
		t.Fatalf("epic approvedBy = %v, want %q", got, AuthorHuman)
	}
	waitEpicCalls(t, fake, 1)
	_, gotID, gotBy := fake.epicCascade()
	if gotID != epicID {
		t.Fatalf("cascade targeted epic %s, want %s", gotID, epicID)
	}
	if gotBy != "policy:epic" {
		t.Fatalf("cascade stamped %q, want policy:epic", gotBy)
	}
}

// Under 'strict' policy the batch approves the epic row itself but must NOT
// cascade to its tasks — each keeps its individual human gate.
func TestApproveBatchEpicStrictPolicySkipsCascade(t *testing.T) {
	canvasID := uuid.New()
	epicID := uuid.New()
	fake := &policyFakeStore{
		policy:  "strict",
		actions: map[uuid.UUID]*store.Action{epicID: {ID: epicID, Type: "epic", State: "proposed"}},
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ApproveActionsBatch(w, canvasRequest(t, "POST", "/api/canvas/actions/approve-batch",
		map[string]any{"ids": []string{epicID.String()}}, canvasID, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	approved, skipped := approveBatchResponse(t, w)
	if len(approved) != 1 || approved[0] != epicID || len(skipped) != 0 {
		t.Fatalf("approved/skipped = %v / %v, want just the epic approved", approved, skipped)
	}
	if fake.actions[epicID].State != "approved" {
		t.Fatalf("epic state = %q, want approved (strict blocks the cascade, not the approve)", fake.actions[epicID].State)
	}
	settleEpicCalls(t, fake, 0)
}

// An empty ids list is a 400, and a duplicate skipped id reports once.
func TestApproveBatchValidation(t *testing.T) {
	canvasID := uuid.New()
	missing := uuid.New()
	fake := &policyFakeStore{policy: "epic", actions: map[uuid.UUID]*store.Action{}}
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ApproveActionsBatch(w, canvasRequest(t, "POST", "/api/canvas/actions/approve-batch",
		map[string]any{"ids": []string{}}, canvasID, ""))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty ids: status = %d, want 400", w.Code)
	}

	w = httptest.NewRecorder()
	h.ApproveActionsBatch(w, canvasRequest(t, "POST", "/api/canvas/actions/approve-batch",
		map[string]any{"ids": []string{missing.String(), missing.String()}}, canvasID, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	approved, skipped := approveBatchResponse(t, w)
	if len(approved) != 0 || len(skipped) != 1 || skipped[0] != missing {
		t.Fatalf("approved/skipped = %v / %v, want one deduped skipped id", approved, skipped)
	}
}

// A terminal transition (done/failed) from a NAMED agent that does not hold the
// claim is rejected 409 — the claim buys exclusivity at finish, not just start.
func TestCompleteRespectsClaim(t *testing.T) {
	canvasID := uuid.New()
	taskID := uuid.New()
	holder := "session-A"
	fake := &policyFakeStore{
		policy: "epic",
		actions: map[uuid.UUID]*store.Action{
			taskID: {ID: taskID, Type: "task", State: "executing", ClaimedBy: &holder},
		},
	}
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.UpdateActionState(w, canvasRequest(t, "PATCH", "/api/canvas/actions/"+taskID.String(),
		map[string]any{"state": "done", "result": "stolen", "agentName": "session-B"}, canvasID, taskID.String()))
	if w.Code != http.StatusConflict {
		t.Fatalf("rival complete: status = %d, want 409 (body %s)", w.Code, w.Body.String())
	}
	if fake.actions[taskID].State != "executing" {
		t.Fatalf("rival complete mutated state to %q", fake.actions[taskID].State)
	}

	w = httptest.NewRecorder()
	h.UpdateActionState(w, canvasRequest(t, "PATCH", "/api/canvas/actions/"+taskID.String(),
		map[string]any{"state": "done", "result": "mine", "agentName": "session-A"}, canvasID, taskID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("holder complete: status = %d, body %s", w.Code, w.Body.String())
	}
	if fake.actions[taskID].State != "done" {
		t.Fatalf("holder complete left state %q, want done", fake.actions[taskID].State)
	}
}

// epicId is canonicalized at creation (the cascade and gateway filter match on
// stored text); malformed ids are rejected instead of silently orphaning the task.
func TestEpicIdCanonicalizedOnCreate(t *testing.T) {
	canvasID := uuid.New()
	epicID := uuid.New()
	fake := &policyFakeStore{policy: "strict", actions: map[uuid.UUID]*store.Action{}}
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	upper := strings.ToUpper(epicID.String())
	h.ProposeAction(w, canvasRequest(t, "POST", "/api/canvas/actions",
		taskBody(map[string]any{"title": "t", "epicId": upper}), canvasID, ""))
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	var p struct {
		EpicID string `json:"epicId"`
	}
	if err := json.Unmarshal(fake.created[0].Payload, &p); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if p.EpicID != epicID.String() {
		t.Fatalf("stored epicId = %q, want canonical %q", p.EpicID, epicID.String())
	}

	w = httptest.NewRecorder()
	h.ProposeAction(w, canvasRequest(t, "POST", "/api/canvas/actions",
		taskBody(map[string]any{"title": "t", "epicId": "not-a-uuid"}), canvasID, ""))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("malformed epicId: status = %d, want 400", w.Code)
	}
}
