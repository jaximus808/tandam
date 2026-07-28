// Package metrics collects in-memory, per-route request-latency aggregates.
//
// Scope is deliberately tiny: no external deps, no persistence — everything is
// aggregated in process memory since boot and exposed as JSON by Handler. The
// point is cheap per-route p50/p95/p99 numbers so every future latency
// improvement (batching, broadcast changes, store tuning) can be measured
// instead of guessed at.
package metrics

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
)

// sampleCap bounds per-route memory.
//
// Tradeoff — ring buffer vs reservoir: we use a fixed-size RING BUFFER (the
// most recent sampleCap latencies per route) rather than a uniform reservoir
// over all-time samples. A reservoir gives statistically unbiased percentiles
// since boot, but that is the wrong bias for operations: after a deploy or a
// perf fix we want the numbers to reflect *current* behavior quickly, and a
// since-boot reservoir dilutes recent samples more the longer the process
// lives. The ring is recency-weighted by construction, O(1) to record, and
// trivially bounded. Count and max are still tracked over ALL samples since
// boot (they're scalars, so no memory cost); only the percentiles are
// window-limited to the last sampleCap requests.
const sampleCap = 1024

type routeStats struct {
	count   uint64            // all requests since boot
	maxMS   float64           // all-time max since boot
	samples [sampleCap]float64 // ring of most recent latencies (ms)
	idx     int                // next write position
	filled  bool               // true once the ring has wrapped
}

func (s *routeStats) record(ms float64) {
	s.count++
	if ms > s.maxMS {
		s.maxMS = ms
	}
	s.samples[s.idx] = ms
	s.idx++
	if s.idx == sampleCap {
		s.idx = 0
		s.filled = true
	}
}

// Registry aggregates latencies keyed by (method, route pattern). A single
// mutex guards the map and every routeStats: recording is a few scalar writes,
// so contention is negligible next to actual request work (Supabase round
// trips), and it keeps snapshotting trivially consistent.
type Registry struct {
	mu        sync.Mutex
	routes    map[string]*routeStats // key: METHOD + " " + pattern
	startedAt time.Time
}

func NewRegistry() *Registry {
	return &Registry{
		routes:    make(map[string]*routeStats),
		startedAt: time.Now(),
	}
}

// Record adds one observation for the given method + route pattern.
func (reg *Registry) Record(method, route string, d time.Duration) {
	if route == "" {
		return
	}
	key := method + " " + route
	reg.mu.Lock()
	st, ok := reg.routes[key]
	if !ok {
		st = &routeStats{}
		reg.routes[key] = st
	}
	st.record(float64(d) / float64(time.Millisecond))
	reg.mu.Unlock()
}

// Middleware times every request and records it under chi's RoutePattern —
// resolved AFTER next.ServeHTTP returns, so /api/canvas/actions/{id} is one
// key rather than one key per UUID. Hijacked connections (/ws) are EXCLUDED:
// their handler returns at disconnect, so the "latency" would be connection
// lifetime — hours-long p99s that dominate the count-sorted table and mean
// nothing next to request/response routes.
func (reg *Registry) Middleware(next http.Handler) http.Handler {
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

// RouteMetric is one row of the /api/metrics response.
type RouteMetric struct {
	Route  string  `json:"route"`
	Method string  `json:"method"`
	Count  uint64  `json:"count"`
	P50MS  float64 `json:"p50_ms"`
	P95MS  float64 `json:"p95_ms"`
	P99MS  float64 `json:"p99_ms"`
	MaxMS  float64 `json:"max_ms"`
}

type snapshot struct {
	UptimeS   float64       `json:"uptime_s"`
	StartedAt time.Time     `json:"started_at"`
	Routes    []RouteMetric `json:"routes"`
}

// Snapshot returns per-route aggregates sorted by count desc.
func (reg *Registry) Snapshot() []RouteMetric {
	reg.mu.Lock()
	out := make([]RouteMetric, 0, len(reg.routes))
	for key, st := range reg.routes {
		n := st.idx
		if st.filled {
			n = sampleCap
		}
		window := make([]float64, n)
		copy(window, st.samples[:n])

		method, route := splitKey(key)
		m := RouteMetric{Route: route, Method: method, Count: st.count, MaxMS: st.maxMS}
		if n > 0 {
			sort.Float64s(window)
			m.P50MS = percentile(window, 0.50)
			m.P95MS = percentile(window, 0.95)
			m.P99MS = percentile(window, 0.99)
		}
		out = append(out, m)
	}
	reg.mu.Unlock()

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

// Handler serves GET /api/metrics. Open by design: it exposes only latency
// aggregates and route patterns, never canvas data.
func (reg *Registry) Handler(w http.ResponseWriter, r *http.Request) {
	resp := snapshot{
		UptimeS:   time.Since(reg.startedAt).Seconds(),
		StartedAt: reg.startedAt.UTC(),
		Routes:    reg.Snapshot(),
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

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

func splitKey(key string) (method, route string) {
	for i := 0; i < len(key); i++ {
		if key[i] == ' ' {
			return key[:i], key[i+1:]
		}
	}
	return key, ""
}
