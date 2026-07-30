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

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/ws"
	"github.com/google/uuid"
)

// fleetFakeStore backs the roster + activity reads and the transitions that
// ping the live feed. Everything else panics via the embedded nil interface.
type fleetFakeStore struct {
	store.Store
	mu      sync.Mutex
	agents  []*store.Agent
	actions []*store.Action
	canvas  *store.Canvas
	ticket  int
}

func (f *fleetFakeStore) ListAgents(context.Context, uuid.UUID) ([]*store.Agent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*store.Agent(nil), f.agents...), nil
}

// ListActions applies the state/type filters the handlers use; assignee is
// unused by the fleet reads.
func (f *fleetFakeStore) ListActions(_ context.Context, _ uuid.UUID, stateFilter, typeFilter, _ string) ([]*store.Action, error) {
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
		out = append(out, a)
	}
	return out, nil
}

func (f *fleetFakeStore) GetAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, a := range f.actions {
		if a.ID == id {
			return a, nil
		}
	}
	return nil, fmt.Errorf("action %s not found", id)
}

func (f *fleetFakeStore) UpdateActionState(_ context.Context, _ uuid.UUID, id uuid.UUID, patch store.ActionStatePatch) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, a := range f.actions {
		if a.ID == id {
			a.State = patch.State
			if patch.Result != nil {
				a.Result = patch.Result
			}
			if patch.ApprovedBy != nil {
				a.ApprovedBy = patch.ApprovedBy
			}
		}
	}
	return 1, nil
}

func (f *fleetFakeStore) ClaimAction(_ context.Context, _ uuid.UUID, id uuid.UUID, claimedBy string) (*store.Action, store.ClaimOutcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, a := range f.actions {
		if a.ID == id {
			now := time.Now().UTC()
			a.State, a.ClaimedBy, a.ClaimedAt = "executing", &claimedBy, &now
			return a, store.ClaimOutcome{Version: 1}, nil
		}
	}
	return nil, store.ClaimOutcome{}, store.ErrActionNotFound
}

func (f *fleetFakeStore) CreateAction(_ context.Context, _ uuid.UUID, a *store.Action) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if a.ID == uuid.Nil {
		a.ID = uuid.New()
	}
	f.actions = append(f.actions, a)
	return 1, nil
}

func (f *fleetFakeStore) ReserveTaskTickets(_ context.Context, _ uuid.UUID, n int) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	first := f.ticket + 1
	f.ticket += n
	return first, nil
}

func (f *fleetFakeStore) GetCanvasByID(context.Context, uuid.UUID) (*store.Canvas, error) {
	if f.canvas == nil {
		return &store.Canvas{ApprovalPolicy: "strict"}, nil
	}
	return f.canvas, nil
}

func (f *fleetFakeStore) TouchOrCreateAgent(context.Context, uuid.UUID, string) error { return nil }

// GetCanvasState backs the async post-write state broadcast; erroring makes it
// a no-op, so the only payloads that reach the hub are the activity pings.
func (f *fleetFakeStore) GetCanvasState(context.Context, uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in tests")
}

func ptr[T any](v T) *T { return &v }

func taskPayload(title string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"title":%q}`, title))
}

// ── (a) Roster ────────────────────────────────────────────────────────────────

// The roster must pair registered agents with the work they hold AND surface
// claimants that never registered — a board where "fable-orchestrator" holds
// two tasks but appears nowhere is the exact failure this endpoint exists to
// prevent.
func TestAgentRosterJoinsClaimsAndUnregisteredClaimants(t *testing.T) {
	canvasID := uuid.New()
	base := time.Date(2026, 7, 29, 9, 0, 0, 0, time.UTC)
	workerID, idlerID := uuid.New(), uuid.New()
	parentID := uuid.New()

	fake := &fleetFakeStore{
		agents: []*store.Agent{
			{ID: workerID, Kind: "agent", Name: "executor-1", Role: "executor",
				Model: ptr("claude-opus-5"), ParentAgentID: &parentID,
				Status: "online", CreatedAt: base, LastSeenAt: base.Add(20 * time.Minute)},
			{ID: idlerID, Kind: "agent", Name: "planner-1", Role: "planner",
				Status: "online", CreatedAt: base, LastSeenAt: base.Add(5 * time.Minute)},
		},
		actions: []*store.Action{
			{ID: uuid.New(), Type: "task", State: "executing", Ticket: ptr(46),
				Payload:   taskPayload("E6.1 presence API"),
				ClaimedBy: ptr("executor-1"), ClaimedAt: ptr(base.Add(30 * time.Minute))},
			// Claimed by a name with no agents row — the unregistered case.
			{ID: uuid.New(), Type: "task", State: "executing", Ticket: ptr(47),
				Payload:   taskPayload("E6.2 board wiring"),
				ClaimedBy: ptr("fable-orchestrator"), ClaimedAt: ptr(base.Add(40 * time.Minute))},
			// Executing but unclaimed — nobody to attribute it to, so it must
			// NOT invent a roster entry.
			{ID: uuid.New(), Type: "task", State: "executing", Payload: taskPayload("orphan")},
			// Not executing — must not appear as in-flight work.
			{ID: uuid.New(), Type: "task", State: "approved", Payload: taskPayload("queued")},
		},
	}

	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ListAgentRoster(w, canvasRequest(t, "GET", "/api/canvas/agents", nil, canvasID, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	var got rosterMsg
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if got.Counts.Agents != 3 || got.Counts.Registered != 2 || got.Counts.Unregistered != 1 {
		t.Fatalf("counts = %+v, want 3 agents / 2 registered / 1 unregistered", got.Counts)
	}
	if got.Counts.Working != 2 || got.Counts.Idle != 1 || got.Counts.Claims != 2 {
		t.Fatalf("counts = %+v, want 2 working / 1 idle / 2 claims", got.Counts)
	}
	// Working agents sort first, newest activity leading: the unregistered
	// claimant claimed at +40m, executor-1 at +30m, planner-1 is idle.
	names := make([]string, len(got.Agents))
	for i, a := range got.Agents {
		names[i] = a.Name
	}
	want := []string{"fable-orchestrator", "executor-1", "planner-1"}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("roster order = %v, want %v", names, want)
		}
	}

	unreg := got.Agents[0]
	if unreg.Registered {
		t.Fatalf("%s reported registered:true", unreg.Name)
	}
	if unreg.ID != "" || unreg.LastSeen != nil || unreg.RegisteredAt != nil {
		t.Fatalf("unregistered claimant carries registration fields: %+v", unreg)
	}
	if unreg.Status != "unknown" {
		t.Fatalf("unregistered status = %q, want %q", unreg.Status, "unknown")
	}
	if len(unreg.Tasks) != 1 || unreg.Tasks[0].TicketID != "TDM-47" {
		t.Fatalf("unregistered tasks = %+v, want just TDM-47", unreg.Tasks)
	}
	// Its only liveness signal is the claim.
	if unreg.LastActivityAt == nil || !unreg.LastActivityAt.Equal(base.Add(40*time.Minute)) {
		t.Fatalf("unregistered lastActivityAt = %v, want the claim time", unreg.LastActivityAt)
	}

	worker := got.Agents[1]
	if !worker.Registered || worker.ID != workerID.String() {
		t.Fatalf("executor-1 identity = %+v", worker)
	}
	if worker.Model != "claude-opus-5" || worker.ParentAgentID != parentID.String() {
		t.Fatalf("executor-1 lost identity fields: %+v", worker)
	}
	if len(worker.Tasks) != 1 || worker.Tasks[0].TicketID != "TDM-46" ||
		worker.Tasks[0].Title != "E6.1 presence API" || worker.Tasks[0].State != "executing" {
		t.Fatalf("executor-1 tasks = %+v", worker.Tasks)
	}
	// max(createdAt, lastSeen, claimedAt) — the claim is newest here.
	if worker.LastActivityAt == nil || !worker.LastActivityAt.Equal(base.Add(30*time.Minute)) {
		t.Fatalf("executor-1 lastActivityAt = %v, want the claim time", worker.LastActivityAt)
	}

	idle := got.Agents[2]
	if len(idle.Tasks) != 0 {
		t.Fatalf("planner-1 should hold nothing, got %+v", idle.Tasks)
	}
	if idle.LastActivityAt == nil || !idle.LastActivityAt.Equal(base.Add(5*time.Minute)) {
		t.Fatalf("planner-1 lastActivityAt = %v, want lastSeen", idle.LastActivityAt)
	}
}

// An id-form claimant (the gateway may send the agent id instead of the name)
// must attach to the same registered agent, not spawn a phantom entry.
func TestAgentRosterMatchesClaimantByID(t *testing.T) {
	canvasID := uuid.New()
	agentID := uuid.New()
	fake := &fleetFakeStore{
		agents: []*store.Agent{{ID: agentID, Name: "executor-1", Role: "executor", Status: "online"}},
		actions: []*store.Action{{ID: uuid.New(), Type: "task", State: "executing",
			Payload: taskPayload("t"), ClaimedBy: ptr(agentID.String()), ClaimedAt: ptr(time.Now().UTC())}},
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ListAgentRoster(w, canvasRequest(t, "GET", "/api/canvas/agents", nil, canvasID, ""))
	var got rosterMsg
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Agents) != 1 {
		t.Fatalf("roster = %d entries, want 1 (id claimant folded into the agent)", len(got.Agents))
	}
	if len(got.Agents[0].Tasks) != 1 {
		t.Fatalf("agent holds %d tasks, want 1", len(got.Agents[0].Tasks))
	}
}

// ── (b) Activity feed ─────────────────────────────────────────────────────────

// The derived feed's ordering AND its documented blind spots, asserted
// together: what it shows must be newest-first, and what it can't know must be
// absent rather than guessed.
func TestActivityFeedDerivationAndOrdering(t *testing.T) {
	canvasID := uuid.New()
	base := time.Date(2026, 7, 29, 9, 0, 0, 0, time.UTC)

	doneID, approvedID, execID := uuid.New(), uuid.New(), uuid.New()
	fake := &fleetFakeStore{actions: []*store.Action{
		// Completed: proposed → (approval time unknowable) → claimed → done.
		{ID: doneID, Type: "task", State: "done", Ticket: ptr(1),
			Payload: taskPayload("shipped"), ProposedBy: "planner-1",
			ApprovedBy: ptr("human"), ClaimedBy: ptr("executor-1"),
			ClaimedAt: ptr(base.Add(10 * time.Minute)), Result: ptr("all green"),
			CreatedAt: base, UpdatedAt: base.Add(30 * time.Minute)},
		// Sitting in approved: the one state whose approval time IS knowable.
		{ID: approvedID, Type: "task", State: "approved", Ticket: ptr(2),
			Payload: taskPayload("queued"), ProposedBy: "planner-1",
			ApprovedBy: ptr("human"),
			CreatedAt:  base.Add(time.Minute), UpdatedAt: base.Add(20 * time.Minute)},
		// Executing: proposed + claimed, no completion yet.
		{ID: execID, Type: "task", State: "executing", Ticket: ptr(3),
			Payload: taskPayload("in flight"), ProposedBy: "planner-1",
			ApprovedBy: ptr("human"), ClaimedBy: ptr("fable-orchestrator"),
			ClaimedAt: ptr(base.Add(40 * time.Minute)),
			CreatedAt: base.Add(2 * time.Minute), UpdatedAt: base.Add(40 * time.Minute)},
	}}

	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ListActivity(w, canvasRequest(t, "GET", "/api/canvas/activity", nil, canvasID, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	var got activityMsgList
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Truncated {
		t.Fatalf("feed reported truncated with %d events under the default limit", len(got.Events))
	}

	type fact struct {
		verb  string
		at    time.Time
		actor string
	}
	facts := make([]fact, len(got.Events))
	for i, e := range got.Events {
		facts[i] = fact{e.Action, e.At, e.Actor}
		if e.Type != "activity" {
			t.Fatalf("event %d type = %q, want \"activity\" (same shape as the WS message)", i, e.Type)
		}
	}
	want := []fact{
		{activityClaimed, base.Add(40 * time.Minute), "fable-orchestrator"},
		{activityCompleted, base.Add(30 * time.Minute), "executor-1"},
		{activityApproved, base.Add(20 * time.Minute), "human"},
		{activityClaimed, base.Add(10 * time.Minute), "executor-1"},
		{activityProposed, base.Add(2 * time.Minute), "planner-1"},
		{activityProposed, base.Add(time.Minute), "planner-1"},
		{activityProposed, base, "planner-1"},
	}
	if len(facts) != len(want) {
		t.Fatalf("feed = %+v, want %d events", facts, len(want))
	}
	for i := range want {
		if facts[i].verb != want[i].verb || !facts[i].at.Equal(want[i].at) || facts[i].actor != want[i].actor {
			t.Fatalf("event %d = %+v, want %+v (full feed %+v)", i, facts[i], want[i], facts)
		}
	}

	// The completion carries the summary a UI renders inline.
	completed := got.Events[1]
	if completed.Result != "all green" || completed.State != "done" ||
		completed.TicketID != "TDM-1" || completed.ActionID != doneID {
		t.Fatalf("completion event = %+v", completed)
	}
	// Documented blind spot: the done task WAS approved (approvedBy survives),
	// but its approval time was overwritten by the completion — so no approved
	// fact is emitted for it rather than a fabricated timestamp.
	for _, e := range got.Events {
		if e.Action == activityApproved && e.ActionID == doneID {
			t.Fatalf("emitted an approved fact for a completed task: %+v", e)
		}
	}
	// A claim on the executing task is timed from claimed_at, and its state is
	// the state AT the fact, not the row's current state.
	if got.Events[0].State != "executing" || got.Events[0].ActionID != execID {
		t.Fatalf("newest event = %+v, want the executing task's claim", got.Events[0])
	}
}

// A released task keeps no trace of the claim it lost — the honest consequence
// of deriving instead of logging, and the reason the WS stream exists.
func TestActivityFeedCannotSeeReleasedClaims(t *testing.T) {
	canvasID := uuid.New()
	base := time.Date(2026, 7, 29, 9, 0, 0, 0, time.UTC)
	fake := &fleetFakeStore{actions: []*store.Action{
		// Post-release: back to approved, claim cleared.
		{ID: uuid.New(), Type: "task", State: "approved", Payload: taskPayload("was claimed"),
			ProposedBy: "planner-1", ApprovedBy: ptr("human"),
			CreatedAt: base, UpdatedAt: base.Add(time.Hour)},
	}}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ListActivity(w, canvasRequest(t, "GET", "/api/canvas/activity", nil, canvasID, ""))
	var got activityMsgList
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, e := range got.Events {
		if e.Action == activityClaimed {
			t.Fatalf("derived a claim from a released task: %+v", e)
		}
	}
	if len(got.Events) != 2 {
		t.Fatalf("events = %+v, want proposed + approved only", got.Events)
	}
}

func TestActivityFeedLimit(t *testing.T) {
	canvasID := uuid.New()
	base := time.Date(2026, 7, 29, 9, 0, 0, 0, time.UTC)
	fake := &fleetFakeStore{}
	for i := 0; i < 5; i++ {
		fake.actions = append(fake.actions, &store.Action{
			ID: uuid.New(), Type: "task", State: "proposed", Payload: taskPayload("t"),
			ProposedBy: "planner-1", CreatedAt: base.Add(time.Duration(i) * time.Minute),
			UpdatedAt: base.Add(time.Duration(i) * time.Minute),
		})
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ListActivity(w, canvasRequest(t, "GET", "/api/canvas/activity?limit=2", nil, canvasID, ""))
	var got activityMsgList
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Events) != 2 || !got.Truncated || got.Limit != 2 {
		t.Fatalf("limit=2 gave %d events (truncated=%v, limit=%d)", len(got.Events), got.Truncated, got.Limit)
	}
	// Newest first, so the two most recent proposals survive the cut.
	if !got.Events[0].At.Equal(base.Add(4 * time.Minute)) {
		t.Fatalf("newest event at %v, want %v", got.Events[0].At, base.Add(4*time.Minute))
	}

	w = httptest.NewRecorder()
	h.ListActivity(w, canvasRequest(t, "GET", "/api/canvas/activity?limit=nope", nil, canvasID, ""))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("limit=nope status = %d, want 400", w.Code)
	}
}

// ── Live WS pings ─────────────────────────────────────────────────────────────

// drainActivity pulls the action-lifecycle activity messages off a (non-Run)
// hub. Full-state broadcasts never land here — the fake's GetCanvasState
// errors — so everything queued is an activity ping.
func drainActivity(t *testing.T, hub *ws.Hub) []activityEvent {
	t.Helper()
	var out []activityEvent
	for _, raw := range hub.DrainBroadcasts() {
		var ev activityEvent
		if err := json.Unmarshal(raw, &ev); err != nil {
			t.Fatalf("unmarshal broadcast %s: %v", raw, err)
		}
		if ev.Type != "activity" || ev.ActionID == uuid.Nil {
			continue // presence pulse, not an action-lifecycle event
		}
		out = append(out, ev)
	}
	return out
}

// Every transition a fleet feed cares about must ping, with enough payload to
// update a list without refetching: the action id, its type, the ticket, and
// who moved it.
func TestTransitionsBroadcastActivity(t *testing.T) {
	canvasID := uuid.New()
	proposedID, approvedID, executingID := uuid.New(), uuid.New(), uuid.New()

	newFake := func() *fleetFakeStore {
		return &fleetFakeStore{actions: []*store.Action{
			{ID: proposedID, Type: "task", State: "proposed", Ticket: ptr(10),
				Payload: taskPayload("gate me"), ProposedBy: "planner-1"},
			{ID: approvedID, Type: "task", State: "approved", Ticket: ptr(11),
				Payload: taskPayload("claim me"), ProposedBy: "planner-1"},
			{ID: executingID, Type: "task", State: "executing", Ticket: ptr(12),
				Payload: taskPayload("finish me"), ProposedBy: "planner-1",
				ClaimedBy: ptr("executor-1"), ClaimedAt: ptr(time.Now().UTC())},
		}}
	}

	tests := []struct {
		name      string
		id        uuid.UUID
		call      func(h *Handler, w http.ResponseWriter, r *http.Request)
		body      map[string]any
		wantVerb  string
		wantActor string
		wantState string
	}{
		{
			name: "approve", id: proposedID,
			call:     func(h *Handler, w http.ResponseWriter, r *http.Request) { h.ApproveAction(w, r) },
			// approvedBy is server-derived (human), not read from the body (TDM-129).
			body:     map[string]any{},
			wantVerb: activityApproved, wantActor: "human", wantState: "approved",
		},
		{
			name: "claim", id: approvedID,
			call:     func(h *Handler, w http.ResponseWriter, r *http.Request) { h.UpdateActionState(w, r) },
			body:     map[string]any{"state": "executing", "agentName": "executor-2"},
			wantVerb: activityClaimed, wantActor: "executor-2", wantState: "executing",
		},
		{
			name: "complete", id: executingID,
			call:     func(h *Handler, w http.ResponseWriter, r *http.Request) { h.UpdateActionState(w, r) },
			body:     map[string]any{"state": "done", "result": "landed in 4646742"},
			wantVerb: activityCompleted, wantActor: "executor-1", wantState: "done",
		},
		{
			name: "reject", id: proposedID,
			call:     func(h *Handler, w http.ResponseWriter, r *http.Request) { h.RejectAction(w, r) },
			body:     map[string]any{"reason": "out of scope"},
			wantVerb: activityRejected, wantActor: "human", wantState: "rejected",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			hub := ws.NewHub() // deliberately not Run() — see DrainBroadcasts
			h := NewHandler(newFake(), hub, nil)
			w := httptest.NewRecorder()
			tc.call(h, w, canvasRequest(t, "PATCH", "/api/canvas/actions", tc.body, canvasID, tc.id.String()))
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
			}
			events := drainActivity(t, hub)
			if len(events) != 1 {
				t.Fatalf("broadcast %d activity events, want 1: %+v", len(events), events)
			}
			ev := events[0]
			if ev.Action != tc.wantVerb || ev.Actor != tc.wantActor || ev.State != tc.wantState {
				t.Fatalf("event = %+v, want verb %q actor %q state %q", ev, tc.wantVerb, tc.wantActor, tc.wantState)
			}
			if ev.ActionID != tc.id || ev.ActionType != "task" || ev.TicketID == "" {
				t.Fatalf("event lacks the identity a feed needs to update in place: %+v", ev)
			}
			if ev.At.IsZero() {
				t.Fatalf("event has no timestamp: %+v", ev)
			}
			if tc.wantVerb == activityCompleted && ev.Result != "landed in 4646742" {
				t.Fatalf("completion event dropped the result summary: %+v", ev)
			}
		})
	}
}

// A task BORN approved (human passing state:"approved", or the approval policy)
// never passes through an approve call — so propose must ping both verbs, or a
// feed listening for `approved` silently misses it entering the queue.
func TestProposeBroadcastsProposedAndBornApproved(t *testing.T) {
	canvasID := uuid.New()
	hub := ws.NewHub()
	h := NewHandler(&fleetFakeStore{}, hub, nil)
	w := httptest.NewRecorder()
	body := map[string]any{
		"type": "task", "state": "approved", "proposedBy": "jaxon",
		"payload": map[string]any{"title": "born approved"},
	}
	h.ProposeAction(w, canvasRequest(t, "POST", "/api/canvas/actions", body, canvasID, ""))
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	events := drainActivity(t, hub)
	if len(events) != 2 {
		t.Fatalf("broadcast %d events, want proposed + approved: %+v", len(events), events)
	}
	if events[0].Action != activityProposed || events[1].Action != activityApproved {
		t.Fatalf("verbs = %q,%q, want proposed,approved", events[0].Action, events[1].Action)
	}
	if events[0].Title != "born approved" || events[0].TicketID == "" {
		t.Fatalf("proposed event = %+v, want the title and a ticket", events[0])
	}
}

// A plain proposal (still gated) pings once — no phantom approval.
func TestProposeGatedBroadcastsOnce(t *testing.T) {
	canvasID := uuid.New()
	hub := ws.NewHub()
	h := NewHandler(&fleetFakeStore{}, hub, nil)
	w := httptest.NewRecorder()
	body := map[string]any{
		"type": "task", "proposedBy": "planner-1",
		"payload": map[string]any{"title": "needs a human"},
	}
	h.ProposeAction(w, canvasRequest(t, "POST", "/api/canvas/actions", body, canvasID, ""))
	events := drainActivity(t, hub)
	if len(events) != 1 || events[0].Action != activityProposed {
		t.Fatalf("events = %+v, want a single proposed", events)
	}
	if events[0].Actor != "planner-1" {
		t.Fatalf("proposed actor = %q, want planner-1", events[0].Actor)
	}
}

// The idempotent already-there retry must NOT re-ping: a client whose request
// timed out and retried would otherwise double an entry in every open feed.
func TestIdempotentTransitionDoesNotBroadcastActivity(t *testing.T) {
	canvasID := uuid.New()
	id := uuid.New()
	hub := ws.NewHub()
	fake := &fleetFakeStore{actions: []*store.Action{
		{ID: id, Type: "task", State: "approved", Ticket: ptr(9),
			Payload: taskPayload("already approved"), ProposedBy: "planner-1",
			ApprovedBy: ptr("jaxon")},
	}}
	h := NewHandler(fake, hub, nil)
	w := httptest.NewRecorder()
	h.ApproveAction(w, canvasRequest(t, "POST", "/api/canvas/actions/approve",
		map[string]any{"approvedBy": "jaxon"}, canvasID, id.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	if events := drainActivity(t, hub); len(events) != 0 {
		t.Fatalf("re-approve broadcast %+v, want nothing", events)
	}
}

// ── Route wiring ──────────────────────────────────────────────────────────────

// Both fleet endpoints are READS: a canvas token resolved to 'read' (a public
// read-only canvas, or a member shared at read) must reach them. Registering
// them a group too far down — beside POST /api/canvas/agents, behind
// RequireWrite — would 403 exactly the viewers a presence panel is for, and
// nothing else in the suite would notice.
func TestFleetReadsReachableWithReadOnlyToken(t *testing.T) {
	canvasID := uuid.New()
	authSvc := auth.NewService("test-secret-for-tdm-46", time.Hour)
	token, err := authSvc.Issue(canvasID, "read", nil)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	r := NewRouter(&fleetFakeStore{}, nil, authSvc, nil, false, nil, "", t.TempDir(), "", nil, nil)

	for _, path := range []string{"/api/canvas/agents", "/api/canvas/activity"} {
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("GET %s with a read token = %d: %s", path, w.Code, w.Body.String())
		}
	}
}
