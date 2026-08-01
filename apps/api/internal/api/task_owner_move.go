package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// ── Owner moves on ONE TICKET (TDM-190) ──────────────────────────────────────
//
// THE PROBLEM THIS FILE EXISTS FOR, and it is the epic story (TDM-189) one level
// down. Batches got their undo: an epic approved by mistake can be un-approved,
// a drained one re-opened, a triaged one revived. A TICKET could not make the
// same moves. The board's human matrix (task_move.go) walks a card FORWARD
// through its life and rewinds it as far as the ready queue — release, requeue,
// reopen — but every one of those rewinds stops at 'approved'. There was no way
// to put a single ticket back BEHIND the gate:
//
//   - a ticket approved by mistake (or by an epic cascade that swept up one that
//     wasn't ready) stayed workable, and the only way to stop it was to reject
//     it — which is not "wait", it is "never";
//   - a ticket whose completion turned out to be wrong could be reopened, but
//     only into the ready queue, where the next session picks it straight back
//     up on plan nobody has re-read;
//   - un-approving one ticket meant un-approving its whole batch.
//
// So this is the epic endpoint's counterpart, with the same shape, the same
// gate, the same audit trail and the same refusal vocabulary — and one target
// state, because the point of every move here is the SAME point: put this
// ticket back in front of the human who owns it.
//
// WHAT AN OWNER MAY DO — this table IS taskGateMoveTargets below:
//
//	from       →  to         what the person means
//	─────────     ─────────  ─────────────────────────────────────────────────
//	proposed      (nothing)  it is already at the gate
//	approved   →  proposed   un-approve — "not ready after all; don't start it"
//	done       →  proposed   re-open — "that isn't finished", back to the gate
//	rejected   →  proposed   revive — reconsider a ticket triaged away
//	executing     (nothing)  someone is holding it — release it first
//	failed        (nothing)  the board's re-queue already covers it
//
// NOTHING HERE CAN REACH 'approved', which is the same load-bearing rule the two
// sibling matrices carry: /approve is what stamps approved_by, fires
// task.approved and wakes a parked queue_wait, so a second door into the ready
// queue with none of that would make the gate theater. Every move in this file
// lands in 'proposed', i.e. strictly BEHIND the gate. It follows that this
// endpoint can only ever take work OUT of the queue, never put it in — which is
// why, unlike the board's rewinds, it signals no queue-ready and fires no
// webhook (see the handler).
//
// 'executing' IS ABSENT ON PURPOSE, and it is the claim guard. A ticket a worker
// is holding must not be yanked back to the gate underneath it — the same rule
// the epic cascade spells in SQL (UnapproveEpicTasks' `claimed_by is null`
// predicate). Here it is structural instead: in-flight work simply has no move,
// so an owner has to release it (executing → approved, task_move.go) and then
// un-approve, which is two deliberate clicks rather than one that silently
// pulls the rug.
//
// NO NEW TRANSITIONS AND NO MIGRATION. store.ReopenAction has always made
// exactly this write — a conditional UPDATE predicated on the state the caller
// believed the row was in, clearing the claim, the stale result and the stale
// error, and clearing approved_by when the target is 'proposed'. It already
// backed reopen (done → approved) and reconsider (rejected → proposed); this
// file is a third caller for it, with its own matrix and its own gate.
//
// OWNER-ONLY, from callerIsHuman — server-derived provenance no agent credential
// can forge (provenance.go) — exactly like /approve, /reject and the epic move.
// Note the difference from task_move.go's /move, which is human-only BY SURFACE
// (no MCP tool maps to it) and not checked: un-approving is the undo of a human
// approval, so "no tool advertises it" is not a strong enough rail. An agent
// that could un-approve could quietly re-plan around a gate it never passed. No
// MCP tool maps to this endpoint either.
//
// WHY A SECOND ENDPOINT AND NOT A ROW IN humanMoveTargets: that matrix is the
// board's, checked only by surface, and gating one row of it differently would
// make it stop meaning what its header says it means — the argument ReworkAction
// already made when it needed a differently-gated done → approved.

const (
	// maxTaskGateMoveReason bounds the optional reason. Same budget as a board
	// move's note and an epic move's reason: it lands in the same audit entry.
	maxTaskGateMoveReason = maxMoveNote
)

// The moves themselves, as humanMove values kept deliberately OUT of
// humanMoveTargets — the pattern moveRework established: a second door reusing
// the mechanism without widening the board's matrix. All three are rewinds, so
// all three run through store.ReopenAction.
var (
	taskUnapprove    = humanMove{"approved", "proposed", moveKindRewind, activityProposed, "un-approve"}
	taskReopenToGate = humanMove{"done", "proposed", moveKindRewind, activityProposed, "re-open"}
	// The revive is the board's reconsider — the identical rewind, offered at this
	// door too so the owner surface is complete and matches the epic's. One
	// definition, so the two doors cannot drift into two audit labels for one move.
	taskRevive = moveReconsider
)

// taskGateMoveTargets is the matrix, keyed by the state the ticket is in. The
// ABSENCE of 'proposed', 'executing' and 'failed' is a rule in each case — see
// the file header.
//
// Order matters: it is the order the moves are offered in the 400's `moves`
// list, so a client rendering straight from it puts the primary action first.
var taskGateMoveTargets = map[string][]humanMove{
	"approved": {taskUnapprove},
	"done":     {taskReopenToGate},
	"rejected": {taskRevive},
}

// taskGateMoveFor resolves (from, to) against the matrix. The bool is the ONLY
// authorization this feature has beyond the human gate, so every path that
// writes a state must come through here — never off a request body's string.
func taskGateMoveFor(from, to string) (humanMove, bool) {
	for _, m := range taskGateMoveTargets[from] {
		if m.to == to {
			return m, true
		}
	}
	return humanMove{}, false
}

// taskGateMoveOptions lists the legal targets out of a state, for the 400 body.
func taskGateMoveOptions(from string) []map[string]string {
	moves := taskGateMoveTargets[from]
	out := make([]map[string]string, 0, len(moves))
	for _, m := range moves {
		out = append(out, map[string]string{"to": m.to, "label": m.label})
	}
	return out
}

// POST /api/canvas/tasks/{id}/move  — the OWNER's state moves on ONE TICKET.
//
//	{ "to": "proposed", "reason": "the migration is missing — this isn't done" }
//
// The task counterpart of POST /api/canvas/epics/{id}/move, same request and
// same answer shape. `to` is required and must be a legal target for the
// ticket's CURRENT state (today that is always "proposed"); `reason` is optional
// everywhere and always recorded on the ticket's audit trail — where, for a
// re-open, the author reads it back verbatim as task_get's `review` block.
//
// Addressed by uuid OR by ticket ref ("TDM-21", "#21", "21"): the route carries
// ResolveTicketRef like every other action endpoint, because a ref is the form a
// ticket actually travels in. (The epic endpoint does not, since refs name
// tasks.)
//
// On success: 200 with the moved task, the (from, to) pair, and moved:true. On a
// re-send of the state it is already in: 200 moved:false, nothing written. On an
// illegal move: 400 task_move_illegal carrying the ticket's state and the moves
// that ARE legal from it, so a client working off a stale board can re-render
// instead of guessing.
//
// Coded errors, all stable: task_move_invalid_id, task_move_human_only,
// task_move_target_required, task_move_reason_too_long, task_not_found,
// task_move_not_a_task, task_move_illegal.
func (h *Handler) MoveTask(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeCodedError(w, http.StatusBadRequest, "task_move_invalid_id",
			"invalid id: expected a task uuid or an existing ticket ref like TDM-21", nil)
		return
	}
	// THE GATE, before anything is read: this is the undo of a human approval, so
	// it is refused for anyone the server cannot see as a signed-in human — the
	// same rule, from the same server-derived provenance, as /approve and /reject
	// (action_handler.go). Checked ahead of the 404 on purpose: whether a task
	// exists is not something an unauthorized caller learns here.
	if !callerIsHuman(r.Context()) {
		writeCodedError(w, http.StatusForbidden, "task_move_human_only",
			"only a signed-in human can move a ticket back to the gate: un-approving, re-opening or "+
				"reviving is the owner's decision, and no agent credential stands in for it. A reviewer "+
				"agent sends finished work back with POST /api/canvas/actions/{id}/rework", nil)
		return
	}
	var body struct {
		To string `json:"to"`
		// Reason is why — context for the audit trail on every move, and (on a
		// re-open) the brief the next attempt reads back. Optional: an owner
		// correcting their own click owes nobody an explanation.
		Reason string `json:"reason"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	to := strings.TrimSpace(body.To)
	if to == "" {
		writeCodedError(w, http.StatusBadRequest, "task_move_target_required",
			"to: the state to move the ticket into is required (proposed)", nil)
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if len(reason) > maxTaskGateMoveReason {
		writeCodedError(w, http.StatusBadRequest, "task_move_reason_too_long",
			fmt.Sprintf("reason must be at most %d characters", maxTaskGateMoveReason), nil)
		return
	}

	current, err := h.store.GetAction(r.Context(), canvasID, id)
	if err != nil {
		writeCodedError(w, http.StatusNotFound, "task_not_found",
			"no task with that id on this canvas", map[string]string{"id": id.String()})
		return
	}
	if current.Type != "task" {
		// The caller is holding the right idea with the wrong endpoint — batches
		// have their own matrix and their own door.
		writeCodedError(w, http.StatusBadRequest, "task_move_not_a_task",
			fmt.Sprintf("only tasks move through this endpoint (this is a %q) — an epic moves through "+
				"POST /api/canvas/epics/{id}/move", current.Type),
			map[string]string{"type": current.Type})
		return
	}
	// Idempotency, same rule as the epic move and transitionAction: a click whose
	// response was lost must not come back as "illegal move: proposed → proposed".
	// Safe unconditionally here because — unlike the board's approved → executing
	// — no move in this matrix is a claim, so there is no race hiding behind the
	// no-op. `moved:false` is what tells the caller nothing happened this time.
	if current.State == to {
		writeJSON(w, http.StatusOK, map[string]any{
			"action": current, "moved": false, "from": current.State, "to": to,
		})
		return
	}
	move, ok := taskGateMoveFor(current.State, to)
	if !ok {
		msg := fmt.Sprintf("a task in %q cannot be moved to %q", current.State, to)
		switch current.State {
		case "proposed":
			msg += " — it is already at the gate: POST /api/canvas/actions/{id}/approve or /reject"
		case "executing":
			// The claim guard, said out loud. Two deliberate clicks, never one that
			// pulls the rug out from under a worker.
			msg += " — a worker is holding it: release it first " +
				`(POST /api/canvas/actions/{id}/move {"to":"approved"}), then un-approve it`
		case "failed":
			msg += ` — re-queue it instead (POST /api/canvas/actions/{id}/move {"to":"approved"}), ` +
				"or reject it if it should not run again"
		default:
			// The named illegal target: anything → approved. Approving is not a move,
			// it is the gate, and going back through it is what stamps and announces.
			msg += " — nothing moves INTO 'approved' here: that is the approval gate, " +
				"POST /api/canvas/actions/{id}/approve"
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":   "task_move_illegal",
			"message": msg,
			"state":   current.State,
			"moves":   taskGateMoveOptions(current.State),
		})
		return
	}

	// The write. store.ReopenAction is predicated on `move.from` and type='task',
	// so a ticket that moved under the request (a worker claiming it between the
	// read above and here) matches nothing and comes back as
	// ErrIllegalActionState rather than a lost update. It clears the claim, the
	// now-stale result and the stale error, and — because every target here is
	// 'proposed' — the approved_by stamp, so a ticket waiting at the gate never
	// renders "approved by human".
	action, _, err := h.store.ReopenAction(r.Context(), canvasID, id, move.from, move.to)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrActionNotFound):
			writeCodedError(w, http.StatusNotFound, "task_not_found",
				"no task with that id on this canvas", map[string]string{"id": id.String()})
		case errors.Is(err, store.ErrIllegalActionState):
			// Answered like the matrix refusal so a client has one branch.
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": "task_move_illegal", "message": err.Error(), "state": current.State,
				"moves": taskGateMoveOptions(current.State),
			})
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}

	// The audit entry — "every transition is recorded with actor and optional
	// reason". Same trail, shape and server-derived actor as a board move's and an
	// epic move's. Best-effort by contract for the same reason: the move has
	// already committed, and failing the request now would tell the owner it
	// didn't happen when it did.
	h.recordMove(r.Context(), canvasID, action, move, reason, moveActor(r))

	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	// The actor the SERVER derived, not actorFor's guess: a ticket landing in
	// 'proposed' would otherwise be attributed to proposedBy — the agent that
	// planned it — when the person who moved it is the news.
	broadcastActionActivityAs(h.hub, canvasID, move.verb, action, moveActor(r))
	// Deliberately NO queue-ready signal and NO webhook, and both follow from the
	// same fact: every move here lands BEHIND the gate. A parked queue_wait is
	// asking "is there work?", and there is now strictly less. And while a re-open
	// does falsify a task.completed this canvas published — the thing that earns
	// task.returned on the reviewer's bounce (TDM-170) — that event's contract is
	// "finished work is back in the queue, go redo it", and a webhook orchestrator
	// acting on it here would relaunch a ticket that is no longer approved. The
	// state broadcast and the activity line above are the live signal; see
	// task_events.go for the boundary.

	writeJSON(w, http.StatusOK, map[string]any{
		"action": action,
		"moved":  true,
		"from":   move.from,
		"to":     move.to,
	})
}
