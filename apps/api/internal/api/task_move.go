package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/webhooks"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// ── Human board moves (E10) ───────────────────────────────────────────────────
//
// THE PROBLEM THIS FILE EXISTS FOR. Every transition on the board except
// approve / reject / release / requeue used to be an AGENT transition: the
// state machine moved when an MCP session claimed a task and again when it
// reported back. A human looking at their own `assignee:"human"` todo sitting
// in Ready had no way to say "I started this" or "this is done" — the board was
// a window onto other people's work. A queue you cannot move your own card in
// is not a task manager.
//
// WHAT A HUMAN MAY DO — this table IS humanMoveTargets below:
//
//	from       →  to         mechanism            what the person means
//	─────────     ─────────  ───────────────────  ──────────────────────────────
//	proposed      (nothing)  —                    the GATE: approve/reject only
//	approved   →  executing  atomic claim         "I'm on it"
//	executing  →  done       terminal transition  "finished"  (+ result note)
//	executing  →  failed     terminal transition  "I couldn't" (+ reason note)
//	executing  →  approved   ReleaseAction        hand the claim back
//	failed     →  approved   RequeueAction        another attempt
//	done       →  approved   ReopenAction         it wasn't really finished
//	rejected   →  proposed   ReopenAction         reconsider what was triaged away
//
// 'proposed' HAS NO MOVE TARGETS, and that is the load-bearing line in this
// file. Approval is the product: the only exits from proposed are POST
// …/approve and POST …/reject, which stamp approved_by, fire task.approved, and
// run the epic cascade. If /move could write state:"approved" it would be a
// second door into the ready queue with none of that, and the gate would be
// theater. Nothing here can put a task in 'approved' except by REWINDING one
// that already passed the gate once (release / requeue / reopen) — which is
// also why none of those re-fires task.approved (see task_events.go).
//
// NO NEW TRANSITIONS EITHER. Every forward move a human makes is one
// validActionStates already allows (approved → executing → done|failed); the
// human surface just reaches them without an agent. The rewinds are the three
// store methods that exist precisely because the generic PATCH must never make
// them. So there is no migration behind this file and no widening of the state
// machine — only a new caller for it.
//
// HUMAN-ONLY BY SURFACE, exactly like release and requeue (whose doc comments
// carry the full argument): a canvas JWT is identical for a browser and an
// MCP/gateway caller, so the token cannot tell human from agent. The gate is
// that no MCP tool maps to POST …/move. An agent that wants to start a task
// uses PATCH {state:"executing"}, which takes the claim under its own name and
// puts it in the fleet roster; /move deliberately does neither (see
// humanClaimant and claimTaskAs's `presence` parameter).

const (
	// humanClaimant is what claimed_by says when a PERSON starts a task. Not the
	// provenance-derived actor (which can be "anonymous" on a public canvas, and
	// would read as a mystery agent in the claimant chip and the claimant
	// filter): claimed_by answers "who is holding this card", and the answer is
	// the same word the web app already uses for proposedBy / approvedBy. WHO
	// exactly the server concluded was calling is recorded separately and
	// honestly, in the audit entry — see moveActor.
	humanClaimant = "human"

	// maxMoveNote bounds the optional note a human types when completing (or
	// giving up on) a task. Same budget as the status API's summary — it lands in
	// the same `result` / `error` columns that API writes.
	maxMoveNote = 8192
)

// moveKind is HOW the API gets a task from one state to the other. Three
// mechanisms, because the three groups of moves have genuinely different
// semantics — a claim must be atomic, a completion is a state transition with
// outcome fields and a webhook, and a rewind is a conditional UPDATE that
// clears the last life's bookkeeping.
type moveKind int

const (
	// moveKindClaim is approved → executing: the SAME atomic claim an agent
	// makes, so a human and an agent racing for one task produce exactly one
	// winner (and the loser a 409).
	moveKindClaim moveKind = iota
	// moveKindFinish is executing → done|failed: transitionAction, so a human
	// completion is indistinguishable downstream from an agent's — same content
	// gate, same idempotent retry, same task.completed webhook.
	moveKindFinish
	// moveKindRewind is a backwards move out of a state a task cannot leave on
	// its own: release / requeue / reopen / reconsider.
	moveKindRewind
)

// humanMove is ONE legal human board move. Comparable (all scalars) so the
// dispatch below can switch on the value itself.
type humanMove struct {
	from string
	to   string
	kind moveKind
	// verb is the fleet activity verb pushed to viewers (fleet_handler.go).
	verb string
	// label is how the move reads to a person: in the 400 that lists the legal
	// targets, and in the log line if its audit entry fails to record.
	label string
}

// The moves themselves. moveRelease and moveRequeue back the two endpoints that
// predate this file (Handler.ReleaseAction / Handler.RequeueAction), which is
// why those handlers are now one line each — same store call, same broadcast,
// and now the same audit entry as every other human move.
var (
	moveStart      = humanMove{"approved", "executing", moveKindClaim, activityClaimed, "start"}
	moveComplete   = humanMove{"executing", "done", moveKindFinish, activityCompleted, "complete"}
	moveGiveUp     = humanMove{"executing", "failed", moveKindFinish, activityCompleted, "mark failed"}
	moveRelease    = humanMove{"executing", "approved", moveKindRewind, activityReleased, "release"}
	moveRequeue    = humanMove{"failed", "approved", moveKindRewind, activityRequeued, "re-queue"}
	moveReopen     = humanMove{"done", "approved", moveKindRewind, activityRequeued, "reopen"}
	moveReconsider = humanMove{"rejected", "proposed", moveKindRewind, activityProposed, "reconsider"}
	// moveRework is the REVIEWER's bounce (TDM-154): the same done → approved
	// rewind as moveReopen, under a different verb and a different door. It is
	// deliberately NOT in humanMoveTargets — the human board's matrix is
	// unchanged, and a person reopening a task still gets moveReopen. This one
	// exists so the agent-facing endpoint reuses rewindTask (and therefore
	// store.ReopenAction's state-predicated UPDATE, the audit entry, the
	// queue-ready signal and the broadcasts) without widening the human surface
	// or the state machine by a single transition.
	moveRework = humanMove{"done", "approved", moveKindRewind, activityReworked, "send back for rework"}
)

// humanMoveTargets is the matrix, keyed by the state the card is in. The
// ABSENCE of "proposed" is a rule, not an omission — see the file header.
//
// Order matters: it is the order the moves are offered in the 400's `moves`
// list, forward move first, so a client rendering straight from it puts the
// primary action first.
var humanMoveTargets = map[string][]humanMove{
	"approved":  {moveStart},
	"executing": {moveComplete, moveGiveUp, moveRelease},
	"failed":    {moveRequeue},
	"done":      {moveReopen},
	"rejected":  {moveReconsider},
}

// humanMoveFor resolves (from, to) against the matrix. The bool is the ONLY
// authorization this feature has, so every path that writes a state must come
// through here — never off a request body's state string.
func humanMoveFor(from, to string) (humanMove, bool) {
	for _, m := range humanMoveTargets[from] {
		if m.to == to {
			return m, true
		}
	}
	return humanMove{}, false
}

// humanMoveOptions lists the legal targets out of a state, for the 400 body.
func humanMoveOptions(from string) []map[string]string {
	moves := humanMoveTargets[from]
	out := make([]map[string]string, 0, len(moves))
	for _, m := range moves {
		out = append(out, map[string]string{"to": m.to, "label": m.label})
	}
	return out
}

// POST /api/canvas/actions/{id}/move  — the human state-move endpoint.
//
//	{ "to": "done", "note": "shipped in 748b348" }
//
// `to` is required and must be one of the legal targets for the task's CURRENT
// state; `note` is optional and always allowed to be absent. On success:
// {"action": …} with the moved row. On an illegal move: 400 with the task's
// state and the moves that ARE legal from it, so a client working from a stale
// board can correct itself instead of guessing.
func (h *Handler) MoveAction(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var body struct {
		To string `json:"to"`
		// Note is the short result summary (on 'done'), the reason (on 'failed'),
		// or just context for the audit trail (on a rewind, which clears both
		// columns by design). Optional everywhere.
		Note string `json:"note"`
		// Agent and ClaimGeneration are the caller's claim identity, for the case
		// this endpoint was not built for but can be reached by: something holding
		// a claim moving its OWN card. Both optional; the human board sends
		// neither, and an agent that sends neither is still identified by the
		// X-Tandem-Agent header (see callerClaim). Presenting either engages the
		// fence — see the escape-hatch note in claim_fence.go for why the absence
		// of an identity deliberately does not.
		Agent           string `json:"agent"`
		ClaimGeneration int    `json:"claimGeneration"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.To == "" {
		writeError(w, http.StatusBadRequest, "to: the state to move the task into is required")
		return
	}
	note := strings.TrimSpace(body.Note)
	if !checkMoveNote(w, note) {
		return
	}
	caller := callerClaim(r, body.Agent, body.ClaimGeneration)
	current, err := h.store.GetAction(r.Context(), canvasID, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "action not found")
		return
	}
	// Tasks only. Epics have states too, but on the board they are the LENS, not
	// work — their only human transitions are the approve/reject that gate the
	// batch under them, and all three rewind store methods carry a
	// type='task' predicate anyway.
	if current.Type != "task" {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("only tasks can be moved on the board (this is a %q)", current.Type))
		return
	}
	// Idempotency, same rule as transitionAction: a click whose response was lost
	// must not come back as "illegal move: done → done". Checked BEFORE the
	// matrix so a retry succeeds even for a target that is not otherwise a legal
	// move out of that state.
	//
	// WITH ONE EXCEPTION, and it is the interesting case. An already-'executing'
	// task is not necessarily "already where you asked": approved → executing is
	// a CLAIM, and whether a second start is a harmless retry (same holder) or a
	// lost race (an agent picked it up while the person was reading the card) is
	// a question only the atomic claim can answer — it answers it with a 200 or a
	// 409 naming the holder. Short-circuiting here would hand the human a 200
	// carrying somebody else's claim.
	if current.State == body.To {
		if body.To == moveStart.to {
			h.startTaskAsHuman(w, r, moveStart, note)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"action": current})
		return
	}
	move, ok := humanMoveFor(current.State, body.To)
	if !ok {
		msg := fmt.Sprintf("a task in %q cannot be moved to %q", current.State, body.To)
		if current.State == "proposed" {
			// The one refusal that needs explaining rather than just listing: it is
			// the approval gate, and the caller is holding the right idea with the
			// wrong endpoint.
			msg += " — a proposed task leaves only through the approval gate: " +
				"POST /api/canvas/actions/{id}/approve or /reject"
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": msg,
			"state": current.State,
			"moves": humanMoveOptions(current.State),
		})
		return
	}
	// One fence for every move this endpoint makes, before the switch: a claim
	// (moveKindClaim) is atomic and fences itself in the DB, but a finish and a
	// rewind are writes onto a task somebody may be holding.
	if !h.fenceTaskWriteOrFail(w, r, current, caller) {
		return
	}
	switch move.kind {
	case moveKindClaim:
		h.startTaskAsHuman(w, r, move, note)
	case moveKindFinish:
		h.finishTaskAsHuman(w, r, current, move, note, caller)
	case moveKindRewind:
		// The note is passed in, not re-read: r.Body has already been consumed
		// above. (It was a silent bug the first time round — a decode of a spent
		// body fails with EOF, which rewindTask correctly ignores, so the note
		// simply vanished from the audit trail.)
		//
		// A zero claimant: this move was already fenced above, off the row we had
		// read anyway, so rewindTask must not spend a second read repeating it.
		h.rewindTask(w, r, move, note, claimant{})
	}
}

// POST /api/canvas/actions/{id}/rework — the REVIEWER'S "NO" (TDM-154).
//
//	{ "reason": "the migration is missing; TDM-40 needs the index too" }
//
// A registered agent on a 'peer' canvas sends FINISHED work back: done →
// approved, the claim and the stale result cleared, the task in the ready queue
// again for its author to revise. `reason` is REQUIRED — a bounce with no
// reason is a task that comes back with no instruction, which costs the author
// a whole run to rediscover what the reviewer already knew. Empty is a 400, not
// a silent success.
//
// WHY IT IS A SEPARATE DOOR AND NOT /move OR /reject:
//
//   - not /reject — rejection destroys a proposal and stays human-only
//     (action_handler.go). This destroys nothing; see peer_approval.go.
//   - not /move — that endpoint is human-only by surface and its matrix is the
//     human board's. Reusing it would have meant either widening the human
//     matrix for an agent's benefit or gating one row of it differently, and
//     both make the matrix stop meaning what its header says it means.
//
// So the state machine gains nothing: this is a second CALLER for the done →
// approved rewind that store.ReopenAction has always made, behind a gate of its
// own. Everything downstream — audit entry, queue-ready signal for a parked
// queue_wait, state broadcast, fleet activity — is rewindTask's, unchanged.
//
// 403s are coded (see peer_approval.go): rework_policy_required,
// rework_identity_required, rework_task_only, rework_completer_unknown,
// rework_self_review, rework_agent_unregistered.
func (h *Handler) ReworkAction(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id: expected a task uuid or an existing ticket ref like TDM-21")
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if len(reason) < reworkMinReason {
		// The one field this endpoint exists to carry. A 400 rather than a bounce
		// with an empty reason: the author would get the task back knowing only
		// that somebody disliked it.
		writeCodedError(w, http.StatusBadRequest, "rework_reason_required",
			"reason: say what has to change — sending work back without a reason gives the author no way to revise it", nil)
		return
	}
	if !checkMoveNote(w, reason) {
		return
	}
	current, err := h.store.GetAction(r.Context(), canvasID, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "action not found")
		return
	}
	// The gate. A signed-in human short-circuits it exactly as on approve: a
	// person can already make this move from the board (moveReopen), so refusing
	// them at this door would be theatre — but the reason stays required, because
	// the author's need for one does not depend on who pressed the button. Every
	// non-human caller is judged by the 'peer' rework rule.
	if !callerIsHuman(r.Context()) && !h.authorizePeerRework(w, r, current) {
		return
	}
	// FINISHED work only, and strictly: 'done' is the one state a bounce means
	// anything from. Deliberately NOT idempotent on 'approved' — a task already
	// back in the queue answers with its state rather than a 200 and a second
	// audit entry, so a reviewer re-sending a lost request can see what happened
	// instead of silently double-bouncing.
	if current.State != moveRework.from {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "rework_not_finished",
			"message": fmt.Sprintf("only finished work can be sent back for rework: this task is %q, not %q",
				current.State, moveRework.from),
			"state": current.State,
		})
		return
	}
	// Zero claimant: the reviewer is not the holder, and it must not have to be —
	// bouncing somebody else's finished work is the entire point, so the claim
	// fence would refuse exactly the caller this endpoint is for. The non-self
	// rule above is what stands in its place.
	h.rewindTask(w, r, moveRework, reason, claimant{})
}

// startTaskAsHuman is approved → executing for a PERSON: the identical atomic
// claim an agent makes (so a human and an agent cannot both win one task),
// minus the presence side effect — see claimTaskAs's `presence` parameter for
// why a human must not mint an agents row.
func (h *Handler) startTaskAsHuman(w http.ResponseWriter, r *http.Request, move humanMove, note string) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	action, err := h.claimTaskAs(r.Context(), canvasID, id, humanClaimant, false)
	if err != nil {
		// Same mapping as claimAction — including the structured 409 naming the
		// holder, which on this surface is what tells a person "an agent picked
		// this up while you were reading it".
		var claimed *store.AlreadyClaimedError
		switch {
		case errors.As(err, &claimed):
			writeJSON(w, http.StatusConflict, map[string]string{
				"error":     "already_claimed",
				"claimedBy": claimed.ClaimedBy,
			})
		case errors.Is(err, store.ErrActionNotFound):
			writeError(w, http.StatusNotFound, "action not found")
		case errors.Is(err, store.ErrIllegalActionState):
			writeError(w, http.StatusBadRequest, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	h.recordMove(r.Context(), canvasID, action, move, note, moveActor(r))
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	// Same shape as every other claim: the token comes back even here, so a
	// person's Start and an agent's task_claim are answered identically.
	writeClaimed(w, action)
}

// finishTaskAsHuman is executing → done|failed for a person, through
// transitionAction — the one funnel every completion on every surface goes
// through. That is the point: a task a human finished must be
// indistinguishable downstream from one an agent finished (same content gate,
// same idempotent retry, same task.completed webhook, same "completed" activity
// verb), because a receiver's job is to react to finished work, not to audit who
// pressed the button.
//
// The audit entry rides the SAME write as the transition, as patch.Payload,
// rather than being appended after it: one round trip, and the response plus the
// state broadcast both already carry it. (Safe at the gate: an audit-only
// payload changes no content field, so ContentDiff is empty and
// transitionAction's content_locked check passes. Exactly how the status API's
// evidence links ride a completion.)
func (h *Handler) finishTaskAsHuman(w http.ResponseWriter, r *http.Request, current *store.Action, move humanMove, note string, caller claimant) {
	patch := store.ActionStatePatch{}
	if note != "" {
		// Where the note lands is the difference between the two finishes: 'done'
		// gets a result summary, 'failed' gets the reason. Same two columns the
		// MCP task_complete and the CI status API write.
		if move.to == "done" {
			patch.Result = &note
		} else {
			patch.Error = &note
		}
	}
	entry := store.NewStateAudit(moveActor(r), move.from, move.to, note, time.Now().UTC())
	if next, err := store.AppendAudit(current.Payload, entry); err == nil {
		patch.Payload = next
	} else {
		// Losing the audit entry must not lose the completion — a person who
		// pressed Done and got an error would press it again.
		log.Printf("move %s (%s): building the audit entry: %v", current.ID, move.label, err)
	}
	fresh, moved := h.transitionAction(w, r, move.to, patch, caller)
	if moved {
		h.emitTaskEvent(CanvasIDFromCtx(r.Context()), webhooks.EventTaskCompleted, fresh)
	}
}

// rewindTask is the shared body of every BACKWARDS human move: release,
// requeue, reopen and reconsider. All four are the same shape — one conditional
// UPDATE predicated on the state the card was in, then the audit entry, then the
// broadcasts — which is why ReleaseAction and RequeueAction are now one line
// each on top of it.
//
// `move` decides which store method runs, and the store method (not this
// function) is what makes the write safe against a task that moved under the
// request: each carries a state predicate and re-reads to disambiguate, so a
// lost race becomes ErrIllegalActionState rather than a lost update.
//
// `note` arrives already parsed because the two doors read it from different
// places: MoveAction takes it alongside `to` in one body, while the standalone
// release/requeue endpoints read (usually absent) bodies of their own.
func (h *Handler) rewindTask(w http.ResponseWriter, r *http.Request, move humanMove, note string, caller claimant) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if !checkMoveNote(w, note) {
		return
	}
	// The fence, for the standalone release/requeue doors (POST …/move fences off
	// the row it already read and passes a zero claimant). Only a caller that
	// asserts a claim identity pays for the read — and only such a caller is
	// fenced: taking a task away from a worker that died is what these endpoints
	// are FOR, so a human must always be able to. See claim_fence.go.
	if caller.presented() {
		if current, gerr := h.store.GetAction(r.Context(), canvasID, id); gerr == nil {
			if !h.fenceTaskWriteOrFail(w, r, current, caller) {
				return
			}
		}
	}

	var action *store.Action
	switch move {
	case moveRelease:
		action, _, err = h.store.ReleaseAction(r.Context(), canvasID, id)
	case moveRequeue:
		action, _, err = h.store.RequeueAction(r.Context(), canvasID, id)
	default:
		// reopen (done → approved), rework (the reviewer's bounce, same pair) and
		// reconsider (rejected → proposed): one method, predicated on a pair the
		// caller has already validated — the human matrix for the first and last
		// (humanMoveFor), the explicit 'done' check in ReworkAction for the middle.
		// It is never reachable with an arbitrary pair from a request body.
		action, _, err = h.store.ReopenAction(r.Context(), canvasID, id, move.from, move.to)
	}
	if err != nil {
		switch {
		case errors.Is(err, store.ErrActionNotFound):
			writeError(w, http.StatusNotFound, "action not found")
		case errors.Is(err, store.ErrIllegalActionState):
			writeError(w, http.StatusBadRequest, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	h.recordMove(r.Context(), canvasID, action, move, note, moveActor(r))
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	// A rewind that lands in 'approved' put a task back in the READY QUEUE, so
	// anyone long-polling for work must be told (TDM-148). It deliberately fires
	// no task.approved webhook — re-queueing is not a second approval, and a fleet
	// subscribed to that event would re-run work it already picked up — but a
	// parked waiter is not a subscriber: it is an agent asking "is there work?",
	// and after a release there is. Cheap when nobody is waiting.
	if action != nil && action.Type == "task" && action.State == "approved" {
		h.signalQueueReady(canvasID)
		// …and for the ONE rewind that undoes a terminal state, the webhook half of
		// the same news (TDM-170). Until this existed, a bounce woke a live
		// orchestrator through the signal above and told a webhook-launched one
		// nothing — the two orchestration modes disagreed about whether returned
		// work is an event, and on a 'peer' canvas the reviewer's whole "redo this"
		// reached nobody outside the process.
		//
		// SCOPED TO done → approved on purpose: that transition falsifies a
		// task.completed this canvas already published, and retracting our own
		// claim is what earns an event. Release and requeue contradict nothing and
		// stay silent (see task_events.go for the full boundary). `move.from` is the
		// discriminator rather than the row, because the row has already been
		// rewound by here and no longer remembers where it came from.
		if move.from == moveRework.from {
			h.emitTaskEvent(canvasID, webhooks.EventTaskReturned, action,
				withReturned(move.from, moveActor(r), note))
		}
	}
	// The fleet verb, with the actor the SERVER derived rather than the "human"
	// actorFor assumes for these verbs: a rewind on a public canvas may well be
	// an anonymous viewer, and the feed should say so.
	broadcastActionActivityAs(h.hub, canvasID, move.verb, action, moveActor(r))
	writeJSON(w, http.StatusOK, map[string]any{"action": action})
}

// recordMove writes the one audit entry a human move owes the task, and folds
// the stored payload back onto the action about to be returned so the response
// carries the entry it just created (the board renders the audit chips straight
// off the payload).
//
// BEST-EFFORT BY CONTRACT, and deliberately so: the state change has already
// committed and the person has already seen their card move. Failing the request
// now would tell them the move didn't happen when it did — the worst possible
// lie for a board whose whole job is to say where the work is. A dropped entry
// is logged instead.
func (h *Handler) recordMove(ctx context.Context, canvasID uuid.UUID, action *store.Action, move humanMove, note, actor string) {
	if action == nil {
		return
	}
	entry := store.NewStateAudit(actor, move.from, move.to, note, time.Now().UTC())
	next, err := h.store.AppendActionAudit(ctx, canvasID, action.ID, entry)
	if err != nil {
		log.Printf("move %s (%s): recording the audit entry: %v", action.ID, move.label, err)
		return
	}
	action.Payload = next
}

// moveBody reads the optional note AND the optional claim identity off a request
// body NOBODY has read yet — the shape the standalone release/requeue endpoints
// take. They usually carry no body at all, so a decode failure (including the EOF
// of an empty body) is not an error: it means "no note, no identity". An
// unidentified caller is unfenced by design (claim_fence.go).
func moveBody(r *http.Request) (string, claimant) {
	var body struct {
		Note            string `json:"note"`
		Agent           string `json:"agent"`
		ClaimGeneration int    `json:"claimGeneration"`
	}
	_ = decode(r, &body)
	return strings.TrimSpace(body.Note), callerClaim(r, body.Agent, body.ClaimGeneration)
}

// checkMoveNote bounds the note and writes the 400 itself. Enforced on both
// doors into a move — /move parses the note next to `to`, release/requeue read
// their own bodies — so neither can grow an unbounded audit summary.
func checkMoveNote(w http.ResponseWriter, note string) bool {
	if len(note) > maxMoveNote {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("note must be at most %d characters", maxMoveNote))
		return false
	}
	return true
}

// moveActor is who the SERVER concluded is moving this card — "human" for a
// signed-in browser session, "anonymous" for a viewer on a public canvas,
// "agent:<name>" if something asserted an agent identity. Never a guess: an
// empty string (a route without the Provenance middleware) stays empty, and
// NewStateAudit records that honestly as "unknown".
func moveActor(r *http.Request) string {
	if a := AuthorFromCtx(r.Context()); a != nil {
		return *a
	}
	return ""
}
