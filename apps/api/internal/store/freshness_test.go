package store

import (
	"testing"
	"time"
)

func TestDeriveFreshness(t *testing.T) {
	// Fixed clock: every case is expressed as an offset from this instant, so the
	// boundary rows below land on the exact nanosecond, not "about now".
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) *time.Time { t := now.Add(d); return &t }
	secs := func(n int) *int { return &n }

	tests := []struct {
		name       string
		verifiedAt *time.Time
		staleAfter *int
		want       Freshness
	}{
		// ── unknown: never verified (distinct from stale) ─────────────────────
		{"never verified, no shelf life", nil, nil, FreshnessUnknown},
		{"never verified, shelf life declared", nil, secs(3600), FreshnessUnknown},

		// ── verified with no declared shelf life: fresh forever ───────────────
		{"verified just now, no shelf life", at(0), nil, FreshnessFresh},
		{"verified a decade ago, no shelf life", at(-10 * 365 * 24 * time.Hour), nil, FreshnessFresh},
		// Non-positive windows can't reach the DB (0037 CHECK) but must not be
		// read as instantly stale if they arrive from memory.
		{"zero shelf life folds into no shelf life", at(-time.Hour), secs(0), FreshnessFresh},
		{"negative shelf life folds into no shelf life", at(-time.Hour), secs(-60), FreshnessFresh},

		// ── fresh: inside the first half of the window ────────────────────────
		{"verified this instant", at(0), secs(3600), FreshnessFresh},
		{"one quarter elapsed", at(-15 * time.Minute), secs(3600), FreshnessFresh},
		{"one nanosecond before the aging boundary", at(-30*time.Minute + time.Nanosecond), secs(3600), FreshnessFresh},

		// ── aging: at or past 50%, not yet expired ────────────────────────────
		{"exactly 50% elapsed is aging", at(-30 * time.Minute), secs(3600), FreshnessAging},
		{"one nanosecond past the aging boundary", at(-30*time.Minute - time.Nanosecond), secs(3600), FreshnessAging},
		{"three quarters elapsed", at(-45 * time.Minute), secs(3600), FreshnessAging},
		{"one nanosecond before expiry", at(-time.Hour + time.Nanosecond), secs(3600), FreshnessAging},

		// ── stale: at or past the expiry instant ──────────────────────────────
		{"exactly expired is stale", at(-time.Hour), secs(3600), FreshnessStale},
		{"one nanosecond past expiry", at(-time.Hour - time.Nanosecond), secs(3600), FreshnessStale},
		{"long past expiry", at(-30 * 24 * time.Hour), secs(3600), FreshnessStale},

		// ── odd windows halve exactly (durations are ns, so no rounding) ──────
		{"odd window, exactly 50%", at(-1500 * time.Millisecond), secs(3), FreshnessAging},
		{"odd window, just under 50%", at(-1500*time.Millisecond + time.Nanosecond), secs(3), FreshnessFresh},

		// ── clock skew: verified in the future reads fresh, never stale ───────
		{"verified in the future", at(time.Hour), secs(3600), FreshnessFresh},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := DeriveFreshness(tc.verifiedAt, tc.staleAfter, now); got != tc.want {
				t.Errorf("DeriveFreshness() = %q, want %q", got, tc.want)
			}
		})
	}
}

// The function must depend only on its arguments — no hidden time.Now(), no
// mutation of the inputs — since E1.3 derives freshness for a whole canvas
// against one pinned instant.
func TestDeriveFreshnessIsPure(t *testing.T) {
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	verified := now.Add(-45 * time.Minute)
	window := 3600

	first := DeriveFreshness(&verified, &window, now)
	for range 3 {
		if got := DeriveFreshness(&verified, &window, now); got != first {
			t.Fatalf("repeat call = %q, want %q — result depends on something other than its arguments", got, first)
		}
	}
	if !verified.Equal(now.Add(-45 * time.Minute)) {
		t.Errorf("verifiedAt mutated: %v", verified)
	}
	if window != 3600 {
		t.Errorf("staleAfterSeconds mutated: %d", window)
	}

	// Advancing only the clock must be enough to move the status along.
	if got := DeriveFreshness(&verified, &window, now.Add(20*time.Minute)); got != FreshnessStale {
		t.Errorf("with the clock advanced past expiry = %q, want %q", got, FreshnessStale)
	}
}
