package api

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/metrics"
	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// TDM-100 — the two choke points record the right collisions.
//
// The store tests (store/contention_test.go) prove the trail itself: coalescing,
// the cap, and the server-owned carry rules. These prove the WIRING, which is the
// part that rots: that a lost claim and a fenced write each leave an entry naming
// the loser and the winner, that recording them cannot change or slow the refusal
// (TDM-98's contract), and that the counters and the trail cannot disagree.
//
// The harness is TDM-98's fenceFakeStore — the same fake that mints generations
// and expires leases on demand — plus the one method this feature needs. Methods
// on a type can live in any file in its package, so the fence's fixtures are
// reused here without touching that file.

// AppendContentionEvent runs the REAL store.AppendContention over the stored
// payload (coalescing and capping included), then hands back the fresh row the way
// the Supabase write's return=representation does. Filling a zero generation from
// the claim record is the production behaviour a losing claimant depends on — it
// cannot know the token it lost to — so the fake does it too.
func (f *fenceFakeStore) AppendContentionEvent(_ context.Context, _ uuid.UUID, id uuid.UUID, ev store.ContentionEvent) (*store.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ErrActionNotFound
	}
	if ev.Generation == 0 {
		ev.Generation = store.ReadClaimRecord(a.Payload).Generation
	}
	next, err := store.AppendContention(a.Payload, ev)
	if err != nil {
		return nil, err
	}
	a.Payload = next
	return copyAction(a), nil
}

// contention waits for the DETACHED recording goroutine and returns the trail.
//
// Polling rather than a channel because the whole point of the design is that the
// caller does not wait for this: the refusal is already on the wire, and the write
// lands whenever it lands. A test that could not tolerate that would be testing a
// different (and worse) implementation.
func awaitContention(t *testing.T, fake *fenceFakeStore, id uuid.UUID, want int) []store.ContentionEvent {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var got []store.ContentionEvent
	for time.Now().Before(deadline) {
		got = store.ReadContention(fake.task(id).Payload)
		if len(got) >= want {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("contention trail has %d entries after 2s, want %d: %+v", len(got), want, got)
	return nil
}

// noContention gives the goroutine a fair chance to write and then insists it
// didn't. Used for the paths that must stay silent — a human's board controls are
// not a fleet collision.
func noContention(t *testing.T, fake *fenceFakeStore, id uuid.UUID) {
	t.Helper()
	time.Sleep(120 * time.Millisecond)
	if got := store.ReadContention(fake.task(id).Payload); len(got) != 0 {
		t.Fatalf("expected no contention recorded, got %+v", got)
	}
}

// ── (1) A lost claim: who lost to whom ───────────────────────────────────────

// The headline event. worker-a holds the task; worker-b asks for it and is
// refused. Before this, that was a 409 worker-b read and threw away plus a +1 on a
// process-wide counter — nothing on the board said a race had happened at all.
func TestLostClaimIsRecordedOnTheTask(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	genA := claimVia(t, h, canvasID, task.ID, "worker-a")

	w := patchTask(t, h, canvasID, task.ID, map[string]any{"state": "executing", "agentName": "worker-b"})
	if w.Code != http.StatusConflict {
		t.Fatalf("second claim = %d, want 409; body %s", w.Code, w.Body)
	}

	got := awaitContention(t, fake, task.ID, 1)
	if len(got) != 1 {
		t.Fatalf("trail = %+v, want exactly one entry", got)
	}
	e := got[0]
	if e.Kind != store.ContentionLostClaim {
		t.Errorf("kind = %q, want %q", e.Kind, store.ContentionLostClaim)
	}
	if e.Agent != "worker-b" {
		t.Errorf("agent = %q, want worker-b — the entry names the LOSER", e.Agent)
	}
	if e.Holder != "worker-a" {
		t.Errorf("holder = %q, want worker-a — who they lost to is the whole sentence", e.Holder)
	}
	if e.Generation != genA {
		t.Errorf("generation = %d, want the live token %d (filled in by the store, which reads the row anyway)", e.Generation, genA)
	}
	if e.At == "" {
		t.Error("no timestamp — 'when' is one of the three facts")
	}

	// The claim itself is untouched: telemetry must not cost the winner anything.
	if holder := fake.holder(task.ID); holder != "worker-a" {
		t.Errorf("holder after the race = %q, want worker-a", holder)
	}
}

// The counter and the trail must never disagree about whether a collision
// happened — a metric that says N races with N-1 events recorded is worse than
// having only the metric. Both are incremented at the same choke point for
// exactly this reason.
func TestLostClaimCounterAndTrailAgree(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	reg := metrics.NewRegistry()
	h := NewHandler(fake, nil, nil, WithMetrics(reg))

	claimVia(t, h, canvasID, task.ID, "worker-a")
	for _, loser := range []string{"worker-b", "worker-c", "worker-d"} {
		if w := patchTask(t, h, canvasID, task.ID, map[string]any{"state": "executing", "agentName": loser}); w.Code != http.StatusConflict {
			t.Fatalf("%s claim = %d, want 409", loser, w.Code)
		}
	}

	got := awaitContention(t, fake, task.ID, 3)
	if len(got) != 3 {
		t.Fatalf("trail has %d entries, want 3 (three DIFFERENT losers never coalesce): %+v", len(got), got)
	}
	if n := reg.Snapshot().Counters.ClaimConflicts; n != 3 {
		t.Fatalf("claim_conflicts = %d, want 3 — the counter and the trail must agree", n)
	}
	// Every loser is named, and only once each. Deliberately a SET assertion:
	// recording is detached, so three losers refused in quick succession land in
	// whatever order their goroutines get to the store. Ordering within a second is
	// not a fact this trail promises — "these three lost to worker-a" is.
	seen := map[string]int{}
	for _, e := range got {
		seen[e.Agent] += e.Repeats()
	}
	for _, want := range []string{"worker-b", "worker-c", "worker-d"} {
		if seen[want] != 1 {
			t.Errorf("%s appears %d times in the trail, want exactly 1: %+v", want, seen[want], got)
		}
	}
}

// ── (2) A fenced write: who was fenced, under which dead lease ────────────────

// The case the fencing token exists for, now with a record. worker-a's lease
// lapses, worker-b takes the task over, worker-a comes back and writes — and the
// trail says which generation it wrote under against which live one, which is the
// only form of this event a human can act on.
func TestFencedWriteIsRecordedWithBothGenerations(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	genA := claimVia(t, h, canvasID, task.ID, "worker-a")
	fake.expireClaim(task.ID)
	genB := claimVia(t, h, canvasID, task.ID, "worker-b")

	// The takeover itself is not contention — worker-a lost nothing at the door,
	// it lost a lease it wasn't defending. Only the WRITE is a collision.
	if got := store.ReadContention(fake.task(task.ID).Payload); len(got) != 0 {
		t.Fatalf("a lease takeover recorded a collision: %+v", got)
	}

	w := patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "claimGeneration": genA,
		"result": "I thought this was mine",
	})
	assertFenced(t, w, fenceCodeOther, "worker-b")

	got := awaitContention(t, fake, task.ID, 1)
	e := got[len(got)-1]
	if e.Kind != store.ContentionFencedWrite {
		t.Errorf("kind = %q, want %q", e.Kind, store.ContentionFencedWrite)
	}
	if e.Agent != "worker-a" || e.Holder != "worker-b" {
		t.Errorf("agent/holder = %q/%q, want worker-a fenced against worker-b", e.Agent, e.Holder)
	}
	if e.Reason != fenceCodeOther {
		t.Errorf("reason = %q, want the fence code %q", e.Reason, fenceCodeOther)
	}
	if e.Presented != genA {
		t.Errorf("presented = %d, want the stale token %d the loser wrote under", e.Presented, genA)
	}
	if e.Generation != genB {
		t.Errorf("generation = %d, want the live token %d", e.Generation, genB)
	}

	// The refusal's own contract is unchanged — recording is additive, and the
	// fenced write still did not land.
	if state := fake.task(task.ID).State; state != "executing" {
		t.Fatalf("task state = %q, want executing — the fenced write must still not land", state)
	}
}

// The stale-generation case: the holder's NAME is right, its lease is not. Identity
// alone cannot see this, which is why the recorded pair (presented → live) is the
// only thing that explains the refusal to a human reading the ticket later.
func TestStaleGenerationWriteIsRecorded(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	genA1 := claimVia(t, h, canvasID, task.ID, "worker-a")
	fake.expireClaim(task.ID)
	claimVia(t, h, canvasID, task.ID, "worker-b")
	fake.expireClaim(task.ID)
	genA3 := claimVia(t, h, canvasID, task.ID, "worker-a") // same name, new lease

	w := patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "claimGeneration": genA1, "result": "a write from lease 1",
	})
	assertFenced(t, w, fenceCodeStale, "worker-a")

	got := awaitContention(t, fake, task.ID, 1)
	e := got[len(got)-1]
	if e.Reason != fenceCodeStale {
		t.Errorf("reason = %q, want %q", e.Reason, fenceCodeStale)
	}
	if e.Agent != "worker-a" || e.Holder != "worker-a" {
		t.Errorf("agent/holder = %q/%q — a stale write by the CURRENT holder is exactly this shape", e.Agent, e.Holder)
	}
	if e.Presented != genA1 || e.Generation != genA3 {
		t.Errorf("presented/live = %d/%d, want %d/%d", e.Presented, e.Generation, genA1, genA3)
	}
}

// A worker whose tap-out doesn't engage retries the same dead write. That is ONE
// collision with a count, not a trail full of noise — otherwise a single confused
// worker could push every other collision on the task out past the cap.
func TestRepeatedFencedWritesCoalesceIntoOneEntry(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	genA := claimVia(t, h, canvasID, task.ID, "worker-a")
	fake.expireClaim(task.ID)
	claimVia(t, h, canvasID, task.ID, "worker-b")

	for i := 0; i < 4; i++ {
		w := patchTask(t, h, canvasID, task.ID, map[string]any{
			"state": "done", "agentName": "worker-a", "claimGeneration": genA, "result": "again",
		})
		assertFenced(t, w, fenceCodeOther, "worker-b")
		// Serialised on purpose: coalescing is about repeats over time, and letting
		// four goroutines interleave would test the fake's locking instead.
		awaitContention(t, fake, task.ID, 1)
	}

	got := store.ReadContention(fake.task(task.ID).Payload)
	if len(got) != 1 {
		t.Fatalf("trail has %d entries, want 1 coalesced entry: %+v", len(got), got)
	}
	if got[0].Repeats() < 2 {
		t.Errorf("Repeats() = %d, want the retries counted on one entry", got[0].Repeats())
	}
}

// ── (3) What must NOT be recorded ────────────────────────────────────────────

// The human escape hatch is not a fleet collision. Release / requeue / reopen on a
// task an agent is holding is a PERSON unsticking a dead worker — the fence
// deliberately stays out of the way there (see claim_fence.go), and so must this:
// a board full of "contended" markers every time someone releases a stuck task
// would train people to ignore the marker.
func TestHumanControlsRecordNoContention(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	claimVia(t, h, canvasID, task.ID, "worker-a")

	// A human releases it — no agent header, no agentName in the body.
	w := moveTask(t, h, canvasID, task.ID, map[string]any{"to": "approved"}, "")
	if w.Code != http.StatusOK {
		t.Fatalf("human release = %d, want 200; body %s", w.Code, w.Body)
	}
	noContention(t, fake, task.ID)
}

// A claim that WINS records nothing, including the idempotent retry of a claim the
// same worker already holds. The trail is a record of collisions; an agent
// re-confirming its own claim collided with nobody.
func TestSuccessfulAndIdempotentClaimsRecordNothing(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	claimVia(t, h, canvasID, task.ID, "worker-a")
	claimVia(t, h, canvasID, task.ID, "worker-a") // the retry
	noContention(t, fake, task.ID)
}

// The holder's own writes, under its live token, are the happy path — and the
// happy path must leave the trail empty. If an ordinary completion recorded
// anything, the marker would appear on every finished task and mean nothing.
func TestHolderWritesRecordNothing(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	gen := claimVia(t, h, canvasID, task.ID, "worker-a")
	w := patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "claimGeneration": gen, "result": "did the work",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("holder complete = %d, want 200; body %s", w.Code, w.Body)
	}
	noContention(t, fake, task.ID)
}

// ── (4) The degradation ──────────────────────────────────────────────────────

// A store that cannot record collisions must still refuse them correctly. This is
// why the capability is type-asserted rather than a method on store.Store (see
// api.contentionStore): telemetry is not allowed to be load-bearing.
func TestRefusalsStillWorkWithoutAContentionStore(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := &noContentionStore{fenceFakeStore: newFenceStore(task)}
	h := NewHandler(fake, nil, nil)

	genA := claimVia(t, h, canvasID, task.ID, "worker-a")

	// The claim race still 409s…
	w := patchTask(t, h, canvasID, task.ID, map[string]any{"state": "executing", "agentName": "worker-b"})
	if w.Code != http.StatusConflict {
		t.Fatalf("second claim = %d, want 409; body %s", w.Code, w.Body)
	}
	// …and the fence still refuses, with its full shape.
	fake.expireClaim(task.ID)
	claimVia(t, h, canvasID, task.ID, "worker-b")
	w = patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "claimGeneration": genA,
	})
	assertFenced(t, w, fenceCodeOther, "worker-b")
	if state := fake.task(task.ID).State; state != "executing" {
		t.Fatalf("task state = %q, want executing", state)
	}
}

// noContentionStore is a store WITHOUT the optional capability. Achieved by
// shadowing the method with a non-matching signature, which is the only way to
// un-implement an interface in Go — and the shape a store that predates this
// feature would have.
type noContentionStore struct {
	*fenceFakeStore
}

func (n *noContentionStore) AppendContentionEvent(int) {}
