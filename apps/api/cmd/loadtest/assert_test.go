package main

import (
	"strings"
	"testing"
)

func findAssertion(t *testing.T, as []Assertion, target, source string) Assertion {
	t.Helper()
	for _, a := range as {
		if a.Target == target && a.Source == source {
			return a
		}
	}
	t.Fatalf("no %s assertion from %s in %+v", target, source, as)
	return Assertion{}
}

// baseResult is a scenario that comfortably meets every target, so each test
// below can break exactly one thing.
func baseResult() ScenarioResult {
	return ScenarioResult{
		Name:            "unit",
		Params:          Scenario{Agents: 64},
		MeasuredSeconds: 10,
		TaskOpsPerSec:   250,
		Ops: map[string]OpStat{
			opClaim:         {Count: 100, P95MS: 40},
			opQueueList:     {Count: 100, P95MS: 90},
			opTaskGet:       {Count: 100, P95MS: 90},
			opContextGet:    {Count: 100, P95MS: 200},
			opStatusPost:    {Count: 100, P95MS: 70},
			opClaimConflict: {Count: 300, P95MS: 40},
			opComplete:      {Count: 100, P95MS: 40},
		},
		Server: ServerView{
			Available: true, CountersAvailable: true, Windowed: true, WindowSeconds: 300,
			PercentilesAreWindowed: true,
			Routes: []ServerRoute{
				{Route: opRoutes[opClaim], Op: opClaim, P95MS: 30, WindowCount: 500, CountTotal: 500},
				{Route: opRoutes[opQueueList], Op: opQueueList, P95MS: 80, WindowCount: 100, CountTotal: 100},
				{Route: opRoutes[opTaskGet], Op: opTaskGet, P95MS: 80, WindowCount: 100, CountTotal: 100},
				{Route: opRoutes[opContextGet], Op: opContextGet, P95MS: 190, WindowCount: 100, CountTotal: 100},
				{Route: opRoutes[opStatusPost], Op: opStatusPost, P95MS: 60, WindowCount: 100, CountTotal: 100},
			},
		},
		Invariant: InvariantResult{DoubleClaimFree: true, OK: true, ClaimWins: 100},
	}
}

func TestEvaluateAllTargetsPass(t *testing.T) {
	as := evaluate(charterTargets(), baseResult())
	s := summarize(as)
	if s.Failed != 0 || s.Skipped != 0 {
		for _, a := range as {
			if a.Status != statusPass {
				t.Logf("non-pass: %+v", a)
			}
		}
		t.Fatalf("summary = %+v, want everything passing", s)
	}
	// Every latency target must be evaluated against BOTH views, never one.
	if got := len(as); got != 12 {
		t.Errorf("assertion count = %d, want 12 (5 latency × 2 views + throughput + invariant)", got)
	}
}

// The limits are the charter's. A test pins them so a future edit to the target
// table is a deliberate act with a failing test attached, not a quiet drift.
func TestCharterTargetLimits(t *testing.T) {
	want := map[string]float64{
		"task_claim_p95": 100, "queue_list_p95": 150, "task_get_p95": 150,
		"context_get_p95": 250, "status_post_p95": 100,
	}
	seen := map[string]bool{}
	for _, tg := range charterTargets() {
		switch tg.Kind {
		case kindLatencyP95:
			if w, ok := want[tg.ID]; !ok || tg.LimitMS != w {
				t.Errorf("target %s limit = %v, want %v", tg.ID, tg.LimitMS, want[tg.ID])
			}
			seen[tg.ID] = true
		case kindThroughput:
			if tg.MinPerSec != 100 {
				t.Errorf("throughput target = %v, want 100 task-ops/sec", tg.MinPerSec)
			}
		}
	}
	for id := range want {
		if !seen[id] {
			t.Errorf("charter target %s is missing", id)
		}
	}
}

func TestEvaluateLatencyFailsOnClientAndServerIndependently(t *testing.T) {
	res := baseResult()
	res.Ops[opClaim] = OpStat{Count: 100, P95MS: 640} // client misses
	as := evaluate(charterTargets(), res)
	if got := findAssertion(t, as, "task_claim_p95", "client").Status; got != statusFail {
		t.Errorf("client claim status = %s, want fail at 640ms vs a 100ms limit", got)
	}
	if got := findAssertion(t, as, "task_claim_p95", "server").Status; got != statusPass {
		t.Errorf("server claim status = %s, want pass — the two views are judged separately", got)
	}
}

// The boundary is inclusive: exactly at the limit passes.
func TestEvaluateLatencyBoundary(t *testing.T) {
	res := baseResult()
	res.Ops[opClaim] = OpStat{Count: 10, P95MS: 100}
	if got := findAssertion(t, evaluate(charterTargets(), res), "task_claim_p95", "client").Status; got != statusPass {
		t.Errorf("p95 exactly at the limit = %s, want pass", got)
	}
	res.Ops[opClaim] = OpStat{Count: 10, P95MS: 100.001}
	if got := findAssertion(t, evaluate(charterTargets(), res), "task_claim_p95", "client").Status; got != statusFail {
		t.Errorf("p95 just over the limit = %s, want fail", got)
	}
}

// An endpoint the server does not serve must SKIP, never pass. This is the
// assertion-side half of the SPA-fallback trap: a missing endpoint answers fast,
// and a naive framework would report the fastest PASS in the file.
func TestEvaluateUnavailableEndpointSkips(t *testing.T) {
	res := baseResult()
	res.Ops[opContextGet] = OpStat{Unavailable: true, Note: "not served by this build"}
	res.Server.Routes = res.Server.Routes[:3] // no context route either
	as := evaluate(charterTargets(), res)

	client := findAssertion(t, as, "context_get_p95", "client")
	if client.Status != statusSkipped {
		t.Fatalf("client status = %s, want skipped for a missing endpoint", client.Status)
	}
	if client.Observed != 0 || !strings.Contains(client.Note, "not served") {
		t.Errorf("skip carried no explanation: %+v", client)
	}
	if got := findAssertion(t, as, "context_get_p95", "server").Status; got != statusSkipped {
		t.Errorf("server status = %s, want skipped", got)
	}
	if summarize(as).Passed >= 12 {
		t.Error("a skipped target was counted as a pass")
	}
}

func TestEvaluateNoSamplesSkips(t *testing.T) {
	res := baseResult()
	res.Ops[opStatusPost] = OpStat{Count: 0, Errors: 12}
	a := findAssertion(t, evaluate(charterTargets(), res), "status_post_p95", "client")
	if a.Status != statusSkipped || !strings.Contains(a.Note, "12 errors") {
		t.Errorf("all-errors op = %+v, want a skip naming the error count", a)
	}
}

func TestEvaluateOpNeverAttemptedSkips(t *testing.T) {
	res := baseResult()
	delete(res.Ops, opContextGet)
	res.Server.Routes = nil
	a := findAssertion(t, evaluate(charterTargets(), res), "context_get_p95", "client")
	if a.Status != statusSkipped || !strings.Contains(a.Note, "never attempted") {
		t.Errorf("missing op = %+v, want a skip saying it was never attempted", a)
	}
}

func TestEvaluateServerViewUnavailableSkips(t *testing.T) {
	res := baseResult()
	res.Server = ServerView{Available: false}
	for _, target := range []string{"task_claim_p95", "queue_list_p95", "context_get_p95"} {
		a := findAssertion(t, evaluate(charterTargets(), res), target, "server")
		if a.Status != statusSkipped || !strings.Contains(a.Note, "/api/metrics") {
			t.Errorf("%s server assertion = %+v, want a skip naming the missing metrics endpoint", target, a)
		}
	}
}

// The shared-route caveat must be attached to the claim assertion, because the
// server literally cannot separate a claim from a complete: same method, same
// route pattern.
func TestServerClaimAssertionCarriesSharedRouteCaveat(t *testing.T) {
	a := findAssertion(t, evaluate(charterTargets(), baseResult()), "task_claim_p95", "server")
	if !strings.Contains(a.Note, "shared route") {
		t.Errorf("note = %q, want the shared-route caveat", a.Note)
	}
	if b := findAssertion(t, evaluate(charterTargets(), baseResult()), "queue_list_p95", "server"); strings.Contains(b.Note, "shared route") {
		t.Errorf("the caveat leaked onto a route that isn't shared: %q", b.Note)
	}
}

func TestEvaluateThroughput(t *testing.T) {
	res := baseResult()
	res.TaskOpsPerSec = 17.4
	a := findAssertion(t, evaluate(charterTargets(), res), "throughput", "client")
	if a.Status != statusFail {
		t.Fatalf("17.4 ops/sec against a 100 floor = %s, want fail", a.Status)
	}
	if !strings.Contains(a.Note, "concurrent agents") {
		t.Errorf("note = %q, want the offered-load caveat", a.Note)
	}
	if a.Observed != 17.4 || a.Limit != 100 {
		t.Errorf("observed/limit = %v/%v, want 17.4/100 recorded verbatim", a.Observed, a.Limit)
	}
}

// The invariant is not a latency target: it is the promise. It fails on any
// double-claim, and it is never softened by the state-hygiene checks.
func TestEvaluateInvariant(t *testing.T) {
	res := baseResult()
	res.Invariant = InvariantResult{DoubleClaimFree: false, OK: false, ClaimWins: 100,
		DoubleClaims: []DoubleClaim{{TaskID: "t1", Agents: []string{"a0", "a1"}, Kind: "claim"}}}
	a := findAssertion(t, evaluate(charterTargets(), res), "no_double_claims", "invariant")
	if a.Status != statusFail || a.Observed != 1 {
		t.Fatalf("invariant assertion = %+v, want fail with 1 double-claim observed", a)
	}
}

func TestEvaluateInvariantPassesWithUnrelatedViolations(t *testing.T) {
	res := baseResult()
	res.Invariant = InvariantResult{DoubleClaimFree: true, OK: false, ClaimWins: 100,
		Violations: []string{"task t9 was left executing"}}
	a := findAssertion(t, evaluate(charterTargets(), res), "no_double_claims", "invariant")
	if a.Status != statusPass {
		t.Fatalf("status = %s — a leaked claim must not be reported as a double-claim", a.Status)
	}
	if !strings.Contains(a.Note, "other violations") {
		t.Errorf("note = %q, want it to point at the other violations", a.Note)
	}
}

func TestEvaluateInvariantSkipsWithNoClaims(t *testing.T) {
	res := baseResult()
	res.Invariant = InvariantResult{DoubleClaimFree: true, OK: true, ClaimWins: 0}
	a := findAssertion(t, evaluate(charterTargets(), res), "no_double_claims", "invariant")
	if a.Status != statusSkipped {
		t.Errorf("status = %s, want skipped — a run that won no claims proves nothing", a.Status)
	}
}

// Two baselines have to diff line for line, which means the assertion table's
// order is part of the contract.
func TestEvaluateOrderIsDeterministic(t *testing.T) {
	first := evaluate(charterTargets(), baseResult())
	for i := 0; i < 20; i++ {
		next := evaluate(charterTargets(), baseResult())
		for j := range first {
			if first[j].Target != next[j].Target || first[j].Source != next[j].Source {
				t.Fatalf("assertion order changed at %d: %s/%s vs %s/%s",
					j, first[j].Target, first[j].Source, next[j].Target, next[j].Source)
			}
		}
	}
}

func TestSummarizeTallies(t *testing.T) {
	got := summarize([]Assertion{
		{Status: statusPass}, {Status: statusPass}, {Status: statusFail}, {Status: statusSkipped},
	})
	if got != (AssertionSummary{Passed: 2, Failed: 1, Skipped: 1}) {
		t.Errorf("summary = %+v", got)
	}
	if sum := got.add(AssertionSummary{Passed: 1, Failed: 1, Skipped: 1}); sum != (AssertionSummary{Passed: 3, Failed: 2, Skipped: 2}) {
		t.Errorf("add = %+v", sum)
	}
}
