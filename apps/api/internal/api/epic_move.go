package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// ── Owner moves on a BATCH (TDM-189) ─────────────────────────────────────────
//
// THE PROBLEM THIS FILE EXISTS FOR. Every state an epic could reach was a state
// it could never leave. A batch approved by mistake stayed approved; a batch
// rejected in triage was dead even when the plan turned out to be right; a
// drained one could never be re-opened. Tasks got their reversibility in E10
// (task_move.go — release / requeue / reopen / reconsider) and epics got
// nothing, so the ONE decision the human gate is built around — approving a
// batch — was the one decision the board would not let them take back. A gate
// with no undo is a gate people approve nothing through.
//
// WHAT AN OWNER MAY DO — this table IS epicMoveTargets below:
//
//	from       →  to         what the person means
//	─────────     ─────────  ─────────────────────────────────────────────────
//	proposed      (nothing)  the GATE: approve/reject only
//	approved   →  proposed   un-approve — "this batch isn't ready after all"
//	done       →  proposed   re-open — the batch is live again
//	done       →  rejected   retire — it drained, and it should not have run
//	rejected   →  proposed   revive — reconsider a batch triaged away
//
// 'proposed' HAS NO MOVE TARGETS, for exactly the reason it has none in the
// human task matrix: approve/reject are the only door into (and out of) the
// gate, and they stamp approved_by, fire the events and run the task cascade.
// A second door with none of that would make the gate theater. Nothing here can
// put an epic in 'approved' — every target is 'proposed' or 'rejected'.
//
// AND NO NEW TRANSITIONS IN THE TASK STATE MACHINE. validActionStates is
// untouched: these are epic-only rewinds, made by a store method
// (store.MoveEpic) that exists precisely because the generic PATCH must never
// make them.
//
// OWNER-ONLY, by the same rule the epic's approval already uses: callerIsHuman,
// server-derived provenance no agent credential can forge (see provenance.go).
// Agents do not gain this verb — un-approving a batch is the human's undo of a
// human's decision, and an agent that could un-approve could also quietly
// re-plan around a gate it never passed. No MCP tool maps to this endpoint.

const (
	// epicApprovalStamp is the approved_by provenance the epic cascade writes
	// (policyApproval / ApproveEpicTasks, action_handler.go). The un-approve
	// cascade below matches on it EXACTLY, which is what makes it undo the
	// batch's approval and nothing else — a ticket a human approved one at a time
	// keeps that approval.
	epicApprovalStamp = "policy:epic"

	// maxEpicMoveReason bounds the optional reason. Same budget as a task move's
	// note: it lands in the same audit entry, and (on a rejection) the same
	// `error` column.
	maxEpicMoveReason = maxMoveNote
)

// epicMove is ONE legal owner move on a batch. Comparable (all scalars), like
// humanMove, so the dispatch can switch on the value.
type epicMove struct {
	from string
	to   string
	// verb is the fleet activity verb pushed to viewers (fleet_handler.go).
	verb string
	// label is how the move reads to a person: in the 400 that lists the legal
	// targets, and in the log line if its audit entry fails to record.
	label string
}

// The moves themselves.
var (
	epicUnapprove = epicMove{"approved", "proposed", activityProposed, "un-approve"}
	epicReopen    = epicMove{"done", "proposed", activityProposed, "re-open"}
	epicRetire    = epicMove{"done", "rejected", activityRejected, "retire"}
	epicRevive    = epicMove{"rejected", "proposed", activityProposed, "revive"}
)

// epicMoveTargets is the matrix, keyed by the state the epic is in. The ABSENCE
// of "proposed" is a rule, not an omission — see the file header.
//
// Order matters: it is the order the moves are offered in the 400's `moves`
// list, so a client rendering straight from it puts the primary action first.
var epicMoveTargets = map[string][]epicMove{
	"approved": {epicUnapprove},
	"done":     {epicReopen, epicRetire},
	"rejected": {epicRevive},
}

// epicMoveFor resolves (from, to) against the matrix. The bool is the ONLY
// authorization this feature has beyond the human gate, so every path that
// writes a state must come through here — never off a request body's string.
func epicMoveFor(from, to string) (epicMove, bool) {
	for _, m := range epicMoveTargets[from] {
		if m.to == to {
			return m, true
		}
	}
	return epicMove{}, false
}

// epicMoveOptions lists the legal targets out of a state, for the 400 body.
func epicMoveOptions(from string) []map[string]string {
	moves := epicMoveTargets[from]
	out := make([]map[string]string, 0, len(moves))
	for _, m := range moves {
		out = append(out, map[string]string{"to": m.to, "label": m.label})
	}
	return out
}

// unapprovedLine is one ticket the cascade took back out of the ready queue.
// Enough for the board (and the human) to see exactly what stopped being
// workable, without a second read.
type unapprovedLine struct {
	ID       uuid.UUID `json:"id"`
	TicketID string    `json:"ticketId,omitempty"`
	Title    string    `json:"title,omitempty"`
	State    string    `json:"state"`
}

// POST /api/canvas/epics/{id}/move  — the OWNER's state moves on a batch.
//
//	{ "to": "proposed", "reason": "the messaging half is a separate service" }
//
// `to` is required and must be one of the legal targets for the epic's CURRENT
// state; `reason` is optional everywhere and always recorded on the epic's audit
// trail (and, on a rejection, in the same `error` column /reject writes, which
// is what the rollup's `review` block reads back).
//
// On success: 200 with the moved epic, the (from, to) pair, and the tickets the
// un-approve cascade sent back to the gate. On an illegal move: 400
// `epic_move_illegal` carrying the epic's state and the moves that ARE legal
// from it, so a client working off a stale board can correct itself.
//
// Coded errors, all stable: epic_move_invalid_id, epic_move_human_only,
// epic_move_target_required, epic_move_reason_too_long, epic_not_found,
// epic_move_not_an_epic, epic_move_illegal.
func (h *Handler) MoveEpic(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeCodedError(w, http.StatusBadRequest, "epic_move_invalid_id",
			"invalid id: an epic is addressed by uuid (tickets refs name tasks, not batches)", nil)
		return
	}
	// THE GATE, before anything is read: this is the undo of a human approval, so
	// it is refused for anyone the server cannot see as a signed-in human — the
	// same rule, from the same server-derived provenance, as /approve and /reject
	// (action_handler.go). Checked ahead of the 404 on purpose: whether an epic
	// exists is not something an unauthorized caller learns here.
	if !callerIsHuman(r.Context()) {
		writeCodedError(w, http.StatusForbidden, "epic_move_human_only",
			"only a signed-in human can move an epic: un-approving, reviving or retiring a batch is the "+
				"owner's decision, and no agent credential stands in for it", nil)
		return
	}
	var body struct {
		To string `json:"to"`
		// Reason is why — context for the audit trail on every move, and the
		// rejection reason on a move to 'rejected'. Optional: an owner correcting
		// their own click owes nobody an explanation.
		Reason string `json:"reason"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	to := strings.TrimSpace(body.To)
	if to == "" {
		writeCodedError(w, http.StatusBadRequest, "epic_move_target_required",
			"to: the state to move the epic into is required (proposed | rejected)", nil)
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if len(reason) > maxEpicMoveReason {
		writeCodedError(w, http.StatusBadRequest, "epic_move_reason_too_long",
			fmt.Sprintf("reason must be at most %d characters", maxEpicMoveReason), nil)
		return
	}

	current, err := h.store.GetAction(r.Context(), canvasID, id)
	if err != nil {
		writeCodedError(w, http.StatusNotFound, "epic_not_found",
			"no epic with that id on this canvas", map[string]string{"id": id.String()})
		return
	}
	if current.Type != "epic" {
		// The caller is holding the right idea with the wrong endpoint — tasks have
		// their own matrix and their own door.
		writeCodedError(w, http.StatusBadRequest, "epic_move_not_an_epic",
			fmt.Sprintf("only epics move through this endpoint (this is a %q) — a task moves through "+
				"POST /api/canvas/actions/{id}/move", current.Type),
			map[string]string{"type": current.Type})
		return
	}
	// Idempotency, same rule as transitionAction and /move: a click whose response
	// was lost must not come back as "illegal move: proposed → proposed". An epic
	// has no claim, so unlike a task's start there is no race hiding behind this —
	// the no-op is unconditionally safe. `moved:false` is what tells the caller
	// nothing happened this time.
	if current.State == to {
		writeJSON(w, http.StatusOK, map[string]any{
			"action": current, "moved": false, "from": current.State, "to": to,
			"unapproved": []unapprovedLine{}, "unapprovedCount": 0,
		})
		return
	}
	move, ok := epicMoveFor(current.State, to)
	if !ok {
		msg := fmt.Sprintf("an epic in %q cannot be moved to %q", current.State, to)
		switch current.State {
		case "proposed":
			msg += " — a proposed epic leaves only through the approval gate: " +
				"POST /api/canvas/actions/{id}/approve or /reject"
		case "done":
			// The named illegal move: done → approved. Re-approving is not a move,
			// it is the gate, and going back through it is what re-runs the cascade.
			msg += " — re-open it to 'proposed' first, then approve it, so the batch " +
				"re-enters the gate instead of skipping it"
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":   "epic_move_illegal",
			"message": msg,
			"state":   current.State,
			"moves":   epicMoveOptions(current.State),
		})
		return
	}

	epic, _, err := h.store.MoveEpic(r.Context(), canvasID, id, move.from, move.to, reason)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrActionNotFound):
			writeCodedError(w, http.StatusNotFound, "epic_not_found",
				"no epic with that id on this canvas", map[string]string{"id": id.String()})
		case errors.Is(err, store.ErrIllegalActionState):
			// The epic moved under the request — the conditional UPDATE matched
			// nothing. Answered like the matrix refusal so a client has one branch.
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": "epic_move_illegal", "message": err.Error(), "state": current.State,
				"moves": epicMoveOptions(current.State),
			})
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}

	// The audit entry — "every transition is recorded with actor and optional
	// reason". Same trail, same shape and the same server-derived actor as a task
	// move's (recordMove), so an epic's history reads like a ticket's. Best-effort
	// by contract for the same reason: the move has already committed, and failing
	// the request now would tell the owner it didn't happen when it did.
	h.recordEpicMove(r, canvasID, epic, move, reason)

	// The CASCADE, and it runs synchronously — unlike the approve-side cascade,
	// which is detached because approving is a hot path a fleet is waiting on.
	// Un-approving is a rare human click, it is ONE bulk UPDATE, and the count is
	// the whole point of the answer: an owner needs to be told how many tickets
	// just left the ready queue, and a web UI cannot render a number it was never
	// sent.
	unapproved := h.unapproveEpicTasks(r, canvasID, epic)

	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	// The actor the SERVER derived, not actorFor's guess: an epic moving to
	// 'proposed' would otherwise be attributed to proposedBy — the agent that
	// planned the batch — when the person who moved it is the news.
	broadcastActionActivityAs(h.hub, canvasID, move.verb, epic, moveActor(r))
	// One line per ticket that left the queue, so a watching board strikes the
	// cards through live instead of waiting for the next full state push.
	for _, t := range unapproved {
		broadcastActionActivityAs(h.hub, canvasID, activityProposed, t, moveActor(r))
	}
	// Deliberately NO webhook. The vocabulary (task.approved / task.completed /
	// task.returned) has no event for "this stopped being workable", and firing
	// task.returned — whose contract is "finished work came back" — at a fleet
	// would have it re-run tickets nobody finished. The state broadcast and the
	// activity lines above are the live signal; see task_events.go for the
	// boundary.

	lines := make([]unapprovedLine, 0, len(unapproved))
	for _, t := range unapproved {
		lines = append(lines, unapprovedLine{
			ID: t.ID, TicketID: t.TicketID(), Title: epicTaskTitle(t.Payload), State: t.State,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"action":          epic,
		"moved":           true,
		"from":            move.from,
		"to":              move.to,
		"unapproved":      lines,
		"unapprovedCount": len(lines),
	})
}

// unapproveEpicTasks runs the cascade and returns what it moved.
//
// BEST-EFFORT, like the audit entry and for the same reason: the epic's own move
// has already committed and the response is about to go out. A failed cascade is
// logged and reported as zero tickets — the owner sees the batch un-approved with
// nothing pulled back, which is recoverable by moving it again (the bulk UPDATE
// is idempotent), where a 500 after a committed move would leave them believing
// neither half happened.
func (h *Handler) unapproveEpicTasks(r *http.Request, canvasID uuid.UUID, epic *store.Action) []*store.Action {
	if epic == nil {
		return nil
	}
	tasks, err := h.store.UnapproveEpicTasks(r.Context(), canvasID, epic.ID, epicApprovalStamp)
	if err != nil {
		log.Printf("move epic %s: un-approving its tasks: %v", epic.ID, err)
		return nil
	}
	return tasks
}

// recordEpicMove writes the one audit entry an epic move owes the batch, and
// folds the stored payload back onto the action about to be returned so the
// response carries the entry it just created. The epic counterpart of
// recordMove — same store call, same NewStateAudit shape, same best-effort
// contract.
func (h *Handler) recordEpicMove(r *http.Request, canvasID uuid.UUID, epic *store.Action, move epicMove, reason string) {
	if epic == nil {
		return
	}
	entry := store.NewStateAudit(moveActor(r), move.from, move.to, reason, time.Now().UTC())
	next, err := h.store.AppendActionAudit(r.Context(), canvasID, epic.ID, entry)
	if err != nil {
		log.Printf("move epic %s (%s): recording the audit entry: %v", epic.ID, move.label, err)
		return
	}
	epic.Payload = next
}

// epicTaskTitle reads a task payload's title for the cascade report. A payload
// that won't parse contributes an empty title rather than failing the answer —
// the id and ticket ref already identify the row.
func epicTaskTitle(raw json.RawMessage) string {
	var p struct {
		Title string `json:"title"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return ""
	}
	return strings.TrimSpace(p.Title)
}
