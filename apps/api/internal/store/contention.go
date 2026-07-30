package store

import (
	"encoding/json"
	"time"
)

// ── Contention events: the collision trail (TDM-100) ──────────────────────────
//
// WHAT WAS MISSING. TDM-98 made the protocol correct — a claim is atomic, and a
// write from an agent that no longer holds the claim is refused (see
// claim_fence.go). TDM-99 made losing graceful — the loser is told to tap out
// instead of retrying. Both of those are counters on /api/metrics
// (claim_conflicts, fenced_writes) and a 409 the loser reads and then throws
// away. Which means the ONE thing the protocol working looks like from outside —
// "two agents went for the same task and one yielded" — was invisible on the
// board. A human watching a fleet saw a task get claimed. They never saw the
// race.
//
// So the events are RECORDED, per task, where the board already reads:
//
//	LOST CLAIM    an agent asked for a task somebody else already held. Who
//	              asked, who held it, when. This is the claim_conflicts counter's
//	              individual events, attributed.
//	FENCED WRITE  an agent wrote to a task under a claim it no longer holds —
//	              wrong holder, or the right name under a superseded lease. Who
//	              was fenced, who holds it now, and the stale generation they
//	              presented against the live one.
//
// WHERE IT LIVES, and why no migration. Same reserved-key-on-the-payload
// decision as the claim record next to it (ClaimRecordKey) and the audit log
// next to that: a task's payload rides every existing read — REST, the WS state
// broadcast, the MCP task_get — so an event recorded here reaches the board with
// no new table, no new endpoint and no new push. It is SERVER-OWNED in exactly
// the same sense: CarryContention and carryContentAudit both replace whatever a
// caller sent under this key with the copy off the stored row, so an agent can
// neither invent a race it won nor erase the record of one it lost.
//
// WHY EVENTS AND NOT JUST COUNTS. A count answers "how hot is this task"; the
// board's job is to answer "who raced whom". Two counters cannot say that
// worker-b lost this task to worker-a specifically, which is the whole sentence
// the fleet view wants to show. The counters stay — they are the fleet-wide rate
// — and this is the per-task attribution underneath them.
//
// COALESCING, and why the cap is not the only bound. A worker whose gateway
// tap-out does not engage (a raw HTTP client, an older gateway) can present the
// same dead lease repeatedly. Twenty distinct entries all saying "worker-a,
// generation 3, fenced" is not twenty facts, it is one fact with a count — so an
// event identical to the newest one bumps its Count and its At instead of
// appending. That keeps the last twenty DISTINCT collisions rather than the last
// twenty retries of one, which is the version a human can read.

const (
	// ContentionKey is the payload key the trail lives under. Reserved: callers
	// may send it and it is discarded.
	ContentionKey = "contention"

	// MaxContentionEvents bounds the trail, for the same reason MaxContentAudit
	// bounds audit[]: this payload is re-read by every board load and every WS
	// state broadcast, so an unbounded log would tax the whole canvas. Twenty
	// distinct collisions on one task is already a story; the ones that matter
	// are the recent ones, and those are the ones kept.
	MaxContentionEvents = 20
)

// The two kinds of collision. One vocabulary, shared by the API that records and
// the web that renders — a client switches on these strings.
const (
	// ContentionLostClaim: a claim refused because the task was already held.
	ContentionLostClaim = "lost_claim"
	// ContentionFencedWrite: a write refused because the caller does not hold the
	// live claim (wrong holder, or a superseded generation).
	ContentionFencedWrite = "fenced_write"
)

// ContentionEvent is ONE collision on ONE task.
//
// Deliberately compact and self-describing, like ContentAudit: it answers who
// collided with whom, when, and — for a fenced write — under which dead lease.
// It carries no task id or canvas id because it is stored ON the task; adding
// them would be duplicating the row it lives in.
type ContentionEvent struct {
	// At is when the collision happened (RFC3339, UTC). On a coalesced event this
	// is the MOST RECENT occurrence, so the trail still sorts by recency.
	At string `json:"at"`
	// Kind is ContentionLostClaim or ContentionFencedWrite.
	Kind string `json:"kind"`
	// Agent is the LOSER: the caller whose claim or write was refused. Empty only
	// for an anonymous caller, which the fence does not engage for at all — so in
	// practice this is always a name.
	Agent string `json:"agent"`
	// Holder is who held the task at that moment — the winner. "nobody" when the
	// claim had been cleared out from under a still-writing loser.
	Holder string `json:"holder,omitempty"`
	// Reason is the fence code for a fenced write ("claimed_by_other" |
	// "stale_claim_generation"); empty for a lost claim, whose reason is its kind.
	Reason string `json:"reason,omitempty"`
	// Presented is the STALE fencing token the loser wrote under, and the reason
	// this field exists separately from Generation: "you presented 3, the live
	// lease is 7" is the fact that explains a refusal identity alone could not
	// have caught. 0 when the caller presented none.
	Presented int `json:"presented,omitempty"`
	// Generation is the LIVE claim generation at the moment of the collision. 0
	// on a task claimed before the token existed.
	Generation int `json:"generation,omitempty"`
	// Count is how many times this exact collision has repeated, coalesced onto
	// one entry. Absent (0) and 1 both mean "once" — a client must read
	// max(Count, 1). See the coalescing note above.
	Count int `json:"count,omitempty"`
}

// Repeats is Count normalised: how many times this collision actually happened.
func (e ContentionEvent) Repeats() int {
	if e.Count < 1 {
		return 1
	}
	return e.Count
}

// sameCollision reports whether two events are the same collision repeating —
// everything but the timestamp and the count. Deliberately strict: a DIFFERENT
// generation, or a different holder, is a new fact about the task's history and
// earns its own entry.
func (e ContentionEvent) sameCollision(o ContentionEvent) bool {
	return e.Kind == o.Kind && e.Agent == o.Agent && e.Holder == o.Holder &&
		e.Reason == o.Reason && e.Presented == o.Presented && e.Generation == o.Generation
}

// NewLostClaim is the event for a claim that lost the race: `agent` asked for a
// task `holder` already had. `generation` is the live token on the task (0 when
// it has none), read for context — the loser presented nothing, so there is no
// Presented to record.
func NewLostClaim(agent, holder string, generation int, at time.Time) ContentionEvent {
	return ContentionEvent{
		At:         at.UTC().Format(time.RFC3339),
		Kind:       ContentionLostClaim,
		Agent:      agent,
		Holder:     holder,
		Generation: generation,
	}
}

// NewFencedWrite is the event for a write the claim fence refused. `reason` is
// the fence code, `presented` the token the caller wrote under (0 = none), and
// `generation` the live one.
func NewFencedWrite(agent, holder, reason string, presented, generation int, at time.Time) ContentionEvent {
	return ContentionEvent{
		At:         at.UTC().Format(time.RFC3339),
		Kind:       ContentionFencedWrite,
		Agent:      agent,
		Holder:     holder,
		Reason:     reason,
		Presented:  presented,
		Generation: generation,
	}
}

// ReadContention pulls the stored trail off a task payload, oldest first.
// Anything missing or malformed reads as an empty trail, never an error: a
// corrupt telemetry key must not be able to make a task unreadable — this is a
// record of races, not the work.
func ReadContention(raw json.RawMessage) []ContentionEvent {
	var p struct {
		Contention []ContentionEvent `json:"contention"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil
	}
	return p.Contention
}

// AppendContention returns `stored` with one collision folded into its trail:
// coalesced onto the newest entry when it is the same collision repeating,
// appended otherwise, and capped at MaxContentionEvents either way.
//
// Takes the prior entries off the STORED payload (never off a caller's) for the
// same reason AppendAudit does — the trail records what agents did, so agents
// must not be able to author it.
func AppendContention(stored json.RawMessage, ev ContentionEvent) (json.RawMessage, error) {
	trail := ReadContention(stored)
	if n := len(trail); n > 0 && trail[n-1].sameCollision(ev) {
		trail[n-1].Count = trail[n-1].Repeats() + 1
		trail[n-1].At = ev.At
	} else {
		trail = append(trail, ev)
	}
	if len(trail) > MaxContentionEvents {
		trail = trail[len(trail)-MaxContentionEvents:]
	}
	p := map[string]any{}
	if len(stored) > 0 {
		if err := json.Unmarshal(stored, &p); err != nil {
			p = map[string]any{}
		}
	}
	p[ContentionKey] = trail
	return json.Marshal(p)
}

// CarryContention returns `incoming` with its contention trail forced to the one
// on `stored`, dropping the key entirely when the stored row has none.
//
// This is CarryClaimRecord's rule applied to the other server-owned key on the
// payload, and it exists for the same reason: ActionStatePatch.Payload is
// written raw by UpdateActionState, so without this a caller could send
// `{state:"done", payload:{contention:[]}}` and erase the record of the races it
// lost on its way there. Unparsable input is returned untouched — shape
// validation belongs upstream.
func CarryContention(incoming, stored json.RawMessage) json.RawMessage {
	if len(incoming) == 0 {
		return incoming
	}
	p := map[string]any{}
	if json.Unmarshal(incoming, &p) != nil {
		return incoming
	}
	if trail := ReadContention(stored); len(trail) > 0 {
		p[ContentionKey] = trail
	} else if _, had := p[ContentionKey]; had {
		delete(p, ContentionKey)
	} else {
		return incoming
	}
	out, err := json.Marshal(p)
	if err != nil {
		return incoming
	}
	return out
}
