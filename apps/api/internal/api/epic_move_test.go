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
	"github.com/google/uuid"
)

// TDM-189 — the owner's state moves on a BATCH
// (POST /api/canvas/epics/{id}/move).
//
// What these tests are FOR, in priority order:
//
//  1. THE GATE HOLDS, on epics as it does on tasks. No move puts an epic in
//     'approved', and 'proposed' has no move targets at all — approve/reject
//     stay the only door into and out of the gate, because they are what stamps
//     approved_by and runs the task cascade. TestEpicMoveCannotLeaveProposed
//     and TestEpicMoveNeverReachesApproved walk every state to prove there is
//     no accidental one.
//  2. THE CASCADE'S BOUNDARY. Un-approving takes back exactly the tickets that
//     were workable only because this epic was approved — and nothing else.
//     Executing work, finished work, individually-approved work and another
//     batch's work are all untouched, which is the difference between an undo
//     and a wrecking ball.
//  3. AGENTS DO NOT GAIN THIS VERB. Same human-only rule, from the same
//     server-derived provenance, as the epic approval it undoes.
//  4. Every transition leaves the audit entry the board reads, with the actor
//     the server derived and the reason verbatim.

// ── Fake store ────────────────────────────────────────────────────────────────

// epicMoveFakeStore models the two store methods this endpoint uses the way the
// real ones behave: a conditional UPDATE predicated on the state the caller
// believed the row was in, and a bulk UPDATE whose predicates ARE the cascade
// rules. Anything else panics through the embedded nil interface.
type epicMoveFakeStore struct {
	store.Store
	mu      sync.Mutex
	actions map[uuid.UUID]*store.Action
	// moveErr, when set, is what MoveEpic returns instead of moving.
	moveErr error
	// cascadeErr, when set, fails the un-approve cascade (the best-effort half).
	cascadeErr error
}

func newEpicMoveStore(actions ...*store.Action) *epicMoveFakeStore {
	f := &epicMoveFakeStore{actions: map[uuid.UUID]*store.Action{}}
	for _, a := range actions {
		f.actions[a.ID] = a
	}
	return f
}

func (f *epicMoveFakeStore) GetAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ErrActionNotFound
	}
	cp := *a
	return &cp, nil
}

// MoveEpic mirrors the real conditional UPDATE: predicated on `from` and
// type='epic', clearing what the store clears (approved_by on the way back into
// the gate, `error` always, re-set only when this move IS the rejection).
func (f *epicMoveFakeStore) MoveEpic(_ context.Context, _ uuid.UUID, id uuid.UUID, from, to, reason string) (*store.Action, int, error) {
	if f.moveErr != nil {
		return nil, 0, f.moveErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, 0, store.ErrActionNotFound
	}
	if a.Type != "epic" {
		return nil, 0, fmt.Errorf("%w: only epics can be moved this way (this is a %q)",
			store.ErrIllegalActionState, a.Type)
	}
	if a.State == to {
		cp := *a
		return &cp, 0, nil // idempotent retry
	}
	if a.State != from {
		return nil, 0, fmt.Errorf("%w: cannot move epic from %q to %q (it is %q now)",
			store.ErrIllegalActionState, from, to, a.State)
	}
	a.State, a.Error = to, nil
	if to == "proposed" {
		a.ApprovedBy = nil
	}
	if to == "rejected" && strings.TrimSpace(reason) != "" {
		r := reason
		a.Error = &r
	}
	cp := *a
	return &cp, 1, nil
}

// UnapproveEpicTasks mirrors the real bulk UPDATE's predicates one for one —
// they ARE the cascade rules, so the tests must exercise them rather than a
// looser Go copy.
func (f *epicMoveFakeStore) UnapproveEpicTasks(_ context.Context, _ uuid.UUID, epicID uuid.UUID, onlyApprovedBy string) ([]*store.Action, error) {
	if f.cascadeErr != nil {
		return nil, f.cascadeErr
	}
	if onlyApprovedBy == "" {
		return []*store.Action{}, nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []*store.Action{}
	for _, a := range f.actions {
		if a.Type != "task" || a.State != "approved" || a.ClaimedBy != nil {
			continue
		}
		if a.ApprovedBy == nil || *a.ApprovedBy != onlyApprovedBy {
			continue
		}
		var p struct {
			EpicID string `json:"epicId"`
		}
		_ = json.Unmarshal(a.Payload, &p)
		if p.EpicID != epicID.String() {
			continue
		}
		a.State, a.ApprovedBy = "proposed", nil
		cp := *a
		out = append(out, &cp)
	}
	return out, nil
}

// AppendActionAudit runs the REAL store.AppendAudit over the stored payload, so
// these tests exercise the actual audit rule rather than a second copy of it.
func (f *epicMoveFakeStore) AppendActionAudit(_ context.Context, _ uuid.UUID, id uuid.UUID, entry store.ContentAudit) (json.RawMessage, error) {
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

// GetCanvasState backs the async post-write broadcast; erroring makes it a no-op.
func (f *epicMoveFakeStore) GetCanvasState(_ context.Context, _ uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in tests")
}

func (f *epicMoveFakeStore) get(t *testing.T, id uuid.UUID) *store.Action {
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

func epicIn(state string) *store.Action {
	a := &store.Action{
		ID: uuid.New(), Kind: "action", Type: "epic", State: state,
		Payload:    json.RawMessage(`{"title":"Reversible board states"}`),
		ProposedBy: "agent",
		UpdatedAt:  time.Now().UTC(),
	}
	if state == "approved" || state == "done" {
		a.ApprovedBy = ptr("human")
	}
	return a
}

// epicTask is a ticket under a batch: `state` is where it sits, `approvedBy`
// says WHY it is where it is (the cascade's whole discriminator).
func epicTask(epicID uuid.UUID, state, approvedBy string, ticket int) *store.Action {
	a := &store.Action{
		ID: uuid.New(), Kind: "action", Type: "task", State: state, Ticket: ptr(ticket),
		Payload: json.RawMessage(fmt.Sprintf(
			`{"title":"Ticket %d","assignee":"agent","epicId":%q}`, ticket, epicID.String())),
		ProposedBy: "agent",
	}
	if approvedBy != "" {
		a.ApprovedBy = ptr(approvedBy)
	}
	if state == "executing" || state == "done" {
		now := time.Now().UTC()
		a.ClaimedBy, a.ClaimedAt = ptr("worker-1"), &now
	}
	return a
}

// epicMoveRequest is the call as the board makes it, WITH the provenance the
// route group's middleware derives.
func epicMoveRequest(t *testing.T, canvasID, id uuid.UUID, body any) *http.Request {
	t.Helper()
	r := canvasRequest(t, "POST", "/api/canvas/epics/"+id.String()+"/move", body, canvasID, id.String())
	return r.WithContext(WithAuthor(r.Context(), AuthorHuman))
}

// moveEpicJSON runs the endpoint and decodes the answer.
func moveEpicJSON(t *testing.T, h *Handler, canvasID, id uuid.UUID, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	h.MoveEpic(w, epicMoveRequest(t, canvasID, id, body))
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response (%d %s): %v", w.Code, w.Body.String(), err)
	}
	return w, out
}

// ── 1. The gate ──────────────────────────────────────────────────────────────

// The load-bearing test: a proposed epic has NO legal move, to any state. If
// this ever fails, /move has become a second (unstamped, un-cascaded) door into
// the ready queue for every ticket in the batch.
func TestEpicMoveCannotLeaveProposed(t *testing.T) {
	for _, to := range []string{"approved", "executing", "done", "failed", "rejected"} {
		t.Run(to, func(t *testing.T) {
			canvasID := uuid.New()
			epic := epicIn("proposed")
			f := newEpicMoveStore(epic)
			h := NewHandler(f, nil, nil)

			w, body := moveEpicJSON(t, h, canvasID, epic.ID, map[string]any{"to": to})
			if w.Code != http.StatusBadRequest {
				t.Fatalf("proposed → %s: status %d, want 400", to, w.Code)
			}
			if body["error"] != "epic_move_illegal" {
				t.Fatalf("error code %v, want epic_move_illegal", body["error"])
			}
			if got := f.get(t, epic.ID).State; got != "proposed" {
				t.Fatalf("proposed → %s moved the epic to %q", to, got)
			}
			if moves, _ := body["moves"].([]any); len(moves) != 0 {
				t.Fatalf("offered moves out of proposed: %v", moves)
			}
			// The refusal has to point at the right endpoint, or a client author
			// reasonably concludes the board is broken rather than gated.
			if msg, _ := body["message"].(string); !strings.Contains(msg, "/approve") {
				t.Fatalf("400 does not point at the approval gate: %q", msg)
			}
		})
	}
}

// No move, from any state, may land an epic in 'approved'. Approval is the gate;
// a rewind that granted it would be a rewind that approves a whole batch.
func TestEpicMoveNeverReachesApproved(t *testing.T) {
	for from, moves := range epicMoveTargets {
		for _, m := range moves {
			if m.to == "approved" {
				t.Fatalf("epic move %s → %s grants approval outside the gate", from, m.to)
			}
			if m.to != "proposed" && m.to != "rejected" {
				t.Fatalf("epic move %s → %s targets a state outside {proposed, rejected}", from, m.to)
			}
		}
	}
}

// The matrix itself, asserted as a whole. A new entry here must be a deliberate
// edit to this table, not a side effect of touching the dispatch.
func TestEpicMoveMatrix(t *testing.T) {
	want := map[string][]string{
		"approved": {"proposed"},
		"done":     {"proposed", "rejected"},
		"rejected": {"proposed"},
	}
	for from, tos := range want {
		got := []string{}
		for _, m := range epicMoveTargets[from] {
			got = append(got, m.to)
		}
		if strings.Join(got, ",") != strings.Join(tos, ",") {
			t.Fatalf("moves out of %q are %v, want %v", from, got, tos)
		}
	}
	if len(epicMoveTargets) != 3 {
		t.Fatalf("the matrix has %d source states, want 3 (proposed must not be one)", len(epicMoveTargets))
	}
	// Every move's `from` must be the key it hangs under, or the store's
	// conditional UPDATE gets a predicate that never matches.
	for from, moves := range epicMoveTargets {
		for _, m := range moves {
			if m.from != from {
				t.Fatalf("epic move %s → %s is filed under %q", m.from, m.to, from)
			}
		}
	}
}

// done → approved is the named illegal move in the brief: re-approving is the
// gate, not a move, so the batch has to go back through 'proposed' first.
func TestEpicMoveDoneToApprovedRefused(t *testing.T) {
	canvasID := uuid.New()
	epic := epicIn("done")
	task := epicTask(epic.ID, "approved", epicApprovalStamp, 1)
	f := newEpicMoveStore(epic, task)
	h := NewHandler(f, nil, nil)

	w, body := moveEpicJSON(t, h, canvasID, epic.ID, map[string]any{"to": "approved"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400 (body %s)", w.Code, w.Body.String())
	}
	if body["error"] != "epic_move_illegal" {
		t.Fatalf("error code %v, want epic_move_illegal", body["error"])
	}
	if body["state"] != "done" {
		t.Fatalf("refusal reports state %v, want done", body["state"])
	}
	if got := f.get(t, epic.ID).State; got != "done" {
		t.Fatalf("the refused move still changed the epic to %q", got)
	}
	// A refused move must not cascade — the tickets are untouched.
	if got := f.get(t, task.ID).State; got != "approved" {
		t.Fatalf("a refused move cascaded: ticket is %q", got)
	}
	// The legal way out is listed, so a client can offer it.
	moves, _ := body["moves"].([]any)
	if len(moves) != 2 {
		t.Fatalf("moves out of done: %v, want re-open + retire", moves)
	}
}

// ── 2. The transitions ───────────────────────────────────────────────────────

// Each listed transition works, end to end, through the endpoint.
func TestEpicMoveTransitions(t *testing.T) {
	cases := []struct {
		name, from, to string
	}{
		{"un-approve", "approved", "proposed"},
		{"re-open", "done", "proposed"},
		{"retire", "done", "rejected"},
		{"revive", "rejected", "proposed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			canvasID := uuid.New()
			epic := epicIn(tc.from)
			f := newEpicMoveStore(epic)
			h := NewHandler(f, nil, nil)

			w, body := moveEpicJSON(t, h, canvasID, epic.ID, map[string]any{"to": tc.to})
			if w.Code != http.StatusOK {
				t.Fatalf("%s: status %d, want 200 (body %s)", tc.name, w.Code, w.Body.String())
			}
			if body["moved"] != true {
				t.Fatalf("%s: moved %v, want true", tc.name, body["moved"])
			}
			if body["from"] != tc.from || body["to"] != tc.to {
				t.Fatalf("%s: answer says %v → %v", tc.name, body["from"], body["to"])
			}
			stored := f.get(t, epic.ID)
			if stored.State != tc.to {
				t.Fatalf("%s: state %q, want %q", tc.name, stored.State, tc.to)
			}
			// Back INTO the gate means the approval stamp goes with it — an epic
			// waiting for approval that renders "approved by human" is a lie.
			if tc.to == "proposed" && stored.ApprovedBy != nil {
				t.Fatalf("%s: approvedBy survived the move back into the gate: %q", tc.name, *stored.ApprovedBy)
			}
		})
	}
}

// Reviving a rejected batch must not carry its rejection reason forward — the
// rollup derives the `review` block off state + error, and a stale reason there
// is a verdict that no longer stands.
func TestEpicRetireStoresReasonAndReviveClearsIt(t *testing.T) {
	canvasID := uuid.New()
	epic := epicIn("done")
	f := newEpicMoveStore(epic)
	h := NewHandler(f, nil, nil)

	w, _ := moveEpicJSON(t, h, canvasID, epic.ID,
		map[string]any{"to": "rejected", "reason": "shipped behind a flag we then deleted"})
	if w.Code != http.StatusOK {
		t.Fatalf("retire: status %d (body %s)", w.Code, w.Body.String())
	}
	stored := f.get(t, epic.ID)
	if stored.Error == nil || *stored.Error != "shipped behind a flag we then deleted" {
		t.Fatalf("rejection reason not stored: %v", stored.Error)
	}
	// It reads back through the SAME derivation the rollup and task_get use.
	fb := deriveReviewFeedback(stored)
	if fb == nil || fb.Outcome != reviewRejected || !strings.Contains(fb.Reason, "behind a flag") {
		t.Fatalf("review feedback %+v does not carry the rejection", fb)
	}

	w, _ = moveEpicJSON(t, h, canvasID, epic.ID, map[string]any{"to": "proposed"})
	if w.Code != http.StatusOK {
		t.Fatalf("revive: status %d (body %s)", w.Code, w.Body.String())
	}
	revived := f.get(t, epic.ID)
	if revived.Error != nil {
		t.Fatalf("the revived epic kept its rejection reason: %q", *revived.Error)
	}
	if fb := deriveReviewFeedback(revived); fb != nil {
		t.Fatalf("a revived epic still reads as returned: %+v", fb)
	}
}

// A move whose response was lost must not come back as "illegal move" on the
// retry. It answers 200 with moved:false and changes nothing.
func TestEpicMoveIsIdempotent(t *testing.T) {
	canvasID := uuid.New()
	epic := epicIn("proposed")
	f := newEpicMoveStore(epic)
	h := NewHandler(f, nil, nil)

	w, body := moveEpicJSON(t, h, canvasID, epic.ID, map[string]any{"to": "proposed"})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	if body["moved"] != false {
		t.Fatalf("moved %v, want false on the already-there retry", body["moved"])
	}
	if got := f.get(t, epic.ID).State; got != "proposed" {
		t.Fatalf("state %q, want proposed", got)
	}
}

// ── 3. The cascade ───────────────────────────────────────────────────────────

// The boundary, in one canvas: un-approving takes back the tickets that were
// workable only because this epic was approved, and NOTHING else.
func TestEpicUnapproveCascadeBoundary(t *testing.T) {
	canvasID := uuid.New()
	epic := epicIn("approved")
	other := epicIn("approved")

	ready := epicTask(epic.ID, "approved", epicApprovalStamp, 1)           // ← the only one that moves
	executing := epicTask(epic.ID, "executing", epicApprovalStamp, 2)      // a worker holds it
	finished := epicTask(epic.ID, "done", epicApprovalStamp, 3)            // already reported
	byHuman := epicTask(epic.ID, "approved", "human", 4)                   // approved one at a time
	stillProposed := epicTask(epic.ID, "proposed", "", 5)                  // never approved
	elsewhere := epicTask(other.ID, "approved", epicApprovalStamp, 6)      // another batch
	claimedApproved := epicTask(epic.ID, "approved", epicApprovalStamp, 7) // stale claim record
	claimedApproved.ClaimedBy = ptr("worker-9")

	f := newEpicMoveStore(epic, other, ready, executing, finished, byHuman, stillProposed, elsewhere, claimedApproved)
	h := NewHandler(f, nil, nil)

	w, body := moveEpicJSON(t, h, canvasID, epic.ID,
		map[string]any{"to": "proposed", "reason": "the plan changed"})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}

	if got := f.get(t, ready.ID); got.State != "proposed" {
		t.Fatalf("the epic-approved unclaimed ticket is %q, want proposed", got.State)
	} else if got.ApprovedBy != nil {
		t.Fatalf("an un-approved ticket kept approvedBy %q", *got.ApprovedBy)
	}
	// Everything the cascade must NOT touch.
	untouched := map[string]struct {
		a    *store.Action
		want string
	}{
		"executing":            {executing, "executing"},
		"done":                 {finished, "done"},
		"approved by a human":  {byHuman, "approved"},
		"still proposed":       {stillProposed, "proposed"},
		"another batch":        {elsewhere, "approved"},
		"approved but claimed": {claimedApproved, "approved"},
	}
	for name, c := range untouched {
		if got := f.get(t, c.a.ID).State; got != c.want {
			t.Fatalf("cascade touched the %s ticket: %q, want %q", name, got, c.want)
		}
	}

	// The answer reports exactly what left the queue — the number a board renders
	// and the reason this cascade is synchronous.
	if body["unapprovedCount"] != float64(1) {
		t.Fatalf("unapprovedCount %v, want 1", body["unapprovedCount"])
	}
	lines, _ := body["unapproved"].([]any)
	if len(lines) != 1 {
		t.Fatalf("unapproved lines %v, want 1", lines)
	}
	line, _ := lines[0].(map[string]any)
	if line["ticketId"] != "TDM-1" || line["title"] != "Ticket 1" || line["state"] != "proposed" {
		t.Fatalf("unapproved line %v does not identify the ticket", line)
	}
}

// Retiring or re-opening a DONE batch withdraws its approval too — any ticket
// still sitting in the queue on the strength of it goes back to the gate. And
// nothing is ever rejected by the cascade: killing tickets stays a separate act.
func TestEpicCascadeRunsOnEveryMoveAndNeverRejects(t *testing.T) {
	for _, to := range []string{"proposed", "rejected"} {
		t.Run(to, func(t *testing.T) {
			canvasID := uuid.New()
			epic := epicIn("done")
			ready := epicTask(epic.ID, "approved", epicApprovalStamp, 1)
			f := newEpicMoveStore(epic, ready)
			h := NewHandler(f, nil, nil)

			w, _ := moveEpicJSON(t, h, canvasID, epic.ID, map[string]any{"to": to})
			if w.Code != http.StatusOK {
				t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
			}
			if got := f.get(t, ready.ID).State; got != "proposed" {
				t.Fatalf("ticket is %q after the batch moved to %q, want proposed", got, to)
			}
		})
	}
}

// The cascade is best-effort: a failure there must not fail a move that has
// already committed, or the owner is told nothing happened when half of it did.
func TestEpicMoveSurvivesACascadeFailure(t *testing.T) {
	canvasID := uuid.New()
	epic := epicIn("approved")
	f := newEpicMoveStore(epic)
	f.cascadeErr = fmt.Errorf("supabase said no")
	h := NewHandler(f, nil, nil)

	w, body := moveEpicJSON(t, h, canvasID, epic.ID, map[string]any{"to": "proposed"})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 — the epic move committed (body %s)", w.Code, w.Body.String())
	}
	if body["unapprovedCount"] != float64(0) {
		t.Fatalf("unapprovedCount %v, want 0 when the cascade failed", body["unapprovedCount"])
	}
	if got := f.get(t, epic.ID).State; got != "proposed" {
		t.Fatalf("epic state %q, want proposed", got)
	}
}

// ── 4. Authorization ─────────────────────────────────────────────────────────

// Agents do not gain this verb, on any policy. Same rule and same provenance as
// the epic approval it undoes.
func TestEpicMoveIsHumanOnly(t *testing.T) {
	for _, author := range []string{"agent:reviewer-1", AuthorAnonymous} {
		t.Run(author, func(t *testing.T) {
			canvasID := uuid.New()
			epic := epicIn("approved")
			task := epicTask(epic.ID, "approved", epicApprovalStamp, 1)
			f := newEpicMoveStore(epic, task)
			h := NewHandler(f, nil, nil)

			r := epicMoveRequest(t, canvasID, epic.ID, map[string]any{"to": "proposed"})
			r = r.WithContext(WithAuthor(r.Context(), author))
			w := httptest.NewRecorder()
			h.MoveEpic(w, r)

			if w.Code != http.StatusForbidden {
				t.Fatalf("%s: status %d, want 403 (body %s)", author, w.Code, w.Body.String())
			}
			var body map[string]string
			_ = json.Unmarshal(w.Body.Bytes(), &body)
			if body["error"] != "epic_move_human_only" {
				t.Fatalf("%s: error code %q, want epic_move_human_only", author, body["error"])
			}
			if got := f.get(t, epic.ID).State; got != "approved" {
				t.Fatalf("%s: the refused caller moved the epic to %q", author, got)
			}
			if got := f.get(t, task.ID).State; got != "approved" {
				t.Fatalf("%s: the refused caller cascaded: ticket is %q", author, got)
			}
		})
	}
}

// ── 5. The rest of the refusals ──────────────────────────────────────────────

func TestEpicMoveRefusals(t *testing.T) {
	canvasID := uuid.New()
	epic := epicIn("approved")
	task := epicTask(epic.ID, "approved", epicApprovalStamp, 1)
	f := newEpicMoveStore(epic, task)
	h := NewHandler(f, nil, nil)

	t.Run("target required", func(t *testing.T) {
		w, body := moveEpicJSON(t, h, canvasID, epic.ID, map[string]any{})
		if w.Code != http.StatusBadRequest || body["error"] != "epic_move_target_required" {
			t.Fatalf("status %d body %v, want 400 epic_move_target_required", w.Code, body)
		}
	})

	t.Run("reason too long", func(t *testing.T) {
		w, body := moveEpicJSON(t, h, canvasID, epic.ID, map[string]any{
			"to": "proposed", "reason": strings.Repeat("x", maxEpicMoveReason+1),
		})
		if w.Code != http.StatusBadRequest || body["error"] != "epic_move_reason_too_long" {
			t.Fatalf("status %d body %v, want 400 epic_move_reason_too_long", w.Code, body)
		}
		if got := f.get(t, epic.ID).State; got != "approved" {
			t.Fatalf("an over-long reason still moved the epic to %q", got)
		}
	})

	t.Run("not an epic", func(t *testing.T) {
		w, body := moveEpicJSON(t, h, canvasID, task.ID, map[string]any{"to": "proposed"})
		if w.Code != http.StatusBadRequest || body["error"] != "epic_move_not_an_epic" {
			t.Fatalf("status %d body %v, want 400 epic_move_not_an_epic", w.Code, body)
		}
		// …and it points at the endpoint that DOES move tasks.
		if msg, _ := body["message"].(string); !strings.Contains(msg, "/api/canvas/actions/{id}/move") {
			t.Fatalf("the refusal does not point at the task move endpoint: %q", msg)
		}
		if got := f.get(t, task.ID).State; got != "approved" {
			t.Fatalf("the task moved anyway: %q", got)
		}
	})

	t.Run("not found", func(t *testing.T) {
		w, body := moveEpicJSON(t, h, canvasID, uuid.New(), map[string]any{"to": "proposed"})
		if w.Code != http.StatusNotFound || body["error"] != "epic_not_found" {
			t.Fatalf("status %d body %v, want 404 epic_not_found", w.Code, body)
		}
	})

	t.Run("invalid id", func(t *testing.T) {
		r := canvasRequest(t, "POST", "/api/canvas/epics/nope/move",
			map[string]any{"to": "proposed"}, canvasID, "nope")
		r = r.WithContext(WithAuthor(r.Context(), AuthorHuman))
		w := httptest.NewRecorder()
		h.MoveEpic(w, r)
		var body map[string]string
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		if w.Code != http.StatusBadRequest || body["error"] != "epic_move_invalid_id" {
			t.Fatalf("status %d body %v, want 400 epic_move_invalid_id", w.Code, body)
		}
	})

	// The epic moved under the request: the conditional UPDATE matched nothing,
	// and the caller gets the same coded refusal the matrix gives.
	t.Run("lost the race", func(t *testing.T) {
		raced := newEpicMoveStore(epicIn("approved"))
		var id uuid.UUID
		for k := range raced.actions {
			id = k
		}
		raced.moveErr = fmt.Errorf("%w: cannot move epic from %q to %q (it is %q now)",
			store.ErrIllegalActionState, "approved", "proposed", "done")
		rh := NewHandler(raced, nil, nil)
		w, body := moveEpicJSON(t, rh, canvasID, id, map[string]any{"to": "proposed"})
		if w.Code != http.StatusBadRequest || body["error"] != "epic_move_illegal" {
			t.Fatalf("status %d body %v, want 400 epic_move_illegal", w.Code, body)
		}
	})
}

// ── 6. The audit trail ───────────────────────────────────────────────────────

// Every transition is recorded on the epic's audit trail with the actor the
// SERVER derived and the reason verbatim — the same trail, shape and reader as a
// task move's, so an epic's history renders with the board's existing chips.
func TestEpicMoveRecordsTheAudit(t *testing.T) {
	canvasID := uuid.New()
	epic := epicIn("approved")
	f := newEpicMoveStore(epic)
	h := NewHandler(f, nil, nil)

	reason := "the messaging half is a separate service — see the note on the batch"
	w, _ := moveEpicJSON(t, h, canvasID, epic.ID, map[string]any{"to": "proposed", "reason": reason})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}

	entry := lastAudit(t, f.get(t, epic.ID))
	if entry.FromState != "approved" || entry.ToState != "proposed" {
		t.Fatalf("audit entry says %q → %q", entry.FromState, entry.ToState)
	}
	if entry.Actor != AuthorHuman {
		t.Fatalf("audit actor %q, want %q", entry.Actor, AuthorHuman)
	}
	// Verbatim, not the 80-rune summary excerpt: the reason IS the correction.
	if entry.Note != reason {
		t.Fatalf("audit note %q, want the reason verbatim", entry.Note)
	}
	if len(entry.Change) != 1 || entry.Change[0] != store.StateChange {
		t.Fatalf("audit change %v, want [%q]", entry.Change, store.StateChange)
	}
	// Reverted keys the UI's "edited after approval" notice; a state move is not
	// a content edit and must never look like one.
	if entry.Reverted {
		t.Fatalf("an epic state move recorded itself as an approval-reverting edit")
	}
	// The response carries the entry it just wrote, so the board renders the chip
	// without a second read.
	if !strings.Contains(w.Body.String(), "\"audit\"") {
		t.Fatalf("the answer does not carry the audit trail: %s", w.Body.String())
	}
}

// A move with no reason is fine — an owner correcting their own click owes
// nobody an explanation — and still leaves a trail.
func TestEpicMoveWithoutAReasonStillAudits(t *testing.T) {
	canvasID := uuid.New()
	epic := epicIn("rejected")
	f := newEpicMoveStore(epic)
	h := NewHandler(f, nil, nil)

	w, _ := moveEpicJSON(t, h, canvasID, epic.ID, map[string]any{"to": "proposed"})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	entry := lastAudit(t, f.get(t, epic.ID))
	if entry.FromState != "rejected" || entry.ToState != "proposed" || entry.Note != "" {
		t.Fatalf("audit entry %+v", entry)
	}
}
