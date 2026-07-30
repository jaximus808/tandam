package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/agentcanvas/api/internal/metrics"
	"github.com/google/uuid"
)

// SCENARIO 2 OF THE CONTENTION HARNESS (TDM-102) — kill the winner.
//
// The harness proper is a runnable script that points two real gateway sessions
// at one task on a live server: apps/mcp-gateway/scripts/contention-harness.ts,
// documented in docs/contention-harness.md. Its scenario 1 (the claim race, the
// loser's refused writes, the anti-loop) runs there end to end.
//
// SCENARIO 2 IS SPLIT, and this file is the half that cannot live in the script.
// "The winner goes silent and the task comes back" turns on the claim LEASE, and
// the lease window is fixed when the server boots (CLAIM_TTL_MINUTES, default 15
// minutes — store.DefaultClaimTTL). A script talking to a running server can
// neither shrink it nor wait it out in CI, so the script ends the winner's lease
// with the board's release control (same recovery, different cause) and the
// EXPIRY cause is proven here, against the store fake that can backdate a claim.
//
// WHAT THIS ADDS over TDM-98's own tests, which already walk the lapse-and-
// takeover lifecycle (TestReclaimAfterExpiryFencesTheOldHolder next door):
//
//  1. the two-agent narrative through the endpoints the MCP GATEWAY actually
//     uses — PATCH {state:executing} to claim, the status API to heartbeat, PATCH
//     {state:done} to finish — so the harness's assertions and the API's tests
//     are about the same doors;
//  2. the DEGRADATION the gateway currently sits in, pinned deliberately (see
//     the last block): a client that presents no fencing token is identity-
//     checked only, and identity cannot see a lease that came back to the same
//     name. That is the one hole scenario 2 leaves open on the live path, and a
//     test that pins it is how we notice when it closes.
func TestContentionHarnessScenario2LeaseExpiry(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	reg := metrics.NewRegistry()
	h := NewHandler(fake, nil, nil, WithMetrics(reg))

	// ── The winner claims, and works. ────────────────────────────────────────
	genA := claimVia(t, h, canvasID, task.ID, "worker-a")
	if w := postStatus(t, h, canvasID, task.ID, map[string]any{
		"state": "progress", "agent": "worker-a", "summary": "on it",
	}); w.Code != http.StatusOK {
		t.Fatalf("holder heartbeat = %d, want 200; body %s", w.Code, w.Body)
	}

	// ── Then it goes silent. The lease lapses. ───────────────────────────────
	// Backdating the claim IS the passage of the lease window: ClaimAction's
	// expiry is lazy (no sweeper), so the next claimer is the one who observes it.
	fake.expireClaim(task.ID)

	// The task is claimable again — by the loser of the original race, or by any
	// other member of the fleet. The takeover is a NEW lease with a NEW token.
	genB := claimVia(t, h, canvasID, task.ID, "worker-b")
	if genB <= genA {
		t.Fatalf("takeover generation = %d, want > %d — a new lease must mint a new token", genB, genA)
	}
	if holder := fake.holder(task.ID); holder != "worker-b" {
		t.Fatalf("holder after takeover = %q, want worker-b", holder)
	}

	// ── The dead winner comes back and finishes work that moved on. ──────────
	// Both shapes a zombie arrives in: the gateway's completion PATCH, and a
	// heartbeat through the status API. Both refused, and the refusal names the
	// live holder so the zombie can see what happened.
	before := counters(reg).FencedWrites
	zombie := patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "claimGeneration": genA,
		"result": "I finished the task I was given",
	})
	assertFenced(t, zombie, fenceCodeOther, "worker-b")
	zombieBeat := postStatus(t, h, canvasID, task.ID, map[string]any{
		"state": "progress", "agent": "worker-a", "summary": "still going", "claimGeneration": genA,
	})
	assertFenced(t, zombieBeat, fenceCodeOther, "worker-b")

	if got := counters(reg).FencedWrites - before; got != 2 {
		t.Errorf("fenced_writes rose by %d over two zombie writes, want 2", got)
	}

	stored := fake.task(task.ID)
	if stored.State != "executing" {
		t.Fatalf("state = %q, want executing — the zombie must not have completed it", stored.State)
	}
	if stored.Result != nil && *stored.Result != "" {
		t.Errorf("result = %q, want empty — a fenced completion wrote its summary anyway", *stored.Result)
	}
	var payload map[string]any
	if err := json.Unmarshal(stored.Payload, &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	entries, _ := payload["progress"].([]any)
	if len(entries) != 1 {
		t.Errorf("progress entries = %d, want 1 (the holder's, not the zombie's)", len(entries))
	}

	// ── The new holder finishes. Exactly one completion, and it is theirs. ────
	done := patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-b", "claimGeneration": genB,
		"result": "worker-b finished the reclaimed task",
	})
	if done.Code != http.StatusOK {
		t.Fatalf("new holder completion = %d, want 200; body %s", done.Code, done.Body)
	}
	final := fake.task(task.ID)
	if final.State != "done" {
		t.Fatalf("final state = %q, want done", final.State)
	}
	if final.Result == nil || *final.Result != "worker-b finished the reclaimed task" {
		t.Errorf("result = %v, want the NEW holder's summary", final.Result)
	}
}

// THE HOLE SCENARIO 2 LEAVES OPEN, pinned on purpose.
//
// The MCP gateway reads a claim generation out of a refusal (see tapout.ts) but
// has no field to SEND one on a write — so every gateway write is identity-
// checked only. Identity cannot see the case the token exists for: a lease that
// came back to the same agent name. This test walks exactly that and asserts the
// CURRENT behaviour, which is that the stale write lands.
//
// It is not a bug in the fence — presenting a token is optional by design, so a
// client from before TDM-98 keeps working (see claim_fence.go's "WHAT PRESENTED
// MEANS"). It is a gap in the CLIENT, and this is the tripwire: when the gateway
// starts carrying its generation, this test fails and gets inverted, which is the
// point. Until then the harness reports it as a GAP rather than a pass.
func TestGatewayWithoutAFencingTokenIsNotFencedOnSelfTakeover(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	// worker-a → (lapse) → worker-b → (lapse) → worker-a again. The name has come
	// full circle; the generation has not.
	genA1 := claimVia(t, h, canvasID, task.ID, "worker-a")
	fake.expireClaim(task.ID)
	claimVia(t, h, canvasID, task.ID, "worker-b")
	fake.expireClaim(task.ID)
	genA3 := claimVia(t, h, canvasID, task.ID, "worker-a")
	if genA3 <= genA1 {
		t.Fatalf("generations did not advance across takeovers: %d → %d", genA1, genA3)
	}

	// WITH the token, the lease-1 write dies — the fence working as designed.
	withToken := patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "claimGeneration": genA1,
		"result": "a write from lease 1",
	})
	assertFenced(t, withToken, fenceCodeStale, "worker-a")

	// WITHOUT it — the gateway's current call shape — the same write lands.
	noToken := patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "result": "a write from lease 1, no token",
	})
	if noToken.Code != http.StatusOK {
		t.Fatalf("tokenless stale write = %d, want 200: this test pins the CURRENT degradation. "+
			"If the fence now catches it, the gateway or the fence changed — invert this test "+
			"and drop the GAP note from docs/contention-harness.md. body %s", noToken.Code, noToken.Body)
	}
	if state := fake.task(task.ID).State; state != "done" {
		t.Fatalf("state = %q, want done — the tokenless write was expected to land", state)
	}
}
