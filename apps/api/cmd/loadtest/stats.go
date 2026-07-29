package main

import (
	"math"
	"sort"
	"sync"
	"time"
)

// ── Op vocabulary ─────────────────────────────────────────────────────────────
//
// One string per HTTP call an agent session makes. These names are the KEYS of
// the results file's per-op tables and of the charter target table, so they are
// part of the file's stable schema — renaming one breaks the diff between two
// baselines. Add, don't rename.
const (
	opConnect       = "connect"        // POST /api/mcp/auth (once per agent)
	opQueueList     = "queue_list"     // GET  /api/canvas/actions?type=task&state=approved
	opTaskGet       = "task_get"       // GET  /api/canvas/actions/{id}
	opContextGet    = "context_get"    // GET  /api/canvas/context
	opClaim         = "task_claim"     // PATCH /api/canvas/actions/{id} → 200 (won)
	opClaimConflict = "claim_conflict" // PATCH /api/canvas/actions/{id} → 409 already_claimed
	opClaimStale    = "claim_stale"    // PATCH /api/canvas/actions/{id} → 400 (left approved)
	opStatusPost    = "status_post"    // POST /api/canvas/{code}/tasks/{id}/status
	opComplete      = "task_complete"  // PATCH /api/canvas/actions/{id} → done
	opSeedBatch     = "seed_batch"     // POST /api/canvas/actions/batch (harness, not an agent op)
)

// taskOps are the ops that count toward the charter's "sustained 100 task-ops/sec"
// throughput target: everything an agent session does against the queue during
// the measured window. Harness work (seeding, cleanup, reconciliation reads) is
// deliberately excluded — it is not fleet traffic.
var taskOps = []string{
	opQueueList, opTaskGet, opContextGet,
	opClaim, opClaimConflict, opClaimStale,
	opStatusPost, opComplete,
}

// ── Recording ─────────────────────────────────────────────────────────────────

// OpStat is one op's row in the results file.
//
// Latency percentiles cover SUCCESSFUL calls only: a call that failed (transport
// error, unexpected status) says nothing about how fast the server serves that
// op, and folding a 30s timeout into p95 would quietly turn an availability
// problem into a latency problem. Errors get their own count.
type OpStat struct {
	Count  int     `json:"count"`
	Errors int     `json:"errors"`
	P50MS  float64 `json:"p50_ms"`
	P95MS  float64 `json:"p95_ms"`
	P99MS  float64 `json:"p99_ms"`
	MaxMS  float64 `json:"max_ms"`
	// Unavailable marks an op whose endpoint this server build does not serve.
	// Tandem's router falls through to the SPA for unknown paths, so a missing
	// endpoint answers 200 with HTML in ~5ms — which would otherwise be recorded
	// as a spectacularly fast success and turn a missing feature into a PASS.
	Unavailable bool   `json:"unavailable,omitempty"`
	Note        string `json:"note,omitempty"`
}

// ErrSample is one recorded failure, kept for the results file so a run with a
// non-zero error count says WHAT went wrong without a re-run.
type ErrSample struct {
	Op    string `json:"op"`
	Agent string `json:"agent"`
	Error string `json:"error"`
}

const maxErrSamples = 25

type opSeries struct {
	samples     []time.Duration
	errors      int
	unavailable bool
	note        string
}

// recorder collects per-op latency samples and error counts from every agent.
// One mutex is plenty at benchmark scale — the lock is nanoseconds against
// network calls that are milliseconds.
type recorder struct {
	mu     sync.Mutex
	series map[string]*opSeries
	errs   []ErrSample
	errN   int
}

func newRecorder() *recorder { return &recorder{series: map[string]*opSeries{}} }

func (r *recorder) at(op string) *opSeries {
	s, ok := r.series[op]
	if !ok {
		s = &opSeries{}
		r.series[op] = s
	}
	return s
}

// observe records one successful call.
func (r *recorder) observe(op string, d time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.at(op)
	s.samples = append(s.samples, d)
}

// fail records one failed call. The sample is NOT added to the latency series.
func (r *recorder) fail(op, agent string, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.at(op).errors++
	r.errN++
	if len(r.errs) < maxErrSamples {
		r.errs = append(r.errs, ErrSample{Op: op, Agent: agent, Error: err.Error()})
	}
}

// markUnavailable flags an op whose endpoint this server build doesn't serve.
// Idempotent: the first agent to discover it wins, the rest are no-ops.
func (r *recorder) markUnavailable(op, note string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.at(op)
	s.unavailable = true
	s.note = note
}

func (r *recorder) isUnavailable(op string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.series[op]
	return ok && s.unavailable
}

func (r *recorder) errorCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.errN
}

// successCount returns how many successful calls have been recorded across the
// given ops. Used by the abort watchdog and by the throughput number.
func (r *recorder) successCount(ops ...string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, op := range ops {
		if s, ok := r.series[op]; ok {
			n += len(s.samples)
		}
	}
	return n
}

func (r *recorder) errSamples() []ErrSample {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]ErrSample, len(r.errs))
	copy(out, r.errs)
	return out
}

// snapshot summarizes every op recorded so far. Ops that were never attempted
// are omitted; ops flagged unavailable appear with count 0 and the flag set, so
// the results file distinguishes "never ran" from "endpoint not there".
func (r *recorder) snapshot() map[string]OpStat {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]OpStat, len(r.series))
	for op, s := range r.series {
		out[op] = OpStat{
			Count:       len(s.samples),
			Errors:      s.errors,
			P50MS:       durMS(percentile(s.samples, 50)),
			P95MS:       durMS(percentile(s.samples, 95)),
			P99MS:       durMS(percentile(s.samples, 99)),
			MaxMS:       durMS(percentile(s.samples, 100)),
			Unavailable: s.unavailable,
			Note:        s.note,
		}
	}
	return out
}

// ── Percentiles ───────────────────────────────────────────────────────────────

// percentile computes the p-th percentile (nearest-rank on a sorted copy),
// matching internal/metrics so client-side and server-side numbers in the same
// results file are computed the same way. p is in [0,100]; an empty sample set
// yields 0.
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
	rank := int(math.Ceil((p / 100) * float64(len(sorted))))
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}

func sortDurations(in []time.Duration) []time.Duration {
	out := make([]time.Duration, len(in))
	copy(out, in)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func durMS(d time.Duration) float64 {
	// Round to 3 decimals so two runs of the same shape diff on real change
	// rather than on float noise in the last digits.
	return math.Round(float64(d)/float64(time.Millisecond)*1000) / 1000
}
