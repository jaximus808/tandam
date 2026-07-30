package store

import (
	"encoding/json"
	"time"
)

// ── Claim generations: the fencing token (TDM-98) ─────────────────────────────
//
// THE PROBLEM. The claim is atomic (ClaimAction) and it has a lease
// (DefaultClaimTTL, lazily expired), so a worker that goes dark stops wedging
// the queue: a rival takes the task over. But "took it over" only rebinds
// claimed_by — it says nothing about the WRITES the dead-looking worker may
// still have in flight. A worker whose lease lapsed while it was busy comes
// back and completes a task that now belongs to someone else, and the board
// records the wrong agent finishing work it never did (or worse, marks done a
// task the new holder is still working).
//
// Holder identity alone cannot catch every case of that, because the holder can
// legitimately be the same name twice:
//
//	worker-a claims          (lease 1)
//	worker-a's lease lapses
//	worker-b takes over      (lease 2)   ← worker-a is now a rival: identity catches it
//	worker-b's lease lapses
//	worker-a takes over      (lease 3)   ← worker-a is the holder AGAIN
//	worker-a's lease-1 write lands                    ← identity says yes. It must not.
//
// THE TOKEN. Every claim that stamps a fresh lease mints a generation: a
// per-task counter that increments on each claim and never resets (so it
// survives reclaims, releases and takeovers — a generation identifies a LEASE
// INSTANCE, not an agent). The claimant gets it back from the claim, presents it
// on every later write, and the server refuses a write whose generation isn't
// the live one. That is a fencing token in the Kleppmann sense, and it is the
// only thing that makes the third line above safe.
//
// WHERE IT LIVES, and why not in a column. The record is a reserved key on the
// task's payload (ClaimRecordKey), not a new column, so this needs no migration
// and rides every existing read: any response carrying the action carries its
// claim record. It is SERVER-OWNED like the audit log next to it — a payload
// PATCH can neither forge nor drop it (see carryContentAudit in content_gate.go,
// which replaces both keys from the stored row).
//
// HOW IT IS MINTED, and why that is safe. The claim's conditional UPDATE returns
// the row it won (return=representation) and does not touch `payload`, so the
// returned payload is the PRE-IMAGE the next generation counts from — no extra
// read. The record is then written by a second conditional UPDATE predicated on
// the exact lease that was just stamped (state + claimed_by + claimed_at), so a
// takeover racing in between cannot be overwritten by the loser's stamp. If that
// write fails the claim still stands and simply carries NO generation: the
// caller presents nothing and the fence degrades to a holder-identity check,
// which is exactly the behaviour of every client that predates this token.
const (
	// ClaimRecordKey is the payload key the claim record lives under. Reserved:
	// callers may send it and it is discarded (content_gate.go).
	ClaimRecordKey = "claim"
)

// ClaimRecord is the fencing record for a task's CURRENT lease. Written only by
// the claim path; read by every write path that fences.
type ClaimRecord struct {
	// Generation is the fencing token: 1 for a task's first claim, +1 for every
	// claim after it. 0 means "no generation recorded" — a task claimed before
	// this existed, or a claim whose stamp write failed. 0 never fences: it reads
	// as "this deployment can only check identity", not as a valid token.
	Generation int `json:"generation"`
	// Holder is who the generation was minted for. Duplicated from claimed_by on
	// purpose: it makes the record self-describing in a payload dump, and lets a
	// reader see when the record is stale relative to the row (a released task
	// keeps its record so the NEXT claim keeps counting up).
	Holder string `json:"holder,omitempty"`
	// At is the claimed_at the generation was minted against, RFC3339.
	At string `json:"at,omitempty"`
}

// ReadClaimRecord pulls the stored claim record off a task payload. Anything
// missing or malformed reads as the zero record (generation 0 = unfenced), never
// as an error: a corrupt payload must not make a task impossible to finish.
func ReadClaimRecord(raw json.RawMessage) ClaimRecord {
	var p struct {
		Claim ClaimRecord `json:"claim"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return ClaimRecord{}
	}
	if p.Claim.Generation < 0 {
		return ClaimRecord{}
	}
	return p.Claim
}

// WithClaimRecord returns `raw` with rec written under ClaimRecordKey, every
// other key untouched. A payload that isn't a JSON object is replaced by one
// holding just the record — task payloads are objects by validation
// (canonicalizeTaskPayload), so that branch is a safety net, not a path.
func WithClaimRecord(raw json.RawMessage, rec ClaimRecord) (json.RawMessage, error) {
	p := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			p = map[string]any{}
		}
	}
	p[ClaimRecordKey] = rec
	return json.Marshal(p)
}

// CarryClaimRecord returns `incoming` with its claim record forced to the one on
// `stored`, dropping the key entirely when the stored row has none.
//
// This is carryContentAudit's rule (server-owned keys come off the stored row,
// never off the request) applied to the OTHER door a payload can arrive through:
// ActionStatePatch.Payload, which UpdateActionState writes raw. Without it,
// `PATCH {state:"done", payload:{claim:{generation:99}}}` would let a caller
// rewrite the token its NEXT write will be fenced by — the fence would still
// refuse the write in hand, and then be holding a number the caller chose.
//
// Anything unparsable is returned untouched: shape validation belongs upstream,
// and this must not turn a malformed payload into a different malformed payload.
func CarryClaimRecord(incoming, stored json.RawMessage) json.RawMessage {
	if len(incoming) == 0 {
		return incoming
	}
	p := map[string]any{}
	if json.Unmarshal(incoming, &p) != nil {
		return incoming
	}
	if rec := ReadClaimRecord(stored); rec.Generation > 0 {
		p[ClaimRecordKey] = rec
	} else if _, had := p[ClaimRecordKey]; had {
		delete(p, ClaimRecordKey)
	} else {
		return incoming
	}
	out, err := json.Marshal(p)
	if err != nil {
		return incoming
	}
	return out
}

// NextClaimRecord builds the record for a lease that just landed: the stored
// generation plus one, stamped with the new holder and lease time.
func NextClaimRecord(stored json.RawMessage, holder string, at time.Time) ClaimRecord {
	return ClaimRecord{
		Generation: ReadClaimRecord(stored).Generation + 1,
		Holder:     holder,
		At:         at.UTC().Format(time.RFC3339),
	}
}
