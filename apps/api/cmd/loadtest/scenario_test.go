package main

import (
	"strings"
	"testing"
)

// ── Op mix ────────────────────────────────────────────────────────────────────

func TestPickWeightedBoundaries(t *testing.T) {
	choices := []weightedOp{{opQueueList, 1}, {opTaskGet, 1}, {opClaim, 2}}
	for _, tc := range []struct {
		r    float64
		want string
	}{
		{0, opQueueList}, {0.24, opQueueList},
		{0.25, opTaskGet}, {0.49, opTaskGet},
		{0.5, opClaim}, {0.999, opClaim},
		{-1, opQueueList}, {1.5, opClaim}, // out-of-range input is clamped, not a panic
	} {
		if got := pickWeighted(choices, tc.r); got != tc.want {
			t.Errorf("pickWeighted(r=%v) = %s, want %s", tc.r, got, tc.want)
		}
	}
}

// Weights are proportions, not probabilities: they need not sum to 1 or 100.
func TestPickWeightedRespectsProportions(t *testing.T) {
	counts := map[string]int{}
	choices := fleetMix.idleChoices()
	const n = 100000
	for i := 0; i < n; i++ {
		counts[pickWeighted(choices, float64(i)/n)]++
	}
	total := fleetMix.QueueList + fleetMix.TaskGet + fleetMix.ContextGet + fleetMix.Claim
	for _, c := range choices {
		want := float64(c.weight) / float64(total)
		got := float64(counts[c.op]) / n
		if diff := got - want; diff > 0.01 || diff < -0.01 {
			t.Errorf("%s share = %.3f, want ≈%.3f", c.op, got, want)
		}
	}
}

func TestPickWeightedZeroAndNegativeWeights(t *testing.T) {
	if got := pickWeighted([]weightedOp{{opClaim, 0}, {opTaskGet, 0}}, 0.5); got != "" {
		t.Errorf("all-zero mix = %q, want the empty no-preference answer", got)
	}
	if got := pickWeighted([]weightedOp{{opClaim, -5}, {opTaskGet, 3}}, 0.9); got != opTaskGet {
		t.Errorf("negative weight was selectable: got %s", got)
	}
	if got := pickWeighted(nil, 0.5); got != "" {
		t.Errorf("empty choice set = %q, want \"\"", got)
	}
}

// Every op the mix can choose must be an op the recorder knows about, or a
// scenario would drive traffic that never appears in the results file.
func TestMixChoicesAreKnownOps(t *testing.T) {
	known := map[string]bool{}
	for _, op := range taskOps {
		known[op] = true
	}
	for _, c := range append(fleetMix.idleChoices(), fleetMix.holdingChoices()...) {
		if !known[c.op] {
			t.Errorf("mix can choose %q, which is not in taskOps", c.op)
		}
	}
}

// ── Built-in scenarios ────────────────────────────────────────────────────────

// The contention property is the whole point: a claim benchmark with a queue
// deeper than the fleet measures nothing, because nobody ever races.
func TestBuiltinScenariosAreContended(t *testing.T) {
	for _, sc := range builtinScenarios() {
		if sc.QueueDepth >= sc.Agents {
			t.Errorf("%s: queue depth %d >= %d agents — claims would not contend",
				sc.Name, sc.QueueDepth, sc.Agents)
		}
		if sc.Rounds < 1 || sc.OpsPerAgentRound < 1 {
			t.Errorf("%s: rounds/ops must be >= 1, got %d/%d", sc.Name, sc.Rounds, sc.OpsPerAgentRound)
		}
		if sc.MaxProgressPerTask < 1 {
			t.Errorf("%s: MaxProgressPerTask %d would never post progress", sc.Name, sc.MaxProgressPerTask)
		}
	}
}

// Bounded by construction: this suite runs against shared infrastructure, so a
// scenario that could issue tens of thousands of ops is a bug, not a knob.
func TestBuiltinScenarioOpBudgetsAreBounded(t *testing.T) {
	for _, sc := range builtinScenarios() {
		if got := sc.PlannedOps(); got > 6000 {
			t.Errorf("%s plans %d ops — above the few-thousand band the suite commits to", sc.Name, got)
		}
	}
}

func TestBuiltinScenarioNames(t *testing.T) {
	for _, name := range []string{"agents-8", "agents-64", "agents-256"} {
		sc, ok := scenarioByName(name)
		if !ok {
			t.Fatalf("scenario %s missing", name)
		}
		if !strings.HasSuffix(name, itoa(sc.Agents)) {
			t.Errorf("%s declares %d agents", name, sc.Agents)
		}
	}
	if _, ok := scenarioByName("agents-9999"); ok {
		t.Error("unknown scenario resolved")
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// ── Scenario selection ────────────────────────────────────────────────────────

func TestResolveScenarios(t *testing.T) {
	custom := Scenario{Name: "custom", Agents: 4, QueueDepth: 2, Rounds: 1, OpsPerAgentRound: 3}

	all, err := resolveScenarios("all", custom)
	if err != nil || len(all) != 3 {
		t.Fatalf(`"all" = %d scenarios, err %v`, len(all), err)
	}
	pair, err := resolveScenarios("agents-8, agents-64", custom)
	if err != nil || len(pair) != 2 || pair[0].Name != "agents-8" || pair[1].Name != "agents-64" {
		t.Fatalf("comma list = %+v, err %v", pair, err)
	}
	if got, err := resolveScenarios("custom", custom); err != nil || len(got) != 1 || got[0].Agents != 4 {
		t.Fatalf("custom = %+v, err %v", got, err)
	}
	if _, err := resolveScenarios("nope", custom); err == nil {
		t.Error("unknown scenario name accepted")
	}
	if _, err := resolveScenarios("", custom); err == nil {
		t.Error("empty -scenarios accepted")
	}
	if _, err := resolveScenarios("custom", Scenario{Name: "custom"}); err == nil {
		t.Error("custom scenario with zeroed params accepted")
	}
}

// ── The escalation gate ───────────────────────────────────────────────────────

// Running 256 agents at a backend that already errored at 64 is how a benchmark
// turns into an incident. The gate is what stops it, so it gets tested.
func TestGateBlocksEscalationAfterErrors(t *testing.T) {
	dirty := ScenarioResult{Name: "agents-64", Ops: map[string]OpStat{
		opClaim: {Count: 90, Errors: 10},
	}}
	reason := gateReason(dirty, 0.01)
	if reason == "" {
		t.Fatal("a 10% error rate did not block the next scenario")
	}
	if !strings.Contains(reason, "error rate") {
		t.Errorf("reason = %q, want it to name the error rate", reason)
	}
}

func TestGateAllowsCleanRun(t *testing.T) {
	clean := ScenarioResult{Name: "agents-64", Ops: map[string]OpStat{opClaim: {Count: 500}}}
	if r := gateReason(clean, 0.01); r != "" {
		t.Errorf("a clean scenario blocked the next one: %s", r)
	}
}

func TestGateBlocksAfterAbortOrSkip(t *testing.T) {
	if r := gateReason(ScenarioResult{Name: "x", Aborted: true, AbortReason: "ceiling"}, 0.5); r == "" {
		t.Error("an aborted scenario did not block escalation")
	}
	if r := gateReason(ScenarioResult{Name: "x", Skipped: true}, 0.5); r == "" {
		t.Error("a skipped scenario did not block escalation")
	}
}

func TestErrorRate(t *testing.T) {
	r := ScenarioResult{Ops: map[string]OpStat{
		opClaim:     {Count: 70, Errors: 5},
		opQueueList: {Count: 25, Errors: 0},
	}}
	if got := r.errorRate(); got < 0.0499 || got > 0.0501 {
		t.Errorf("errorRate = %v, want 0.05", got)
	}
	if got := (ScenarioResult{}).errorRate(); got != 0 {
		t.Errorf("empty errorRate = %v, want 0", got)
	}
}

// ── Throughput accounting ─────────────────────────────────────────────────────

// Throughput is a claim about FLEET traffic. Harness work — seeding the queue,
// authenticating — must not inflate it.
func TestCountTaskOpsExcludesHarnessTraffic(t *testing.T) {
	ops := map[string]OpStat{
		opQueueList: {Count: 10}, opTaskGet: {Count: 5}, opContextGet: {Count: 3},
		opClaim: {Count: 7}, opClaimConflict: {Count: 20}, opClaimStale: {Count: 1},
		opStatusPost: {Count: 4}, opComplete: {Count: 7},
		opConnect: {Count: 64}, opSeedBatch: {Count: 5},
	}
	if got, want := countTaskOps(ops), 57; got != want {
		t.Errorf("countTaskOps = %d, want %d (connect and seed_batch excluded)", got, want)
	}
}

// ── Abort guard ───────────────────────────────────────────────────────────────

func TestGuardTripsOnErrorRate(t *testing.T) {
	rec := newRecorder()
	g := newGuard(rec, 0.10, 10_000*msDur)
	for i := 0; i < 40; i++ {
		rec.observe(opClaim, ms(5))
	}
	for i := 0; i < 20; i++ {
		rec.fail(opClaim, "a", errFake{})
	}
	g.check()
	if !g.tripped() {
		t.Fatal("33% errors over 60 ops did not trip the guard")
	}
	if !strings.Contains(g.why(), "error rate") {
		t.Errorf("reason = %q", g.why())
	}
}

func TestGuardIgnoresEarlyNoise(t *testing.T) {
	rec := newRecorder()
	g := newGuard(rec, 0.10, 10_000*msDur)
	// A couple of failures in the first handful of ops must not abort a run.
	rec.observe(opClaim, ms(5))
	rec.fail(opClaim, "a", errFake{})
	g.check()
	if g.tripped() {
		t.Fatalf("guard tripped on 2 ops: %s", g.why())
	}
}

func TestGuardTripsOnAbsoluteLatencyCeiling(t *testing.T) {
	rec := newRecorder()
	g := newGuard(rec, 0.9, 500*msDur)
	for i := 0; i < 25; i++ {
		rec.observe(opQueueList, ms(900))
	}
	g.check()
	if !g.tripped() {
		t.Fatal("a 900ms p95 against a 500ms ceiling did not trip the guard")
	}
	if !strings.Contains(g.why(), "ceiling") {
		t.Errorf("reason = %q", g.why())
	}
}

// The ceiling is absolute, not a multiple of the charter targets: a setup that
// misses the targets by design (localhost API, remote database) must still be
// able to produce a baseline instead of aborting on the first sample.
func TestGuardDoesNotTripMerelyForMissingTargets(t *testing.T) {
	rec := newRecorder()
	g := newGuard(rec, 0.10, 10_000*msDur)
	for i := 0; i < 100; i++ {
		rec.observe(opClaim, ms(600)) // 6× the 100ms claim target
	}
	g.check()
	if g.tripped() {
		t.Fatalf("guard aborted a run that was merely slower than target: %s", g.why())
	}
}

func TestGuardTripsOnce(t *testing.T) {
	rec := newRecorder()
	g := newGuard(rec, 0.5, 10*msDur)
	g.trip("first")
	g.trip("second")
	if g.why() != "first" {
		t.Errorf("reason = %q, want the first trip to win", g.why())
	}
}

const msDur = 1000000 // one millisecond in nanoseconds, as a time.Duration constant

type errFake struct{}

func (errFake) Error() string { return "fake" }
