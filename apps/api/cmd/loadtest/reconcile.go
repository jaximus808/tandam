package main

import (
	"fmt"
	"sort"
)

// serverTaskState is what the API reports for a seeded task after the drain.
type serverTaskState struct {
	State     string `json:"state"`
	ClaimedBy string `json:"claimedBy"`
}

// doubleClaim records one task that appears in more than one worker's win set
// — the exact failure the product promises can never happen.
type doubleClaim struct {
	TaskID  string   `json:"task_id"`
	Workers []string `json:"workers"`
}

// reconResult is the verdict of the post-drain correctness assertion.
type reconResult struct {
	OK           bool          `json:"ok"`
	DoubleClaims []doubleClaim `json:"double_claims,omitempty"`
	Violations   []string      `json:"violations,omitempty"`
}

// reconcile is the correctness assertion, pure so it can be unit-tested:
//   - every seeded task is in exactly one worker's win set (any overlap, or a
//     task won twice by the same worker, is a DOUBLE-CLAIM);
//   - every seeded task ended state "done" on the server;
//   - the server's claimedBy agrees with the client-side winner;
//   - wins == len(seeded), and wins + losses == attempts.
//
// states may be nil in tests that only exercise the win-set overlap logic.
func reconcile(seeded []string, winsByWorker map[string][]string, states map[string]serverTaskState, counts opCounts) reconResult {
	res := reconResult{OK: true}
	fail := func(format string, args ...any) {
		res.OK = false
		res.Violations = append(res.Violations, fmt.Sprintf(format, args...))
	}

	seededSet := make(map[string]bool, len(seeded))
	for _, id := range seeded {
		seededSet[id] = true
	}

	// Win-set overlap: task id → every (worker, occurrence) that claims it won.
	winners := make(map[string][]string)
	totalWins := 0
	// Deterministic worker order so violation output is stable.
	workerNames := make([]string, 0, len(winsByWorker))
	for w := range winsByWorker {
		workerNames = append(workerNames, w)
	}
	sort.Strings(workerNames)
	for _, w := range workerNames {
		for _, id := range winsByWorker[w] {
			winners[id] = append(winners[id], w)
			totalWins++
			if !seededSet[id] {
				fail("worker %s won task %s that was never seeded by this run", w, id)
			}
		}
	}
	for id, ws := range winners {
		if len(ws) > 1 {
			res.OK = false
			res.DoubleClaims = append(res.DoubleClaims, doubleClaim{TaskID: id, Workers: ws})
		}
	}
	sort.Slice(res.DoubleClaims, func(i, j int) bool {
		return res.DoubleClaims[i].TaskID < res.DoubleClaims[j].TaskID
	})
	if len(res.DoubleClaims) > 0 {
		fail("DOUBLE-CLAIM DETECTED: %d task(s) won by more than one worker", len(res.DoubleClaims))
	}

	// Every seeded task won exactly once, done on the server, claimant agrees.
	for _, id := range seeded {
		ws := winners[id]
		if len(ws) == 0 {
			fail("task %s was seeded but never claimed by any worker", id)
		}
		if states == nil {
			continue
		}
		st, ok := states[id]
		if !ok {
			fail("task %s has no server state after the drain", id)
			continue
		}
		if st.State != "done" {
			fail("task %s ended in state %q, expected done", id, st.State)
		}
		if len(ws) == 1 && st.ClaimedBy != "" && st.ClaimedBy != ws[0] {
			fail("task %s: server says claimedBy=%q but client-side winner was %q", id, st.ClaimedBy, ws[0])
		}
	}

	// Count invariants.
	if totalWins != len(seeded) {
		fail("wins=%d but %d tasks were seeded", totalWins, len(seeded))
	}
	if counts.ClaimsWon != totalWins {
		fail("recorder counted %d wins but win sets hold %d", counts.ClaimsWon, totalWins)
	}
	if got := counts.ClaimsWon + counts.ClaimsLost409 + counts.ClaimsLostStale; got != counts.ClaimAttempts {
		fail("wins+losses=%d but attempts=%d", got, counts.ClaimAttempts)
	}
	if counts.Completed != counts.ClaimsWon {
		fail("completed=%d but claims_won=%d — a won task was not completed", counts.Completed, counts.ClaimsWon)
	}
	return res
}
