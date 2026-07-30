package api

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/agentcanvas/api/internal/store"
)

// ── The claim fence (TDM-98) ──────────────────────────────────────────────────
//
// ONE rule, applied by EVERY task write path: a write is refused unless the
// caller still holds the claim it is writing under. "Still holds" is two facts,
// checked together:
//
//	1. IDENTITY — claimed_by is this caller (or nobody exclusive).
//	2. GENERATION — the fencing token the caller presents is the LIVE lease's.
//	   Minted by the claim, stored on the task, monotone per task. See
//	   store/claim_fence.go for why identity alone is not enough (a lease can come
//	   back to the same agent name, and its old in-flight writes must still die).
//
// WHY IT IS A SHARED FUNCTION AND NOT A CHECK PER HANDLER. Before this, the
// holder check existed twice — once inline in UpdateActionState (complete), once
// as guardClaimedTask (the CI status API) — and not at all on /move, the
// payload-only PATCH or DELETE. Three surfaces, three answers, and the two that
// existed disagreed in wording. A fence with holes in it is not a fence, so the
// decision (fenceTaskWrite) and the refusal (writeFenced) each live in exactly
// one place, and every path below calls them.
//
// THE AUDIT — every write path that can touch a task, and what fences it:
//
//	PATCH  actions/{id} state=executing      the atomic CLAIM. Mints the token.
//	PATCH  actions/{id} state=done|failed    fenced (transitionAction)
//	PATCH  actions/{id} payload-only         fenced (updateActionPayload) + the
//	                                         content gate, which is a separate
//	                                         rule about approval, not ownership
//	POST   {code}/tasks/{id}/status started   the atomic CLAIM. Mints the token.
//	POST   {code}/tasks/{id}/status progress  fenced (guardClaimedTask) + lease
//	                                          renewal, holder-only in SQL
//	POST   {code}/tasks/{id}/status done|fail fenced (guardClaimedTask →
//	                                          transitionAction)
//	POST   actions/{id}/move  → executing     the atomic CLAIM (as "human")
//	POST   actions/{id}/move  → done|failed   fenced (transitionAction)
//	POST   actions/{id}/move  → approved|…    fenced (rewindTask) — the rewinds
//	POST   actions/{id}/release, /requeue     fenced (rewindTask)
//	DELETE actions/{id}                       fenced (DeleteAction)
//	POST   actions/{id}/approve, /reject      NOT fenced, and must not be: a
//	                                          proposed task has no holder, and
//	                                          approval is the human gate.
//	POST   actions/batch-delete               NOT fenced. No MCP tool reaches it
//	                                          (the gateway has no action-delete
//	                                          tool at all) and it reads nothing —
//	                                          fencing it would cost one read per
//	                                          id for a board-only bulk door.
//
// WHAT "PRESENTED" MEANS, and why the fence is opt-in per caller. A canvas JWT is
// identical for a browser and an agent (see task_move.go), so the server cannot
// tell a human from a worker by credential alone. The fence therefore engages on
// the caller's own assertion of a claim identity — an agent name in the body, or
// the X-Tandem-Agent header the MCP gateway sets on every call (provenance.go) —
// and stays out of the way when there is none. That is deliberate on both sides:
//
//   - Agents are fenced, because they always assert who they are (they must:
//     claimed_by comes from the same string).
//   - The human board keeps its escape hatch. Release / requeue / reopen / delete
//     on a task an agent is holding is the WHOLE POINT of those controls — a
//     person unsticking a dead worker. A fence that locked a human out of a task
//     its claimant abandoned would be a worse bug than the one being fixed.
//
// Presenting a generation is likewise optional: a client that sends only its name
// gets the identity check alone, which is what every agent shipped before this
// token did. The generation check engages the moment a caller presents one.

const (
	// fenceCodeOther is the refusal when the claim is someone else's. Kept as the
	// existing wire code ("claimed_by_other") — clients and tests already branch
	// on it, and it means precisely what it always did.
	fenceCodeOther = "claimed_by_other"
	// fenceCodeStale is the refusal when the caller IS the recorded name but its
	// lease has been superseded — the case identity cannot see.
	fenceCodeStale = "stale_claim_generation"
)

// claimant is the claim identity a request presents: who it says it is, and which
// lease it believes it holds.
type claimant struct {
	// name is the claim identity (the same string that lands in claimed_by).
	name string
	// generation is the fencing token the caller presents; 0 = none presented.
	generation int
}

// presented reports whether this request asserted anything to fence on. False is
// the human/anonymous surface, which is left exactly as it was.
func (c claimant) presented() bool { return c.name != "" || c.generation > 0 }

// callerClaim resolves the claim identity behind a request.
//
// `agentName` and `generation` are the request body's fields (whatever this
// surface calls them: agentName / agent / claimGeneration). The name falls back
// to the server-derived agent identity from provenance — the X-Tandem-Agent
// header — so surfaces whose body has no agent field (POST …/move, DELETE) still
// fence agent callers, and only them: a browser never sends that header, so
// AuthorFromCtx there is "human" or "anonymous" and yields no claim identity.
func callerClaim(r *http.Request, agentName string, generation int) claimant {
	name := strings.TrimSpace(agentName)
	if name == "" {
		name = assertedAgentName(r)
	}
	if generation < 0 {
		generation = 0
	}
	return claimant{name: name, generation: generation}
}

// assertedAgentName pulls the agent identity out of this request's derived
// provenance ("agent:<name>" → "<name>"). Empty for human/anonymous callers and
// for routes without the Provenance middleware (the CI status API, which carries
// its agent in the body instead).
func assertedAgentName(r *http.Request) string {
	a := AuthorFromCtx(r.Context())
	if a == nil {
		return ""
	}
	name, ok := strings.CutPrefix(*a, authorAgentPrefix)
	if !ok {
		return ""
	}
	return strings.TrimSpace(name)
}

// claimFence is a refusal: which rule refused, who holds the task now, and the
// generation a re-claim would have to present.
type claimFence struct {
	Code       string
	Holder     string
	Generation int
	Message    string
}

// fenceTaskWrite is THE decision. nil means the write may proceed.
//
// It is a pure function of the stored action and the presented identity so that
// every surface gets the same answer and the rule can be tested without HTTP.
func fenceTaskWrite(current *store.Action, caller claimant) *claimFence {
	if current == nil || current.Type != "task" || !caller.presented() {
		return nil
	}
	rec := store.ReadClaimRecord(current.Payload)

	// 1. IDENTITY. A holder of "" or the generic "agent" is not an exclusive
	// identity and blocks nobody (the anonymous web/MCP path, unchanged); a NAMED
	// holder blocks everyone else. Skipped when the caller presented only a token:
	// there is no name to compare, and the generation is the stronger check anyway.
	if caller.name != "" {
		if holder := rivalClaimHolder(current, caller.name); holder != "" {
			return &claimFence{
				Code:       fenceCodeOther,
				Holder:     holder,
				Generation: rec.Generation,
				Message: fmt.Sprintf("STOP — this task is claimed by %q, not by you. "+
					"Do not report progress, complete, move or delete it: another fleet member is doing this work. "+
					"Take a different approved task, or ask a human to release this one.", holder),
			}
		}
	}

	// 2. GENERATION. Both sides must have one: a caller that presents none is a
	// client from before the token (identity-checked only, above), and a task with
	// none was claimed before the token existed or by a claim whose stamp failed.
	// Neither is treated as a mismatch — an unfenced write is the documented
	// degradation, a spurious refusal would strand real work.
	if caller.generation > 0 && rec.Generation > 0 && caller.generation != rec.Generation {
		holder := claimHolder(current)
		return &claimFence{
			Code:       fenceCodeStale,
			Holder:     holder,
			Generation: rec.Generation,
			Message: fmt.Sprintf("STOP — your claim on this task has been superseded. "+
				"You presented claim generation %d; the live claim is generation %d, held by %q. "+
				"Your lease expired and the task was claimed again, so this write is not yours to make: "+
				"do not retry it. Claim the task again and use the generation that claim returns.",
				caller.generation, rec.Generation, holder),
		}
	}
	return nil
}

// claimHolder names the current holder for a message, or "nobody" when the claim
// has been cleared (a released task whose old lease is still being written to).
func claimHolder(a *store.Action) string {
	if a.ClaimedBy == nil || *a.ClaimedBy == "" {
		return "nobody"
	}
	return *a.ClaimedBy
}

// writeFenced writes the ONE refusal shape every fenced write path answers with,
// as 409:
//
//	{ "error": "claimed_by_other", "fenced": true, "holder": "worker-b",
//	  "claimedBy": "worker-b", "reason": "claimed_by_other",
//	  "claimGeneration": 4, "message": "STOP — …" }
//
// `fenced` is the flag a client branches on without having to know the codes:
// whatever the reason, it means "you do not hold this task, so stop writing to
// it". `holder` names who does. `claimGeneration` is the live token, so a client
// that legitimately re-claims knows what it should be presenting. `claimedBy`
// duplicates `holder` because that is the key the pre-fence 409s used and clients
// (and the gateway) already read it — a refusal is the worst possible place to
// break compatibility.
func writeFenced(w http.ResponseWriter, f *claimFence) {
	out := map[string]any{
		"error":     f.Code,
		"fenced":    true,
		"reason":    f.Code,
		"holder":    f.Holder,
		"claimedBy": f.Holder,
		"message":   f.Message,
	}
	if f.Generation > 0 {
		out["claimGeneration"] = f.Generation
	}
	writeJSON(w, http.StatusConflict, out)
}

// fenceTaskWriteOrFail is the form every handler uses: decide, and on a refusal
// write it, count it, RECORD it, and report false.
//
// The counter is here rather than in the handlers for the same reason the
// decision is: one place, so the next surface to grow a write path cannot forget
// it. A rising fenced_writes is the fleet telling you workers are outliving their
// leases — see metrics.IncFencedWrite.
//
// The trail entry (TDM-100) is here for the same reason again, and it is what
// makes the counter legible: fenced_writes says the fleet collided N times,
// recordFencedWrite says worker-b was refused on THIS task under generation 3
// while worker-a holds generation 7. It is detached and best-effort — see
// contention.go — so it cannot slow or fail the refusal it describes. `r` is
// taken solely to reach the canvas id and the caller's derived provenance; the
// fence decision itself stays a pure function of the action and the claimant.
func (h *Handler) fenceTaskWriteOrFail(w http.ResponseWriter, r *http.Request, current *store.Action, caller claimant) bool {
	if f := fenceTaskWrite(current, caller); f != nil {
		h.metrics.IncFencedWrite()
		h.recordFencedWrite(r, current, caller, f)
		writeFenced(w, f)
		return false
	}
	return true
}

// claimBlock is the token handed BACK to a claimant, alongside the action every
// claim response already carries:
//
//	{ "action": {…}, "claim": { "holder": "worker-a", "generation": 3 } }
//
// The claimant must keep `generation` and present it on every later write to the
// task (as claimGeneration) — that is the whole contract. nil when the claim
// carries no token (see store.ClaimOutcome.ClaimGeneration), so the key is simply
// absent rather than present-and-zero: a client must never read 0 as a token.
func claimBlock(a *store.Action) map[string]any {
	if a == nil {
		return nil
	}
	rec := store.ReadClaimRecord(a.Payload)
	if rec.Generation <= 0 {
		return nil
	}
	out := map[string]any{"generation": rec.Generation}
	if a.ClaimedBy != nil && *a.ClaimedBy != "" {
		out["holder"] = *a.ClaimedBy
	}
	if a.ClaimedAt != nil {
		out["claimedAt"] = *a.ClaimedAt
	}
	return out
}

// writeClaimed answers a successful claim: the action, plus the fencing token
// when there is one. One function so the MCP PATCH, the CI status API and the
// human board's Start button all hand the token back identically.
func writeClaimed(w http.ResponseWriter, action *store.Action) {
	out := map[string]any{"action": action}
	if claim := claimBlock(action); claim != nil {
		out["claim"] = claim
	}
	writeJSON(w, http.StatusOK, out)
}
