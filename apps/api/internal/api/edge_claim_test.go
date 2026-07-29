package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// TDM-65 / E9.5 — the edge-claim path, end to end at the HTTP layer.
//
// E9's contract is that WORKERS claim their own tasks under their own
// identities and an orchestrator only dispatches. Every piece of that has unit
// coverage somewhere (the store's atomic claim in store/claim_test.go, the
// roster join in fleet_handler_test.go, registration in agent_register_test.go)
// — but the sequence a real fleet actually walks has never been asserted as one
// path. These tests walk it: two workers race one task, the loser is handed
// DATA and takes different work, the winner completes under its own identity
// without tripping the holder guard, a rival cannot finish work it does not
// hold, and a planner that claimed nothing still sees the whole tree.
//
// The store fake below implements the REAL claim decision (winner / idempotent
// self / loser), because a fake whose ClaimAction always succeeds — as the
// other fakes in this package deliberately have — cannot express the loser
// path that is half of this contract.

type edgeClaimFakeStore struct {
	store.Store
	mu         sync.Mutex
	actions    map[uuid.UUID]*store.Action
	registered []*store.Agent
	seeded     map[uuid.UUID]*store.Agent // pre-existing rows for GetAgent
}

func newEdgeClaimStore(tasks ...*store.Action) *edgeClaimFakeStore {
	f := &edgeClaimFakeStore{actions: map[uuid.UUID]*store.Action{}, seeded: map[uuid.UUID]*store.Agent{}}
	for _, a := range tasks {
		f.actions[a.ID] = a
	}
	return f
}

// readyTask is a ready-to-claim row: what the queue hands a worker.
func readyTask(ticket int, title string) *store.Action {
	return &store.Action{
		ID: uuid.New(), Type: "task", State: "approved", Ticket: ptr(ticket),
		Payload: taskPayload(title), ProposedBy: "planner-1", ApprovedBy: ptr("human"),
	}
}

// ClaimAction models the conditional UPDATE in supabaseStore: an approved task
// is claimed, an executing one is idempotent for its own holder (and for the
// generic "agent") and refused to anyone else, and any other state is illegal.
// Returns a COPY so the handler never reads a row a concurrent claim is writing.
func (f *edgeClaimFakeStore) ClaimAction(_ context.Context, _ uuid.UUID, id uuid.UUID, claimedBy string) (*store.Action, store.ClaimOutcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ClaimOutcome{}, store.ErrActionNotFound
	}
	switch a.State {
	case "approved":
	case "executing":
		holder := ""
		if a.ClaimedBy != nil {
			holder = *a.ClaimedBy
		}
		if holder != "" && holder != "agent" && holder != claimedBy {
			return nil, store.ClaimOutcome{}, &store.AlreadyClaimedError{ClaimedBy: holder}
		}
	default:
		return nil, store.ClaimOutcome{}, store.ErrIllegalActionState
	}
	now := time.Now().UTC()
	a.State, a.ClaimedBy, a.ClaimedAt = "executing", &claimedBy, &now
	cp := *a
	return &cp, store.ClaimOutcome{Version: 1}, nil
}

func (f *edgeClaimFakeStore) GetAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, fmt.Errorf("action %s not found", id)
	}
	cp := *a
	return &cp, nil
}

func (f *edgeClaimFakeStore) UpdateActionState(_ context.Context, _ uuid.UUID, id uuid.UUID, patch store.ActionStatePatch) (int, error) {
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
	return 1, nil
}

func (f *edgeClaimFakeStore) ListActions(_ context.Context, _ uuid.UUID, stateFilter, typeFilter, _ string) ([]*store.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []*store.Action{}
	for _, a := range f.actions {
		if stateFilter != "" && a.State != stateFilter {
			continue
		}
		if typeFilter != "" && a.Type != typeFilter {
			continue
		}
		cp := *a
		out = append(out, &cp)
	}
	return out, nil
}

func (f *edgeClaimFakeStore) RegisterAgent(_ context.Context, _ uuid.UUID, a *store.Agent) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, existing := range f.registered {
		if existing.Name == a.Name {
			a.ID = existing.ID
			*existing = *a
			return 1, nil
		}
	}
	a.ID = uuid.New()
	if a.CreatedAt.IsZero() {
		a.CreatedAt = time.Now().UTC()
	}
	f.registered = append(f.registered, a)
	return 1, nil
}

func (f *edgeClaimFakeStore) GetAgent(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Agent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if a, ok := f.seeded[id]; ok {
		return a, nil
	}
	for _, a := range f.registered {
		if a.ID == id {
			return a, nil
		}
	}
	return nil, fmt.Errorf("agent %s not found", id)
}

func (f *edgeClaimFakeStore) ListAgents(context.Context, uuid.UUID) ([]*store.Agent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*store.Agent, 0, len(f.registered))
	for _, a := range f.registered {
		cp := *a
		out = append(out, &cp)
	}
	return out, nil
}

// TouchOrCreateAgent is the claim path's detached liveness heartbeat: a known
// name is refreshed, an unknown one gets a minimal executor row (which is what
// puts an unregistered claimant on the board at all).
func (f *edgeClaimFakeStore) TouchOrCreateAgent(_ context.Context, _ uuid.UUID, claimant string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if claimant == "" || claimant == "agent" {
		return nil
	}
	if _, err := uuid.Parse(claimant); err == nil {
		return nil
	}
	for _, a := range f.registered {
		if a.Name == claimant {
			a.Status, a.LastSeenAt = "online", time.Now().UTC()
			return nil
		}
	}
	f.registered = append(f.registered, &store.Agent{
		ID: uuid.New(), Kind: "agent", Name: claimant, Role: "executor",
		Status: "online", CreatedAt: time.Now().UTC(), LastSeenAt: time.Now().UTC(),
	})
	return nil
}

// GetCanvasState backs the async post-write broadcast; erroring makes it a no-op.
func (f *edgeClaimFakeStore) GetCanvasState(context.Context, uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in tests")
}

// stateOf reads a task's stored state/holder under the lock — the detached
// liveness goroutines run concurrently with assertions.
func (f *edgeClaimFakeStore) stateOf(id uuid.UUID) (state, holder string, result *string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a := f.actions[id]
	if a.ClaimedBy != nil {
		holder = *a.ClaimedBy
	}
	return a.State, holder, a.Result
}

// patchTask drives the one endpoint every claim and completion goes through:
// PATCH /api/canvas/actions/{id} with an agentName — task_start when state is
// "executing", task_complete when it's terminal.
func patchTask(t *testing.T, h *Handler, canvasID, taskID uuid.UUID, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.UpdateActionState(w, canvasRequest(t, "PATCH", "/api/canvas/actions/"+taskID.String(), body, canvasID, taskID.String()))
	return w
}

func decodeMap(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal %s: %v", w.Body.String(), err)
	}
	return got
}

// ── (1) The loser path is DATA, and the loser goes on to do other work ────────

// The branch every dispatch recipe tells a subagent to take: worker B loses the
// race for a task, is told WHO holds it, and claims a different ready task
// instead. If the loss were anything but a clean 409-with-holder the subagent
// would either retry forever or die — and the winner's task would still be at
// risk of a second executor.
func TestRivalClaimLosesCleanlyThenTakesAnotherTask(t *testing.T) {
	canvasID := uuid.New()
	mine, other := readyTask(101, "E9.5 the contested task"), readyTask(102, "E9.5 the next ready task")
	fake := newEdgeClaimStore(mine, other)
	h := NewHandler(fake, nil, nil)

	if w := patchTask(t, h, canvasID, mine.ID, map[string]any{"state": "executing", "agentName": "worker-a"}); w.Code != http.StatusOK {
		t.Fatalf("worker-a claim status = %d, body %s", w.Code, w.Body.String())
	}

	// Worker B, arriving second, must be REFUSED — with the holder's name.
	w := patchTask(t, h, canvasID, mine.ID, map[string]any{"state": "executing", "agentName": "worker-b"})
	if w.Code != http.StatusConflict {
		t.Fatalf("rival claim status = %d, want 409; body %s", w.Code, w.Body.String())
	}
	got := decodeMap(t, w)
	if got["error"] != "already_claimed" || got["claimedBy"] != "worker-a" {
		t.Fatalf("loser payload = %v, want already_claimed by worker-a", got)
	}

	// The loss changed nothing about the winner's claim.
	if state, holder, _ := fake.stateOf(mine.ID); state != "executing" || holder != "worker-a" {
		t.Fatalf("contested task = %s / %s, want executing / worker-a", state, holder)
	}

	// …and the fallback branch works: B takes the next ready task.
	if w := patchTask(t, h, canvasID, other.ID, map[string]any{"state": "executing", "agentName": "worker-b"}); w.Code != http.StatusOK {
		t.Fatalf("worker-b fallback claim status = %d, body %s", w.Code, w.Body.String())
	}
	if state, holder, _ := fake.stateOf(other.ID); state != "executing" || holder != "worker-b" {
		t.Fatalf("fallback task = %s / %s, want executing / worker-b", state, holder)
	}
}

// The same race run CONCURRENTLY, since that is how two dispatched subagents
// actually hit the queue: exactly one 200, exactly one 409, and the 409 names
// whoever won.
func TestConcurrentWorkerClaimsProduceOneWinner(t *testing.T) {
	canvasID := uuid.New()
	task := readyTask(103, "E9.5 the concurrently contested task")
	fake := newEdgeClaimStore(task)
	h := NewHandler(fake, nil, nil)

	names := []string{"worker-a", "worker-b"}
	codes := make([]int, len(names))
	bodies := make([]map[string]any, len(names))
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i, name := range names {
		wg.Add(1)
		go func(i int, name string) {
			defer wg.Done()
			<-start
			w := patchTask(t, h, canvasID, task.ID, map[string]any{"state": "executing", "agentName": name})
			codes[i], bodies[i] = w.Code, decodeMap(t, w)
		}(i, name)
	}
	close(start)
	wg.Wait()

	winner, loser := -1, -1
	for i, code := range codes {
		switch code {
		case http.StatusOK:
			winner = i
		case http.StatusConflict:
			loser = i
		default:
			t.Fatalf("%s got status %d, want 200 or 409", names[i], code)
		}
	}
	if winner < 0 || loser < 0 {
		t.Fatalf("codes = %v, want exactly one 200 and one 409", codes)
	}
	if bodies[loser]["claimedBy"] != names[winner] {
		t.Fatalf("loser told claimedBy=%v, want the winner %q", bodies[loser]["claimedBy"], names[winner])
	}
	if _, holder, _ := fake.stateOf(task.ID); holder != names[winner] {
		t.Fatalf("stored claimedBy = %q, want %q", holder, names[winner])
	}
}

// ── (2) Self-complete: the holder guard must not fire on the holder ───────────

// The whole reason E9 pushes claiming down to the worker: the agent that claims
// is the agent that finishes, so completing under its OWN identity has to sail
// straight through the claimed_by_other guard. If this ever 409s, every worker
// in the fleet strands its task in 'executing'.
func TestHolderCompletesItsOwnClaimWithoutConflict(t *testing.T) {
	canvasID := uuid.New()
	task := readyTask(104, "E9.5 claim then finish")
	fake := newEdgeClaimStore(task)
	h := NewHandler(fake, nil, nil)

	if w := patchTask(t, h, canvasID, task.ID, map[string]any{"state": "executing", "agentName": "worker-a"}); w.Code != http.StatusOK {
		t.Fatalf("claim status = %d, body %s", w.Code, w.Body.String())
	}
	w := patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "result": "tests added, all green",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("self-complete status = %d, want 200; body %s", w.Code, w.Body.String())
	}
	state, holder, result := fake.stateOf(task.ID)
	if state != "done" {
		t.Fatalf("task state = %q, want done", state)
	}
	if holder != "worker-a" {
		t.Fatalf("claimedBy = %q after self-complete, want worker-a", holder)
	}
	if result == nil || *result != "tests added, all green" {
		t.Fatalf("result = %v, want the completion summary", result)
	}
}

// Failing your own task is the same path — a worker that reports failure must
// not be blocked by the guard either, or a failed run stays 'executing' forever.
func TestHolderFailsItsOwnClaimWithoutConflict(t *testing.T) {
	canvasID := uuid.New()
	task := readyTask(105, "E9.5 claim then fail")
	fake := newEdgeClaimStore(task)
	h := NewHandler(fake, nil, nil)

	if w := patchTask(t, h, canvasID, task.ID, map[string]any{"state": "executing", "agentName": "worker-a"}); w.Code != http.StatusOK {
		t.Fatalf("claim status = %d, body %s", w.Code, w.Body.String())
	}
	w := patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "failed", "agentName": "worker-a", "error": "build broke",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("self-fail status = %d, want 200; body %s", w.Code, w.Body.String())
	}
	if state, _, _ := fake.stateOf(task.ID); state != "failed" {
		t.Fatalf("task state = %q, want failed", state)
	}
}

// ── (3) Regression: nobody finishes work they don't hold ──────────────────────

// THE bug this epic exists to fix. Before E9 an orchestrator claimed on a
// worker's behalf and the worker (or another worker) completed — so a task
// could be closed by a session that never did it. The atomic claim alone buys
// exclusivity at START and nothing at FINISH; this guard is the other half.
func TestRivalCannotCompleteAClaimItDoesNotHold(t *testing.T) {
	for _, terminal := range []string{"done", "failed"} {
		t.Run(terminal, func(t *testing.T) {
			canvasID := uuid.New()
			task := readyTask(106, "E9.5 held by worker-a")
			fake := newEdgeClaimStore(task)
			h := NewHandler(fake, nil, nil)

			if w := patchTask(t, h, canvasID, task.ID, map[string]any{"state": "executing", "agentName": "worker-a"}); w.Code != http.StatusOK {
				t.Fatalf("claim status = %d, body %s", w.Code, w.Body.String())
			}
			w := patchTask(t, h, canvasID, task.ID, map[string]any{
				"state": terminal, "agentName": "worker-b", "result": "I did not do this",
			})
			if w.Code != http.StatusConflict {
				t.Fatalf("rival %s status = %d, want 409; body %s", terminal, w.Code, w.Body.String())
			}
			got := decodeMap(t, w)
			if got["error"] != "claimed_by_other" || got["claimedBy"] != "worker-a" {
				t.Fatalf("rival completion payload = %v, want claimed_by_other by worker-a", got)
			}
			// The refusal must be total: no state change, no result written.
			state, holder, result := fake.stateOf(task.ID)
			if state != "executing" || holder != "worker-a" {
				t.Fatalf("task = %s / %s after a refused completion, want executing / worker-a", state, holder)
			}
			if result != nil {
				t.Fatalf("refused completion still wrote result %q", *result)
			}
		})
	}
}

// The guard keys on the CLAIMANT IDENTITY, not on registration: an anonymous
// gateway session (session-xxxxxx, the fallback claimant a worker that never
// registered presents) is protected exactly like a named executor. Otherwise
// the protection would silently depend on whether the subagent remembered to
// register.
func TestGuardProtectsAnonymousSessionClaimants(t *testing.T) {
	canvasID := uuid.New()
	task := readyTask(107, "E9.5 held by an unregistered session")
	fake := newEdgeClaimStore(task)
	h := NewHandler(fake, nil, nil)

	if w := patchTask(t, h, canvasID, task.ID, map[string]any{"state": "executing", "agentName": "session-a1b2c3"}); w.Code != http.StatusOK {
		t.Fatalf("claim status = %d, body %s", w.Code, w.Body.String())
	}
	w := patchTask(t, h, canvasID, task.ID, map[string]any{"state": "done", "agentName": "session-d4e5f6"})
	if w.Code != http.StatusConflict {
		t.Fatalf("rival session completion status = %d, want 409; body %s", w.Code, w.Body.String())
	}
	if got := decodeMap(t, w); got["claimedBy"] != "session-a1b2c3" {
		t.Fatalf("conflict names %v, want the holding session", got["claimedBy"])
	}
	// The SAME session finishes fine — the guard is about identity, not names
	// that look official.
	if w := patchTask(t, h, canvasID, task.ID, map[string]any{"state": "done", "agentName": "session-a1b2c3"}); w.Code != http.StatusOK {
		t.Fatalf("self-complete by the holding session = %d, body %s", w.Code, w.Body.String())
	}
}

// ── (4) Fleet visibility: the planner sees a fleet it never claimed for ───────

// A planner that only dispatched — never claimed, never completed — must still
// see both workers AND the work they hold, grouped under itself. That grouping
// is the only thing that makes a fan-out legible on the board, and it comes
// entirely from E9.1's connect-and-register (parentAgentId) plus the roster's
// claimedBy join. If either half slipped, the board would show two orphan
// executors and an idle planner.
func TestPlannerSeesItsWorkersAndTheirTasksInTheRoster(t *testing.T) {
	canvasID := uuid.New()
	taskA, taskB := readyTask(108, "E9.5 worker-a's task"), readyTask(109, "E9.5 worker-b's task")
	unclaimed := readyTask(110, "E9.5 still in the queue")
	fake := newEdgeClaimStore(taskA, taskB, unclaimed)
	h := NewHandler(fake, nil, nil)

	// The planner comes up first; the workers register UNDER it, exactly as
	// canvas_connect(role:"executor", parentAgentId:<planner>) does.
	plannerID := registerResponse(t, h, canvasID, map[string]any{"name": "planner-1", "role": "planner"})
	for _, name := range []string{"worker-a", "worker-b"} {
		registerResponse(t, h, canvasID, map[string]any{
			"name": name, "role": "executor", "model": "claude-opus-5", "parentAgentId": plannerID,
		})
	}

	// Each worker claims its OWN task. The planner claims nothing.
	for _, c := range []struct {
		name string
		task *store.Action
	}{{"worker-a", taskA}, {"worker-b", taskB}} {
		if w := patchTask(t, h, canvasID, c.task.ID, map[string]any{"state": "executing", "agentName": c.name}); w.Code != http.StatusOK {
			t.Fatalf("%s claim status = %d, body %s", c.name, w.Code, w.Body.String())
		}
	}

	w := httptest.NewRecorder()
	h.ListAgentRoster(w, canvasRequest(t, "GET", "/api/canvas/agents", nil, canvasID, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("roster status = %d, body %s", w.Code, w.Body.String())
	}
	var roster rosterMsg
	if err := json.Unmarshal(w.Body.Bytes(), &roster); err != nil {
		t.Fatalf("unmarshal roster: %v", err)
	}

	byName := map[string]*rosterAgent{}
	for _, a := range roster.Agents {
		byName[a.Name] = a
	}
	if len(byName) != 3 {
		t.Fatalf("roster = %d agents (%v), want planner-1 + 2 workers", len(byName), byName)
	}

	planner, ok := byName["planner-1"]
	if !ok {
		t.Fatalf("the dispatching planner is missing from the roster: %v", byName)
	}
	if !planner.Registered || planner.Role != "planner" {
		t.Fatalf("planner entry = %+v, want a registered planner", planner)
	}
	if len(planner.Tasks) != 0 {
		t.Fatalf("planner holds %+v — it dispatched, it never claimed", planner.Tasks)
	}

	for _, c := range []struct{ name, ticket, title string }{
		{"worker-a", "TDM-108", "E9.5 worker-a's task"},
		{"worker-b", "TDM-109", "E9.5 worker-b's task"},
	} {
		got, ok := byName[c.name]
		if !ok {
			t.Fatalf("%s missing from the roster: %v", c.name, byName)
		}
		if !got.Registered {
			t.Fatalf("%s reported unregistered — the claim detached from its agent row", c.name)
		}
		if got.ParentAgentID != plannerID {
			t.Fatalf("%s parentAgentId = %q, want the planner %q", c.name, got.ParentAgentID, plannerID)
		}
		if len(got.Tasks) != 1 || got.Tasks[0].TicketID != c.ticket || got.Tasks[0].Title != c.title {
			t.Fatalf("%s tasks = %+v, want just %s", c.name, got.Tasks, c.ticket)
		}
		if got.Tasks[0].State != "executing" {
			t.Fatalf("%s task state = %q, want executing", c.name, got.Tasks[0].State)
		}
	}

	if roster.Counts.Registered != 3 || roster.Counts.Unregistered != 0 {
		t.Fatalf("counts = %+v, want 3 registered / 0 unregistered", roster.Counts)
	}
	if roster.Counts.Working != 2 || roster.Counts.Idle != 1 || roster.Counts.Claims != 2 {
		t.Fatalf("counts = %+v, want 2 working / 1 idle (the planner) / 2 claims", roster.Counts)
	}
	// The task nobody took must not be attributed to anyone.
	if state, holder, _ := fake.stateOf(unclaimed.ID); state != "approved" || holder != "" {
		t.Fatalf("unclaimed task = %s / %q, want approved and unheld", state, holder)
	}
}
