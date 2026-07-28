package main

import (
	"math"
	"sync"
	"time"
)

// ── Latency recording ─────────────────────────────────────────────────────────

type op int

const (
	opList op = iota
	opClaimWin
	opClaimLoss // 409 already_claimed
	opComplete
	opCount
)

var opNames = map[op]string{
	opList:      "list",
	opClaimWin:  "claim_win",
	opClaimLoss: "claim_loss_409",
	opComplete:  "complete",
}

// opCounts are the outcome tallies the reconciliation asserts over.
type opCounts struct {
	ClaimsWon       int `json:"claims_won"`
	ClaimsLost409   int `json:"claims_lost_409"`
	ClaimsLostStale int `json:"claims_lost_stale"`
	ClaimAttempts   int `json:"claim_attempts"`
	Completed       int `json:"completed"`
	Lists           int `json:"lists"`
}

// recorder collects per-op latency samples and outcome counts from all
// workers. One mutex is plenty at benchmark scale — the lock is nanoseconds
// against network calls that are milliseconds.
type recorder struct {
	mu      sync.Mutex
	byOp    [opCount][]time.Duration
	tallies opCounts
}

func newRecorder() *recorder { return &recorder{} }

func (r *recorder) observe(o op, d time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.byOp[o] = append(r.byOp[o], d)
	switch o {
	case opList:
		r.tallies.Lists++
	case opComplete:
		r.tallies.Completed++
	}
}

// attempt tallies one claim attempt and its outcome (wins/losses also get a
// latency sample via observe; stale losses are counted but not timed as an op
// of interest).
func (r *recorder) attempt(outcome claimOutcome) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tallies.ClaimAttempts++
	switch outcome {
	case claimWon:
		r.tallies.ClaimsWon++
	case claimLost:
		r.tallies.ClaimsLost409++
	case claimStale:
		r.tallies.ClaimsLostStale++
	}
}

func (r *recorder) counts() opCounts {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tallies
}

func (r *recorder) samples(o op) []time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]time.Duration, len(r.byOp[o]))
	copy(out, r.byOp[o])
	return out
}

// ── Percentiles ───────────────────────────────────────────────────────────────

// percentile computes the p-th percentile (nearest-rank on a sorted copy).
// p is in [0,100]. An empty sample set yields 0.
func percentile(samples []time.Duration, p float64) time.Duration {
	if len(samples) == 0 {
		return 0
	}
	sorted := sortDurations(samples)
	if p <= 0 {
		return sorted[0]
	}
	if p >= 100 {
		return sorted[len(sorted)-1]
	}
	// nearest-rank: ceil(p/100 * n), 1-based
	rank := int(math.Ceil((p / 100) * float64(len(sorted))))
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}
