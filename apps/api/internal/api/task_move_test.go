package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/webhooks"
	"github.com/google/uuid"
)

// E10 — the human board moves (POST /api/canvas/actions/{id}/move).
//
// What these tests are FOR, in priority order:
//
//  1. THE GATE HOLDS. /move cannot take a task out of 'proposed', in any
//     direction, ever. That is the one assertion in this file that is a security
//     property rather than a feature: approve/reject stamp approved_by, fire
//     task.approved and cascade the epic, and a second door into the ready queue
//     with none of that would make the approval gate theater. TestMoveCannot…
//     walks EVERY state as a target to prove there is no accidental one.
//  2. A person can walk their own task through its whole life — start, finish,
//     and back again — which is the complaint that produced the feature ("I see
//     my human tasks but I'm unable to move the task").
//  3. Each move leaves the same trail an agent's would: the audit entry the
//     board's chips read, the webhook a terminal state owes its receivers, and
//     the claim columns cleared on a rewind.

// ── Fake store ────────────────────────────────────────────────────────────────

// moveFakeStore models the state machine the way the real store enforces it: a
// predicate on the state the caller believed the row was in, and an
// ErrIllegalActionState when it has moved. Anything the move path doesn't touch
// panics through the embedded nil interface.
type moveFakeStore struct {
	store.Store
	mu      sync.Mutex
	actions map[uuid.UUID]*store.Action
	// touched records TouchOrCreateAgent calls — a HUMAN move must never make
	// one (it would mint a permanently-online fake executor in the swarm view).
	touched []string
}

func newMoveStore(actions ...*store.Action) *moveFakeStore {
	f := &moveFakeStore{actions: map[uuid.UUID]*store.Action{}}
	for _, a := range actions {
		f.actions[a.ID] = a
	}
	return f
}

func (f *moveFakeStore) GetAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ErrActionNotFound
	}
	cp := *a
	return &cp, nil
}

func (f *moveFakeStore) ClaimAction(_ context.Context, _ uuid.UUID, id uuid.UUID, claimedBy string) (*store.Action, store.ClaimOutcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ClaimOutcome{}, store.ErrActionNotFound
	}
	if a.State == "executing" && a.ClaimedBy != nil && *a.ClaimedBy != claimedBy {
		return nil, store.ClaimOutcome{}, &store.AlreadyClaimedError{ClaimedBy: *a.ClaimedBy}
	}
	if a.State != "approved" {
		return nil, store.ClaimOutcome{}, fmt.Errorf("%w: cannot claim in state %q", store.ErrIllegalActionState, a.State)
	}
	now := time.Now().UTC()
	a.State, a.ClaimedBy, a.ClaimedAt = "executing", &claimedBy, &now
	cp := *a
	return &cp, store.ClaimOutcome{Version: 1}, nil
}

func (f *moveFakeStore) UpdateActionState(_ context.Context, _ uuid.UUID, id uuid.UUID, patch store.ActionStatePatch) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return 0, store.ErrActionNotFound
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
	}
	return 1, nil
}

func (f *moveFakeStore) ReleaseAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, int, error) {
	return f.rewind(id, "executing", "approved")
}

func (f *moveFakeStore) RequeueAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, int, error) {
	return f.rewind(id, "failed", "approved")
}

func (f *moveFakeStore) ReopenAction(_ context.Context, _ uuid.UUID, id uuid.UUID, from, to string) (*store.Action, int, error) {
	return f.rewind(id, from, to)
}

// rewind mirrors the real conditional UPDATE: predicated on `from`, clearing
// exactly what the store methods clear (claim, result, error — plus approved_by
// when the task is going back INTO the gate).
func (f *moveFakeStore) rewind(id uuid.UUID, from, to string) (*store.Action, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, 0, store.ErrActionNotFound
	}
	if a.State == to {
		cp := *a
		return &cp, 0, nil // idempotent retry
	}
	if a.State != from {
		return nil, 0, fmt.Errorf("%w: cannot move task from %q to %q (it is %q now)",
			store.ErrIllegalActionState, from, to, a.State)
	}
	a.State, a.ClaimedBy, a.ClaimedAt, a.Result, a.Error = to, nil, nil, nil, nil
	if to == "proposed" {
		a.ApprovedBy = nil
	}
	cp := *a
	return &cp, 1, nil
}

// AppendActionAudit runs the REAL store.AppendAudit over the stored payload, so
// these tests exercise the actual audit rule rather than a second copy of it.
func (f *moveFakeStore) AppendActionAudit(_ context.Context, _ uuid.UUID, id uuid.UUID, entry store.ContentAudit) (json.RawMessage, error) {
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

func (f *moveFakeStore) TouchOrCreateAgent(_ context.Context, _ uuid.UUID, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touched = append(f.touched, name)
	return nil
}

// GetCanvasState backs the async post-write broadcast; erroring makes it a no-op.
func (f *moveFakeStore) GetCanvasState(_ context.Context, _ uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in tests")
}

func (f *moveFakeStore) get(t *testing.T, id uuid.UUID) *store.Action {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		t.Fatalf("action %s vanished", id)
	}
	return a
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

// humanTask is the row the whole feature is about: a task a PERSON is meant to
// do, sitting on the board in some state.
func humanTask(state string) *store.Action {
	a := &store.Action{
		ID: uuid.New(), Type: "task", State: state, Ticket: ptr(10),
		Payload:    json.RawMessage(`{"title":"Write the migration","assignee":"human"}`),
		ProposedBy: "human", ApprovedBy: ptr("human"),
	}
	if state == "executing" {
		now := time.Now().UTC()
		a.ClaimedBy, a.ClaimedAt = ptr("human"), &now
	}
	return a
}

// moveRequest is a /move call as the browser makes it, WITH the provenance the
// route group's middleware derives (so the audit actor under test is the one
// production records).
func moveRequest(t *testing.T, canvasID uuid.UUID, id uuid.UUID, body any) *http.Request {
	t.Helper()
	r := canvasRequest(t, "POST", "/api/canvas/actions/"+id.String()+"/move", body, canvasID, id.String())
	return r.WithContext(WithAuthor(r.Context(), AuthorHuman))
}

// lastAudit is the entry the move under test just wrote. auditOf (the shared
// reader, in content_gate_test.go) is the same trail the content gate writes —
// deliberately, since a task has ONE audit log.
func lastAudit(t *testing.T, a *store.Action) store.ContentAudit {
	t.Helper()
	log := auditOf(t, a)
	if len(log) == 0 {
		t.Fatalf("no audit entry recorded for the move")
	}
	return log[len(log)-1]
}

// ── 1. The gate ──────────────────────────────────────────────────────────────

// The load-bearing test: a proposed task has NO legal move, to any state. If
// this ever fails, /move has become a second (unstamped, un-cascaded,
// un-notified) door into the ready queue and the approval gate is decoration.
func TestMoveCannotLeaveProposed(t *testing.T) {
	for _, to := range []string{"approved", "executing", "done", "failed", "rejected"} {
		t.Run(to, func(t *testing.T) {
			canvasID := uuid.New()
			task := humanTask("proposed")
			task.ApprovedBy = nil
			f := newMoveStore(task)
			h := NewHandler(f, nil, nil)

			w := httptest.NewRecorder()
			h.MoveAction(w, moveRequest(t, canvasID, task.ID, map[string]any{"to": to}))

			if w.Code != http.StatusBadRequest {
				t.Fatalf("proposed → %s: status %d, want 400 (body %s)", to, w.Code, w.Body.String())
			}
			if got := f.get(t, task.ID).State; got != "proposed" {
				t.Fatalf("proposed → %s moved the task to %q", to, got)
			}
			var body struct {
				Error string              `json:"error"`
				State string              `json:"state"`
				Moves []map[string]string `json:"moves"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode 400 body: %v", err)
			}
			if len(body.Moves) != 0 {
				t.Fatalf("offered moves out of proposed: %v", body.Moves)
			}
			// The refusal has to point at the right endpoint, or a client author
			// reasonably concludes the board is broken rather than gated.
			if !strings.Contains(body.Error, "/approve") {
				t.Fatalf("400 does not point at the approval gate: %q", body.Error)
			}
		})
	}
}

// The matrix itself, asserted as a whole. A new entry here must be a deliberate
// edit to this table, not a side effect of touching the dispatch.
func TestHumanMoveMatrix(t *testing.T) {
	want := map[string][]string{
		"proposed":  {},
		"approved":  {"executing"},
		"executing": {"done", "failed", "approved"},
		"failed":    {"approved"},
		"done":      {"approved"},
		"rejected":  {"proposed"},
	}
	for from, tos := range want {
		got := []string{}
		for _, m := range humanMoveTargets[from] {
			got = append(got, m.to)
		}
		if strings.Join(got, ",") != strings.Join(tos, ",") {
			t.Fatalf("moves out of %q are %v, want %v", from, got, tos)
		}
	}
	if len(humanMoveTargets) != 5 {
		t.Fatalf("the matrix has %d source states, want 5 (proposed must not be one)", len(humanMoveTargets))
	}
	// Every move's `from` must be the key it hangs under, or the store rewinds
	// get a predicate that never matches.
	for from, moves := range humanMoveTargets {
		for _, m := range moves {
			if m.from != from {
				t.Fatalf("move %s → %s is filed under %q", m.from, m.to, from)
			}
		}
	}
}

// ── 2. A person walking their own task through its life ──────────────────────

func TestMoveStartClaimsForTheHuman(t *testing.T) {
	canvasID := uuid.New()
	task := humanTask("approved")
	f := newMoveStore(task)
	h := NewHandler(f, nil, nil)

	w := httptest.NewRecorder()
	h.MoveAction(w, moveRequest(t, canvasID, task.ID, map[string]any{"to": "executing"}))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}

	stored := f.get(t, task.ID)
	if stored.State != "executing" {
		t.Fatalf("state %q, want executing", stored.State)
	}
	if stored.ClaimedBy == nil || *stored.ClaimedBy != humanClaimant {
		t.Fatalf("claimedBy %v, want %q", stored.ClaimedBy, humanClaimant)
	}
	if stored.ClaimedAt == nil {
		t.Fatalf("claimedAt not stamped — the board shows 'working for …' off it")
	}
	// The reason claimTaskAs grew a `presence` flag: a person is not a fleet
	// member, and an agents row named "human" would sit in the swarm view
	// permanently online for the life of the canvas.
	time.Sleep(50 * time.Millisecond) // the touch is detached when it happens at all
	f.mu.Lock()
	touched := append([]string(nil), f.touched...)
	f.mu.Unlock()
	if len(touched) != 0 {
		t.Fatalf("a human start registered agents %v", touched)
	}
	entry := lastAudit(t, stored)
	if entry.FromState != "approved" || entry.ToState != "executing" {
		t.Fatalf("audit entry says %q → %q", entry.FromState, entry.ToState)
	}
	if entry.Actor != AuthorHuman {
		t.Fatalf("audit actor %q, want %q", entry.Actor, AuthorHuman)
	}
	if len(entry.Change) != 1 || entry.Change[0] != store.StateChange {
		t.Fatalf("audit change %v, want [%q]", entry.Change, store.StateChange)
	}
	// Reverted keys the UI's "edited after approval" notice. A state move never
	// costs an approval, so it must never look like one.
	if entry.Reverted {
		t.Fatalf("a state move recorded itself as an approval-reverting edit")
	}
}

// An agent already holding the task wins: the human gets the same structured
// 409 the losing worker does, naming the holder.
func TestMoveStartLosesToAnAgentClaim(t *testing.T) {
	canvasID := uuid.New()
	task := humanTask("approved")
	f := newMoveStore(task)
	h := NewHandler(f, nil, nil)
	// The agent got there first.
	if _, _, err := f.ClaimAction(context.Background(), canvasID, task.ID, "worker-3"); err != nil {
		t.Fatalf("seed claim: %v", err)
	}

	w := httptest.NewRecorder()
	h.MoveAction(w, moveRequest(t, canvasID, task.ID, map[string]any{"to": "executing"}))
	if w.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409 (body %s)", w.Code, w.Body.String())
	}
	var body map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["error"] != "already_claimed" || body["claimedBy"] != "worker-3" {
		t.Fatalf("409 body %v, want already_claimed by worker-3", body)
	}
}

func TestMoveCompleteWritesResultAuditAndWebhook(t *testing.T) {
	canvasID := uuid.New()
	task := humanTask("executing")
	f := newMoveStore(task)
	em := &recordingEmitter{}
	h := NewHandler(f, nil, nil, WithTaskEvents(em))

	w := httptest.NewRecorder()
	h.MoveAction(w, moveRequest(t, canvasID, task.ID,
		map[string]any{"to": "done", "note": "shipped in 748b348"}))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}

	stored := f.get(t, task.ID)
	if stored.State != "done" {
		t.Fatalf("state %q, want done", stored.State)
	}
	if stored.Result == nil || *stored.Result != "shipped in 748b348" {
		t.Fatalf("result %v, want the note", stored.Result)
	}
	// The audit entry rides the SAME write as the transition, so it must be in
	// the payload the transition stored — not appended by a second round trip.
	entry := lastAudit(t, stored)
	if entry.ToState != "done" || !strings.Contains(entry.Summary, "748b348") {
		t.Fatalf("audit entry %+v does not describe the completion", entry)
	}
	// The content the human approved must survive an audit-carrying write.
	var p map[string]any
	if err := json.Unmarshal(stored.Payload, &p); err != nil {
		t.Fatalf("stored payload: %v", err)
	}
	if p["title"] != "Write the migration" || p["assignee"] != "human" {
		t.Fatalf("the move rewrote the payload: %v", p)
	}
	// A terminal state is a terminal state whoever reached it: a receiver
	// waiting on task.completed must not hang because a person pressed Done.
	em.wantTypes(t, "task.completed")
}

func TestMoveGiveUpWritesTheReasonAsError(t *testing.T) {
	canvasID := uuid.New()
	task := humanTask("executing")
	f := newMoveStore(task)
	em := &recordingEmitter{}
	h := NewHandler(f, nil, nil, WithTaskEvents(em))

	w := httptest.NewRecorder()
	h.MoveAction(w, moveRequest(t, canvasID, task.ID,
		map[string]any{"to": "failed", "note": "blocked on the Supabase migration"}))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	stored := f.get(t, task.ID)
	if stored.State != "failed" {
		t.Fatalf("state %q, want failed", stored.State)
	}
	if stored.Error == nil || *stored.Error != "blocked on the Supabase migration" {
		t.Fatalf("error %v, want the note", stored.Error)
	}
	if stored.Result != nil {
		t.Fatalf("a failure wrote a result: %v", *stored.Result)
	}
	em.wantTypes(t, "task.completed") // state:"failed" inside — see task_events.go
}

// ── 3. The rewinds ───────────────────────────────────────────────────────────

func TestMoveReopenClearsTheLastLife(t *testing.T) {
	canvasID := uuid.New()
	task := humanTask("done")
	task.Result, task.ClaimedBy = ptr("done in a4b1c2d"), ptr("worker-3")
	f := newMoveStore(task)
	em := &recordingEmitter{}
	h := NewHandler(f, nil, nil, WithTaskEvents(em))

	w := httptest.NewRecorder()
	h.MoveAction(w, moveRequest(t, canvasID, task.ID,
		map[string]any{"to": "approved", "note": "the migration was never applied"}))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}

	stored := f.get(t, task.ID)
	if stored.State != "approved" {
		t.Fatalf("state %q, want approved", stored.State)
	}
	// A card back in Ready must not advertise the outcome of the life being
	// undone — it would match the has-commit filter and report work that no
	// longer stands.
	if stored.Result != nil || stored.ClaimedBy != nil {
		t.Fatalf("reopen kept result=%v claimedBy=%v", stored.Result, stored.ClaimedBy)
	}
	// The reason for the reopen is only recoverable from the audit trail, since
	// the result column it would otherwise live in is (correctly) cleared.
	if entry := lastAudit(t, stored); !strings.Contains(entry.Summary, "never applied") {
		t.Fatalf("the reopen note is not in the audit entry: %+v", entry)
	}
	// A rewind is not an approval — re-firing task.approved would make a fleet
	// subscribed to it re-run work it already picked up. But this particular
	// rewind undoes a TERMINAL state, retracting the task.completed this canvas
	// already published, so since TDM-170 it fires an event of its own. A human's
	// reopen and a reviewer's bounce are the same fact to a receiver; `returned.by`
	// is what tells them apart.
	em.settleTypes(t, webhooks.EventTaskReturned)
	if by := em.recorded()[0].body["returned"].(map[string]any)["by"]; by != AuthorHuman {
		t.Fatalf("returned.by = %v, want %q for a board reopen", by, AuthorHuman)
	}
}

func TestMoveReconsiderReturnsToTheGate(t *testing.T) {
	canvasID := uuid.New()
	task := humanTask("rejected")
	task.Error = ptr("out of scope")
	f := newMoveStore(task)
	h := NewHandler(f, nil, nil)

	w := httptest.NewRecorder()
	h.MoveAction(w, moveRequest(t, canvasID, task.ID, map[string]any{"to": "proposed"}))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	stored := f.get(t, task.ID)
	if stored.State != "proposed" {
		t.Fatalf("state %q, want proposed", stored.State)
	}
	// It is going back INTO the gate: a proposed card rendering "approved by …"
	// is a lie, and the rejection reason is no longer why it's there.
	if stored.ApprovedBy != nil {
		t.Fatalf("a proposed task still claims approval by %q", *stored.ApprovedBy)
	}
	if stored.Error != nil {
		t.Fatalf("the rejection reason survived the reconsider: %q", *stored.Error)
	}
}

// Release and requeue kept their own endpoints; both now run on rewindTask, so
// this asserts the shared body did not change what they do — and that they gained
// the audit entry every other human move writes.
func TestReleaseAndRequeueStillWorkThroughRewind(t *testing.T) {
	for _, tc := range []struct {
		name  string
		from  string
		call  func(*Handler, http.ResponseWriter, *http.Request)
		claim bool
	}{
		{"release", "executing", func(h *Handler, w http.ResponseWriter, r *http.Request) { h.ReleaseAction(w, r) }, true},
		{"requeue", "failed", func(h *Handler, w http.ResponseWriter, r *http.Request) { h.RequeueAction(w, r) }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			canvasID := uuid.New()
			task := humanTask(tc.from)
			if tc.claim {
				task.ClaimedBy = ptr("worker-9")
			} else {
				task.Error = ptr("tests red")
			}
			f := newMoveStore(task)
			h := NewHandler(f, nil, nil)

			w := httptest.NewRecorder()
			// No body at all — the pre-existing web callers send none, and an
			// empty body must not read as a bad request.
			r := canvasRequest(t, "POST", "/api/canvas/actions/"+task.ID.String()+"/"+tc.name, nil, canvasID, task.ID.String())
			tc.call(h, w, r.WithContext(WithAuthor(r.Context(), AuthorHuman)))
			if w.Code != http.StatusOK {
				t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
			}
			stored := f.get(t, task.ID)
			if stored.State != "approved" {
				t.Fatalf("state %q, want approved", stored.State)
			}
			if stored.ClaimedBy != nil || stored.Error != nil {
				t.Fatalf("%s left claimedBy=%v error=%v", tc.name, stored.ClaimedBy, stored.Error)
			}
			if entry := lastAudit(t, stored); entry.ToState != "approved" {
				t.Fatalf("%s recorded %+v", tc.name, entry)
			}
		})
	}
}

// ── 4. Shape of the endpoint ─────────────────────────────────────────────────

func TestMoveIdempotentAndIllegal(t *testing.T) {
	canvasID := uuid.New()

	t.Run("already there", func(t *testing.T) {
		task := humanTask("done")
		f := newMoveStore(task)
		h := NewHandler(f, nil, nil)
		w := httptest.NewRecorder()
		// 'done' → 'done' is not in the matrix at all; a retry whose first
		// response was lost must still read as the success it was.
		h.MoveAction(w, moveRequest(t, canvasID, task.ID, map[string]any{"to": "done"}))
		if w.Code != http.StatusOK {
			t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
		}
		if len(auditOf(t, f.get(t, task.ID))) != 0 {
			t.Fatalf("an idempotent no-op wrote an audit entry")
		}
	})

	t.Run("illegal move lists the legal ones", func(t *testing.T) {
		task := humanTask("done")
		f := newMoveStore(task)
		h := NewHandler(f, nil, nil)
		w := httptest.NewRecorder()
		h.MoveAction(w, moveRequest(t, canvasID, task.ID, map[string]any{"to": "executing"}))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status %d, want 400", w.Code)
		}
		var body struct {
			State string              `json:"state"`
			Moves []map[string]string `json:"moves"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body.State != "done" || len(body.Moves) != 1 || body.Moves[0]["to"] != "approved" {
			t.Fatalf("400 body %+v, want state done and one move to approved", body)
		}
	})

	t.Run("missing target", func(t *testing.T) {
		task := humanTask("approved")
		f := newMoveStore(task)
		h := NewHandler(f, nil, nil)
		w := httptest.NewRecorder()
		h.MoveAction(w, moveRequest(t, canvasID, task.ID, map[string]any{}))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status %d, want 400", w.Code)
		}
	})

	t.Run("epics are the lens, not the work", func(t *testing.T) {
		epic := &store.Action{
			ID: uuid.New(), Type: "epic", State: "approved",
			Payload: json.RawMessage(`{"title":"E10"}`),
		}
		f := newMoveStore(epic)
		h := NewHandler(f, nil, nil)
		w := httptest.NewRecorder()
		h.MoveAction(w, moveRequest(t, canvasID, epic.ID, map[string]any{"to": "executing"}))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status %d, want 400 (body %s)", w.Code, w.Body.String())
		}
		if got := f.get(t, epic.ID).State; got != "approved" {
			t.Fatalf("the epic moved to %q", got)
		}
	})

	t.Run("oversized note", func(t *testing.T) {
		task := humanTask("executing")
		f := newMoveStore(task)
		h := NewHandler(f, nil, nil)
		w := httptest.NewRecorder()
		h.MoveAction(w, moveRequest(t, canvasID, task.ID,
			map[string]any{"to": "done", "note": strings.Repeat("x", maxMoveNote+1)}))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status %d, want 400", w.Code)
		}
		if got := f.get(t, task.ID).State; got != "executing" {
			t.Fatalf("a rejected note still moved the task to %q", got)
		}
	})
}

// Provenance is the server's conclusion, never the body's claim. A route without
// the middleware records "unknown" rather than guessing "human" — the exact lie
// the provenance work exists to prevent.
func TestMoveAuditActorIsServerDerived(t *testing.T) {
	canvasID := uuid.New()
	task := humanTask("failed")
	f := newMoveStore(task)
	h := NewHandler(f, nil, nil)

	w := httptest.NewRecorder()
	// Provenance was NOT derived for this request: clear the author canvasRequest
	// stamps by default (WithAuthor "" reads back as nil, i.e. no middleware ran),
	// so MoveAction must record "unknown" rather than trust the body's actor.
	r := canvasRequest(t, "POST", "/move",
		map[string]any{"to": "approved", "actor": "human", "authoredBy": "human"},
		canvasID, task.ID.String())
	r = r.WithContext(WithAuthor(r.Context(), ""))
	h.MoveAction(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	if entry := lastAudit(t, f.get(t, task.ID)); entry.Actor != "unknown" {
		t.Fatalf("audit actor %q, want unknown — the body must not be able to set it", entry.Actor)
	}
}
