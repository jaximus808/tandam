package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// ── Resubmit: the author's answer to a rejection (TDM-3) ─────────────────────
//
// THE DEAD END THIS CLOSES. A human rejects a ticket and says why. The agent
// that wrote it has, until now, exactly one move: propose a NEW ticket. So the
// board accumulates near-duplicates — TDM-51, TDM-58 and TDM-63 all being the
// same idea with the reviewer's correction folded in one attempt at a time — and
// the rejection reason, the ticket's own history and its ticket ref are left
// behind on a card nobody will look at again. rejected → proposed already exists
// as a move; it was just human-only (moveReconsider in task_move.go, taskRevive
// in task_owner_move.go), and a human re-proposing an agent's ticket byte-for-
// byte is not what anybody wanted from the gate either.
//
// So: the author may put its OWN rejected ticket back at the gate, with a note
// saying what it changed, and optionally with the amendment itself.
//
// IT LANDS BEHIND THE HUMAN GATE, and that is what makes this safe to give an
// agent at all. Every other property follows from it:
//
//   - the target state is 'proposed', never 'approved'. Nothing here reaches the
//     ready queue; the human who rejected it decides again, exactly as they did
//     the first time. The gate is not weakened by one click.
//   - NO queue-ready signal and NO webhook. A parked queue_wait is asking "is
//     there work?" and after a resubmit there is strictly none — the same
//     reasoning task_owner_move.go's un-approve spells out. (The rejection WAKE
//     is a different ticket's contract, on the rejection itself, not here.)
//   - it is reversible by one human click: reject it again.
//
// THE GATE IS AUTHORSHIP, from provenance the caller cannot forge. `authored_by`
// is stamped on INSERT from the same middleware that answers AuthorFromCtx here
// (provenance.go), and nothing in any request body can name it. An agent may
// therefore resubmit its own rejected work and nobody else's — which is the
// narrowest rule that makes the feature useful, and it fails CLOSED on anything
// it cannot attribute (see resubmitRefusal). It is deliberately NOT "any
// registered agent": bringing back a peer's rejected ticket is a planning
// decision about someone else's work, and the human who rejected it already has
// the board move for that.
//
// WHY A SEPARATE DOOR AND NOT /move OR task_amend:
//
//   - not /move — that endpoint's matrix is the human board's, and gating one
//     row of it differently would make it stop meaning what its header says
//     (the argument ReworkAction and MoveTask both already made).
//   - not the payload PATCH (task_amend) — a content edit on a rejected task
//     leaves it rejected. Amending is how the ticket CHANGES; this is how it goes
//     back to the gate, and folding the two would mean every stray edit to a
//     triaged ticket silently re-queued it for human attention.
//
// Refusals are coded JSON data a gateway can branch on: task_not_found,
// resubmit_wrong_state, resubmit_not_author, resubmit_note_required.

const (
	// resubmitMinNote is the floor on the note, deliberately the SAME bar the
	// reviewer's bounce sets (reworkMinReason): the cost of saying "here it is
	// again" is one sentence about what changed. It is not a quality gate — the
	// human re-reading the ticket is.
	resubmitMinNote = reworkMinReason

	// resubmitRejectionMarker separates the author's note from the rejection
	// reason it is answering, inside the ONE audit entry the resubmit writes.
	// The reason lives in actions.error while a ticket is rejected, and the
	// resubmit clears that column — so unless it is folded in here, the verdict
	// this attempt exists to answer is destroyed by the answer. Greppable on
	// purpose: it is the seam a reader (or a later feature) can split on.
	resubmitRejectionMarker = "\n\n— was rejected: "
)

// resubmitServerOwnedKeys are the payload keys a caller's amendment may not
// speak for. store.carryContentAudit already replaces all three with the stored
// row's copies on the write, so this is belt-and-braces — but it also keeps them
// out of the validation step in between, where a forged `audit` array would
// otherwise look like ordinary content passing through canonicalizeTaskPayload.
var resubmitServerOwnedKeys = map[string]bool{
	"claim":      true,
	"contention": true,
	"audit":      true,
}

// POST /api/canvas/actions/{id}/resubmit — the author's amend-and-retry.
//
//	{ "note": "dropped the migration; this is the API change only",
//	  "payload": { "body": "…the narrowed scope…" } }
//
// `note` is REQUIRED: it is what the human reads next to the card to decide
// whether anything actually changed since they said no. `payload` is optional
// and MERGED onto the stored payload key by key (a JSON null deletes a key), so
// an author fixing a body does not have to resend a title, linkedIds and epicId
// it never meant to touch.
//
// On success: 200 with the ticket now 'proposed', its claim, approval stamp and
// rejection reason cleared, and one audit entry carrying the note plus the
// rejection reason it answers. Same ticket, same ref, same history.
func (h *Handler) ResubmitAction(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	canvasID := CanvasIDFromCtx(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		// A ref that names nothing on this canvas arrives here unresolved (see
		// ResolveTicketRef). "No such ticket" is the honest answer and the one the
		// gateway can act on — not "invalid id", which reads as a client bug.
		writeCodedError(w, http.StatusNotFound, "task_not_found",
			"no task with that id or ticket ref on this canvas",
			map[string]string{"id": chi.URLParam(r, "id")})
		return
	}
	var body struct {
		// Note is what changed since the rejection. Required — see below.
		Note string `json:"note"`
		// Payload is the amendment: a PARTIAL task payload merged onto the stored
		// one. Absent means "the ticket text stands; I am asking again".
		Payload json.RawMessage `json:"payload"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	note := strings.TrimSpace(body.Note)
	if len(note) < resubmitMinNote {
		// The whole cost of the feature, and it is one sentence. Without it a human
		// sees a ticket they already rejected sitting back at the gate with nothing
		// to distinguish it from the version they said no to — which is precisely
		// the duplicate-ticket problem in a new costume.
		writeCodedError(w, http.StatusBadRequest, "resubmit_note_required",
			"note: say what changed since the rejection — a ticket that comes back with no answer to the reason it was rejected "+
				"gives the human nothing new to decide on", nil)
		return
	}
	if !checkMoveNote(w, note) {
		return
	}

	current, err := h.store.GetAction(ctx, canvasID, id)
	if err != nil {
		writeCodedError(w, http.StatusNotFound, "task_not_found",
			"no task with that id on this canvas", map[string]string{"id": id.String()})
		return
	}
	// AUTHORSHIP FIRST, before the state is disclosed: whether a ticket exists is
	// already answered above (it is on this canvas), but what state somebody
	// else's ticket is in is not something a non-author learns from this door.
	caller := ""
	if a := AuthorFromCtx(ctx); a != nil {
		caller = *a
	}
	if refusal := resubmitRefusal(caller, current); refusal != nil {
		writeCodedError(w, http.StatusForbidden, refusal.code, refusal.message, refusal.extra)
		return
	}
	if current.State != "rejected" {
		writeCodedError(w, http.StatusBadRequest, "resubmit_wrong_state",
			resubmitWrongStateMessage(current.State),
			map[string]string{"state": current.State})
		return
	}

	// The amendment, validated as a whole task payload — the merge result is what
	// gets stored, so it has to satisfy the same rules a proposal does (a title
	// that survives, a legal assignee, a canonical epicId). A patch that empties
	// the title is a 400 here rather than a ticket at the gate with no name.
	merged, err := mergeTaskPayload(current.Payload, body.Payload)
	if err != nil {
		writeError(w, http.StatusBadRequest, "payload: "+err.Error())
		return
	}
	canonical, err := canonicalizeTaskPayload(merged)
	if err != nil {
		writeError(w, http.StatusBadRequest, "payload: "+err.Error())
		return
	}

	// ONE audit entry, written in the same store call as the state change: actor
	// is the server-derived author (never the body), states are rejected →
	// proposed, and the note carries the author's words PLUS the rejection reason
	// the write is about to clear out of `error`.
	rejection := ""
	if current.Error != nil {
		rejection = strings.TrimSpace(*current.Error)
	}
	entry := store.NewStateAudit(caller, "rejected", "proposed",
		resubmitAuditNote(note, rejection), time.Now().UTC())

	action, _, err := h.store.ResubmitAction(ctx, canvasID, id, canonical, entry)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrActionNotFound):
			writeCodedError(w, http.StatusNotFound, "task_not_found",
				"no task with that id on this canvas", map[string]string{"id": id.String()})
		case errors.Is(err, store.ErrIllegalActionState):
			// It moved under the request — a human revived or re-triaged it while
			// this was in flight. Same code as the pre-check so a client has one
			// branch, with the state the store found.
			writeCodedError(w, http.StatusBadRequest, "resubmit_wrong_state", err.Error(), nil)
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}

	broadcastStateAsync(ctx, h.store, h.hub, canvasID)
	// The actor the SERVER derived, not actorFor's guess: a ticket landing in
	// 'proposed' would otherwise be attributed to proposedBy, which for a resubmit
	// happens to be right and for a human-authored ticket would not be.
	broadcastActionActivityAs(h.hub, canvasID, activityProposed, action, caller)
	// Deliberately NO signalQueueReady and NO webhook — see the file header. This
	// move takes work OUT of the ready queue's future, it does not put any in.

	writeJSON(w, http.StatusOK, map[string]any{
		"action":      action,
		"resubmitted": true,
		"from":        "rejected",
		"to":          "proposed",
	})
}

// resubmitRefusal is the authorship rule as a PURE function — no store, no
// router — so every branch is table-testable, exactly like peerApprovalRefusal
// and peerReworkRefusal whose discipline it borrows.
//
// `caller` is AuthorFromCtx for this request; `target` is the stored row. Returns
// nil when the resubmit may proceed.
//
// EVERY UNATTRIBUTABLE CASE FAILS CLOSED, and the list is worth reading as a
// list: no provenance at all (a route without the middleware), an anonymous
// canvas-token holder, and a row with no recorded author (it predates migration
// 0039) are all "we cannot tell", and "we cannot tell" resolves to "a human
// decides" — the human already has the board's Re-propose. Anonymous is the
// interesting one: two anonymous callers are not the same identity, they are the
// absence of one, so matching "anonymous" against "anonymous" would hand every
// viewer of a public canvas the author's verb.
func resubmitRefusal(caller string, target *store.Action) *peerRefusal {
	caller = strings.TrimSpace(caller)
	if caller == "" || caller == AuthorAnonymous {
		return &peerRefusal{
			code: "resubmit_not_author",
			message: "resubmitting requires an identity the server can see: connect through the MCP gateway (canvas_connect sends the identity header) and resubmit " +
				"under the identity that proposed the ticket — an anonymous canvas token cannot",
		}
	}
	if target.Type != "task" {
		return &peerRefusal{
			code: "resubmit_not_author",
			message: fmt.Sprintf("only a task can be resubmitted (this is a %q): a rejected epic is revived by its owner "+
				`(POST /api/canvas/epics/{id}/move with {"to":"proposed"})`, target.Type),
			extra: map[string]string{"type": target.Type},
		}
	}
	if target.AuthoredBy == nil || strings.TrimSpace(*target.AuthoredBy) == "" {
		return &peerRefusal{
			code: "resubmit_not_author",
			message: "this ticket has no recorded author (it predates provenance), so the server cannot prove you wrote it — " +
				`a human brings it back (POST /api/canvas/tasks/{id}/move with {"to":"proposed"})`,
		}
	}
	if strings.TrimSpace(*target.AuthoredBy) != caller {
		return &peerRefusal{
			code: "resubmit_not_author",
			message: "only the agent that proposed a ticket may resubmit it: this one was proposed by " + strings.TrimSpace(*target.AuthoredBy) +
				" and you are " + caller + ". Bringing back somebody else's rejected ticket is the owner's call, not a peer's.",
			extra: map[string]string{"caller": caller, "proposedBy": strings.TrimSpace(*target.AuthoredBy)},
		}
	}
	return nil
}

// resubmitWrongStateMessage explains the refusal in terms of the state the
// ticket is actually in, and points at the door that DOES apply — a client
// working off a stale board should be able to correct itself rather than guess.
func resubmitWrongStateMessage(state string) string {
	msg := fmt.Sprintf("only a rejected ticket can be resubmitted (this one is %q)", state)
	switch state {
	case "proposed":
		msg += " — it is already at the gate, waiting on a human"
	case "approved":
		msg += " — it is already in the ready queue: claim it"
	case "executing":
		msg += " — somebody is working on it"
	case "done", "failed":
		msg += " — finished work goes back through rework (POST /api/canvas/actions/{id}/rework) or the owner's re-open"
	}
	return msg
}

// resubmitAuditNote folds the author's note and the rejection reason it answers
// into the ONE entry the resubmit writes. See resubmitRejectionMarker: the
// reason lives in a column this write clears, so if it is not carried here it is
// gone, and the next reader of the trail sees an answer with no question.
//
// Both halves are verbatim and unexcerpted. The audit SUMMARY quotes at 80
// runes, which is right for a glance and wrong when the text is the instruction
// — the same lesson TDM-154 learned about a rework reason.
func resubmitAuditNote(note, rejection string) string {
	if rejection == "" {
		return note
	}
	return note + resubmitRejectionMarker + rejection
}

// mergeTaskPayload folds a caller's PARTIAL payload onto the stored one, key by
// top-level key. Shallow on purpose: a task payload is flat ({title, body,
// assignee, epicId, linkedIds, links…}), and a deep merge would make it
// impossible to shorten an array — an author dropping two of three linkedIds
// would find all three still there.
//
// The rules, and each is a decision:
//
//   - a key the patch does not mention is untouched. That is what makes the
//     amendment safe to send from an agent holding only the field it changed.
//   - an explicit JSON null DELETES the key, which is the only way to clear an
//     optional field (sending "" would store an empty string, and for epicId
//     canonicalizeTaskPayload already reads that as "unlink").
//   - server-owned keys in the patch are dropped, never merged. carryContentAudit
//     would overwrite them on the write anyway; dropping them here means the
//     validation step in between never sees a forged audit trail either.
//
// An empty patch returns the stored payload unchanged (not a re-marshalled copy)
// so a plain "ask again" writes byte-identical content.
func mergeTaskPayload(stored, patch json.RawMessage) (json.RawMessage, error) {
	if len(patch) == 0 {
		return stored, nil
	}
	var incoming map[string]any
	if err := json.Unmarshal(patch, &incoming); err != nil {
		return nil, fmt.Errorf("must be an object")
	}
	base := map[string]any{}
	if len(stored) > 0 {
		// A stored payload that isn't an object is not something to merge onto —
		// canonicalizeTaskPayload rejects those on the way in, so this is a safety
		// net, and the safe direction is to treat the patch as the whole payload.
		_ = json.Unmarshal(stored, &base)
	}
	for k, v := range incoming {
		if resubmitServerOwnedKeys[k] {
			continue
		}
		if v == nil {
			delete(base, k)
			continue
		}
		base[k] = v
	}
	return json.Marshal(base)
}
