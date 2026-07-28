package main

import (
	"strings"
	"testing"
)

func doneStates(ids []string, claimedBy map[string]string) map[string]serverTaskState {
	out := make(map[string]serverTaskState, len(ids))
	for _, id := range ids {
		out[id] = serverTaskState{State: "done", ClaimedBy: claimedBy[id]}
	}
	return out
}

func TestReconcileCleanRunPasses(t *testing.T) {
	seeded := []string{"t1", "t2", "t3", "t4"}
	wins := map[string][]string{
		"loadtest-w0": {"t1", "t3"},
		"loadtest-w1": {"t2"},
		"loadtest-w2": {"t4"},
	}
	states := doneStates(seeded, map[string]string{
		"t1": "loadtest-w0", "t2": "loadtest-w1", "t3": "loadtest-w0", "t4": "loadtest-w2",
	})
	counts := opCounts{ClaimsWon: 4, ClaimsLost409: 5, ClaimsLostStale: 1, ClaimAttempts: 10, Completed: 4}

	res := reconcile(seeded, wins, states, counts)
	if !res.OK {
		t.Fatalf("clean run should pass, got violations: %v", res.Violations)
	}
	if len(res.DoubleClaims) != 0 {
		t.Fatalf("clean run reported double-claims: %v", res.DoubleClaims)
	}
}

func TestReconcileDetectsPlantedDoubleClaim(t *testing.T) {
	seeded := []string{"t1", "t2"}
	// PLANTED violation: both workers believe they won t1.
	wins := map[string][]string{
		"loadtest-w0": {"t1", "t2"},
		"loadtest-w1": {"t1"},
	}
	states := doneStates(seeded, map[string]string{"t1": "loadtest-w0", "t2": "loadtest-w0"})
	counts := opCounts{ClaimsWon: 3, ClaimAttempts: 3, Completed: 3}

	res := reconcile(seeded, wins, states, counts)
	if res.OK {
		t.Fatal("planted double-claim was NOT detected")
	}
	if len(res.DoubleClaims) != 1 {
		t.Fatalf("expected exactly 1 double-claim, got %v", res.DoubleClaims)
	}
	dc := res.DoubleClaims[0]
	if dc.TaskID != "t1" || len(dc.Workers) != 2 {
		t.Fatalf("wrong double-claim identified: %+v", dc)
	}
	found := false
	for _, v := range res.Violations {
		if strings.Contains(v, "DOUBLE-CLAIM DETECTED") {
			found = true
		}
	}
	if !found {
		t.Fatalf("violations missing the DOUBLE-CLAIM message: %v", res.Violations)
	}
}

func TestReconcileDetectsSameWorkerWinningTwice(t *testing.T) {
	seeded := []string{"t1"}
	wins := map[string][]string{"loadtest-w0": {"t1", "t1"}}
	res := reconcile(seeded, wins, doneStates(seeded, nil), opCounts{ClaimsWon: 2, ClaimAttempts: 2, Completed: 2})
	if res.OK || len(res.DoubleClaims) != 1 {
		t.Fatalf("duplicate win by one worker not flagged: %+v", res)
	}
}

func TestReconcileDetectsUnclaimedAndNotDone(t *testing.T) {
	seeded := []string{"t1", "t2"}
	wins := map[string][]string{"loadtest-w0": {"t1"}}
	states := map[string]serverTaskState{
		"t1": {State: "done", ClaimedBy: "loadtest-w0"},
		"t2": {State: "approved"}, // never drained
	}
	counts := opCounts{ClaimsWon: 1, ClaimAttempts: 1, Completed: 1}
	res := reconcile(seeded, wins, states, counts)
	if res.OK {
		t.Fatal("undrained task should fail reconciliation")
	}
	joined := strings.Join(res.Violations, "\n")
	if !strings.Contains(joined, "never claimed") || !strings.Contains(joined, "expected done") {
		t.Fatalf("missing expected violations, got: %v", res.Violations)
	}
	if !strings.Contains(joined, "wins=1 but 2 tasks were seeded") {
		t.Fatalf("missing wins!=seeded violation, got: %v", res.Violations)
	}
}

func TestReconcileDetectsClaimantMismatchAndCountDrift(t *testing.T) {
	seeded := []string{"t1"}
	wins := map[string][]string{"loadtest-w0": {"t1"}}
	// Server credits a DIFFERENT worker than the client-side winner.
	states := map[string]serverTaskState{"t1": {State: "done", ClaimedBy: "loadtest-w9"}}
	// And the attempt arithmetic doesn't add up.
	counts := opCounts{ClaimsWon: 1, ClaimsLost409: 2, ClaimAttempts: 4, Completed: 1}
	res := reconcile(seeded, wins, states, counts)
	if res.OK {
		t.Fatal("claimant mismatch + count drift should fail")
	}
	joined := strings.Join(res.Violations, "\n")
	if !strings.Contains(joined, "claimedBy") {
		t.Fatalf("missing claimant-mismatch violation: %v", res.Violations)
	}
	if !strings.Contains(joined, "wins+losses=3 but attempts=4") {
		t.Fatalf("missing attempts-arithmetic violation: %v", res.Violations)
	}
}

func TestReconcileDetectsForeignWin(t *testing.T) {
	seeded := []string{"t1"}
	wins := map[string][]string{"loadtest-w0": {"t1", "not-ours"}}
	res := reconcile(seeded, wins, doneStates(seeded, nil), opCounts{ClaimsWon: 2, ClaimAttempts: 2, Completed: 2})
	if res.OK {
		t.Fatal("winning a non-seeded task should fail reconciliation")
	}
	if !strings.Contains(strings.Join(res.Violations, "\n"), "never seeded") {
		t.Fatalf("missing foreign-win violation: %v", res.Violations)
	}
}
