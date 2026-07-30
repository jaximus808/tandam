package api

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// ── Contention telemetry (TDM-100) ────────────────────────────────────────────
//
// The protocol already worked. TDM-98 fences a write from an agent that no
// longer holds the claim; TDM-99 tells the loser to tap out instead of retrying.
// What neither did is make any of it VISIBLE: the fleet-wide rate lived in two
// /api/metrics counters, and the individual collision lived in a 409 the loser
// read and discarded. Nobody watching the board could see that two agents went
// for the same task and one yielded — which is the single most legible thing a
// coordination plane does.
//
// So both refusals now leave a trail on the task (store/contention.go), and the
// board reads it: a collision marker on the card, the event list in the ticket's
// history, per-agent lost/fenced counts on the fleet view.
//
// TWO CHOKE POINTS, and that is the whole wiring. There is exactly one place
// each kind of collision is decided, which is why this is a small file:
//
//	claimTaskAs      *store.AlreadyClaimedError → a LOST CLAIM. The one function
//	                 both claim surfaces funnel through (the MCP/web PATCH and the
//	                 inbound CI status API), and already the place the
//	                 claim_conflicts counter is incremented — see the note there
//	                 for why the store and the handlers are both wrong homes.
//	fenceTaskWrite-  a refusal → a FENCED WRITE. The single fence decision every
//	OrFail           task write path calls, and already the place fenced_writes is
//	                 counted. A surface that grows a new write path inherits the
//	                 telemetry for free, exactly as it inherits the fence.
//
// Recording next to the counter it belongs to is deliberate: a count and an
// event that can disagree about whether a collision happened is worse than
// having only the count.
//
// COST. Nothing is added to any request. Both call sites hand off to a detached
// goroutine — the refusal has already been decided and (for the fence) already
// written to the wire — so the two round trips this costs land after the caller
// is gone. A failure is logged and dropped: the trail is telemetry, and telemetry
// that can fail a claim or turn a 409 into a 500 is a liability, not a feature.
//
// HOW IT REACHES THE BOARD. The trail lives on the task's payload, which rides
// the existing full-state WS push — so the record is broadcast by the same
// broadcastStateAsync every mutation already does, with no new message type. On
// top of that each collision pings the live `activity` stream (activityContended)
// so the fleet feed shows the race the moment it happens rather than whenever the
// next state push lands.

// contentionStore is the ONE store capability this file needs, declared here
// rather than on store.Store — and that is a decision worth its paragraph.
//
// A method on store.Store is a method every test double inherits from its nil
// embedded Store. Combine that with the fact that this write happens on a
// DETACHED goroutine and the failure mode is the worst kind available: a fake
// that doesn't implement it doesn't fail to compile, it nil-derefs on a
// background goroutine and takes the process down, from telemetry, on a path
// whose whole contract is "must not affect the request". An optional capability
// the API asserts for degrades instead — a store that can't record collisions
// simply doesn't, and everything else works exactly as before.
//
// The production store (supabaseStore) implements it, so this is not a
// feature-flag in disguise: the assertion succeeds in every deployment. It is a
// blast radius, not a toggle.
type contentionStore interface {
	AppendContentionEvent(ctx context.Context, canvasID, id uuid.UUID, ev store.ContentionEvent) (*store.Action, error)
}

// recordContention persists ONE collision on a task and pushes it to viewers.
//
// Detached and best-effort by contract (see the COST note above). Called with the
// request's context only to inherit its values; cancellation is dropped, because
// this runs after the response.
func (h *Handler) recordContention(ctx context.Context, canvasID, actionID uuid.UUID, ev store.ContentionEvent) {
	st, ok := h.store.(contentionStore)
	if !ok {
		return
	}
	// An anonymous caller has nothing to attribute a collision to, and the fence
	// does not engage for one at all — so this is unreachable in practice and
	// guarded anyway: an entry naming nobody is noise on every surface that reads
	// the trail.
	if ev.Agent == "" || actionID == uuid.Nil || canvasID == uuid.Nil {
		return
	}
	ctx = context.WithoutCancel(ctx)
	go func() {
		fresh, err := st.AppendContentionEvent(ctx, canvasID, actionID, ev)
		if err != nil {
			log.Printf("contention %s: recording %s by %q: %v", actionID, ev.Kind, ev.Agent, err)
			return
		}
		// Announced only once the write LANDED — both pushes, in the order a viewer
		// wants them. A marker that appeared and then vanished on the next state push
		// would be worse than a late one.
		//
		// The live ping first, because it is the cheap one and the one a feed renders
		// instantly. The LOSER is the subject, so the actor is passed explicitly: the
		// row names the holder, which is the other half of the sentence.
		broadcastActionActivityAs(h.hub, canvasID, activityContended, fresh, ev.Agent)
		// Then the trail itself, which rides the payload on the ordinary full-state
		// push — the same one every mutation does, and the reason this feature needed
		// no new message type.
		if h.hub != nil {
			broadcastState(ctx, h.store, h.hub, canvasID)
		}
	}()
}

// contentionActor is the identity a collision is attributed to: the caller's own
// asserted claim name, falling back to the server-derived agent provenance for
// surfaces whose body carries no agent field. Same resolution order as
// callerClaim, and for the same reason — this must name whoever the fence just
// refused, not whoever the row says holds the task.
func contentionActor(r *http.Request, caller claimant) string {
	if caller.name != "" {
		return caller.name
	}
	return assertedAgentName(r)
}

// recordFencedWrite is the fence's side of the wiring: turn a refusal into a
// trail entry. `current` is the stored task the fence read, so the live
// generation comes off the same payload the decision was made against.
func (h *Handler) recordFencedWrite(r *http.Request, current *store.Action, caller claimant, f *claimFence) {
	if current == nil || f == nil {
		return
	}
	ev := store.NewFencedWrite(
		contentionActor(r, caller),
		f.Holder,
		f.Code,
		caller.generation,
		f.Generation,
		time.Now().UTC(),
	)
	h.recordContention(r.Context(), CanvasIDFromCtx(r.Context()), current.ID, ev)
}

// recordLostClaim is the claim path's side: `agent` asked for a task `holder`
// already had. Called from claimTaskAs, which has no request in hand (the CI
// status API and the MCP PATCH share it), so the canvas and action ids are
// passed explicitly.
//
// `holder` comes from the *AlreadyClaimedError — the CURRENT holder, which on a
// lost takeover race is the agent that won it rather than the one whose lease had
// lapsed. That is the right answer for this trail: it records who you lost to.
func (h *Handler) recordLostClaim(ctx context.Context, canvasID, actionID uuid.UUID, agent, holder string) {
	// Generation 0: the claim failed, so nothing was read back — losing is
	// precisely not learning the token you lost to — and paying a GetAction here
	// would put a round trip on the contended claim path. The store fills it in
	// from the row it reads anyway (AppendContentionEvent).
	h.recordContention(ctx, canvasID, actionID, store.NewLostClaim(agent, holder, 0, time.Now().UTC()))
}
