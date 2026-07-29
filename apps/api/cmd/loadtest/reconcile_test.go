package main

import (
	"strings"
	"testing"
)

// The invariant checker is the one piece of this tool that must never be wrong:
// it is what turns "zero double-claims" into a testable claim. Every test below
// builds evidence by hand, including evidence that is deliberately broken, so a
// future refactor cannot quietly relax the check.

func done(agent string) serverTaskState {
	return serverTaskState{State: "done", ClaimedBy: agent}
}

func opsFor(wins, completes int) map[string]OpStat {
	return map[string]OpStat{
		opClaim:    {Count: wins},
		opComplete: {Count: completes},
	}
}

func TestInvariantCleanRun(t *testing.T) {
	seeded := []string{"t1", "t2", "t3"}
	claims := map[string][]string{"a0": {"t1", "t3"}, "a1": {"t2"}}
	completes := map[string][]string{"a0": {"t1", "t3"}, "a1": {"t2"}}
	states := map[string]serverTaskState{"t1": done("a0"), "t2": done("a1"), "t3": done("a0")}

	res := checkInvariant(seeded, claims, completes, states, opsFor(3, 3))
	if !res.DoubleClaimFree || !res.OK {
		t.Fatalf("clean run reported dirty: %+v", res)
	}
	if res.ClaimWins != 3 || res.Completions != 3 || res.TasksDone != 3 {
		t.Errorf("counts = %d wins / %d completions / %d done, want 3/3/3", res.ClaimWins, res.Completions, res.TasksDone)
	}
}

// THE failure the product promises cannot happen: two agents winning the same
// claim. It must be caught from the client-side evidence alone — the server row
// only remembers the last writer, so waiting for the server to disagree would
// miss it entirely.
func TestInvariantCatchesDoubleClaim(t *testing.T) {
	seeded := []string{"t1"}
	claims := map[string][]string{"a0": {"t1"}, "a1": {"t1"}}
	completes := map[string][]string{"a0": {"t1"}}
	states := map[string]serverTaskState{"t1": done("a0")}

	res := checkInvariant(seeded, claims, completes, states, opsFor(2, 1))
	if res.DoubleClaimFree {
		t.Fatal("a task won by two agents was reported double-claim-free")
	}
	if res.OK {
		t.Error("OK stayed true with a double claim")
	}
	if len(res.DoubleClaims) != 1 || res.DoubleClaims[0].Kind != "claim" {
		t.Fatalf("double claims = %+v, want one of kind claim", res.DoubleClaims)
	}
	if got := res.DoubleClaims[0].Agents; len(got) != 2 || got[0] != "a0" || got[1] != "a1" {
		t.Errorf("agents = %v, want [a0 a1] in sorted order", got)
	}
}

// The sharper form: two agents both drove the same task to done.
func TestInvariantCatchesDoubleCompletion(t *testing.T) {
	seeded := []string{"t1"}
	claims := map[string][]string{"a0": {"t1"}, "a1": {"t1"}}
	completes := map[string][]string{"a0": {"t1"}, "a1": {"t1"}}
	res := checkInvariant(seeded, claims, completes, map[string]serverTaskState{"t1": done("a1")}, opsFor(2, 2))

	kinds := map[string]bool{}
	for _, dc := range res.DoubleClaims {
		kinds[dc.Kind] = true
	}
	if !kinds["claim"] || !kinds["complete"] {
		t.Fatalf("double claims = %+v, want both a claim and a complete violation", res.DoubleClaims)
	}
}

// One agent recording the same win twice is a double-claim too: a done task
// cannot be re-claimed, so a repeat can only mean the atomic claim handed the
// same task out twice.
func TestInvariantCatchesSelfDoubleClaim(t *testing.T) {
	res := checkInvariant([]string{"t1"},
		map[string][]string{"a0": {"t1", "t1"}},
		map[string][]string{"a0": {"t1"}},
		map[string]serverTaskState{"t1": done("a0")}, opsFor(2, 1))
	if res.DoubleClaimFree {
		t.Fatal("the same agent winning one task twice was not flagged")
	}
}

func TestInvariantCompletionWithoutClaim(t *testing.T) {
	res := checkInvariant([]string{"t1"},
		map[string][]string{"a0": {"t1"}},
		map[string][]string{"a1": {"t1"}}, // a1 never won it
		map[string]serverTaskState{"t1": done("a1")}, opsFor(1, 1))
	if res.OK {
		t.Fatal("a completion by a non-claimant was accepted")
	}
	if !res.DoubleClaimFree {
		t.Error("this is a provenance violation, not a double claim — the two must stay distinguishable")
	}
	assertViolation(t, res, "without ever winning its claim")
}

// A task left executing means a claim leaked. That is a real problem, but it is
// NOT a double-claim, and the report must keep the two apart so a leak can never
// be mistaken for a broken core promise (or vice versa).
func TestInvariantLeftExecutingIsNotADoubleClaim(t *testing.T) {
	res := checkInvariant([]string{"t1"},
		map[string][]string{"a0": {"t1"}},
		map[string][]string{},
		map[string]serverTaskState{"t1": {State: "executing", ClaimedBy: "a0"}}, opsFor(1, 0))
	if res.OK {
		t.Fatal("a leaked claim was accepted")
	}
	if !res.DoubleClaimFree {
		t.Fatal("a leaked claim was misreported as a double claim")
	}
	if res.TasksExecuting != 1 {
		t.Errorf("tasks_executing = %d, want 1", res.TasksExecuting)
	}
	assertViolation(t, res, "left executing")
}

// The client and the server must AGREE on who did the work. A server row naming
// a different claimant than the agent that completed it is exactly the shape a
// claim-overwrite bug would take.
func TestInvariantClaimantDisagreement(t *testing.T) {
	res := checkInvariant([]string{"t1"},
		map[string][]string{"a0": {"t1"}},
		map[string][]string{"a0": {"t1"}},
		map[string]serverTaskState{"t1": done("somebody-else")}, opsFor(1, 1))
	if res.OK {
		t.Fatal("client/server claimant disagreement was accepted")
	}
	assertViolation(t, res, "server recorded claimedBy")
}

func TestInvariantDoneWithNoCompleter(t *testing.T) {
	res := checkInvariant([]string{"t1"}, map[string][]string{}, map[string][]string{},
		map[string]serverTaskState{"t1": done("ghost")}, opsFor(0, 0))
	if res.OK {
		t.Fatal("a task that finished with nobody claiming credit was accepted")
	}
	assertViolation(t, res, "no agent recorded completing it")
}

// Tasks the run never got to are fine — the op budget is bounded, so a leftover
// approved queue is expected, not a failure.
func TestInvariantUnclaimedTasksAreFine(t *testing.T) {
	res := checkInvariant([]string{"t1", "t2"},
		map[string][]string{"a0": {"t1"}},
		map[string][]string{"a0": {"t1"}},
		map[string]serverTaskState{"t1": done("a0"), "t2": {State: "approved"}}, opsFor(1, 1))
	if !res.OK {
		t.Fatalf("an untouched approved task was treated as a violation: %v", res.Violations)
	}
	if res.TasksApproved != 1 {
		t.Errorf("tasks_approved = %d, want 1", res.TasksApproved)
	}
}

func TestInvariantApprovedTaskWithAWinner(t *testing.T) {
	res := checkInvariant([]string{"t1"},
		map[string][]string{"a0": {"t1"}},
		map[string][]string{},
		map[string]serverTaskState{"t1": {State: "approved"}}, opsFor(1, 0))
	if res.OK {
		t.Fatal("a task back in the queue that an agent thinks it won was accepted")
	}
	assertViolation(t, res, "back in the queue")
}

func TestInvariantForeignTask(t *testing.T) {
	res := checkInvariant([]string{"t1"},
		map[string][]string{"a0": {"t1", "not-ours"}},
		map[string][]string{"a0": {"t1"}},
		map[string]serverTaskState{"t1": done("a0")}, opsFor(2, 1))
	if res.OK {
		t.Fatal("claiming a task this run never seeded was accepted")
	}
	assertViolation(t, res, "never seeded")
}

func TestInvariantMissingServerState(t *testing.T) {
	res := checkInvariant([]string{"t1"},
		map[string][]string{"a0": {"t1"}}, map[string][]string{"a0": {"t1"}},
		map[string]serverTaskState{}, opsFor(1, 1))
	if res.OK {
		t.Fatal("a seeded task with no server state was accepted")
	}
	assertViolation(t, res, "no server state")
}

// The recorder and the agents' own win sets are two independent tallies of the
// same events; if they disagree the numbers in the results file are not
// trustworthy, whatever they say about double claims.
func TestInvariantOpCountsMustAgree(t *testing.T) {
	res := checkInvariant([]string{"t1"},
		map[string][]string{"a0": {"t1"}}, map[string][]string{"a0": {"t1"}},
		map[string]serverTaskState{"t1": done("a0")},
		map[string]OpStat{opClaim: {Count: 7}, opComplete: {Count: 1}})
	if res.OK {
		t.Fatal("a recorder/win-set count mismatch was accepted")
	}
	assertViolation(t, res, "recorder counted 7 winning claims")
}

// states may be nil in a run that never got far enough to read them back.
func TestInvariantNilStatesStillChecksOverlap(t *testing.T) {
	res := checkInvariant([]string{"t1"},
		map[string][]string{"a0": {"t1"}, "a1": {"t1"}},
		map[string][]string{}, nil, nil)
	if res.DoubleClaimFree {
		t.Fatal("overlap detection must not depend on server state being available")
	}
}

// ── Cross-check against the server's own counters ─────────────────────────────

func TestCrossCheckExactAgreement(t *testing.T) {
	inv := InvariantResult{ClaimWins: 40}
	view := ServerView{Available: true, CountersAvailable: true, ClaimsDelta: 40, ClaimConflictsDelta: 133}
	cc := crossCheckClaims(inv, view, map[string]OpStat{opClaimConflict: {Count: 133}})
	if !cc.Available || !cc.ClaimsAgree || !cc.ConflictsAgree {
		t.Fatalf("exact agreement not recognised: %+v", cc)
	}
	if !strings.Contains(cc.Note, "exact agreement") {
		t.Errorf("note = %q, want it to say the instruments agree", cc.Note)
	}
}

func TestCrossCheckServerCountedMore(t *testing.T) {
	cc := crossCheckClaims(
		InvariantResult{ClaimWins: 10},
		ServerView{Available: true, CountersAvailable: true, ClaimsDelta: 12, ClaimConflictsDelta: 5},
		map[string]OpStat{opClaimConflict: {Count: 5}})
	if cc.ClaimsAgree {
		t.Error("12 server claims vs 10 client wins reported as agreement")
	}
	if !strings.Contains(cc.Note, "MORE") {
		t.Errorf("note = %q, want the innocent explanation for a shared server", cc.Note)
	}
}

// The one that matters: the server counting FEWER claims than the benchmark
// observed on the wire cannot be explained by other traffic.
func TestCrossCheckServerCountedFewer(t *testing.T) {
	cc := crossCheckClaims(
		InvariantResult{ClaimWins: 10},
		ServerView{Available: true, CountersAvailable: true, ClaimsDelta: 8, ClaimConflictsDelta: 5},
		map[string]OpStat{opClaimConflict: {Count: 5}})
	if !strings.Contains(cc.Note, "real divergence") {
		t.Errorf("note = %q, want it flagged as a real divergence", cc.Note)
	}
}

func TestCrossCheckUnavailableCounters(t *testing.T) {
	cc := crossCheckClaims(
		InvariantResult{ClaimWins: 10},
		ServerView{Available: true, CountersAvailable: false},
		map[string]OpStat{opClaimConflict: {Count: 5}})
	if cc.Available {
		t.Fatal("cross-check reported available with no server counters")
	}
	if cc.ClientClaimWins != 10 || cc.ClientConflicts != 5 {
		t.Errorf("client-side numbers lost: %+v", cc)
	}
	if cc.ClaimsAgree || cc.ConflictsAgree {
		t.Error("agreement must not be asserted when there is nothing to compare against")
	}
	if !strings.Contains(cc.Note, "TDM-42") {
		t.Errorf("note = %q, want it to name why the cross-check is missing", cc.Note)
	}
}

func assertViolation(t *testing.T, res InvariantResult, want string) {
	t.Helper()
	for _, v := range res.Violations {
		if strings.Contains(v, want) {
			return
		}
	}
	t.Fatalf("no violation mentioning %q; got %v", want, res.Violations)
}
