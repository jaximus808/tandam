package store

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TDM-100 — the contention trail, as a pure data structure.
//
// The API-layer tests (api/contention_test.go) prove the two choke points record
// the right events. These prove the record itself: that it appends, that it
// coalesces a repeat instead of drowning the trail in it, that it is capped, and —
// the part that is a security property rather than a convenience — that an agent's
// payload write cannot author or erase it.

func at(min int) time.Time {
	return time.Date(2026, 7, 30, 2, min, 0, 0, time.UTC)
}

// trail is the trail as stored, so a test reads what a board would.
func trail(t *testing.T, raw json.RawMessage) []ContentionEvent {
	t.Helper()
	return ReadContention(raw)
}

func mustAppend(t *testing.T, raw json.RawMessage, ev ContentionEvent) json.RawMessage {
	t.Helper()
	next, err := AppendContention(raw, ev)
	if err != nil {
		t.Fatalf("AppendContention: %v", err)
	}
	return next
}

// The base case, and the thing every surface depends on: a collision lands as one
// readable entry, and the rest of the payload is untouched. If a recorded race
// could drop a task's title, the telemetry would be worse than nothing.
func TestAppendContentionKeepsTheRestOfThePayload(t *testing.T) {
	stored := json.RawMessage(`{"title":"ship it","assignee":"agent","progress":[{"at":"x","note":"n"}]}`)

	next := mustAppend(t, stored, NewLostClaim("worker-b", "worker-a", 3, at(10)))

	got := trail(t, next)
	if len(got) != 1 {
		t.Fatalf("trail length = %d, want 1", len(got))
	}
	want := ContentionEvent{
		At: "2026-07-30T02:10:00Z", Kind: ContentionLostClaim,
		Agent: "worker-b", Holder: "worker-a", Generation: 3,
	}
	if got[0] != want {
		t.Errorf("event = %+v, want %+v", got[0], want)
	}
	if got[0].Repeats() != 1 {
		t.Errorf("Repeats() = %d on a fresh event, want 1 — a client must read max(count,1)", got[0].Repeats())
	}

	var p map[string]any
	if err := json.Unmarshal(next, &p); err != nil {
		t.Fatalf("stored payload is not an object: %v", err)
	}
	if p["title"] != "ship it" || p["assignee"] != "agent" {
		t.Errorf("recording a collision disturbed the task's content: %s", next)
	}
	if _, ok := p["progress"]; !ok {
		t.Errorf("recording a collision dropped progress[]: %s", next)
	}
}

// A fenced write carries the fact identity alone could not have caught: the stale
// token the loser wrote under, next to the live one.
func TestFencedWriteRecordsBothGenerations(t *testing.T) {
	next := mustAppend(t, nil, NewFencedWrite("worker-a", "worker-b", "stale_claim_generation", 3, 7, at(11)))

	got := trail(t, next)
	if len(got) != 1 {
		t.Fatalf("trail length = %d, want 1", len(got))
	}
	e := got[0]
	if e.Kind != ContentionFencedWrite || e.Agent != "worker-a" || e.Holder != "worker-b" {
		t.Fatalf("event = %+v, want a fenced write by worker-a against worker-b", e)
	}
	if e.Presented != 3 || e.Generation != 7 {
		t.Errorf("presented/live = %d/%d, want 3/7 — the pair IS the explanation for the refusal", e.Presented, e.Generation)
	}
	if e.Reason != "stale_claim_generation" {
		t.Errorf("reason = %q, want the fence code", e.Reason)
	}
}

// A worker whose tap-out doesn't engage can present the same dead lease over and
// over. Twenty entries saying the identical thing is one fact with a count, not
// twenty facts — so a repeat coalesces onto the newest entry and moves its clock.
func TestRepeatCollisionCoalescesOntoOneEntry(t *testing.T) {
	ev := func(min int) ContentionEvent {
		return NewFencedWrite("worker-a", "worker-b", "stale_claim_generation", 3, 7, at(min))
	}
	raw := mustAppend(t, nil, ev(10))
	raw = mustAppend(t, raw, ev(11))
	raw = mustAppend(t, raw, ev(12))

	got := trail(t, raw)
	if len(got) != 1 {
		t.Fatalf("trail length = %d, want 1 — three retries of one collision is one entry", len(got))
	}
	if got[0].Repeats() != 3 {
		t.Errorf("Repeats() = %d, want 3", got[0].Repeats())
	}
	if got[0].At != "2026-07-30T02:12:00Z" {
		t.Errorf("At = %q, want the MOST RECENT occurrence so the trail still sorts by recency", got[0].At)
	}
}

// Coalescing must not swallow a DIFFERENT collision. A new generation, a new
// holder or a different kind is a new fact about the task's history — and the
// board's whole job is telling those apart.
func TestDistinctCollisionsAreNotCoalesced(t *testing.T) {
	base := NewFencedWrite("worker-a", "worker-b", "stale_claim_generation", 3, 7, at(10))
	cases := []struct {
		name string
		next ContentionEvent
	}{
		{"different presented generation", NewFencedWrite("worker-a", "worker-b", "stale_claim_generation", 4, 7, at(11))},
		{"different live generation", NewFencedWrite("worker-a", "worker-b", "stale_claim_generation", 3, 8, at(11))},
		{"different holder", NewFencedWrite("worker-a", "worker-c", "stale_claim_generation", 3, 7, at(11))},
		{"different loser", NewFencedWrite("worker-z", "worker-b", "stale_claim_generation", 3, 7, at(11))},
		{"different reason", NewFencedWrite("worker-a", "worker-b", "claimed_by_other", 3, 7, at(11))},
		{"different kind", NewLostClaim("worker-a", "worker-b", 7, at(11))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := mustAppend(t, nil, base)
			raw = mustAppend(t, raw, tc.next)
			if got := trail(t, raw); len(got) != 2 {
				t.Fatalf("trail length = %d, want 2 (%s is its own fact): %s", len(got), tc.name, raw)
			}
		})
	}
}

// The cap, for the same reason audit[] has one: this payload is re-read by every
// board load and every WS state push. Oldest out, newest kept — the recent
// collisions are the ones a human is deciding on.
func TestContentionTrailIsCappedOldestFirst(t *testing.T) {
	var raw json.RawMessage
	// Each event is distinct (a rising generation), so nothing coalesces and the
	// cap is the only thing bounding the trail.
	for i := 1; i <= MaxContentionEvents+7; i++ {
		raw = mustAppend(t, raw, NewFencedWrite("worker-a", "worker-b", "stale_claim_generation", i, i+1, at(i%60)))
	}

	got := trail(t, raw)
	if len(got) != MaxContentionEvents {
		t.Fatalf("trail length = %d, want the cap %d", len(got), MaxContentionEvents)
	}
	if got[0].Presented != 8 {
		t.Errorf("oldest surviving entry presented = %d, want 8 — the first 7 should have aged out", got[0].Presented)
	}
	if last := got[len(got)-1]; last.Presented != MaxContentionEvents+7 {
		t.Errorf("newest entry presented = %d, want %d", last.Presented, MaxContentionEvents+7)
	}
}

// A malformed trail must read as empty, never as an error: this is a record of
// races, and a corrupt one must not be able to make a task unreadable or
// unfinishable.
func TestUnreadableContentionDegradesToEmpty(t *testing.T) {
	for _, raw := range []string{``, `null`, `[]`, `{"contention":"nope"}`, `{"contention":42}`, `not json`} {
		if got := ReadContention(json.RawMessage(raw)); len(got) != 0 {
			t.Errorf("ReadContention(%q) = %+v, want empty", raw, got)
		}
	}
	// And appending to a non-object payload still produces a usable one rather
	// than failing the write.
	next := mustAppend(t, json.RawMessage(`"a string payload"`), NewLostClaim("a", "b", 1, at(10)))
	if got := trail(t, next); len(got) != 1 {
		t.Errorf("append onto a non-object payload lost the event: %s", next)
	}
}

// ── The security property ────────────────────────────────────────────────────
//
// The trail records what agents did to each other. If an agent's own payload
// write could author or erase entries, it would be a record of what agents were
// willing to admit — which is not a record at all.

// CarryContention guards the raw door: ActionStatePatch.Payload, written straight
// through by UpdateActionState.
func TestCarryContentionIsServerOwned(t *testing.T) {
	stored := mustAppend(t, json.RawMessage(`{"title":"t"}`), NewLostClaim("worker-b", "worker-a", 2, at(10)))

	// Forging: a caller invents a trail. The stored one replaces it wholesale.
	forged := json.RawMessage(`{"title":"t","contention":[{"kind":"lost_claim","agent":"worker-a","holder":"worker-b"}]}`)
	out := CarryContention(forged, stored)
	got := trail(t, out)
	if len(got) != 1 || got[0].Agent != "worker-b" {
		t.Fatalf("forged trail survived: %+v (%s)", got, out)
	}

	// Erasing: a caller sends an empty array to wipe the record of what it lost.
	out = CarryContention(json.RawMessage(`{"title":"t","contention":[]}`), stored)
	if got := trail(t, out); len(got) != 1 || got[0].Agent != "worker-b" {
		t.Fatalf("an empty array erased the trail: %+v (%s)", got, out)
	}

	// Omitting: the ordinary write, which says nothing about contention. The trail
	// is re-attached anyway, because the stored row is the authority.
	out = CarryContention(json.RawMessage(`{"title":"t","body":"b"}`), stored)
	if got := trail(t, out); len(got) != 1 {
		t.Fatalf("an ordinary write dropped the trail: %s", out)
	}

	// A task nobody has raced for must NOT grow an empty key — most payloads have
	// no trail and shouldn't carry a field for it.
	out = CarryContention(json.RawMessage(`{"title":"t","contention":[{"kind":"lost_claim","agent":"x"}]}`), json.RawMessage(`{"title":"t"}`))
	var p map[string]any
	if err := json.Unmarshal(out, &p); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, had := p[ContentionKey]; had {
		t.Errorf("a task with no stored trail grew one from the caller's payload: %s", out)
	}
}

// The content gate guards the OTHER door: the payload-only PATCH. Same rule,
// enforced by carryContentAudit alongside audit[] and the claim record.
func TestContentGateCarriesTheContentionTrail(t *testing.T) {
	stored := mustAppend(t, json.RawMessage(`{"title":"t","assignee":"agent"}`), NewLostClaim("worker-b", "worker-a", 2, at(10)))
	current := &Action{ID: uuid.New(), Type: "task", State: "approved", Payload: stored}

	// A bookkeeping write (the hot path) that tries to smuggle a trail with it.
	incoming := json.RawMessage(`{"title":"t","assignee":"agent","links":["https://x"],"contention":[]}`)
	next, out, err := DecideContentUpdate(current, incoming, "agent:worker-a", at(11))
	if err != nil {
		t.Fatalf("DecideContentUpdate: %v", err)
	}
	if len(out.Changed) != 0 {
		t.Fatalf("a links-only write read as a content change: %v", out.Changed)
	}
	if got := trail(t, next); len(got) != 1 || got[0].Agent != "worker-b" {
		t.Fatalf("the payload gate let a caller rewrite the trail: %+v (%s)", got, next)
	}

	// And a CONTENT edit — the reverting path — carries it too. This is the one
	// that matters most: a task sent back for re-approval keeps the record of the
	// races that happened while it was running.
	next, out, err = DecideContentUpdate(current, json.RawMessage(`{"title":"rewritten","assignee":"agent"}`), "agent:worker-a", at(12))
	if err != nil {
		t.Fatalf("DecideContentUpdate (content edit): %v", err)
	}
	if !out.Reverted {
		t.Fatalf("a content edit on an approved task did not revert it")
	}
	if got := trail(t, next); len(got) != 1 {
		t.Fatalf("the revert dropped the trail: %s", next)
	}
}

// A payload with no trail must not grow an empty `contention` key just from
// passing through the gate — the same rule audit[] follows.
func TestContentGateDoesNotIntroduceAnEmptyTrail(t *testing.T) {
	current := &Action{ID: uuid.New(), Type: "task", State: "proposed", Payload: json.RawMessage(`{"title":"t"}`)}
	next, _, err := DecideContentUpdate(current, json.RawMessage(`{"title":"t","links":["https://x"]}`), "human", at(10))
	if err != nil {
		t.Fatalf("DecideContentUpdate: %v", err)
	}
	var p map[string]any
	if err := json.Unmarshal(next, &p); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, had := p[ContentionKey]; had {
		t.Errorf("an untouched task grew a contention key: %s", next)
	}
}
