package metrics

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func recordMS(reg *Registry, method, route string, ms float64) {
	reg.Record(method, route, time.Duration(ms*float64(time.Millisecond)))
}

// Known distribution: 1..100 ms shuffled. Nearest-rank percentiles are exact:
// p50=50, p95=95, p99=99, max=100.
func TestPercentilesKnownDistribution(t *testing.T) {
	reg := NewRegistry()
	vals := rand.Perm(100)
	for _, v := range vals {
		recordMS(reg, "GET", "/x", float64(v+1))
	}

	rows := reg.Snapshot()
	if len(rows) != 1 {
		t.Fatalf("expected 1 route, got %d", len(rows))
	}
	m := rows[0]
	if m.Count != 100 {
		t.Errorf("count = %d, want 100", m.Count)
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

func TestPercentileSingleSample(t *testing.T) {
	reg := NewRegistry()
	recordMS(reg, "GET", "/one", 7)
	m := reg.Snapshot()[0]
	if m.P50MS != 7 || m.P95MS != 7 || m.P99MS != 7 || m.MaxMS != 7 {
		t.Errorf("single sample: got %+v, want all 7", m)
	}
}

// The ring keeps only the most recent sampleCap latencies: after overwriting
// the window with a higher band, percentiles come from the new band, while
// count and max still cover everything since boot.
func TestRingBufferEviction(t *testing.T) {
	reg := NewRegistry()
	// First fill with a low band including one all-time max spike.
	for i := 0; i < sampleCap; i++ {
		recordMS(reg, "GET", "/x", 1)
	}
	recordMS(reg, "GET", "/x", 5000) // spike, will be evicted from the window
	// Now overwrite the whole window with 10ms.
	for i := 0; i < sampleCap; i++ {
		recordMS(reg, "GET", "/x", 10)
	}

	m := reg.Snapshot()[0]
	if want := uint64(sampleCap*2 + 1); m.Count != want {
		t.Errorf("count = %d, want %d", m.Count, want)
	}
	if m.P50MS != 10 || m.P99MS != 10 {
		t.Errorf("window percentiles = p50 %v / p99 %v, want 10 (recent band only)", m.P50MS, m.P99MS)
	}
	if m.MaxMS != 5000 {
		t.Errorf("max = %v, want all-time 5000 even after eviction", m.MaxMS)
	}
}

// Run with -race: parallel goroutines recording into shared + distinct routes.
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
			}
		}(g)
	}
	// Concurrent snapshots must be safe too.
	done := make(chan struct{})
	go func() {
		for i := 0; i < 50; i++ {
			reg.Snapshot()
		}
		close(done)
	}()
	wg.Wait()
	<-done

	rows := reg.Snapshot()
	if len(rows) != goroutines+1 {
		t.Fatalf("routes = %d, want %d", len(rows), goroutines+1)
	}
	// Sorted by count desc — the shared route leads.
	if rows[0].Route != "/shared" || rows[0].Method != "GET" {
		t.Fatalf("top route = %s %s, want GET /shared", rows[0].Method, rows[0].Route)
	}
	if want := uint64(goroutines * perG); rows[0].Count != want {
		t.Errorf("shared count = %d, want %d", rows[0].Count, want)
	}
	for _, r := range rows[1:] {
		if r.Count != perG {
			t.Errorf("%s count = %d, want %d", r.Route, r.Count, perG)
		}
	}
}

// Requests through a chi router must be keyed by the route PATTERN, not the
// concrete URL — two different ids land in one /api/canvas/actions/{id} bucket.
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

	for _, id := range []string{"5f2b6c9a-1111-4a63-9c1e-aaaaaaaaaaaa", "0d9e2f4b-2222-4c1d-8b7a-bbbbbbbbbbbb", "plain-id"} {
		req := httptest.NewRequest(http.MethodGet, "/api/canvas/actions/"+id, nil)
		r.ServeHTTP(httptest.NewRecorder(), req)
	}
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/canvas/notes", nil))

	rows := reg.Snapshot()
	if len(rows) != 2 {
		t.Fatalf("routes = %d, want 2 (pattern keying, not per-URL): %+v", len(rows), rows)
	}
	if rows[0].Route != "/api/canvas/actions/{id}" || rows[0].Method != http.MethodGet || rows[0].Count != 3 {
		t.Errorf("row 0 = %+v, want GET /api/canvas/actions/{id} count 3", rows[0])
	}
	if rows[1].Route != "/api/canvas/notes" || rows[1].Method != http.MethodPost || rows[1].Count != 1 {
		t.Errorf("row 1 = %+v, want POST /api/canvas/notes count 1", rows[1])
	}
}

func TestHandlerResponseShape(t *testing.T) {
	reg := NewRegistry()
	recordMS(reg, "GET", "/api/stats", 3)

	rec := httptest.NewRecorder()
	reg.Handler(rec, httptest.NewRequest(http.MethodGet, "/api/metrics", nil))

	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type = %q", ct)
	}
	var body struct {
		UptimeS   float64       `json:"uptime_s"`
		StartedAt time.Time     `json:"started_at"`
		Routes    []RouteMetric `json:"routes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, rec.Body.String())
	}
	if body.StartedAt.IsZero() || body.UptimeS < 0 {
		t.Errorf("uptime/started_at missing: %+v", body)
	}
	if len(body.Routes) != 1 || body.Routes[0].Route != "/api/stats" {
		t.Errorf("routes = %+v", body.Routes)
	}
}
