// Package metrics collects in-memory operational aggregates for the API:
// per-route request latency, per-op latency (WebSocket broadcast fan-out),
// process counters for the task-queue contention signals (claims, claim
// conflicts, TTL takeovers) and webhook delivery outcomes, plus pull-style
// gauges (connected WS clients). Everything is exposed as JSON by Handler.
//
// Scope is deliberately tiny: no external deps, no persistence, no exporter
// protocol. The charter's requirement is "numbers from day one" — agents push
// work at Tandem continuously, and if it is slow it gets dropped, so every
// future latency claim (batching, broadcast changes, store tuning) can be
// measured instead of guessed at.
//
// # Privacy
//
// GET /api/metrics is OPEN by design, so nothing canvas-shaped may ever reach
// this package: route keys are chi ROUTE PATTERNS (/api/canvas/actions/{id}),
// never concrete ids; counters are process-wide scalars; gauges are counts. No
// canvas id, code, name, agent name or payload is recorded anywhere here.
//
// # Nil safety
//
// Every exported method tolerates a nil *Registry, so a metrics-disabled
// deployment wires nil through the hub, the webhook worker and the API handlers
// and each call site stays a plain unconditional call (the same shape as the
// webhooks Emitter seam). A nil Registry boxed into an interface is safe too:
// the methods, not the callers, do the nil check.
package metrics

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
)

// sampleCap bounds per-series memory: the most recent sampleCap observations.
//
// Tradeoff — ring buffer vs reservoir: we use a fixed-size RING BUFFER rather
// than a uniform reservoir over all-time samples. A reservoir gives
// statistically unbiased percentiles since boot, but that is the wrong bias for
// operations: after a deploy or a perf fix we want the numbers to reflect
// *current* behavior quickly, and a since-boot reservoir dilutes recent samples
// more the longer the process lives. The ring is recency-weighted by
// construction, O(1) to record, allocation-free, and trivially bounded.
//
// MEMORY BOUND: one series is sampleCap × sizeof(sample) = 1024 × 16 B = 16 KiB,
// allocated lazily on that series' first observation and never grown. Series are
// bounded by the number of (method, route pattern) pairs the router declares
// (~200 today) plus a handful of named ops, so the whole registry is bounded at
// roughly 200 × 16 KiB ≈ 3.2 MiB in the worst case where every route is hit.
// Nothing here is keyed by anything a request can vary, so the cardinality
// cannot be pushed up from outside.
const sampleCap = 1024

// DefaultWindow is the recency window for percentiles.
//
// The window is DUAL-BOUNDED — last sampleCap samples AND last DefaultWindow of
// wall time — because each bound alone goes stale in a different direction. A
// pure sample ring lets a low-traffic route report percentiles from samples
// hours old (the "all-time percentile" problem, just slower); a pure time window
// is unbounded in memory for a hot route. Taking both gives "the recent past,
// capped": at most 1024 samples, none older than 5 minutes.
//
// Count and max are deliberately NOT windowed — they are scalars, so they cost
// no memory, and "how many requests has this process served" / "what is the
// worst we have ever seen" are both since-boot questions.
const DefaultWindow = 5 * time.Minute

// OpBroadcastFanout is the op key for WebSocket broadcast fan-out duration —
// how long the hub spends handing one canvas broadcast to every connected
// client. It is the number that decides whether a 100k-lines/min agent fleet
// feels live or laggy, and it is invisible to the HTTP middleware (the hub loop
// is off the request path).
const OpBroadcastFanout = "broadcast_fanout_ms"

// Webhook delivery outcomes, as reported by the delivery worker.
const (
	WebhookOutcomeOK     = "ok"
	WebhookOutcomeFailed = "failed"
	WebhookOutcomeDead   = "dead"
)

// sample is one observation: latency in milliseconds plus the wall clock at
// which it was taken (unix nanos), so the snapshot can drop stale samples.
// 16 bytes, no padding.
type sample struct {
	ms float64
	at int64
}

// histogram is a bounded ring of recent samples for one series.
//
// Locking: each histogram owns its own mutex, and the registry's map lock is
// only held (shared) long enough to find the histogram. Two different routes
// therefore never contend, and record() under the histogram lock is a handful
// of scalar writes with no allocation and no syscall. Percentiles are computed
// at SNAPSHOT time (sort a copy) rather than maintained on write, which is the
// whole reason the hot path can stay this cheap.
type histogram struct {
	mu      sync.Mutex
	count   uint64 // all observations since boot
	maxMS   float64
	samples [sampleCap]sample
	idx     int  // next write position
	filled  bool // true once the ring has wrapped
}

func (h *histogram) record(ms float64, at int64) {
	h.mu.Lock()
	h.count++
	if ms > h.maxMS {
		h.maxMS = ms
	}
	h.samples[h.idx] = sample{ms: ms, at: at}
	h.idx++
	if h.idx == sampleCap {
		h.idx = 0
		h.filled = true
	}
	h.mu.Unlock()
}

// summarize returns the percentile summary over samples at or after cutoff.
func (h *histogram) summarize(cutoff int64) Summary {
	h.mu.Lock()
	n := h.idx
	if h.filled {
		n = sampleCap
	}
	window := make([]float64, 0, n)
	for i := 0; i < n; i++ {
		if s := h.samples[i]; s.at >= cutoff {
			window = append(window, s.ms)
		}
	}
	out := Summary{Count: h.count, MaxMS: h.maxMS, WindowCount: len(window)}
	h.mu.Unlock()

	if len(window) > 0 {
		sort.Float64s(window)
		out.P50MS = percentile(window, 0.50)
		out.P95MS = percentile(window, 0.95)
		out.P99MS = percentile(window, 0.99)
	}
	return out
}

// counters are the process-wide event tallies. Plain atomics: incrementing one
// is a single lock-free add on the hot path (a task claim, a webhook delivery),
// with no interaction with the histogram locks.
type counters struct {
	claims         atomic.Uint64
	claimConflicts atomic.Uint64
	ttlExpiries    atomic.Uint64
	webhookOK      atomic.Uint64
	webhookFailed  atomic.Uint64
	webhookDead    atomic.Uint64
}

// routeKey identifies one latency series. A STRUCT key rather than a
// concatenated "METHOD path" string on purpose: building that string would be a
// heap allocation on every single request, which is exactly the overhead this
// package must not add. Hashing a two-string struct allocates nothing.
type routeKey struct {
	method string
	route  string
}

// Registry aggregates everything /api/metrics reports. Safe for concurrent use.
type Registry struct {
	mu     sync.RWMutex
	routes map[routeKey]*histogram
	ops    map[string]*histogram // key: op name (e.g. broadcast_fanout_ms)
	gauges map[string]func() int // pull-style gauges, read at snapshot time

	counts    counters
	startedAt time.Time
	window    time.Duration

	// now is the clock. A field rather than a direct time.Now call so the
	// in-package tests can drive the recency window deterministically.
	now func() time.Time
}

func NewRegistry() *Registry {
	return &Registry{
		routes:    make(map[routeKey]*histogram),
		ops:       make(map[string]*histogram),
		gauges:    make(map[string]func() int),
		startedAt: time.Now(),
		window:    DefaultWindow,
		now:       time.Now,
	}
}

// series finds (or creates) the histogram for key in m. The steady state is the
// first branch — a shared-lock map read and nothing else; the exclusive path is
// walked once per key, per process, because the key space is the router's fixed
// set of patterns.
func series[K comparable](reg *Registry, m map[K]*histogram, key K) *histogram {
	reg.mu.RLock()
	h, ok := m[key]
	reg.mu.RUnlock()
	if ok {
		return h
	}
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if h, ok := m[key]; ok {
		return h
	}
	h = &histogram{}
	m[key] = h
	return h
}

// Record adds one observation for the given method + route PATTERN.
func (reg *Registry) Record(method, route string, d time.Duration) {
	if reg == nil || route == "" {
		return
	}
	series(reg, reg.routes, routeKey{method: method, route: route}).record(msOf(d), reg.now().UnixNano())
}

// RecordOp adds one observation for a named non-HTTP operation.
func (reg *Registry) RecordOp(op string, d time.Duration) {
	if reg == nil || op == "" {
		return
	}
	series(reg, reg.ops, op).record(msOf(d), reg.now().UnixNano())
}

// ObserveBroadcast records one WebSocket broadcast fan-out duration. It is the
// method ws.Hub's Observer seam calls, so the hub never imports this package.
func (reg *Registry) ObserveBroadcast(d time.Duration) { reg.RecordOp(OpBroadcastFanout, d) }

// RegisterGauge attaches a pull-style gauge, read once per snapshot. Pull (not
// push) because the authoritative number lives in the component that owns it —
// the hub knows exactly how many clients are connected, and a pushed counter
// would drift on every missed unregister.
func (reg *Registry) RegisterGauge(name string, fn func() int) {
	if reg == nil || name == "" || fn == nil {
		return
	}
	reg.mu.Lock()
	reg.gauges[name] = fn
	reg.mu.Unlock()
}

// IncClaim counts a task claim that actually changed (or confirmed) ownership.
func (reg *Registry) IncClaim() {
	if reg != nil {
		reg.counts.claims.Add(1)
	}
}

// IncClaimConflict counts a claim lost to a rival holder — the contention
// signal. A fleet whose conflict rate climbs is a fleet doing duplicate work.
func (reg *Registry) IncClaimConflict() {
	if reg != nil {
		reg.counts.claimConflicts.Add(1)
	}
}

// IncTTLExpiry counts a takeover of a lapsed claim: an agent went dark holding
// a task and someone else picked it up. Claim expiry is lazy (evaluated inside
// the atomic claim, no sweeper), so this is the only place it is observable.
func (reg *Registry) IncTTLExpiry() {
	if reg != nil {
		reg.counts.ttlExpiries.Add(1)
	}
}

// ObserveWebhookDelivery counts one terminal webhook delivery outcome. It is
// the method the webhooks worker's observer seam calls; unknown outcomes are
// ignored rather than silently miscounted.
func (reg *Registry) ObserveWebhookDelivery(outcome string) {
	if reg == nil {
		return
	}
	switch outcome {
	case WebhookOutcomeOK:
		reg.counts.webhookOK.Add(1)
	case WebhookOutcomeFailed:
		reg.counts.webhookFailed.Add(1)
	case WebhookOutcomeDead:
		reg.counts.webhookDead.Add(1)
	}
}

// Middleware times every request and records it under chi's RoutePattern —
// resolved AFTER next.ServeHTTP returns, so /api/canvas/actions/{id} is one key
// rather than one key per UUID. Hijacked connections (/ws) are EXCLUDED: their
// handler returns at disconnect, so the "latency" would be connection lifetime —
// hours-long p99s that dominate the count-sorted table and mean nothing next to
// request/response routes.
//
// A nil Registry returns next untouched: zero overhead when metrics are off.
func (reg *Registry) Middleware(next http.Handler) http.Handler {
	if reg == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if rctx := chi.RouteContext(r.Context()); rctx != nil {
			if pattern := rctx.RoutePattern(); pattern != "/ws" {
				reg.Record(r.Method, pattern, time.Since(start))
			}
		}
	})
}

// Summary is the percentile view of one latency series. Count and MaxMS are
// since boot; the percentiles cover WindowCount samples inside the recency
// window (see DefaultWindow).
type Summary struct {
	Count       uint64  `json:"count"`
	WindowCount int     `json:"window_count"`
	P50MS       float64 `json:"p50_ms"`
	P95MS       float64 `json:"p95_ms"`
	P99MS       float64 `json:"p99_ms"`
	MaxMS       float64 `json:"max_ms"`
}

// RouteMetric is one row of the routes table.
type RouteMetric struct {
	Route   string `json:"route"`
	Method  string `json:"method"`
	Summary        // flattened into the row by encoding/json
}

// Counters is the counter block of the response.
type Counters struct {
	Claims         uint64 `json:"claims"`
	ClaimConflicts uint64 `json:"claim_conflicts"`
	TTLExpiries    uint64 `json:"ttl_expiries"`
	WebhookOK      uint64 `json:"webhook_ok"`
	WebhookFailed  uint64 `json:"webhook_failed"`
	WebhookDead    uint64 `json:"webhook_dead"`
}

// Snapshot is the full /api/metrics response.
type Snapshot struct {
	GeneratedAt   time.Time          `json:"generated_at"`
	StartedAt     time.Time          `json:"started_at"`
	UptimeSeconds float64            `json:"uptime_seconds"`
	WindowSeconds float64            `json:"window_seconds"`
	Routes        []RouteMetric      `json:"routes"`
	Ops           map[string]Summary `json:"ops"`
	Counters      Counters           `json:"counters"`
	Gauges        map[string]int     `json:"gauges"`
}

// RouteMetrics returns per-route aggregates sorted by count desc.
func (reg *Registry) RouteMetrics() []RouteMetric {
	if reg == nil {
		return nil
	}
	cutoff := reg.cutoff()

	reg.mu.RLock()
	keys := make([]routeKey, 0, len(reg.routes))
	hists := make([]*histogram, 0, len(reg.routes))
	for k, h := range reg.routes {
		keys = append(keys, k)
		hists = append(hists, h)
	}
	reg.mu.RUnlock()

	out := make([]RouteMetric, 0, len(keys))
	for i, key := range keys {
		out = append(out, RouteMetric{Route: key.route, Method: key.method, Summary: hists[i].summarize(cutoff)})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		if out[i].Route != out[j].Route {
			return out[i].Route < out[j].Route
		}
		return out[i].Method < out[j].Method
	})
	return out
}

// Snapshot builds the whole response: route latencies, op latencies, counters
// and gauges, read as of now.
func (reg *Registry) Snapshot() Snapshot {
	if reg == nil {
		return Snapshot{}
	}
	now := reg.now()
	cutoff := reg.cutoff()

	reg.mu.RLock()
	ops := make(map[string]*histogram, len(reg.ops))
	for k, h := range reg.ops {
		ops[k] = h
	}
	gauges := make(map[string]func() int, len(reg.gauges))
	for k, fn := range reg.gauges {
		gauges[k] = fn
	}
	reg.mu.RUnlock()

	opOut := make(map[string]Summary, len(ops))
	for k, h := range ops {
		opOut[k] = h.summarize(cutoff)
	}
	gaugeOut := make(map[string]int, len(gauges))
	for k, fn := range gauges {
		gaugeOut[k] = fn()
	}

	return Snapshot{
		GeneratedAt:   now.UTC(),
		StartedAt:     reg.startedAt.UTC(),
		UptimeSeconds: now.Sub(reg.startedAt).Seconds(),
		WindowSeconds: reg.window.Seconds(),
		Routes:        reg.RouteMetrics(),
		Ops:           opOut,
		Counters: Counters{
			Claims:         reg.counts.claims.Load(),
			ClaimConflicts: reg.counts.claimConflicts.Load(),
			TTLExpiries:    reg.counts.ttlExpiries.Load(),
			WebhookOK:      reg.counts.webhookOK.Load(),
			WebhookFailed:  reg.counts.webhookFailed.Load(),
			WebhookDead:    reg.counts.webhookDead.Load(),
		},
		Gauges: gaugeOut,
	}
}

// Handler serves GET /api/metrics. Open by design: aggregates and route
// patterns only, never canvas data.
func (reg *Registry) Handler(w http.ResponseWriter, r *http.Request) {
	if reg == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(reg.Snapshot())
}

func (reg *Registry) cutoff() int64 {
	if reg.window <= 0 {
		return math.MinInt64
	}
	return reg.now().Add(-reg.window).UnixNano()
}

func msOf(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

// percentile computes the nearest-rank percentile of an ascending-sorted,
// non-empty slice: the smallest value with at least q·n samples at or below it.
func percentile(sorted []float64, q float64) float64 {
	rank := int(math.Ceil(q * float64(len(sorted))))
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}
