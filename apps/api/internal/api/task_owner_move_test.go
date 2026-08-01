package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// TDM-190 — the owner's state moves on ONE TICKET
// (POST /api/canvas/tasks/{id}/move).
//
// What these tests are FOR, in priority order:
//
//  1. THE GATE HOLDS, on a ticket as it does on a batch. No move here reaches
//     'approved' — every one lands BEHIND the gate — and 'proposed' has no move
//     targets at all. TestTaskGateMoveNeverReachesApproved and
//     TestTaskGateMoveCannotLeaveProposed walk the matrix and every target state
//     to prove there is no accidental one.
//  2. THE CLAIM GUARD. In-flight work has no move at all (a worker must not have
//     a ticket pulled back to the gate underneath it), and re-opening finished
//     work clears the claim and the now-stale result rather than leaving a card
//     at the gate advertising a run that no longer stands.
//  3. AGENTS DO NOT GAIN THIS VERB. Same human-only rule, from the same
//     server-derived provenance, as the approval it undoes — and unlike the
//     board's /move, it is CHECKED, not merely unadvertised.
//  4. Every transition leaves the audit entry the board reads, with the actor the
//     server derived and the reason verbatim — and a re-open's reason reaches the
//     author through the same `review` block a reviewer's bounce does.

// ── Fixtures ─────────────────────────────────────────────────────────────────

// ownerGateTask is a ticket as the owner finds it: `state` is where it sits, with the
// bookkeeping that state implies — finished work carries a claim and a result,
// and anything past the gate carries an approval stamp.
func ownerGateTask(state string) *store.Action {
	a := &store.Action{
		ID: uuid.New(), Kind: "action", Type: "task", State: state, Ticket: ptr(190),
		Payload:    json.RawMessage(`{"title":"Ship the move endpoint","assignee":"agent"}`),
		ProposedBy: "agent",
		UpdatedAt:  time.Now().UTC(),
	}
	switch state {
	case "approved", "executing", "done", "failed":
		a.ApprovedBy = ptr("human")
	}
	if state == "executing" || state == "done" {
		now := time.Now().UTC()
		a.ClaimedBy, a.ClaimedAt = ptr("worker-1"), &now
	}
	if state == "done" {
		a.Result = ptr("shipped in 748b348")
	}
	return a
}

// taskGateRequest is the call as the board makes it, WITH the provenance the
// route group's middleware derives.
func taskGateRequest(t *testing.T, canvasID, id uuid.UUID, body any) *http.Request {
	t.Helper()
	r := canvasRequest(t, "POST", "/api/canvas/tasks/"+id.String()+"/move", body, canvasID, id.String())
	return r.WithContext(WithAuthor(r.Context(), AuthorHuman))
}

// moveTaskJSON runs the endpoint and decodes the answer.
func moveTaskJSON(t *testing.T, h *Handler, canvasID, id uuid.UUID, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	h.MoveTask(w, taskGateRequest(t, canvasID, id, body))
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response (%d %s): %v", w.Code, w.Body.String(), err)
	}
	return w, out
}

// ── 1. The gate ──────────────────────────────────────────────────────────────

// The load-bearing test: a proposed ticket has NO legal move, to any state. It
// is already at the gate, and a move out of it would be a second (unstamped,
// un-announced) door into the ready queue.
func TestTaskGateMoveCannotLeaveProposed(t *testing.T) {
	for _, to := range []string{"approved", "executing", "done", "failed", "rejected"} {
		t.Run(to, func(t *testing.T) {
			canvasID := uuid.New()
			task := ownerGateTask("proposed")
			f := newMoveStore(task)
			h := NewHandler(f, nil, nil)

			w, body := moveTaskJSON(t, h, canvasID, task.ID, map[string]any{"to": to})
			if w.Code != http.StatusBadRequest {
				t.Fatalf("proposed → %s: status %d, want 400", to, w.Code)
			}
			if body["error"] != "task_move_illegal" {
				t.Fatalf("error code %v, want task_move_illegal", body["error"])
			}
			if got := f.get(t, task.ID).State; got != "proposed" {
				t.Fatalf("proposed → %s moved the ticket to %q", to, got)
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

// No move, from any state, may land a ticket in 'approved' — or anywhere other
// than 'proposed'. Approving is the gate; a rewind that granted it would put
// work in the ready queue with no stamp, no event and nobody's say-so.
func TestTaskGateMoveNeverReachesApproved(t *testing.T) {
	for from, moves := range taskGateMoveTargets {
		for _, m := range moves {
			if m.to == "approved" {
				t.Fatalf("task gate move %s → %s grants approval outside the gate", from, m.to)
			}
			if m.to != "proposed" {
				t.Fatalf("task gate move %s → %s targets a state outside the gate", from, m.to)
			}
		}
	}
}

// The matrix itself, asserted as a whole. A new entry here must be a deliberate
// edit to this table, not a side effect of touching the dispatch — and the
// absent keys are each a rule (see the file header).
func TestTaskGateMoveMatrix(t *testing.T) {
	want := map[string][]string{
		"approved": {"proposed"},
		"done":     {"proposed"},
		"rejected": {"proposed"},
	}
	for from, tos := range want {
		got := []string{}
		for _, m := range taskGateMoveTargets[from] {
			got = append(got, m.to)
		}
		if strings.Join(got, ",") != strings.Join(tos, ",") {
			t.Fatalf("moves out of %q are %v, want %v", from, got, tos)
		}
	}
	if len(taskGateMoveTargets) != 3 {
		t.Fatalf("the matrix has %d source states, want 3 (proposed, executing and failed must not be)",
			len(taskGateMoveTargets))
	}
	// Every move's `from` must be the key it hangs under, or store.ReopenAction's
	// conditional UPDATE gets a predicate that never matches.
	for from, moves := range taskGateMoveTargets {
		for _, m := range moves {
			if m.from != from {
				t.Fatalf("task gate move %s → %s is filed under %q", m.from, m.to, from)
			}
			if m.kind != moveKindRewind {
				t.Fatalf("task gate move %s → %s is not a rewind", m.from, m.to)
			}
		}
	}
	// The board's own matrix must not have grown these rows: it is checked by
	// surface only, and a hard-gated move sitting in it would be reachable
	// ungated through POST /api/canvas/actions/{id}/move.
	for _, m := range humanMoveTargets["approved"] {
		if m.to == "proposed" {
			t.Fatalf("un-approve leaked into the board's (surface-gated) human matrix")
		}
	}
	for _, m := range humanMoveTargets["done"] {
		if m.to == "proposed" {
			t.Fatalf("re-open-to-gate leaked into the board's (surface-gated) human matrix")
		}
	}
}

// ── 2. The transitions ───────────────────────────────────────────────────────

// Each listed transition works, end to end, through the endpoint.
func TestTaskGateMoveTransitions(t *testing.T) {
	cases := []struct {
		name, from string
	}{
		{"un-approve", "approved"},
		{"re-open", "done"},
		{"revive", "rejected"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			canvasID := uuid.New()
			task := ownerGateTask(tc.from)
			f := newMoveStore(task)
			h := NewHandler(f, nil, nil)

			w, body := moveTaskJSON(t, h, canvasID, task.ID, map[string]any{"to": "proposed"})
			if w.Code != http.StatusOK {
				t.Fatalf("%s: status %d, want 200 (body %s)", tc.name, w.Code, w.Body.String())
			}
			if body["moved"] != true {
				t.Fatalf("%s: moved %v, want true", tc.name, body["moved"])
			}
			if body["from"] != tc.from || body["to"] != "proposed" {
				t.Fatalf("%s: answer says %v → %v", tc.name, body["from"], body["to"])
			}
			stored := f.get(t, task.ID)
			if stored.State != "proposed" {
				t.Fatalf("%s: state %q, want proposed", tc.name, stored.State)
			}
			// Back INTO the gate means the approval stamp goes with it — a ticket
			// waiting for approval that renders "approved by human" is a lie, and a
			// stamp left behind is what the epic cascade would match on next time.
			if stored.ApprovedBy != nil {
				t.Fatalf("%s: approvedBy survived the move back into the gate: %q", tc.name, *stored.ApprovedBy)
			}
		})
	}
}

// Re-opening finished work clears the claim and the stale result — the same
// mechanics as a reviewer's bounce, and the reason it matters is the same: a
// ticket back at the gate showing a green "Result" (and matching the has-commit
// filter) reports work that no longer stands, and a claim left on it says a
// worker is holding something nobody can start.
func TestTaskGateReopenClearsClaimAndResult(t *testing.T) {
	canvasID := uuid.New()
	task := ownerGateTask("done")
	if task.ClaimedBy == nil || task.Result == nil {
		t.Fatalf("fixture is not finished work: %+v", task)
	}
	f := newMoveStore(task)
	h := NewHandler(f, nil, nil)

	w, _ := moveTaskJSON(t, h, canvasID, task.ID,
		map[string]any{"to": "proposed", "reason": "the migration is missing"})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	stored := f.get(t, task.ID)
	if stored.ClaimedBy != nil || stored.ClaimedAt != nil {
		t.Fatalf("the re-opened ticket kept its claim: %v", stored.ClaimedBy)
	}
	if stored.Result != nil {
		t.Fatalf("the re-opened ticket kept the stale result: %q", *stored.Result)
	}
	if stored.State != "proposed" {
		t.Fatalf("state %q, want proposed", stored.State)
	}
}

// A ticket a worker is HOLDING has no move at all: the claim guard is the
// absence of 'executing' from the matrix, so the only way to un-approve
// in-flight work is to release it first — two deliberate acts, not one that
// pulls the rug.
func TestTaskGateMoveWillNotTouchExecutingWork(t *testing.T) {
	canvasID := uuid.New()
	task := ownerGateTask("executing")
	f := newMoveStore(task)
	h := NewHandler(f, nil, nil)

	w, body := moveTaskJSON(t, h, canvasID, task.ID, map[string]any{"to": "proposed"})
	if w.Code != http.StatusBadRequest || body["error"] != "task_move_illegal" {
		t.Fatalf("status %d body %v, want 400 task_move_illegal", w.Code, body)
	}
	stored := f.get(t, task.ID)
	if stored.State != "executing" {
		t.Fatalf("the move took a ticket off a worker: %q", stored.State)
	}
	if stored.ClaimedBy == nil {
		t.Fatalf("the worker's claim was cleared by a refused move")
	}
	// The refusal names the way through, or the owner is simply stuck.
	if msg, _ := body["message"].(string); !strings.Contains(msg, "release") {
		t.Fatalf("the refusal does not point at release: %q", msg)
	}
}

// A move whose response was lost must not come back as "illegal move" on the
// retry. It answers 200 with moved:false and changes nothing.
func TestTaskGateMoveIsIdempotent(t *testing.T) {
	canvasID := uuid.New()
	task := ownerGateTask("proposed")
	f := newMoveStore(task)
	h := NewHandler(f, nil, nil)

	w, body := moveTaskJSON(t, h, canvasID, task.ID, map[string]any{"to": "proposed"})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	if body["moved"] != false {
		t.Fatalf("moved %v, want false on the already-there retry", body["moved"])
	}
	if got := f.get(t, task.ID).State; got != "proposed" {
		t.Fatalf("state %q, want proposed", got)
	}
	if len(auditOf(t, f.get(t, task.ID))) != 0 {
		t.Fatalf("the no-op wrote an audit entry")
	}
}

// ── 3. Authorization ─────────────────────────────────────────────────────────

// Agents do not gain this verb, on any policy. Same rule and same provenance as
// the approval it undoes — and unlike the board's /move, it is enforced here
// rather than left to the fact that no MCP tool advertises the route.
func TestTaskGateMoveIsHumanOnly(t *testing.T) {
	for _, author := range []string{"agent:reviewer-1", AuthorAnonymous} {
		t.Run(author, func(t *testing.T) {
			canvasID := uuid.New()
			task := ownerGateTask("approved")
			f := newMoveStore(task)
			h := NewHandler(f, nil, nil)

			r := taskGateRequest(t, canvasID, task.ID, map[string]any{"to": "proposed"})
			r = r.WithContext(WithAuthor(r.Context(), author))
			w := httptest.NewRecorder()
			h.MoveTask(w, r)

			if w.Code != http.StatusForbidden {
				t.Fatalf("%s: status %d, want 403 (body %s)", author, w.Code, w.Body.String())
			}
			var body map[string]string
			_ = json.Unmarshal(w.Body.Bytes(), &body)
			if body["error"] != "task_move_human_only" {
				t.Fatalf("%s: error code %q, want task_move_human_only", author, body["error"])
			}
			if got := f.get(t, task.ID).State; got != "approved" {
				t.Fatalf("%s: the refused caller moved the ticket to %q", author, got)
			}
		})
	}
}

// A route with no Provenance middleware at all (author nil) fails CLOSED —
// "we couldn't tell" resolves to "a human decides", never to "allowed".
func TestTaskGateMoveFailsClosedWithoutProvenance(t *testing.T) {
	canvasID := uuid.New()
	task := ownerGateTask("approved")
	f := newMoveStore(task)
	h := NewHandler(f, nil, nil)

	// canvasRequest stamps a human author; strip it back off.
	r := taskGateRequest(t, canvasID, task.ID, map[string]any{"to": "proposed"})
	r = r.WithContext(context.WithValue(r.Context(), authorKey, ""))
	w := httptest.NewRecorder()
	h.MoveTask(w, r)

	if w.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403 (body %s)", w.Code, w.Body.String())
	}
	if got := f.get(t, task.ID).State; got != "approved" {
		t.Fatalf("an unattested caller moved the ticket to %q", got)
	}
}

// ── 4. The rest of the refusals ──────────────────────────────────────────────

func TestTaskGateMoveRefusals(t *testing.T) {
	canvasID := uuid.New()
	task := ownerGateTask("approved")
	epic := &store.Action{
		ID: uuid.New(), Kind: "action", Type: "epic", State: "approved",
		Payload: json.RawMessage(`{"title":"Reversible board states"}`),
	}
	f := newMoveStore(task, epic)
	h := NewHandler(f, nil, nil)

	t.Run("target required", func(t *testing.T) {
		w, body := moveTaskJSON(t, h, canvasID, task.ID, map[string]any{})
		if w.Code != http.StatusBadRequest || body["error"] != "task_move_target_required" {
			t.Fatalf("status %d body %v, want 400 task_move_target_required", w.Code, body)
		}
	})

	t.Run("reason too long", func(t *testing.T) {
		w, body := moveTaskJSON(t, h, canvasID, task.ID, map[string]any{
			"to": "proposed", "reason": strings.Repeat("x", maxTaskGateMoveReason+1),
		})
		if w.Code != http.StatusBadRequest || body["error"] != "task_move_reason_too_long" {
			t.Fatalf("status %d body %v, want 400 task_move_reason_too_long", w.Code, body)
		}
		if got := f.get(t, task.ID).State; got != "approved" {
			t.Fatalf("an over-long reason still moved the ticket to %q", got)
		}
	})

	t.Run("not a task", func(t *testing.T) {
		w, body := moveTaskJSON(t, h, canvasID, epic.ID, map[string]any{"to": "proposed"})
		if w.Code != http.StatusBadRequest || body["error"] != "task_move_not_a_task" {
			t.Fatalf("status %d body %v, want 400 task_move_not_a_task", w.Code, body)
		}
		// …and it points at the endpoint that DOES move epics.
		if msg, _ := body["message"].(string); !strings.Contains(msg, "/api/canvas/epics/{id}/move") {
			t.Fatalf("the refusal does not point at the epic move endpoint: %q", msg)
		}
		if got := f.get(t, epic.ID).State; got != "approved" {
			t.Fatalf("the epic moved anyway: %q", got)
		}
	})

	t.Run("not found", func(t *testing.T) {
		w, body := moveTaskJSON(t, h, canvasID, uuid.New(), map[string]any{"to": "proposed"})
		if w.Code != http.StatusNotFound || body["error"] != "task_not_found" {
			t.Fatalf("status %d body %v, want 404 task_not_found", w.Code, body)
		}
	})

	t.Run("invalid id", func(t *testing.T) {
		r := canvasRequest(t, "POST", "/api/canvas/tasks/nope/move",
			map[string]any{"to": "proposed"}, canvasID, "nope")
		r = r.WithContext(WithAuthor(r.Context(), AuthorHuman))
		w := httptest.NewRecorder()
		h.MoveTask(w, r)
		var body map[string]string
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		if w.Code != http.StatusBadRequest || body["error"] != "task_move_invalid_id" {
			t.Fatalf("status %d body %v, want 400 task_move_invalid_id", w.Code, body)
		}
	})

	// A 'failed' ticket is the board's re-queue, not this endpoint's — and the
	// refusal says so rather than leaving the owner to guess.
	t.Run("failed has no move here", func(t *testing.T) {
		failed := ownerGateTask("failed")
		ff := newMoveStore(failed)
		fh := NewHandler(ff, nil, nil)
		w, body := moveTaskJSON(t, fh, canvasID, failed.ID, map[string]any{"to": "proposed"})
		if w.Code != http.StatusBadRequest || body["error"] != "task_move_illegal" {
			t.Fatalf("status %d body %v, want 400 task_move_illegal", w.Code, body)
		}
		if body["state"] != "failed" {
			t.Fatalf("refusal reports state %v, want failed", body["state"])
		}
	})

	// The ticket moved under the request: the conditional UPDATE matched nothing,
	// and the caller gets the same coded refusal the matrix gives.
	t.Run("lost the race", func(t *testing.T) {
		raced := &racingGateStore{moveFakeStore: newMoveStore(ownerGateTask("approved"))}
		var id uuid.UUID
		for k := range raced.actions {
			id = k
		}
		raced.err = fmt.Errorf("%w: cannot move task from %q to %q (it is %q now)",
			store.ErrIllegalActionState, "approved", "proposed", "executing")
		rh := NewHandler(raced, nil, nil)
		w, body := moveTaskJSON(t, rh, canvasID, id, map[string]any{"to": "proposed"})
		if w.Code != http.StatusBadRequest || body["error"] != "task_move_illegal" {
			t.Fatalf("status %d body %v, want 400 task_move_illegal", w.Code, body)
		}
		if moves, _ := body["moves"].([]any); len(moves) != 1 {
			t.Fatalf("the race refusal does not offer the legal moves: %v", body["moves"])
		}
	})
}

// racingGateStore is a moveFakeStore whose ReopenAction always loses — the row
// moved between the handler's read and its write.
type racingGateStore struct {
	*moveFakeStore
	err error
}

func (f *racingGateStore) ReopenAction(_ context.Context, _ uuid.UUID, _ uuid.UUID, _, _ string) (*store.Action, int, error) {
	return nil, 0, f.err
}

// The route is registered, reachable, and NOT shadowed. Pinned because
// /api/canvas/tasks/{id}/move introduces a new path shape that sits beside a
// param segment at the same position (/api/canvas/{code}/tasks/{id}/status): a
// static-vs-param resolution chi makes quietly, and a handler nobody can reach
// passes every test above.
func TestTaskGateMoveRouteIsRegistered(t *testing.T) {
	r := NewRouter(nil, nil, auth.NewService("test-secret-for-tdm-190", time.Hour), nil, false, nil, "", t.TempDir(), "", nil, nil)
	mux, ok := r.(*chi.Mux)
	if !ok {
		t.Fatal("NewRouter no longer returns a *chi.Mux; this route-walk test needs updating")
	}
	seen := map[string]bool{}
	if err := chi.Walk(mux, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		seen[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if !seen["POST /api/canvas/tasks/{id}/move"] {
		t.Fatalf("the ticket gate-move route is missing from the router")
	}
	// Its two siblings are untouched: the board's move and the epic's.
	for _, route := range []string{
		"POST /api/canvas/actions/{id}/move",
		"POST /api/canvas/epics/{id}/move",
	} {
		if !seen[route] {
			t.Fatalf("%s went missing", route)
		}
	}
}

// ── 5. The audit trail ───────────────────────────────────────────────────────

// Every transition is recorded on the ticket's audit trail with the actor the
// SERVER derived and the reason verbatim — the same trail, shape and reader as a
// board move's and an epic move's.
func TestTaskGateMoveRecordsTheAudit(t *testing.T) {
	canvasID := uuid.New()
	task := ownerGateTask("approved")
	f := newMoveStore(task)
	h := NewHandler(f, nil, nil)

	reason := "the API half landed but the migration is still unwritten — not ready to start"
	w, _ := moveTaskJSON(t, h, canvasID, task.ID, map[string]any{"to": "proposed", "reason": reason})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}

	entry := lastAudit(t, f.get(t, task.ID))
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
		t.Fatalf("a ticket state move recorded itself as an approval-reverting edit")
	}
	// The response carries the entry it just wrote, so the board renders the chip
	// without a second read.
	if !strings.Contains(w.Body.String(), "\"audit\"") {
		t.Fatalf("the answer does not carry the audit trail: %s", w.Body.String())
	}
}

// A move with no reason is fine — an owner correcting their own click owes
// nobody an explanation — and still leaves a trail.
func TestTaskGateMoveWithoutAReasonStillAudits(t *testing.T) {
	canvasID := uuid.New()
	task := ownerGateTask("rejected")
	f := newMoveStore(task)
	h := NewHandler(f, nil, nil)

	w, _ := moveTaskJSON(t, h, canvasID, task.ID, map[string]any{"to": "proposed"})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	entry := lastAudit(t, f.get(t, task.ID))
	if entry.FromState != "rejected" || entry.ToState != "proposed" || entry.Note != "" {
		t.Fatalf("audit entry %+v", entry)
	}
}

// ── 6. The reason reaches the author ─────────────────────────────────────────

// A re-open's reason is not just filed — it comes back through the SAME `review`
// block a reviewer's bounce does (task_get / the epic rollup / context_get), so
// whoever picks the ticket up next reads why the last attempt didn't stand
// without having to ask the person who re-opened it.
func TestTaskGateReopenReasonReachesTheAuthor(t *testing.T) {
	canvasID := uuid.New()
	task := ownerGateTask("done")
	f := newMoveStore(task)
	h := NewHandler(f, nil, nil)

	reason := "the endpoint works but nothing clears the claim — see TDM-190's brief"
	w, _ := moveTaskJSON(t, h, canvasID, task.ID, map[string]any{"to": "proposed", "reason": reason})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}

	fb := deriveReviewFeedback(f.get(t, task.ID))
	if fb == nil {
		t.Fatalf("a re-opened ticket reports no review feedback at all")
	}
	if fb.Outcome != reviewRework {
		t.Fatalf("outcome %q, want %q", fb.Outcome, reviewRework)
	}
	if fb.Reason != reason {
		t.Fatalf("reason %q, want it verbatim", fb.Reason)
	}
	if fb.By != AuthorHuman {
		t.Fatalf("by %q, want %q", fb.By, AuthorHuman)
	}
	// `State` is what tells the reader this one came back to the GATE rather than
	// to the ready queue — the only part of the two bounces that differs.
	if fb.State != "proposed" {
		t.Fatalf("state %q, want proposed", fb.State)
	}
}

// Reviving a rejected ticket must not carry its rejection reason forward: the
// `review` block derives off state + error, and a stale verdict there is one
// that no longer stands.
func TestTaskGateReviveClearsTheRejection(t *testing.T) {
	canvasID := uuid.New()
	task := ownerGateTask("rejected")
	task.Error = ptr("out of scope for this batch")
	f := newMoveStore(task)
	h := NewHandler(f, nil, nil)

	// It reads back as a rejection before the move…
	if fb := deriveReviewFeedback(f.get(t, task.ID)); fb == nil || fb.Outcome != reviewRejected {
		t.Fatalf("the fixture does not read as rejected: %+v", fb)
	}

	w, _ := moveTaskJSON(t, h, canvasID, task.ID, map[string]any{"to": "proposed", "reason": "it is in scope now"})
	if w.Code != http.StatusOK {
		t.Fatalf("revive: status %d (body %s)", w.Code, w.Body.String())
	}
	revived := f.get(t, task.ID)
	if revived.Error != nil {
		t.Fatalf("the revived ticket kept its rejection reason: %q", *revived.Error)
	}
	if fb := deriveReviewFeedback(revived); fb != nil {
		t.Fatalf("a revived ticket still reads as returned: %+v", fb)
	}
}
