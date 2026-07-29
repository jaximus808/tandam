package metrics

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func recordMS(reg *Registry, method, route string, ms float64) {
	reg.Record(method, route, time.Duration(ms*float64(time.Millisecond)))
}

// fakeClock drives the recency window deterministically. In-package, so the
// test can install it directly rather than growing an exported knob nothing in
// production would ever call.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func withClock(reg *Registry) *fakeClock {
	c := &fakeClock{t: time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)}
	reg.now = c.now
	reg.startedAt = c.t
	return c
}

func routeRow(t *testing.T, reg *Registry, i int) RouteMetric {
	t.Helper()
	rows := reg.RouteMetrics()
	if len(rows) <= i {
		t.Fatalf("wanted row %d, got %d rows: %+v", i, len(rows), rows)
	}
	return rows[i]
}

// ── percentile math ─────────────────────────────────────────────────────────

// Known distribution: 1..100 ms shuffled. Nearest-rank percentiles are exact:
// p50=50, p95=95, p99=99, max=100.
func TestPercentilesKnownDistribution(t *testing.T) {
	reg := NewRegistry()
	for _, v := range rand.Perm(100) {
		recordMS(reg, "GET", "/x", float64(v+1))
	}

	rows := reg.RouteMetrics()
	if len(rows) != 1 {
		t.Fatalf("expected 1 route, got %d", len(rows))
	}
	m := rows[0]
	if m.Count != 100 {
		t.Errorf("count = %d, want 100", m.Count)
	}
	if m.WindowCount != 100 {
		t.Errorf("window_count = %d, want 100", m.WindowCount)
	}
	if m.P50MS != 50 {
		t.Errorf("p50 = %v, want 50", m.P50MS)
	}
	if m.P95MS != 95 {
		t.Errorf("p95 = %v, want 95", m.P95MS)
	}
	if m.P99MS != 99 {
		t.Errorf("p99 = %v, want 99", m.P99MS)
	}
	if m.MaxMS != 100 {
		t.Errorf("max = %v, want 100", m.MaxMS)
	}
}

// A skewed set pins the nearest-rank definition rather than an interpolating
// one: 99 samples of 1ms and 1 of 900ms puts p99 on the fast band and only the
// max on the outlier.
func TestPercentilesSkewedDistribution(t *testing.T) {
	reg := NewRegistry()
	for i := 0; i < 99; i++ {
		recordMS(reg, "GET", "/skew", 1)
	}
	recordMS(reg, "GET", "/skew", 900)

	m := routeRow(t, reg, 0)
	if m.P50MS != 1 || m.P95MS != 1 || m.P99MS != 1 {
		t.Errorf("p50/p95/p99 = %v/%v/%v, want 1/1/1", m.P50MS, m.P95MS, m.P99MS)
	}
	if m.MaxMS != 900 {
		t.Errorf("max = %v, want 900", m.MaxMS)
	}
}

func TestPercentileSingleSample(t *testing.T) {
	reg := NewRegistry()
	recordMS(reg, "GET", "/one", 7)
	m := routeRow(t, reg, 0)
	if m.P50MS != 7 || m.P95MS != 7 || m.P99MS != 7 || m.MaxMS != 7 {
		t.Errorf("single sample: got %+v, want all 7", m)
	}
}

func TestPercentileHelperEdges(t *testing.T) {
	sorted := []float64{1, 2, 3, 4}
	if got := percentile(sorted, 0); got != 1 {
		t.Errorf("q=0 → %v, want 1 (rank clamped to first)", got)
	}
	if got := percentile(sorted, 1); got != 4 {
		t.Errorf("q=1 → %v, want 4 (rank clamped to last)", got)
	}
	if got := percentile(sorted, 0.5); got != 2 {
		t.Errorf("q=.5 → %v, want 2 (nearest rank)", got)
	}
}

// ── sliding window ──────────────────────────────────────────────────────────

// The ring keeps only the most recent sampleCap latencies: after overwriting
// the window with a higher band, percentiles come from the new band, while
// count and max still cover everything since boot.
func TestRingBufferEviction(t *testing.T) {
	reg := NewRegistry()
	for i := 0; i < sampleCap; i++ {
		recordMS(reg, "GET", "/x", 1)
	}
	recordMS(reg, "GET", "/x", 5000) // spike, will be evicted from the window
	for i := 0; i < sampleCap; i++ {
		recordMS(reg, "GET", "/x", 10)
	}

	m := routeRow(t, reg, 0)
	if want := uint64(sampleCap*2 + 1); m.Count != want {
		t.Errorf("count = %d, want %d", m.Count, want)
	}
	if m.WindowCount != sampleCap {
		t.Errorf("window_count = %d, want %d (ring is capped)", m.WindowCount, sampleCap)
	}
	if m.P50MS != 10 || m.P99MS != 10 {
		t.Errorf("window percentiles = p50 %v / p99 %v, want 10 (recent band only)", m.P50MS, m.P99MS)
	}
	if m.MaxMS != 5000 {
		t.Errorf("max = %v, want all-time 5000 even after eviction", m.MaxMS)
	}
}

// The window is TIME-bounded as well as sample-bounded — the failure the sample
// ring alone can't fix. A route that was slow an hour ago and has been fast
// since must not still report the old p99 just because it is low-traffic enough
// that the ring never wrapped.
func TestRecencyWindowDropsStaleSamples(t *testing.T) {
	reg := NewRegistry()
	clock := withClock(reg)

	for i := 0; i < 50; i++ {
		recordMS(reg, "GET", "/slow-then-fast", 800)
	}
	if m := routeRow(t, reg, 0); m.P50MS != 800 || m.WindowCount != 50 {
		t.Fatalf("before the window lapses: p50 %v / window_count %d, want 800/50", m.P50MS, m.WindowCount)
	}

	clock.advance(DefaultWindow + time.Second)
	for i := 0; i < 10; i++ {
		recordMS(reg, "GET", "/slow-then-fast", 4)
	}

	m := routeRow(t, reg, 0)
	if m.WindowCount != 10 {
		t.Errorf("window_count = %d, want 10 (the 50 old samples are outside the window)", m.WindowCount)
	}
	if m.P50MS != 4 || m.P99MS != 4 {
		t.Errorf("p50/p99 = %v/%v, want 4/4 — stale samples must not linger", m.P50MS, m.P99MS)
	}
	if m.Count != 60 {
		t.Errorf("count = %d, want 60 (since boot, not windowed)", m.Count)
	}
	if m.MaxMS != 800 {
		t.Errorf("max = %v, want 800 (since boot, not windowed)", m.MaxMS)
	}
}

// A series with nothing recent reports zeroed percentiles rather than stale
// ones — "no traffic" must be visibly different from "fast".
func TestWindowFullyLapsedReportsNoSamples(t *testing.T) {
	reg := NewRegistry()
	clock := withClock(reg)
	recordMS(reg, "GET", "/quiet", 42)
	clock.advance(DefaultWindow * 2)

	m := routeRow(t, reg, 0)
	if m.WindowCount != 0 || m.P50MS != 0 || m.P99MS != 0 {
		t.Errorf("lapsed series = %+v, want window_count 0 and zero percentiles", m)
	}
	if m.Count != 1 || m.MaxMS != 42 {
		t.Errorf("since-boot scalars lost: count %d max %v, want 1 / 42", m.Count, m.MaxMS)
	}
}

// ── concurrency ─────────────────────────────────────────────────────────────

// Run with -race: parallel goroutines recording into shared + distinct routes,
// bumping counters, and snapshotting at the same time.
func TestConcurrentRecording(t *testing.T) {
	reg := NewRegistry()
	const goroutines = 16
	const perG = 500

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < perG; i++ {
				recordMS(reg, "GET", "/shared", float64(i%50+1))
				recordMS(reg, "POST", fmt.Sprintf("/own/%d", g), 1)
				reg.IncClaim()
				reg.ObserveBroadcast(time.Millisecond)
				reg.ObserveWebhookDelivery(WebhookOutcomeOK)
			}
		}(g)
	}
	done := make(chan struct{})
	go func() {
		for i := 0; i < 50; i++ {
			reg.Snapshot()
		}
		close(done)
	}()
	wg.Wait()
	<-done

	snap := reg.Snapshot()
	if len(snap.Routes) != goroutines+1 {
		t.Fatalf("routes = %d, want %d", len(snap.Routes), goroutines+1)
	}
	// Sorted by count desc — the shared route leads.
	if snap.Routes[0].Route != "/shared" || snap.Routes[0].Method != "GET" {
		t.Fatalf("top route = %s %s, want GET /shared", snap.Routes[0].Method, snap.Routes[0].Route)
	}
	total := uint64(goroutines * perG)
	if snap.Routes[0].Count != total {
		t.Errorf("shared count = %d, want %d", snap.Routes[0].Count, total)
	}
	for _, r := range snap.Routes[1:] {
		if r.Count != perG {
			t.Errorf("%s count = %d, want %d", r.Route, r.Count, perG)
		}
	}
	if snap.Counters.Claims != total {
		t.Errorf("claims = %d, want %d (atomic under contention)", snap.Counters.Claims, total)
	}
	if snap.Counters.WebhookOK != total {
		t.Errorf("webhook_ok = %d, want %d", snap.Counters.WebhookOK, total)
	}
	if snap.Ops[OpBroadcastFanout].Count != total {
		t.Errorf("broadcast count = %d, want %d", snap.Ops[OpBroadcastFanout].Count, total)
	}
}

// ── middleware ──────────────────────────────────────────────────────────────

// Requests through a chi router must be keyed by the route PATTERN, not the
// concrete URL — two different ids land in one /api/canvas/actions/{id} bucket.
// This is also the privacy guarantee: /api/metrics is open, so a canvas id must
// never be able to become a metric key.
func TestMiddlewareRoutePatternKeying(t *testing.T) {
	reg := NewRegistry()
	r := chi.NewRouter()
	r.Use(reg.Middleware)
	r.Get("/api/canvas/actions/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	r.Post("/api/canvas/notes", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})

	ids := []string{"5f2b6c9a-1111-4a63-9c1e-aaaaaaaaaaaa", "0d9e2f4b-2222-4c1d-8b7a-bbbbbbbbbbbb", "plain-id"}
	for _, id := range ids {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/canvas/actions/"+id, nil))
	}
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/canvas/notes", nil))

	rows := reg.RouteMetrics()
	if len(rows) != 2 {
		t.Fatalf("routes = %d, want 2 (pattern keying, not per-URL): %+v", len(rows), rows)
	}
	if rows[0].Route != "/api/canvas/actions/{id}" || rows[0].Method != http.MethodGet || rows[0].Count != 3 {
		t.Errorf("row 0 = %+v, want GET /api/canvas/actions/{id} count 3", rows[0])
	}
	if rows[1].Route != "/api/canvas/notes" || rows[1].Method != http.MethodPost || rows[1].Count != 1 {
		t.Errorf("row 1 = %+v, want POST /api/canvas/notes count 1", rows[1])
	}

	// And nothing id-shaped reached the wire.
	rec := httptest.NewRecorder()
	reg.Handler(rec, httptest.NewRequest(http.MethodGet, "/api/metrics", nil))
	for _, id := range ids {
		if strings.Contains(rec.Body.String(), id) {
			t.Fatalf("concrete id %q leaked into /api/metrics: %s", id, rec.Body.String())
		}
	}
}

// /ws is excluded: its handler returns only when the socket closes, so its
// "latency" is connection lifetime and would swamp every real route.
func TestMiddlewareSkipsWebSocketRoute(t *testing.T) {
	reg := NewRegistry()
	r := chi.NewRouter()
	r.Use(reg.Middleware)
	r.Get("/ws", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Get("/api/stats", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })

	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/ws", nil))
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/stats", nil))

	rows := reg.RouteMetrics()
	if len(rows) != 1 || rows[0].Route != "/api/stats" {
		t.Errorf("rows = %+v, want only /api/stats", rows)
	}
}

// ── counters, gauges, ops ───────────────────────────────────────────────────

func TestCounters(t *testing.T) {
	reg := NewRegistry()
	reg.IncClaim()
	reg.IncClaim()
	reg.IncClaimConflict()
	reg.IncTTLExpiry()
	reg.ObserveWebhookDelivery(WebhookOutcomeOK)
	reg.ObserveWebhookDelivery(WebhookOutcomeOK)
	reg.ObserveWebhookDelivery(WebhookOutcomeOK)
	reg.ObserveWebhookDelivery(WebhookOutcomeFailed)
	reg.ObserveWebhookDelivery(WebhookOutcomeDead)
	reg.ObserveWebhookDelivery("nonsense") // ignored, never miscounted

	got := reg.Snapshot().Counters
	want := Counters{Claims: 2, ClaimConflicts: 1, TTLExpiries: 1, WebhookOK: 3, WebhookFailed: 1, WebhookDead: 1}
	if got != want {
		t.Errorf("counters = %+v, want %+v", got, want)
	}
}

func TestGaugeIsPulledAtSnapshot(t *testing.T) {
	reg := NewRegistry()
	clients := 0
	reg.RegisterGauge("ws_clients", func() int { return clients })

	if got := reg.Snapshot().Gauges["ws_clients"]; got != 0 {
		t.Errorf("gauge = %d, want 0", got)
	}
	clients = 7
	if got := reg.Snapshot().Gauges["ws_clients"]; got != 7 {
		t.Errorf("gauge = %d, want 7 — gauges must be read at scrape time, not cached", got)
	}
}

func TestObserveBroadcastSummary(t *testing.T) {
	reg := NewRegistry()
	for i := 1; i <= 100; i++ {
		reg.ObserveBroadcast(time.Duration(i) * time.Millisecond)
	}
	s := reg.Snapshot().Ops[OpBroadcastFanout]
	if s.Count != 100 || s.P50MS != 50 || s.P95MS != 95 || s.P99MS != 99 || s.MaxMS != 100 {
		t.Errorf("broadcast summary = %+v, want count 100 / p50 50 / p95 95 / p99 99 / max 100", s)
	}
}

// ── nil safety ──────────────────────────────────────────────────────────────

// A metrics-disabled process wires nil everywhere. Every seam must tolerate it,
// including through an interface (the boxed-typed-nil trap), because the hub
// and the webhook worker hold it as one.
func TestNilRegistryIsSafe(t *testing.T) {
	var reg *Registry

	reg.Record("GET", "/x", time.Second)
	reg.RecordOp("op", time.Second)
	reg.ObserveBroadcast(time.Second)
	reg.ObserveWebhookDelivery(WebhookOutcomeOK)
	reg.IncClaim()
	reg.IncClaimConflict()
	reg.IncTTLExpiry()
	reg.RegisterGauge("g", func() int { return 1 })
	if rows := reg.RouteMetrics(); rows != nil {
		t.Errorf("nil registry RouteMetrics = %+v, want nil", rows)
	}
	if snap := (reg.Snapshot()); snap.Routes != nil {
		t.Errorf("nil registry Snapshot = %+v, want zero value", snap)
	}

	// Boxed into an interface, as ws.Hub and the webhook worker hold it.
	var boxed interface {
		ObserveBroadcast(time.Duration)
		ObserveWebhookDelivery(string)
	} = reg
	boxed.ObserveBroadcast(time.Second)
	boxed.ObserveWebhookDelivery(WebhookOutcomeDead)

	// Middleware is a pass-through: zero overhead, and the handler still runs.
	called := false
	h := reg.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
	if !called {
		t.Error("nil-registry middleware swallowed the request")
	}

	rec := httptest.NewRecorder()
	reg.Handler(rec, httptest.NewRequest(http.MethodGet, "/api/metrics", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("nil-registry handler = %d, want 404", rec.Code)
	}
}

// ── handler ─────────────────────────────────────────────────────────────────

func TestHandlerResponseShape(t *testing.T) {
	reg := NewRegistry()
	recordMS(reg, "GET", "/api/stats", 3)
	reg.ObserveBroadcast(2 * time.Millisecond)
	reg.RegisterGauge("ws_clients", func() int { return 4 })
	reg.IncClaim()
	reg.IncClaimConflict()
	reg.IncTTLExpiry()
	reg.ObserveWebhookDelivery(WebhookOutcomeOK)
	reg.ObserveWebhookDelivery(WebhookOutcomeFailed)
	reg.ObserveWebhookDelivery(WebhookOutcomeDead)

	rec := httptest.NewRecorder()
	reg.Handler(rec, httptest.NewRequest(http.MethodGet, "/api/metrics", nil))

	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type = %q", ct)
	}

	var body Snapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, rec.Body.String())
	}
	if body.StartedAt.IsZero() || body.GeneratedAt.IsZero() || body.UptimeSeconds < 0 {
		t.Errorf("uptime/timestamps missing: %+v", body)
	}
	if body.WindowSeconds != DefaultWindow.Seconds() {
		t.Errorf("window_seconds = %v, want %v", body.WindowSeconds, DefaultWindow.Seconds())
	}
	if len(body.Routes) != 1 || body.Routes[0].Route != "/api/stats" || body.Routes[0].P99MS != 3 {
		t.Errorf("routes = %+v", body.Routes)
	}
	if body.Gauges["ws_clients"] != 4 {
		t.Errorf("ws_clients = %d, want 4", body.Gauges["ws_clients"])
	}
	if s := body.Ops[OpBroadcastFanout]; s.Count != 1 || s.P50MS != 2 {
		t.Errorf("%s = %+v, want count 1 p50 2", OpBroadcastFanout, s)
	}
	want := Counters{Claims: 1, ClaimConflicts: 1, TTLExpiries: 1, WebhookOK: 1, WebhookFailed: 1, WebhookDead: 1}
	if body.Counters != want {
		t.Errorf("counters = %+v, want %+v", body.Counters, want)
	}

	// Every key the charter asks for, by name, at the position a scraper reads.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"generated_at", "uptime_seconds", "window_seconds", "routes", "ops", "counters", "gauges"} {
		if _, ok := raw[k]; !ok {
			t.Errorf("missing top-level key %q in %s", k, rec.Body.String())
		}
	}
	var counters map[string]uint64
	if err := json.Unmarshal(raw["counters"], &counters); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"claims", "claim_conflicts", "ttl_expiries", "webhook_ok", "webhook_failed", "webhook_dead"} {
		if _, ok := counters[k]; !ok {
			t.Errorf("missing counter %q", k)
		}
	}
	t.Logf("GET /api/metrics →\n%s", rec.Body.String())
}

// ── overhead ────────────────────────────────────────────────────────────────

// The hot paths must not allocate. This is the acceptance criterion ("overhead
// negligible") pinned as a test rather than left to a benchmark nobody reruns:
// the obvious implementation — keying routes by method+" "+pattern — allocates
// a string per request, and that is a heap allocation on every API call in the
// process. Route series are keyed by a struct instead, and counters are plain
// atomics.
func TestHotPathDoesNotAllocate(t *testing.T) {
	reg := NewRegistry()
	// Pre-create the series so the one-off setup isn't measured.
	reg.Record("GET", "/api/canvas/actions/{id}", time.Millisecond)
	reg.ObserveBroadcast(time.Millisecond)

	cases := []struct {
		name string
		fn   func()
	}{
		{"Record", func() { reg.Record("GET", "/api/canvas/actions/{id}", time.Millisecond) }},
		{"ObserveBroadcast", func() { reg.ObserveBroadcast(time.Millisecond) }},
		{"IncClaim", func() { reg.IncClaim() }},
		{"IncClaimConflict", func() { reg.IncClaimConflict() }},
		{"ObserveWebhookDelivery", func() { reg.ObserveWebhookDelivery(WebhookOutcomeOK) }},
	}
	for _, tc := range cases {
		if n := testing.AllocsPerRun(200, tc.fn); n != 0 {
			t.Errorf("%s allocates %v times per call, want 0", tc.name, n)
		}
	}
}

// ── benchmarks ──────────────────────────────────────────────────────────────
//
// The acceptance bar is "overhead negligible". What these measure:
//   Record            — the histogram hot path (map lookup + per-series mutex).
//   RecordParallel    — the same under GOMAXPROCS-way contention on ONE series,
//                       the worst case (every route is its own mutex, so real
//                       traffic contends less than this).
//   Counter           — an atomic add, the claim/webhook path.
//   Middleware        — end-to-end cost per request through chi, vs Baseline.
//   Snapshot          — the scrape, which is allowed to be expensive.

func BenchmarkRecord(b *testing.B) {
	reg := NewRegistry()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		reg.Record("GET", "/api/canvas/actions/{id}", time.Millisecond)
	}
}

func BenchmarkRecordParallel(b *testing.B) {
	reg := NewRegistry()
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			reg.Record("GET", "/api/canvas/actions/{id}", time.Millisecond)
		}
	})
}

func BenchmarkRecordParallelDistinctRoutes(b *testing.B) {
	reg := NewRegistry()
	routes := make([]string, 32)
	for i := range routes {
		routes[i] = fmt.Sprintf("/api/canvas/r%d", i)
		reg.Record("GET", routes[i], time.Millisecond) // pre-create the series
	}
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			reg.Record("GET", routes[i%len(routes)], time.Millisecond)
			i++
		}
	})
}

func BenchmarkCounterInc(b *testing.B) {
	reg := NewRegistry()
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			reg.IncClaim()
		}
	})
}

func BenchmarkObserveBroadcast(b *testing.B) {
	reg := NewRegistry()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		reg.ObserveBroadcast(time.Millisecond)
	}
}

func benchRouter(reg *Registry) http.Handler {
	r := chi.NewRouter()
	if reg != nil {
		r.Use(reg.Middleware)
	}
	r.Get("/api/canvas/actions/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return r
}

func BenchmarkMiddleware(b *testing.B) {
	h := benchRouter(NewRegistry())
	req := httptest.NewRequest(http.MethodGet, "/api/canvas/actions/5f2b6c9a-1111-4a63-9c1e-aaaaaaaaaaaa", nil)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
}

func BenchmarkMiddlewareBaseline(b *testing.B) {
	h := benchRouter(nil)
	req := httptest.NewRequest(http.MethodGet, "/api/canvas/actions/5f2b6c9a-1111-4a63-9c1e-aaaaaaaaaaaa", nil)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
}

func BenchmarkSnapshot(b *testing.B) {
	reg := NewRegistry()
	for i := 0; i < 64; i++ {
		route := fmt.Sprintf("/api/canvas/r%d", i)
		for j := 0; j < sampleCap; j++ {
			reg.Record("GET", route, time.Duration(j)*time.Microsecond)
		}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = reg.Snapshot()
	}
}
