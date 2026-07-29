package store

import "time"

// Freshness is the DERIVED trust status of a piece of canvas context. It is
// never stored — migration 0037 persists only the (verified_at,
// stale_after_seconds) pair, and this is computed at read time from that pair
// plus the current instant, so it can never itself be stale on read.
type Freshness string

const (
	// FreshnessUnknown — never verified. Deliberately NOT the same as stale:
	// "nobody has vouched for this" is a different (and honest) claim from
	// "someone vouched for it and that vouching has expired".
	FreshnessUnknown Freshness = "unknown"
	// FreshnessFresh — inside the first AgingThreshold of the shelf life.
	FreshnessFresh Freshness = "fresh"
	// FreshnessAging — past AgingThreshold of the shelf life, not yet expired.
	// The warning band: still usable, but worth re-verifying.
	FreshnessAging Freshness = "aging"
	// FreshnessStale — the shelf life has run out.
	FreshnessStale Freshness = "stale"
)

// AgingThreshold is the fraction of an item's shelf life after which it reads
// as "aging" rather than "fresh". Policy, not schema — migration 0037 leaves it
// to Go precisely so it can be tuned without a migration. Half the window gives
// a re-verification warning with as much time left as has already elapsed.
const AgingThreshold = 0.5

// DeriveFreshness computes the freshness of an item from its stored freshness
// pair. Pure: `now` is a parameter, never time.Now(), so callers control the
// clock and tests can pin boundary instants exactly.
//
// Rules, in order:
//
//	verifiedAt == nil                 → unknown (never verified)
//	staleAfterSeconds == nil or <= 0  → fresh   (verified, no declared shelf life)
//	elapsed >= window                 → stale   (boundary instant is stale)
//	elapsed >= window*AgingThreshold  → aging   (boundary instant is aging)
//	otherwise                         → fresh
//
// A verified item with NO declared shelf life is fresh forever and never ages.
// That is the deliberate reading of "no shelf life declared": the author
// asserted the content is true and declined to say it would expire, so the
// system has no basis to start doubting it. Ageing it anyway would invent a
// decay policy the author never set, and the point of this feature is to show
// real decay, not manufacture it. Items that should age must say so by setting
// stale_after_seconds.
//
// A non-positive staleAfterSeconds is impossible through the DB (0037's CHECK
// rejects it), so it can only arrive from a bad in-memory value; it is folded
// into the "no declared shelf life" case rather than being read as instantly
// stale, since a nonsensical window is an absent window, not an expired one.
//
// A `now` before verifiedAt (clock skew, or a verification stamped in the
// future) yields a negative elapsed and therefore fresh.
func DeriveFreshness(verifiedAt *time.Time, staleAfterSeconds *int, now time.Time) Freshness {
	if verifiedAt == nil {
		return FreshnessUnknown
	}
	if staleAfterSeconds == nil || *staleAfterSeconds <= 0 {
		return FreshnessFresh
	}
	window := time.Duration(*staleAfterSeconds) * time.Second
	elapsed := now.Sub(*verifiedAt)
	switch {
	case elapsed >= window:
		return FreshnessStale
	case elapsed >= time.Duration(float64(window)*AgingThreshold):
		return FreshnessAging
	default:
		return FreshnessFresh
	}
}
