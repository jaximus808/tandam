package main

import "fmt"

// The charter targets, and the machinery that decides pass/fail against them.
//
// Everything in this file is PURE: it turns a finished scenario's numbers into
// an assertion table. That separation is the point — the assertion framework is
// the durable deliverable, the numbers are whatever the run measured. A target
// is never adjusted to make a run pass; a run that misses is recorded as a miss,
// with the observed value next to the limit, so the gap is the thing being
// reported.

// Assertion statuses.
const (
	statusPass    = "pass"
	statusFail    = "fail"
	statusSkipped = "skipped"
)

// Target kinds.
const (
	kindLatencyP95    = "latency_p95"
	kindThroughput    = "throughput_min"
	kindNoDoubleClaim = "invariant_no_double_claim"
)

// Target is one charter commitment.
type Target struct {
	ID          string  `json:"id"`
	Kind        string  `json:"kind"`
	Op          string  `json:"op,omitempty"`
	LimitMS     float64 `json:"limit_ms,omitempty"`
	MinPerSec   float64 `json:"min_per_sec,omitempty"`
	Description string  `json:"description"`
}

// charterTargets are the numbers the coordination plane commits to. Server-side
// p95 is the authoritative reading (see serverview.go); the client-side reading
// is evaluated too and reported alongside, never instead.
func charterTargets() []Target {
	return []Target{
		{ID: "task_claim_p95", Kind: kindLatencyP95, Op: opClaim, LimitMS: 100,
			Description: "atomic task claim p95 < 100ms"},
		{ID: "queue_list_p95", Kind: kindLatencyP95, Op: opQueueList, LimitMS: 150,
			Description: "approved-queue read p95 < 150ms"},
		{ID: "task_get_p95", Kind: kindLatencyP95, Op: opTaskGet, LimitMS: 150,
			Description: "single task read p95 < 150ms"},
		{ID: "context_get_p95", Kind: kindLatencyP95, Op: opContextGet, LimitMS: 250,
			Description: "one-call connect bundle p95 < 250ms"},
		{ID: "status_post_p95", Kind: kindLatencyP95, Op: opStatusPost, LimitMS: 100,
			Description: "inbound status POST (the CI surface) p95 < 100ms"},
		{ID: "throughput", Kind: kindThroughput, MinPerSec: 100,
			Description: "sustained 100 task-ops/sec (queue reads, task reads, context reads, claims, conflicts, status posts and completes, over the measured window)"},
		{ID: "no_double_claims", Kind: kindNoDoubleClaim,
			Description: "ZERO double-claims: every task claimed and completed by exactly one agent"},
	}
}

// Assertion is one target evaluated against one view of one scenario.
type Assertion struct {
	Target   string  `json:"target"`
	Source   string  `json:"source"` // client | server | invariant
	Observed float64 `json:"observed"`
	Limit    float64 `json:"limit"`
	Unit     string  `json:"unit"`
	Samples  int     `json:"samples"`
	Status   string  `json:"status"`
	Note     string  `json:"note,omitempty"`
}

// evaluate produces the scenario's full assertion table: every latency target
// against both the client-side and the server-side reading, then throughput, then
// the invariant. Order is deterministic so two baselines diff line-for-line.
func evaluate(targets []Target, res ScenarioResult) []Assertion {
	var out []Assertion
	for _, t := range targets {
		switch t.Kind {
		case kindLatencyP95:
			out = append(out, evalClientLatency(t, res))
			out = append(out, evalServerLatency(t, res))
		case kindThroughput:
			out = append(out, evalThroughput(t, res))
		case kindNoDoubleClaim:
			out = append(out, evalInvariant(t, res))
		}
	}
	return out
}

func evalClientLatency(t Target, res ScenarioResult) Assertion {
	a := Assertion{Target: t.ID, Source: "client", Limit: t.LimitMS, Unit: "ms"}
	st, ok := res.Ops[t.Op]
	switch {
	case !ok:
		a.Status = statusSkipped
		a.Note = "op never attempted in this scenario"
	case st.Unavailable:
		a.Status = statusSkipped
		a.Note = st.Note
	case st.Count == 0:
		a.Status = statusSkipped
		a.Note = fmt.Sprintf("no successful samples (%d errors)", st.Errors)
	default:
		a.Observed = st.P95MS
		a.Samples = st.Count
		a.Status = passFail(st.P95MS <= t.LimitMS)
	}
	return a
}

func evalServerLatency(t Target, res ScenarioResult) Assertion {
	a := Assertion{Target: t.ID, Source: "server", Limit: t.LimitMS, Unit: "ms"}
	p95, ok := res.Server.serverP95(t.Op)
	if !ok {
		a.Status = statusSkipped
		if !res.Server.Available {
			a.Note = "GET /api/metrics unavailable — no server-side view"
		} else {
			a.Note = "the server reported no samples for this op's route — it either never served the route (endpoint absent on this build) or saw no traffic on it inside the metrics window"
		}
		return a
	}
	a.Observed = p95
	a.Status = passFail(p95 <= t.LimitMS)
	a.Note = "server-side percentiles are windowed over ALL traffic the process served, not only this scenario"
	if route, has := opRoutes[t.Op]; has && route == opRoutes[opClaim] {
		a.Note = joinNotes(a.Note, sharedRouteNote)
	}
	for _, r := range res.Server.Routes {
		if r.Op == t.Op {
			a.Samples = r.WindowCount
		}
	}
	return a
}

func evalThroughput(t Target, res ScenarioResult) Assertion {
	a := Assertion{Target: t.ID, Source: "client", Limit: t.MinPerSec, Unit: "ops/sec",
		Observed: res.TaskOpsPerSec, Samples: countTaskOps(res.Ops)}
	if res.MeasuredSeconds <= 0 {
		a.Status = statusSkipped
		a.Note = "no measured window"
		return a
	}
	a.Status = passFail(res.TaskOpsPerSec >= t.MinPerSec)
	// Offered load, not capacity: a scenario cannot exceed agents ÷ mean-latency
	// ops/sec no matter how fast the server is, so a small-fleet scenario can
	// miss this target while the server is nowhere near saturated. Stated, not
	// silently excused — the assertion is still evaluated and still reported.
	a.Note = fmt.Sprintf("offered load is bounded by %d concurrent agents; a miss here may be a load-generator limit rather than a server limit", res.Params.Agents)
	return a
}

func evalInvariant(t Target, res ScenarioResult) Assertion {
	a := Assertion{Target: t.ID, Source: "invariant", Limit: 0, Unit: "double-claims",
		Observed: float64(len(res.Invariant.DoubleClaims)), Samples: res.Invariant.ClaimWins}
	if res.Invariant.ClaimWins == 0 {
		a.Status = statusSkipped
		a.Note = "no claims were won — nothing to prove"
		return a
	}
	a.Status = passFail(res.Invariant.DoubleClaimFree)
	if !res.Invariant.OK && res.Invariant.DoubleClaimFree {
		a.Note = "no double-claims, but the state reconciliation found other violations (see invariant.violations)"
	}
	return a
}

func passFail(ok bool) string {
	if ok {
		return statusPass
	}
	return statusFail
}

// summarize tallies an assertion table.
func summarize(assertions []Assertion) AssertionSummary {
	var s AssertionSummary
	for _, a := range assertions {
		switch a.Status {
		case statusPass:
			s.Passed++
		case statusFail:
			s.Failed++
		default:
			s.Skipped++
		}
	}
	return s
}

// AssertionSummary is the pass/fail tally for one scenario or for a whole run.
type AssertionSummary struct {
	Passed  int `json:"passed"`
	Failed  int `json:"failed"`
	Skipped int `json:"skipped"`
}

func (s AssertionSummary) add(o AssertionSummary) AssertionSummary {
	return AssertionSummary{Passed: s.Passed + o.Passed, Failed: s.Failed + o.Failed, Skipped: s.Skipped + o.Skipped}
}
