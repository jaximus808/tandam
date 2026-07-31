package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// Peer approval — the 'peer' canvas approval policy (TDM-145, migration 0041).
//
// THE FEATURE: on a canvas whose owner opted into 'peer', a REVIEWER agent may
// approve a proposed task that a DIFFERENT agent proposed. That is the whole
// point — an orchestrator+reviewer pair can pilot a pipeline end to end without
// a human clicking Approve on every card — and it is deliberately the only
// thing 'peer' buys. Everything else about the gate is untouched.
//
// THE ONE RULE THAT MUST NOT BE GOT WRONG: both identities are SERVER-derived.
// The approver is AuthorFromCtx (the Provenance middleware's conclusion about
// this request); the proposer is the stored authored_by of the row being
// approved, itself stamped on INSERT from the same middleware. Neither is ever
// read off the request body. The body is precisely the forgery vector TDM-40
// and TDM-129 closed — a task minting itself an approvedBy, or a fabricated
// human-looking stamp — and peer approval must not reopen it. There is,
// accordingly, no "approverId"/"approvedBy"/"proposedBy" field anywhere in this
// file's decision: a caller that sends one is dropped on the floor by
// encoding/json exactly as before.
//
// WHAT IT DOES NOT WEAKEN:
//   - Default OFF. 'peer' has to be set explicitly (owner-only, see
//     SetCanvasApprovalPolicy). A canvas on strict|epic|auto takes the identical
//     path it took before this file existed, down to the refusal TEXT.
//   - Born-approved is still human-only. 'peer' governs approving an EXISTING
//     proposed row; an agent still cannot create one already approved.
//   - Reject is still human-only. An agent must not clear a peer's proposal out
//     of the queue — that is a decision to kill work, not to release it.
//   - EPICS ARE HUMAN-ONLY, on purpose and not by omission. Approving an epic
//     cascades to every task under it, so an agent-approvable epic is a blast
//     radius orders of magnitude larger than one task. Out of scope for TDM-145;
//     peerApprovalRefusal refuses it explicitly rather than leaving it ambiguous.
//   - Bulk approve (POST …/approve-batch) is still human-only. It flips rows in
//     one conditional UPDATE that knows nothing about per-row authorship, so it
//     could not enforce non-self even if it wanted to.
//   - 'peer' never auto-approves anything at birth. Under it, every agent task
//     lands 'proposed' (like 'strict') and the epic cascade is skipped — a
//     reviewer gate that a cascade could walk around would be decoration. See
//     policyApproval and policyCascadesToEpicTasks.
//
// THE HONEST LIMIT: an agent identity is client-asserted (see provenance.go —
// the "agent:" PREFIX is server-stamped, the name after it is not). So the
// non-self rule stops an agent that says who it is from approving its own work;
// it cannot stop an agent that lies about which agent it is. That is the same
// accepted limit claimed_by has always had, and it is why "human" — which no
// agent credential can produce — remains the strong side of the gate. The
// registered-agent check below raises the floor a little: the asserted identity
// must at least name an agent that registered on THIS canvas.

// policyPeer is the fourth approval policy, alongside strict|epic|auto
// (migrations 0033 + 0041). Kept as a constant because three files branch on it
// and a typo'd string literal would silently fail OPEN in one of them.
const policyPeer = "peer"

// refusalApproveHumanOnly is the pre-peer refusal, preserved verbatim: a canvas
// on strict|epic|auto must answer a non-human approve exactly as it did before
// peer approval existed, same status and same bytes.
const refusalApproveHumanOnly = "only a signed-in human can approve an action"

// policyCascadesToEpicTasks reports whether approving an EPIC should batch-approve
// its proposed tasks under this policy. 'strict' says no (every task keeps its own
// gate) and 'peer' says no for the same reason — under 'peer' the per-task gate is
// the reviewer's, and a cascade would hand a whole batch through without one.
func policyCascadesToEpicTasks(policy string) bool {
	return policy != "strict" && policy != policyPeer
}

// authorIsAgent reports whether a server-derived author string names an agent.
// The prefix is the part provenance.go stamps itself, so this is a trustworthy
// classification even though the name after it is client-asserted.
func authorIsAgent(author string) bool {
	return strings.HasPrefix(author, authorAgentPrefix)
}

// peerRefusal is a machine-readable refusal: a stable `code` a gateway or UI can
// branch on, plus prose for whatever is reading the response (which may be a
// curl in CI with no model behind it).
type peerRefusal struct {
	code    string
	message string
	extra   map[string]string
}

// peerApprovalRefusal is the peer rule as a PURE function — no store, no router —
// so the non-self logic is testable on its own. It assumes the canvas is already
// known to be on 'peer' (the handler checks that, since it needs the store).
// Returns nil when the approval may proceed.
//
// `approver` is AuthorFromCtx for this request; `target` is the stored row.
func peerApprovalRefusal(approver string, target *store.Action) *peerRefusal {
	if !authorIsAgent(approver) {
		// Anonymous canvas-token holders land here: a valid 8-char code with no
		// asserted identity. Peer approval is attributable by construction, and an
		// unattributable approval is exactly what the gate exists to prevent.
		return &peerRefusal{
			code: "peer_identity_required",
			message: "peer approval requires an agent identity the server can see — connect through the MCP gateway (canvas_connect registers you and sends the identity header) " +
				"so the approval can be attributed; an anonymous canvas token cannot approve",
		}
	}
	if target.Type != "task" {
		// Deliberate scope line, not an oversight — see the file comment.
		return &peerRefusal{
			code: "peer_epic_human_only",
			message: "peer approval covers tasks only: approving an epic cascades to every task under it, so epics stay human-only on a 'peer' canvas too — " +
				"a human approves the epic, or the tasks are approved one by one",
			extra: map[string]string{"actionType": target.Type},
		}
	}
	if target.AuthoredBy == nil {
		// Fail CLOSED on unknown authorship: with no proposer recorded there is no
		// way to enforce non-self, and "we couldn't tell" must never resolve to
		// "allowed". Rows predating provenance (migration 0039) are the case.
		return &peerRefusal{
			code: "peer_proposer_unknown",
			message: "this task has no recorded proposer (it predates provenance), so the server cannot prove the approver is a different agent — a human must approve it",
		}
	}
	if *target.AuthoredBy == approver {
		return &peerRefusal{
			code: "peer_self_approval",
			message: "self-approval is refused: under the 'peer' policy a task must be approved by a DIFFERENT agent than the one that proposed it, and this approval resolves to the proposer (" +
				approver + "). Hand it to your reviewer agent, or ask a human.",
			extra: map[string]string{"approver": approver, "proposedBy": *target.AuthoredBy},
		}
	}
	return nil
}

// authorizePeerApproval is the store-backed half of the rule: it decides whether
// this NON-HUMAN caller may approve the action named by {id}. Writes the refusal
// itself and returns false when it must not.
//
// Every failure path fails CLOSED, and a canvas that is not on 'peer' gets the
// byte-identical legacy 403 — an existing board must not even be able to TELL
// that this code was added.
func (h *Handler) authorizePeerApproval(w http.ResponseWriter, r *http.Request) bool {
	ctx := r.Context()
	canvasID := CanvasIDFromCtx(ctx)
	// Unreadable policy is treated as "not peer": the human gate is the safe
	// default, exactly as policyResolver.stamp falls back to 'strict'.
	canvas, err := h.store.GetCanvasByID(ctx, canvasID)
	if err != nil || canvas.ApprovalPolicy != policyPeer {
		writeError(w, http.StatusForbidden, refusalApproveHumanOnly)
		return false
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id: expected a task uuid or an existing ticket ref like TDM-21")
		return false
	}
	// The row is read HERE, before the transition, because the rule is about the
	// stored proposer. transitionAction re-reads it; that second read is the price
	// of keeping the gate a precondition rather than threading the action through.
	target, err := h.store.GetAction(ctx, canvasID, id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return false
	}
	approver := ""
	if a := AuthorFromCtx(ctx); a != nil {
		approver = *a
	}
	if refusal := peerApprovalRefusal(approver, target); refusal != nil {
		writeCodedError(w, http.StatusForbidden, refusal.code, refusal.message, refusal.extra)
		return false
	}
	// "A REGISTERED agent may approve": the asserted identity must name an agent
	// that registered on this canvas. It does not make the identity unforgeable
	// (see the file comment), but it does mean a peer approval is always
	// attributable to a row on the fleet view rather than to a string nobody has
	// ever seen — and it keeps a stray script that invents a header out.
	if !h.approverIsRegisteredAgent(ctx, canvasID, approver) {
		writeCodedError(w, http.StatusForbidden, "peer_agent_unregistered",
			"peer approval requires a registered agent on this canvas: register first (canvas_connect / agent_register with a name) and approve under that identity",
			map[string]string{"approver": approver})
		return false
	}
	return true
}

// approverIsRegisteredAgent resolves an "agent:<identity>" author against the
// canvas roster. The gateway sends its registered NAME as the identity header
// (falling back to the agent id), so both spellings are accepted. A store error
// answers false — fail closed.
func (h *Handler) approverIsRegisteredAgent(ctx context.Context, canvasID uuid.UUID, approver string) bool {
	name := strings.TrimPrefix(approver, authorAgentPrefix)
	if name == "" {
		return false
	}
	agents, err := h.store.ListAgents(ctx, canvasID)
	if err != nil {
		return false
	}
	for _, a := range agents {
		if a == nil {
			continue
		}
		if a.Name == name || a.ID.String() == name {
			return true
		}
	}
	return false
}
