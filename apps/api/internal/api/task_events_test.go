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
	"github.com/agentcanvas/api/internal/webhooks"
	"github.com/google/uuid"
)

// TDM-37: the outbound task-lifecycle events. The whole point of these tests is
// the NEGATIVE half of the contract — exactly three event types exist and
// everything else in the task lifecycle is silent. A regression that starts
// emitting on, say, every claim would be invisible in production until someone's
// receiver melted, so each transition is asserted with its full event list, not
// just "the one I expected is in there".

// ── Recording emitter ────────────────────────────────────────────────────────

type recordedEvent struct {
	canvasID  uuid.UUID
	eventID   uuid.UUID
	eventType string
	// body is the payload MARSHALED — the bytes a receiver actually gets and the
	// signature actually covers. Asserting on the struct would let a wrong json
	// tag through.
	body map[string]any
}

// recordingEmitter stands in for *webhooks.Emitter at the handler seam. The real
// emitter's asynchrony lives inside EmitAsyncWithEventID, so recording here is
// synchronous with the handler — except where the handler itself detaches (the
// epic cascade), which is what waitEvents is for.
type recordingEmitter struct {
	mu     sync.Mutex
	events []recordedEvent
}

func (e *recordingEmitter) EmitAsyncWithEventID(canvasID, eventID uuid.UUID, eventType string, payload any) {
	b, err := json.Marshal(payload)
	if err != nil {
		panic("task event payload does not marshal: " + err.Error())
	}
	var body map[string]any
	if err := json.Unmarshal(b, &body); err != nil {
		panic("task event payload is not a JSON object: " + err.Error())
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.events = append(e.events, recordedEvent{canvasID: canvasID, eventID: eventID, eventType: eventType, body: body})
}

func (e *recordingEmitter) recorded() []recordedEvent {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]recordedEvent(nil), e.events...)
}

func (e *recordingEmitter) types() []string {
	out := []string{}
	for _, ev := range e.recorded() {
		out = append(out, ev.eventType)
	}
	return out
}

// wantTypes asserts the COMPLETE event list, in order.
func (e *recordingEmitter) wantTypes(t *testing.T, want ...string) {
	t.Helper()
	got := e.types()
	if len(got) != len(want) {
		t.Fatalf("emitted %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("emitted %v, want %v", got, want)
		}
	}
}

// settle gives a detached handler goroutine a beat, then asserts the exact list.
// The only honest way to check "and nothing else".
func (e *recordingEmitter) settleTypes(t *testing.T, want ...string) {
	t.Helper()
	time.Sleep(100 * time.Millisecond)
	e.wantTypes(t, want...)
}

// waitEvents polls until n events have landed (or fails), for the paths the
// handler runs off-request.
func (e *recordingEmitter) waitEvents(t *testing.T, n int) []recordedEvent {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		got := e.recorded()
		if len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("emitted %v, want %d events", e.types(), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// ── Fake store ───────────────────────────────────────────────────────────────

// eventFakeStore implements only what the task lifecycle touches. Everything
// else panics through the embedded nil interface — a test reaching an
// unstubbed method is a test bug.
type eventFakeStore struct {
	store.Store
	policy  string
	actions map[uuid.UUID]*store.Action

	// writeErr, when set, makes every state-changing store call fail — the
	// "a failed write must not emit" case.
	writeErr error
	// claimOutcome is what ClaimAction reports (set ExpiredClaimBy to simulate a
	// TTL takeover).
	claimOutcome store.ClaimOutcome
	// epicTasks is what the epic cascade reports as flipped.
	epicTasks []*store.Action

	mu sync.Mutex
}

func (f *eventFakeStore) GetCanvasByID(_ context.Context, id uuid.UUID) (*store.Canvas, error) {
	return &store.Canvas{ID: id, ApprovalPolicy: f.policy}, nil
}

func (f *eventFakeStore) GetAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if a, ok := f.actions[id]; ok {
		return a, nil
	}
	return nil, fmt.Errorf("action %s not found", id)
}

func (f *eventFakeStore) CreateAction(_ context.Context, _ uuid.UUID, a *store.Action) (int, error) {
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.actions[a.ID] = a
	return 1, nil
}

func (f *eventFakeStore) CreateActions(_ context.Context, _ uuid.UUID, actions []*store.Action) (int, error) {
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, a := range actions {
		f.actions[a.ID] = a
	}
	return 1, nil
}

func (f *eventFakeStore) UpdateActionState(_ context.Context, _ uuid.UUID, id uuid.UUID, patch store.ActionStatePatch) (int, error) {
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return 0, fmt.Errorf("action %s not found", id)
	}
	a.State = patch.State
	if patch.ApprovedBy != nil {
		a.ApprovedBy = patch.ApprovedBy
	}
	if patch.Result != nil {
		a.Result = patch.Result
	}
	if patch.Error != nil {
		a.Error = patch.Error
	}
	return 1, nil
}

// UpdateActionPayload runs the REAL content gate (store.DecideContentUpdate) so
// the handler tests exercise the shipped rule rather than a fake's idea of it,
// then applies the same row effects the supabase write does.
func (f *eventFakeStore) UpdateActionPayload(_ context.Context, _ uuid.UUID, id uuid.UUID, payload json.RawMessage, actor string) (*store.ContentUpdate, error) {
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
	out.Version = 1
	return out, nil
}

func (f *eventFakeStore) DeleteAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.actions, id)
	return 1, nil
}

func (f *eventFakeStore) ClaimAction(_ context.Context, _ uuid.UUID, id uuid.UUID, claimedBy string) (*store.Action, store.ClaimOutcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ClaimOutcome{}, store.ErrActionNotFound
	}
	a.State = "executing"
	holder := claimedBy
	a.ClaimedBy = &holder
	return a, f.claimOutcome, nil
}

func (f *eventFakeStore) ReleaseAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, 0, store.ErrActionNotFound
	}
	a.State = "approved"
	a.ClaimedBy = nil
	return a, 1, nil
}

// AppendActionAudit is reached by every human board move (recordMove), which
// includes the release/requeue transitions this file asserts fire NO webhook.
// Modelled on the real store method — read, append through the REAL
// store.AppendAudit, write back — so the fake can't drift from the rule.
func (f *eventFakeStore) AppendActionAudit(_ context.Context, _ uuid.UUID, id uuid.UUID, entry store.ContentAudit) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ErrActionNotFound
	}
	next, err := store.AppendAudit(a.Payload, entry)
	if err != nil {
		return nil, err
	}
	a.Payload = next
	return next, nil
}

func (f *eventFakeStore) RequeueAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, 0, store.ErrActionNotFound
	}
	a.State = "approved"
	a.ClaimedBy = nil
	a.Error = nil
	return a, 1, nil
}

func (f *eventFakeStore) ApproveActionsBatch(_ context.Context, _ uuid.UUID, ids []uuid.UUID, approvedBy string) ([]*store.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
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

func (f *eventFakeStore) ApproveEpicTasks(_ context.Context, _ uuid.UUID, _ uuid.UUID, _ string) ([]*store.Action, error) {
	return f.epicTasks, nil
}

func (f *eventFakeStore) ReserveTaskTickets(_ context.Context, _ uuid.UUID, _ int) (int, error) {
	return 7, nil
}

func (f *eventFakeStore) TouchOrCreateAgent(_ context.Context, _ uuid.UUID, _ string) error {
	return nil
}

// GetCanvasState backs the async post-write broadcast; erroring makes it a no-op.
func (f *eventFakeStore) GetCanvasState(_ context.Context, _ uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in tests")
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

func ticketPtr(n int) *int { return &n }

func strPtr(s string) *string { return &s }

// newEventHarness wires a handler with a recording emitter over a fake store
// preloaded with `actions`.
func newEventHarness(t *testing.T, policy string, actions ...*store.Action) (*Handler, *eventFakeStore, *recordingEmitter) {
	t.Helper()
	fake := &eventFakeStore{policy: policy, actions: map[uuid.UUID]*store.Action{}}
	for _, a := range actions {
		fake.actions[a.ID] = a
	}
	em := &recordingEmitter{}
	return NewHandler(fake, nil, nil, WithTaskEvents(em)), fake, em
}

func proposedTask(title string) *store.Action {
	return &store.Action{
		ID: uuid.New(), Kind: "action", Type: "task", State: "proposed",
		Ticket:  ticketPtr(42),
		Payload: json.RawMessage(fmt.Sprintf(`{"title":%q,"assignee":"agent"}`, title)),
	}
}

// ── The state machine, transition by transition ──────────────────────────────

// Every task transition in one table, each asserting the COMPLETE event list.
// The silent rows are the contract: claiming, rejecting, editing, deleting,
// releasing and requeueing must never notify.
func TestTaskEventsPerTransition(t *testing.T) {
	canvasID := uuid.New()

	tests := []struct {
		name  string
		setup func(t *testing.T, h *Handler, task *store.Action)
		// state the task starts in
		from string
		want []string
	}{
		{
			name: "proposed → approved fires task.approved",
			from: "proposed",
			setup: func(t *testing.T, h *Handler, task *store.Action) {
				w := httptest.NewRecorder()
				h.ApproveAction(w, canvasRequest(t, "POST", "/approve",
					map[string]any{"approvedBy": "jaxon"}, canvasID, task.ID.String()))
				if w.Code != http.StatusOK {
					t.Fatalf("approve = %d: %s", w.Code, w.Body)
				}
			},
			want: []string{webhooks.EventTaskApproved},
		},
		{
			name: "approved → executing (claim) fires NOTHING",
			from: "approved",
			setup: func(t *testing.T, h *Handler, task *store.Action) {
				w := httptest.NewRecorder()
				h.UpdateActionState(w, canvasRequest(t, "PATCH", "/action",
					map[string]any{"state": "executing", "agentName": "agent-a"}, canvasID, task.ID.String()))
				if w.Code != http.StatusOK {
					t.Fatalf("claim = %d: %s", w.Code, w.Body)
				}
			},
			want: nil,
		},
		{
			name: "executing → done fires task.completed",
			from: "executing",
			setup: func(t *testing.T, h *Handler, task *store.Action) {
				w := httptest.NewRecorder()
				h.UpdateActionState(w, canvasRequest(t, "PATCH", "/action",
					map[string]any{"state": "done", "result": "shipped"}, canvasID, task.ID.String()))
				if w.Code != http.StatusOK {
					t.Fatalf("complete = %d: %s", w.Code, w.Body)
				}
			},
			want: []string{webhooks.EventTaskCompleted},
		},
		{
			name: "executing → failed fires task.completed (terminal is terminal)",
			from: "executing",
			setup: func(t *testing.T, h *Handler, task *store.Action) {
				w := httptest.NewRecorder()
				h.UpdateActionState(w, canvasRequest(t, "PATCH", "/action",
					map[string]any{"state": "failed", "error": "boom"}, canvasID, task.ID.String()))
				if w.Code != http.StatusOK {
					t.Fatalf("fail = %d: %s", w.Code, w.Body)
				}
			},
			want: []string{webhooks.EventTaskCompleted},
		},
		{
			name: "proposed → rejected fires NOTHING",
			from: "proposed",
			setup: func(t *testing.T, h *Handler, task *store.Action) {
				w := httptest.NewRecorder()
				h.RejectAction(w, canvasRequest(t, "POST", "/reject",
					map[string]any{"reason": "nope"}, canvasID, task.ID.String()))
				if w.Code != http.StatusOK {
					t.Fatalf("reject = %d: %s", w.Code, w.Body)
				}
			},
			want: nil,
		},
		{
			name: "payload edit fires NOTHING",
			from: "approved",
			setup: func(t *testing.T, h *Handler, task *store.Action) {
				w := httptest.NewRecorder()
				h.UpdateActionState(w, canvasRequest(t, "PATCH", "/action",
					map[string]any{"payload": map[string]any{"title": "retitled"}}, canvasID, task.ID.String()))
				if w.Code != http.StatusOK {
					t.Fatalf("edit = %d: %s", w.Code, w.Body)
				}
			},
			want: nil,
		},
		{
			name: "delete fires NOTHING",
			from: "approved",
			setup: func(t *testing.T, h *Handler, task *store.Action) {
				w := httptest.NewRecorder()
				h.DeleteAction(w, canvasRequest(t, "DELETE", "/action", nil, canvasID, task.ID.String()))
				if w.Code != http.StatusOK {
					t.Fatalf("delete = %d: %s", w.Code, w.Body)
				}
			},
			want: nil,
		},
		{
			// Release puts the task back in the queue, but the approval gate was
			// already passed — re-firing task.approved would make a subscribed
			// fleet re-run work it already picked up.
			name: "release (executing → approved) fires NOTHING",
			from: "executing",
			setup: func(t *testing.T, h *Handler, task *store.Action) {
				w := httptest.NewRecorder()
				h.ReleaseAction(w, canvasRequest(t, "POST", "/release", nil, canvasID, task.ID.String()))
				if w.Code != http.StatusOK {
					t.Fatalf("release = %d: %s", w.Code, w.Body)
				}
			},
			want: nil,
		},
		{
			name: "requeue (failed → approved) fires NOTHING",
			from: "failed",
			setup: func(t *testing.T, h *Handler, task *store.Action) {
				w := httptest.NewRecorder()
				h.RequeueAction(w, canvasRequest(t, "POST", "/requeue", nil, canvasID, task.ID.String()))
				if w.Code != http.StatusOK {
					t.Fatalf("requeue = %d: %s", w.Code, w.Body)
				}
			},
			want: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			task := proposedTask("ship it")
			task.State = tc.from
			if tc.from == "executing" {
				task.ClaimedBy = strPtr("agent-a")
			}
			h, _, em := newEventHarness(t, "strict", task)
			tc.setup(t, h, task)
			em.settleTypes(t, tc.want...)
		})
	}
}

// Claim expiry is the third event, and the ONLY path that produces it: the lazy
// takeover inside ClaimAction (there is no sweeper).
func TestClaimExpiryFiresClaimExpired(t *testing.T) {
	canvasID := uuid.New()
	task := proposedTask("stuck work")
	task.State = "executing"
	task.ClaimedBy = strPtr("agent-a")

	h, fake, em := newEventHarness(t, "strict", task)
	lapsed := time.Now().Add(-30 * time.Minute).UTC()
	fake.claimOutcome = store.ClaimOutcome{Version: 2, ExpiredClaimBy: "agent-a", ExpiredClaimAt: lapsed}

	w := httptest.NewRecorder()
	h.UpdateActionState(w, canvasRequest(t, "PATCH", "/action",
		map[string]any{"state": "executing", "agentName": "agent-b"}, canvasID, task.ID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("claim = %d: %s", w.Code, w.Body)
	}
	em.settleTypes(t, webhooks.EventTaskClaimExpired)

	ev := em.recorded()[0]
	expired, ok := ev.body["expired_claim"].(map[string]any)
	if !ok {
		t.Fatalf("claim_expired payload has no expired_claim object: %v", ev.body)
	}
	if expired["claimed_by"] != "agent-a" {
		t.Errorf("expired_claim.claimed_by = %v, want agent-a (the agent that went dark)", expired["claimed_by"])
	}
	// The task itself already belongs to the NEW claimant — which is exactly why
	// expired_claim has to exist separately.
	taskObj := ev.body["task"].(map[string]any)
	if taskObj["claimedBy"] != "agent-b" {
		t.Errorf("task.claimedBy = %v, want agent-b (the new holder)", taskObj["claimedBy"])
	}
}

// A self-reclaim (same agent restamping its own lapsed claim) is not a handoff —
// the store reports no ExpiredClaimBy and nothing fires.
func TestSelfReclaimFiresNothing(t *testing.T) {
	canvasID := uuid.New()
	task := proposedTask("long task")
	task.State = "executing"
	task.ClaimedBy = strPtr("agent-a")

	h, fake, em := newEventHarness(t, "strict", task)
	fake.claimOutcome = store.ClaimOutcome{Version: 2} // no ExpiredClaimBy

	w := httptest.NewRecorder()
	h.UpdateActionState(w, canvasRequest(t, "PATCH", "/action",
		map[string]any{"state": "executing", "agentName": "agent-a"}, canvasID, task.ID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("reclaim = %d: %s", w.Code, w.Body)
	}
	em.settleTypes(t)
}

// ── Payload contract ─────────────────────────────────────────────────────────

func TestTaskEventPayloadShape(t *testing.T) {
	canvasID := uuid.New()
	epicID := uuid.New()
	task := &store.Action{
		ID: uuid.New(), Kind: "action", Type: "task", State: "executing",
		Ticket:    ticketPtr(42),
		ClaimedBy: strPtr("agent-a"),
		Payload: json.RawMessage(fmt.Sprintf(
			`{"title":"Wire outbound events","assignee":"agent","epicId":%q,"body":"a very long body that must NOT be dumped into the event"}`, epicID)),
	}
	h, _, em := newEventHarness(t, "strict", task)

	w := httptest.NewRecorder()
	h.UpdateActionState(w, canvasRequest(t, "PATCH", "/action",
		map[string]any{"state": "done", "result": "done in 4 files"}, canvasID, task.ID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("complete = %d: %s", w.Code, w.Body)
	}
	em.wantTypes(t, webhooks.EventTaskCompleted)
	ev := em.recorded()[0]

	// Envelope.
	if ev.body["type"] != webhooks.EventTaskCompleted {
		t.Errorf("type = %v", ev.body["type"])
	}
	if ev.body["canvas_id"] != canvasID.String() {
		t.Errorf("canvas_id = %v, want %s", ev.body["canvas_id"], canvasID)
	}
	// The event id in the BODY must be the same one the emitter fans the
	// delivery rows out under — that identity is the whole point of
	// EmitWithEventID, and it's what lets a receiver correlate two endpoints'
	// notifications as one event.
	if ev.body["event_id"] != ev.eventID.String() {
		t.Errorf("payload event_id = %v, but fan-out used %s", ev.body["event_id"], ev.eventID)
	}
	if _, err := time.Parse(time.RFC3339, ev.body["timestamp"].(string)); err != nil {
		t.Errorf("timestamp %v is not RFC3339: %v", ev.body["timestamp"], err)
	}
	// `attempt` is deliberately absent: the payload is stored once and re-sent
	// byte-for-byte, so a per-attempt field would break the signed-bytes
	// contract. See task_events.go.
	if _, present := ev.body["attempt"]; present {
		t.Errorf("payload carries `attempt` — it must stay delivery-scoped (headers), not in the signed body")
	}

	taskObj, ok := ev.body["task"].(map[string]any)
	if !ok {
		t.Fatalf("payload has no task object: %v", ev.body)
	}
	want := map[string]any{
		"id":        task.ID.String(),
		"ticketId":  "TDM-42",
		"title":     "Wire outbound events",
		"state":     "done",
		"epicId":    epicID.String(),
		"assignee":  "agent",
		"claimedBy": "agent-a",
		"result":    "done in 4 files",
	}
	for k, v := range want {
		if taskObj[k] != v {
			t.Errorf("task.%s = %v, want %v", k, taskObj[k], v)
		}
	}
	// Compact: the stored payload's `body` must not ride along.
	if _, present := taskObj["body"]; present {
		t.Errorf("task object dumped the stored payload (body present): %v", taskObj)
	}
}

// A failed task fires task.completed carrying the failure — the receiver must be
// able to tell success from failure, and to see WHY, without a callback.
func TestFailedTaskCompletedCarriesError(t *testing.T) {
	canvasID := uuid.New()
	task := proposedTask("risky work")
	task.State = "executing"
	h, _, em := newEventHarness(t, "strict", task)

	w := httptest.NewRecorder()
	h.UpdateActionState(w, canvasRequest(t, "PATCH", "/action",
		map[string]any{"state": "failed", "error": "sandbox died"}, canvasID, task.ID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("fail = %d: %s", w.Code, w.Body)
	}
	em.wantTypes(t, webhooks.EventTaskCompleted)
	taskObj := em.recorded()[0].body["task"].(map[string]any)
	if taskObj["state"] != "failed" {
		t.Errorf("task.state = %v, want failed", taskObj["state"])
	}
	if taskObj["error"] != "sandbox died" {
		t.Errorf("task.error = %v, want the failure reason", taskObj["error"])
	}
}

// ── Born-approved paths ──────────────────────────────────────────────────────

// A task can enter the queue at creation time — under the 'auto' policy, or with
// a human explicitly passing state:"approved". Both are approvals.
func TestBornApprovedFiresTaskApproved(t *testing.T) {
	canvasID := uuid.New()

	t.Run("policy auto", func(t *testing.T) {
		h, _, em := newEventHarness(t, "auto")
		w := httptest.NewRecorder()
		h.ProposeAction(w, canvasRequest(t, "POST", "/actions",
			taskBody(map[string]any{"title": "auto task"}), canvasID, ""))
		if w.Code != http.StatusCreated {
			t.Fatalf("propose = %d: %s", w.Code, w.Body)
		}
		em.settleTypes(t, webhooks.EventTaskApproved)
	})

	t.Run("strict policy lands proposed and stays silent", func(t *testing.T) {
		h, _, em := newEventHarness(t, "strict")
		w := httptest.NewRecorder()
		h.ProposeAction(w, canvasRequest(t, "POST", "/actions",
			taskBody(map[string]any{"title": "gated task"}), canvasID, ""))
		if w.Code != http.StatusCreated {
			t.Fatalf("propose = %d: %s", w.Code, w.Body)
		}
		em.settleTypes(t)
	})

	t.Run("human-supplied approved", func(t *testing.T) {
		h, _, em := newEventHarness(t, "strict")
		w := httptest.NewRecorder()
		h.ProposeAction(w, canvasRequest(t, "POST", "/actions",
			map[string]any{"type": "task", "state": "approved", "payload": map[string]any{"title": "manual"}},
			canvasID, ""))
		if w.Code != http.StatusCreated {
			t.Fatalf("propose = %d: %s", w.Code, w.Body)
		}
		em.settleTypes(t, webhooks.EventTaskApproved)
	})

	t.Run("batch: one event per approved task, none for the gated ones", func(t *testing.T) {
		h, _, em := newEventHarness(t, "strict")
		w := httptest.NewRecorder()
		h.ProposeActionsBatch(w, canvasRequest(t, "POST", "/actions/batch", map[string]any{
			"actions": []map[string]any{
				{"type": "task", "state": "approved", "payload": map[string]any{"title": "a"}},
				{"type": "task", "state": "approved", "payload": map[string]any{"title": "b"}},
				{"type": "task", "payload": map[string]any{"title": "gated"}},
				{"type": "epic", "state": "approved", "payload": map[string]any{"title": "an epic"}},
			},
		}, canvasID, ""))
		if w.Code != http.StatusCreated {
			t.Fatalf("batch = %d: %s", w.Code, w.Body)
		}
		// Two tasks — the gated task and the EPIC are both silent.
		em.settleTypes(t, webhooks.EventTaskApproved, webhooks.EventTaskApproved)
	})
}

// ── Batch / cascade fan-out ──────────────────────────────────────────────────

// approve-batch flips N tasks in one round trip but must notify per task —
// receivers subscribe to task events, not to batches.
func TestApproveBatchFansOutPerFlippedTask(t *testing.T) {
	canvasID := uuid.New()
	t1, t2 := proposedTask("one"), proposedTask("two")
	already := proposedTask("already approved")
	already.State = "approved"

	h, _, em := newEventHarness(t, "strict", t1, t2, already)
	w := httptest.NewRecorder()
	h.ApproveActionsBatch(w, canvasRequest(t, "POST", "/actions/approve-batch", map[string]any{
		"ids": []string{t1.ID.String(), t2.ID.String(), already.ID.String(), uuid.New().String()},
	}, canvasID, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("approve-batch = %d: %s", w.Code, w.Body)
	}
	// Only the two that ACTUALLY flipped: an already-approved id and a missing id
	// are skipped, so a stale panel retry re-notifies nobody.
	em.settleTypes(t, webhooks.EventTaskApproved, webhooks.EventTaskApproved)

	got := map[string]bool{}
	for _, ev := range em.recorded() {
		got[ev.body["task"].(map[string]any)["id"].(string)] = true
	}
	if !got[t1.ID.String()] || !got[t2.ID.String()] {
		t.Errorf("events covered %v, want both flipped tasks", got)
	}
}

// Approving an EPIC emits nothing for the epic itself (it is not a task) and one
// task.approved per task the cascade releases.
func TestEpicApprovalFansOutOnePerCascadedTask(t *testing.T) {
	canvasID := uuid.New()
	epic := &store.Action{ID: uuid.New(), Kind: "action", Type: "epic", State: "proposed",
		Payload: json.RawMessage(`{"title":"E3 webhooks"}`)}
	cascaded := []*store.Action{proposedTask("t1"), proposedTask("t2"), proposedTask("t3")}
	for _, a := range cascaded {
		a.State = "approved"
	}

	h, fake, em := newEventHarness(t, "epic", epic)
	fake.epicTasks = cascaded

	w := httptest.NewRecorder()
	h.ApproveAction(w, canvasRequest(t, "POST", "/approve",
		map[string]any{"approvedBy": "jaxon"}, canvasID, epic.ID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("approve epic = %d: %s", w.Code, w.Body)
	}
	// The cascade is detached — wait for it, then assert the exact list.
	em.waitEvents(t, len(cascaded))
	em.settleTypes(t, webhooks.EventTaskApproved, webhooks.EventTaskApproved, webhooks.EventTaskApproved)
}

// ── Ordering + durability guarantees ─────────────────────────────────────────

// An approve that lands twice notifies once: the second call is the idempotent
// already-approved no-op, and handing a fleet the same task twice is exactly the
// bug this guards.
func TestApproveRetryEmitsOnce(t *testing.T) {
	canvasID := uuid.New()
	task := proposedTask("retryable")
	h, _, em := newEventHarness(t, "strict", task)

	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		h.ApproveAction(w, canvasRequest(t, "POST", "/approve",
			map[string]any{"approvedBy": "jaxon"}, canvasID, task.ID.String()))
		if w.Code != http.StatusOK {
			t.Fatalf("approve #%d = %d: %s", i, w.Code, w.Body)
		}
	}
	em.settleTypes(t, webhooks.EventTaskApproved)
}

// A store write that fails must notify NOBODY — an event for a state change that
// never landed is unrecoverable: the receiver acts on a task the canvas doesn't
// have in that state.
func TestFailedWriteEmitsNothing(t *testing.T) {
	canvasID := uuid.New()
	task := proposedTask("doomed")
	h, fake, em := newEventHarness(t, "strict", task)
	fake.writeErr = fmt.Errorf("supabase is down")

	w := httptest.NewRecorder()
	h.ApproveAction(w, canvasRequest(t, "POST", "/approve",
		map[string]any{"approvedBy": "jaxon"}, canvasID, task.ID.String()))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("approve = %d, want 500: %s", w.Code, w.Body)
	}
	em.settleTypes(t)

	// Same for creation.
	w = httptest.NewRecorder()
	h.ProposeAction(w, canvasRequest(t, "POST", "/actions",
		map[string]any{"type": "task", "state": "approved", "payload": map[string]any{"title": "doomed"}},
		canvasID, ""))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("propose = %d, want 500: %s", w.Code, w.Body)
	}
	em.settleTypes(t)
}

// The emitter is optional: with no webhooks wired every emit is a no-op, and the
// lifecycle still works. This is what every other handler test runs as.
func TestNilEmitterIsANoOp(t *testing.T) {
	canvasID := uuid.New()
	task := proposedTask("no webhooks here")
	fake := &eventFakeStore{policy: "strict", actions: map[uuid.UUID]*store.Action{task.ID: task}}
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ApproveAction(w, canvasRequest(t, "POST", "/approve",
		map[string]any{"approvedBy": "jaxon"}, canvasID, task.ID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("approve = %d: %s", w.Code, w.Body)
	}
}

// Every event type the handlers emit must be in the DB's CHECK vocabulary —
// otherwise the delivery INSERT is rejected and the event silently never fires,
// the worst failure mode this feature has.
func TestEmittedTypesAreKnownWebhookEvents(t *testing.T) {
	for _, e := range []string{webhooks.EventTaskApproved, webhooks.EventTaskCompleted, webhooks.EventTaskClaimExpired} {
		if !store.IsKnownWebhookEvent(e) {
			t.Errorf("%q is not in store.KnownWebhookEvents", e)
		}
	}
	if len(store.KnownWebhookEvents) != 3 {
		t.Errorf("vocabulary is %v — the handlers emit exactly 3 event types; adding a 4th needs a call site", store.KnownWebhookEvents)
	}
}
