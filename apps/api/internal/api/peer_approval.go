package api

import (
	"context"
	"log"
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

// ── Rework: the reviewer's "no" (TDM-154) ────────────────────────────────────
//
// Peer approval let a reviewer say YES. This is the other half: a reviewer agent
// may send FINISHED work back — done → approved, with a required reason — so the
// author can revise it. It is deliberately a BOUNCE and not a kill.
//
// WHY THIS AND NOT REJECT. RejectAction (action_handler.go) stays human-only,
// and the reasoning there is right: rejection destroys a proposal. Rework
// destroys nothing — the task goes back to the ready queue it already passed the
// gate to enter, and every state it lands in is one a human can undo with a
// single move. That reversibility is exactly the class 'peer' already permits,
// which is why this door opens on 'peer' and nowhere else.
//
// THE NON-SELF RULE, again from server-derived identities only. For approval the
// pair is (approver, stored proposer). Here it is (reviewer, stored COMPLETER) —
// the claimant that finished the work, off claimed_by, which the claim path
// stamps. A reviewer that IS the completer is reviewing itself, and an agent
// bouncing its own finished task is just a slower reopen. The reason field is
// never an identity: as everywhere in this file, no request body buys a decision.
//
// FAIL CLOSED ON AN UNKNOWN COMPLETER, the same discipline as
// peer_proposer_unknown: claimed_by may be absent (a row that predates the claim
// record) or the generic "agent" fallback the claim path writes when no name was
// asserted. Neither can prove non-self, so neither is allowed to.
const (
	// reworkGenericClaimant is what claimAction stamps when a caller claims with
	// no asserted name. It names no one, so it cannot be compared for non-self.
	reworkGenericClaimant = "agent"
	// reworkMinReason is a floor, not a quality bar: the point is that "no" costs
	// the reviewer a sentence. The real quality gate is a human reading the board.
	reworkMinReason = 1
)

// sameAgentIdentity compares a server-derived author ("agent:<name>") with a
// claimed_by value. They are stored in two different spellings — provenance
// prefixes, claimed_by holds the bare registered name — so the comparison is on
// the name, with the prefix tolerated on either side.
func sameAgentIdentity(author, claimant string) bool {
	a := strings.TrimPrefix(author, authorAgentPrefix)
	c := strings.TrimPrefix(claimant, authorAgentPrefix)
	return a != "" && a == c
}

// peerReworkRefusal is the rework rule as a PURE function, the counterpart of
// peerApprovalRefusal and testable the same way. It assumes the canvas is
// already known to be on 'peer' and the task already known to be 'done' (the
// handler checks both — one needs the store, the other is the move matrix).
//
// `reviewer` is AuthorFromCtx for this request; `target` is the stored row.
// Returns nil when the bounce may proceed.
func peerReworkRefusal(reviewer string, target *store.Action) *peerRefusal {
	if !authorIsAgent(reviewer) {
		return &peerRefusal{
			code: "rework_identity_required",
			message: "sending work back for rework requires an agent identity the server can see — connect through the MCP gateway (canvas_connect registers you and sends the identity header) " +
				"so the bounce can be attributed; an anonymous canvas token cannot review",
		}
	}
	if target.Type != "task" {
		return &peerRefusal{
			code:    "rework_task_only",
			message: "only a task can be sent back for rework: an epic is the batch, not the work",
			extra:   map[string]string{"actionType": target.Type},
		}
	}
	completer := ""
	if target.ClaimedBy != nil {
		completer = strings.TrimSpace(*target.ClaimedBy)
	}
	if completer == "" || completer == reworkGenericClaimant {
		// Fail CLOSED: with no attributable worker on the row there is no way to
		// prove the reviewer is a different agent, and "we couldn't tell" must
		// never resolve to "allowed" — same rule as peer_proposer_unknown.
		return &peerRefusal{
			code: "rework_completer_unknown",
			message: "this task records no attributable worker (claimed_by is empty or the generic \"agent\"), so the server cannot prove the reviewer is a different agent than the one that finished it — " +
				"a human sends this one back (POST /api/canvas/actions/{id}/move with {\"to\":\"approved\"})",
		}
	}
	if sameAgentIdentity(reviewer, completer) {
		return &peerRefusal{
			code: "rework_self_review",
			message: "self-review is refused: work is sent back by a DIFFERENT agent than the one that finished it, and this reviewer resolves to the worker (" +
				completer + "). Hand it to your reviewer agent, or ask a human.",
			extra: map[string]string{"reviewer": reviewer, "completedBy": completer},
		}
	}
	return nil
}

// authorizePeerRework is the store-backed half of the rework rule, mirroring
// authorizePeerApproval: policy check, then the pure rule, then the registered-
// agent floor. It takes the ALREADY-LOADED target because the handler needs the
// row anyway (to check it is 'done'), so the gate costs no second read here.
//
// Every failure path fails CLOSED, and a canvas that is not on 'peer' is told
// plainly that the human still owns this move — there is no legacy behaviour to
// preserve byte-for-byte, because before TDM-154 the endpoint did not exist.
func (h *Handler) authorizePeerRework(w http.ResponseWriter, r *http.Request, target *store.Action) bool {
	ctx := r.Context()
	canvasID := CanvasIDFromCtx(ctx)
	canvas, err := h.store.GetCanvasByID(ctx, canvasID)
	if err != nil || canvas.ApprovalPolicy != policyPeer {
		writeCodedError(w, http.StatusForbidden, "rework_policy_required",
			"an agent can only send work back for rework on a canvas whose owner set approval_policy to 'peer' — "+
				"on this canvas a human reopens finished work (POST /api/canvas/actions/{id}/move with {\"to\":\"approved\"})", nil)
		return false
	}
	reviewer := ""
	if a := AuthorFromCtx(ctx); a != nil {
		reviewer = *a
	}
	if refusal := peerReworkRefusal(reviewer, target); refusal != nil {
		writeCodedError(w, http.StatusForbidden, refusal.code, refusal.message, refusal.extra)
		return false
	}
	// Same floor as peer approval: the asserted identity must name an agent that
	// registered on THIS canvas, so a bounce is always attributable to a row on
	// the fleet view rather than to a string nobody has ever seen.
	if !h.approverIsRegisteredAgent(ctx, canvasID, reviewer) {
		writeCodedError(w, http.StatusForbidden, "rework_agent_unregistered",
			"sending work back for rework requires a registered agent on this canvas: register first (canvas_connect / agent_register with a name) and review under that identity",
			map[string]string{"reviewer": reviewer})
		return false
	}
	// And the cross-model bar, when the owner opted in (TDM-155). The pair here is
	// (reviewer, COMPLETER) — the same pair peerReworkRefusal just cleared, so the
	// claimant is non-empty and not the generic fallback by here.
	completer := ""
	if target.ClaimedBy != nil {
		completer = strings.TrimSpace(*target.ClaimedBy)
	}
	if refusal := h.enforceCrossModel(ctx, canvas, canvasID, reviewer, completer, "rework",
		peerReworkSameModelRefusal); refusal != nil {
		writeCodedError(w, http.StatusForbidden, refusal.code, refusal.message, refusal.extra)
		return false
	}
	return true
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
	// LAST, and only when the owner opted in: a different agent is not enough, it
	// must be a different model (TDM-155). Deliberately after the registered-agent
	// floor, so a roster error is already refused CLOSED there and never reaches a
	// check that fails open. AuthoredBy is non-nil by here — peerApprovalRefusal
	// refuses peer_proposer_unknown above.
	if refusal := h.enforceCrossModel(ctx, canvas, canvasID, approver, *target.AuthoredBy, "approve",
		peerSameModelRefusal); refusal != nil {
		writeCodedError(w, http.StatusForbidden, refusal.code, refusal.message, refusal.extra)
		return false
	}
	return true
}

// ── Cross-model review: a different agent is not enough (TDM-155) ────────────
//
// THE ARGUMENT. 0041's non-self rule asks for a different AGENT. Two agents on
// the same model are one reviewer wearing two name tags: Opus approving Opus is
// self-review with extra steps, and the whole case for agent review is that a
// different model forms a different opinion. Under this flag the peer rule reads
// "a different agent AND a different model".
//
// OPT-IN, DEFAULT OFF. canvases.require_cross_model_review (migration 0042) is
// false everywhere until an owner sets it, and it is inert on any policy other
// than 'peer' — it is only ever consulted from the two authorize* functions
// below, both of which have already established the canvas is on 'peer'. So no
// existing canvas changes behaviour, which is the same promise 0041 made.
//
// IT COVERS BOTH HALVES OF THE REVIEWER'S JOB — approval AND rework — and that
// was a decision, not a copy-paste. The tempting scope is "approval only": a
// bounce is reversible, so a same-model bounce lets nothing bad THROUGH. But the
// flag's meaning is "review on this canvas comes from a different architecture",
// and a same-model "no" is exactly as much theatre as a same-model "yes" — worse,
// an ungated bounce is a way for an agent to send a same-model peer's work back
// indefinitely. A flag that meant one thing for yes and another for no would be
// the harder thing to explain. The two paths get DISTINCT codes
// (peer_same_model / rework_same_model) so a client can tell which door closed.
//
// FAIL OPEN ON AN UNKNOWN MODEL — and note this is the OPPOSITE posture from
// peer_proposer_unknown and rework_completer_unknown, which fail CLOSED. The
// asymmetry is deliberate and worth stating plainly:
//
//   - An unknown PROPOSER is a defect in the thing the gate is about. Without it
//     the non-self rule is unenforceable, so "we couldn't tell" must resolve to
//     "a human decides".
//   - An unknown MODEL is the ORDINARY case. `model` is an optional argument to
//     canvas_connect; most agents registered before this feature existed never
//     sent one. Failing closed there would take a live 'peer' canvas and brick
//     every peer approval on it the moment the owner ticked a box — turning an
//     opt-in quality bar into an outage. So an unrecorded model means this
//     particular check abstains; the non-self rule and the registered-agent floor
//     both still had to pass to get here.
//
// It is logged, so "why did that get through" has an answer in the logs.
//
// THE HONEST RAIL, which appears in the refusal message itself and must appear in
// any docs: agents.model is SELF-ASSERTED. canvas_connect takes a `model`
// argument and stores it verbatim; nothing verifies it, exactly as nothing
// verifies the agent name (see the file comment). This raises the cost of
// ACCIDENTAL same-model review — a fleet that is quietly all one model, which is
// the realistic failure — and it does not stop a client that lies. It is not a
// guarantee and must never be described as one.

// modelVariantSuffix strips a bracketed variant tag such as the "[1m]" in
// "claude-opus-5[1m]". A context-window variant is the same model, and letting
// two spellings of one model read as two models would defeat the check with a
// typo rather than with a second architecture.
func modelVariantSuffix(id string) string {
	if i := strings.IndexByte(id, '['); i > 0 {
		return strings.TrimSpace(id[:i])
	}
	return id
}

// normalizeModelID reduces a self-asserted model id to what is worth comparing:
// case, surrounding space, a routing prefix ("anthropic/", "us.anthropic.",
// "openai/") and a bracketed variant tag are all noise around the same model.
//
// What it deliberately does NOT do is guess model FAMILIES. "claude-opus-4-8"
// reviewing "claude-opus-5" passes this check — different weights, plausibly a
// genuinely different opinion — and inferring architecture lineage from a free
// text string would be a guess wearing a uniform. The check catches the same
// model spelled two ways, which is the accident it exists to catch.
func normalizeModelID(raw string) string {
	id := strings.ToLower(strings.TrimSpace(raw))
	if id == "" {
		return ""
	}
	if i := strings.LastIndexAny(id, "/"); i >= 0 && i+1 < len(id) {
		id = id[i+1:]
	}
	for _, prefix := range []string{"us.anthropic.", "eu.anthropic.", "anthropic.", "anthropic:"} {
		id = strings.TrimPrefix(id, prefix)
	}
	return strings.TrimSpace(modelVariantSuffix(id))
}

// modelsCollide compares two self-asserted model ids. `known` is false when
// either side is unrecorded, which is the fail-open case — the caller must treat
// !known as "this check abstains", never as "same" and never as "different".
func modelsCollide(a, b string) (collide, known bool) {
	na, nb := normalizeModelID(a), normalizeModelID(b)
	if na == "" || nb == "" {
		return false, false
	}
	return na == nb, true
}

// crossModelHonestyRail is appended to every same-model refusal. The refusal is
// the one place a reader is guaranteed to look, so it is the one place the limit
// of the check has to be stated.
const crossModelHonestyRail = " (Model is self-asserted by the connecting agent — this raises the cost of accidental same-model review, it does not prevent a client that misreports its model. It is not a guarantee.)"

// peerSameModelRefusal is the approval-side branch, pure and testable on its own
// like peerApprovalRefusal, whose result it is meant to follow. Returns nil when
// the models differ OR either is unrecorded (fail open).
func peerSameModelRefusal(approver, approverModel, proposer, proposerModel string) *peerRefusal {
	collide, known := modelsCollide(approverModel, proposerModel)
	if !known || !collide {
		return nil
	}
	return &peerRefusal{
		code: "peer_same_model",
		message: "same-model approval is refused: this canvas requires review from a DIFFERENT model, and both the approver (" + approver + ") and the proposer (" +
			proposer + ") report " + strings.TrimSpace(approverModel) + ". Hand it to a reviewer agent running on a different model, or ask a human." + crossModelHonestyRail,
		extra: map[string]string{
			"approver": approver, "approverModel": strings.TrimSpace(approverModel),
			"proposedBy": proposer, "proposerModel": strings.TrimSpace(proposerModel),
		},
	}
}

// peerReworkSameModelRefusal is the rework-side branch — same rule, different
// pair: (reviewer, COMPLETER off claimed_by), matching peerReworkRefusal.
func peerReworkSameModelRefusal(reviewer, reviewerModel, completer, completerModel string) *peerRefusal {
	collide, known := modelsCollide(reviewerModel, completerModel)
	if !known || !collide {
		return nil
	}
	return &peerRefusal{
		code: "rework_same_model",
		message: "same-model review is refused: this canvas requires review from a DIFFERENT model, and both the reviewer (" + reviewer + ") and the agent that finished the work (" +
			completer + ") report " + strings.TrimSpace(reviewerModel) + ". Hand it to a reviewer agent running on a different model, or ask a human." + crossModelHonestyRail,
		extra: map[string]string{
			"reviewer": reviewer, "reviewerModel": strings.TrimSpace(reviewerModel),
			"completedBy": completer, "completerModel": strings.TrimSpace(completerModel),
		},
	}
}

// agentModelIndex reads the canvas roster ONCE and returns a lookup from agent
// identity to self-asserted model, keyed by both name and id string so it accepts
// whichever spelling an identity arrived in (the gateway prefers the name and
// falls back to the id — same tolerance as approverIsRegisteredAgent).
//
// WHY THE ROSTER AND NOT A COLUMN ON THE ROW. The obvious alternative is to stamp
// the model onto the action at INSERT, next to authored_by. Two reasons not to:
// provenance.go derives authored_by from headers alone and performs no DB work by
// design (a roster read there would be a query on every request on the canvas);
// and a model stamped at insert is no more trustworthy than one read now, since
// both are the same self-asserted string. The cost is real and worth naming: this
// compares the model an identity reports TODAY, not the one it reported when it
// wrote the row. An agent that re-registers the same name under a new model moves
// its whole history with it. For a check whose job is "are these two reviewers
// actually the same brain right now", that is the more useful reading anyway.
//
// A roster error returns the error; callers treat it as unknown and fail open —
// which is safe here only because both authorize* paths run the registered-agent
// floor (which fails CLOSED on a roster error) BEFORE reaching this.
func (h *Handler) agentModelIndex(ctx context.Context, canvasID uuid.UUID) (map[string]string, error) {
	agents, err := h.store.ListAgents(ctx, canvasID)
	if err != nil {
		return nil, err
	}
	index := make(map[string]string, len(agents)*2)
	for _, a := range agents {
		if a == nil || a.Model == nil || strings.TrimSpace(*a.Model) == "" {
			continue
		}
		if a.Name != "" {
			index[a.Name] = *a.Model
		}
		index[a.ID.String()] = *a.Model
	}
	return index, nil
}

// modelFor resolves one server-derived identity ("agent:<name>", or the bare
// registered name claimed_by holds) to its reported model. "" = unrecorded, which
// is the fail-open signal, never a value to compare.
func modelFor(index map[string]string, identity string) string {
	return index[strings.TrimPrefix(strings.TrimSpace(identity), authorAgentPrefix)]
}

// enforceCrossModel is the store-backed half shared by approval and rework: read
// the roster, resolve both models, and hand the pure branch the answer. Returns
// nil (allow) whenever the flag is off, the roster is unreadable, or either model
// is unrecorded — every abstention is logged so a permitted same-model review is
// never silent.
//
// `refuse` is the pure branch to apply, so the two call sites keep their own
// refusal codes and wording without this function knowing about either.
func (h *Handler) enforceCrossModel(
	ctx context.Context, canvas *store.Canvas, canvasID uuid.UUID,
	reviewer, author, path string,
	refuse func(reviewer, reviewerModel, author, authorModel string) *peerRefusal,
) *peerRefusal {
	if canvas == nil || !canvas.RequireCrossModelReview {
		return nil
	}
	index, err := h.agentModelIndex(ctx, canvasID)
	if err != nil {
		// Abstain, loudly. The registered-agent floor already refused on a roster
		// error before this ran, so in practice this is unreachable; if the read
		// ever becomes conditional, this must not silently become the allow path.
		log.Printf("cross-model review (%s) on canvas %s: roster unreadable, check skipped: %v", path, canvasID, err)
		return nil
	}
	reviewerModel, authorModel := modelFor(index, reviewer), modelFor(index, author)
	if reviewerModel == "" || authorModel == "" {
		log.Printf("cross-model review (%s) on canvas %s: model unrecorded (reviewer %q=%q, author %q=%q), failing OPEN",
			path, canvasID, reviewer, reviewerModel, author, authorModel)
		return nil
	}
	return refuse(reviewer, reviewerModel, author, authorModel)
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
