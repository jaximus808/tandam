package main

import (
	"strings"
	"testing"
)

// The current /api/metrics shape (TDM-42): windowed percentiles, counters,
// gauges.
const currentMetricsBody = `{
  "generated_at": "2026-07-29T06:00:00Z",
  "started_at": "2026-07-29T05:00:00Z",
  "uptime_seconds": 3600,
  "window_seconds": 300,
  "routes": [
    {"route":"/api/canvas/actions/{id}","method":"PATCH","count":900,"window_count":512,"p50_ms":40,"p95_ms":88,"p99_ms":120,"max_ms":400},
    {"route":"/api/canvas/actions","method":"GET","count":300,"window_count":300,"p50_ms":50,"p95_ms":110,"p99_ms":150,"max_ms":300},
    {"route":"/api/canvas/context","method":"GET","count":80,"window_count":80,"p50_ms":120,"p95_ms":210,"p99_ms":240,"max_ms":260}
  ],
  "ops": {"broadcast_fanout_ms": {"count": 40, "window_count": 40, "p50_ms": 1, "p95_ms": 3, "p99_ms": 4, "max_ms": 9}},
  "counters": {"claims": 500, "claim_conflicts": 1200, "ttl_expiries": 3, "webhook_ok": 0, "webhook_failed": 0, "webhook_dead": 0},
  "gauges": {"ws_clients": 2}
}`

// The shape a server built before TDM-42 returns: uptime_s, routes, and nothing
// else. Parsing this correctly — as "counters unavailable", not "counters zero"
// — is the difference between reporting a missing cross-check and reporting a
// false one.
const legacyMetricsBody = `{
  "uptime_s": 22433.06,
  "started_at": "2026-07-28T23:38:38Z",
  "routes": [
    {"route":"/api/canvas/actions/{id}","method":"PATCH","count":81,"p50_ms":504,"p95_ms":691,"p99_ms":960,"max_ms":960}
  ]
}`

func TestParseCurrentMetrics(t *testing.T) {
	s, err := parseMetrics([]byte(currentMetricsBody))
	if err != nil {
		t.Fatal(err)
	}
	if !s.Available || !s.CountersAvailable {
		t.Fatalf("availability = %v/%v, want both true", s.Available, s.CountersAvailable)
	}
	if s.WindowSeconds != 300 {
		t.Errorf("window = %v, want 300", s.WindowSeconds)
	}
	if s.Claims != 500 || s.ClaimConflicts != 1200 || s.TTLExpiries != 3 {
		t.Errorf("counters = %d/%d/%d", s.Claims, s.ClaimConflicts, s.TTLExpiries)
	}
	row, ok := s.Routes["PATCH /api/canvas/actions/{id}"]
	if !ok {
		t.Fatalf("route key missing; have %v", s.Routes)
	}
	if row.Count != 900 || row.P95MS != 88 || row.WindowCount != 512 {
		t.Errorf("route row = %+v", row)
	}
	if s.Gauges["ws_clients"] != 2 {
		t.Errorf("gauges lost: %v", s.Gauges)
	}
}

func TestParseLegacyMetricsReportsCountersMissing(t *testing.T) {
	s, err := parseMetrics([]byte(legacyMetricsBody))
	if err != nil {
		t.Fatal(err)
	}
	if !s.Available {
		t.Fatal("a legacy metrics response must still yield a usable route view")
	}
	if s.CountersAvailable {
		t.Fatal("counters reported available on a response that has none")
	}
	if s.Claims != 0 || s.ClaimConflicts != 0 {
		t.Error("absent counters must stay zero AND be flagged unavailable, never surfaced as real zeroes")
	}
	if !strings.Contains(s.Note, "TDM-42") {
		t.Errorf("note = %q, want it to explain why counters are missing", s.Note)
	}
	if row := s.Routes["PATCH /api/canvas/actions/{id}"]; row.P95MS != 691 {
		t.Errorf("legacy route row lost: %+v", row)
	}
}

func TestParseMetricsRejectsNonMetrics(t *testing.T) {
	if _, err := parseMetrics([]byte("<!doctype html><html>…")); err == nil {
		t.Fatal("HTML parsed as metrics — the SPA fallback would masquerade as a server view")
	}
}

func TestBuildServerViewCounterDeltas(t *testing.T) {
	before, _ := parseMetrics([]byte(currentMetricsBody))
	after, _ := parseMetrics([]byte(strings.NewReplacer(
		`"claims": 500`, `"claims": 540`,
		`"claim_conflicts": 1200`, `"claim_conflicts": 1350`,
		`"count":900`, `"count":1100`,
	).Replace(currentMetricsBody)))

	v := buildServerView(before, after)
	if !v.Available || !v.CountersAvailable {
		t.Fatalf("view = %+v", v)
	}
	if v.ClaimsDelta != 40 || v.ClaimConflictsDelta != 150 {
		t.Errorf("deltas = %d claims / %d conflicts, want 40/150", v.ClaimsDelta, v.ClaimConflictsDelta)
	}
	if !v.PercentilesAreWindowed {
		t.Error("percentiles_are_windowed must be recorded so nobody reads them as scenario-only")
	}
	var patch ServerRoute
	for _, r := range v.Routes {
		if r.Route == opRoutes[opClaim] {
			patch = r
		}
	}
	if patch.CountDelta != 200 {
		t.Errorf("route count delta = %d, want 200", patch.CountDelta)
	}
	if !strings.Contains(patch.Note, "shared route") {
		t.Errorf("PATCH route note = %q, want the shared-route caveat", patch.Note)
	}
}

func TestBuildServerViewNoCountersMeansNoDeltas(t *testing.T) {
	before, _ := parseMetrics([]byte(legacyMetricsBody))
	after, _ := parseMetrics([]byte(legacyMetricsBody))
	v := buildServerView(before, after)
	if v.CountersAvailable || v.ClaimsDelta != 0 || v.ClaimConflictsDelta != 0 {
		t.Fatalf("view = %+v, want no counter story at all", v)
	}
	if !v.Available {
		t.Error("route rows are still available on a legacy server")
	}
}

func TestBuildServerViewUnavailable(t *testing.T) {
	v := buildServerView(serverScrape{}, serverScrape{Note: "/api/metrics returned 404"})
	if v.Available || v.Note == "" {
		t.Fatalf("view = %+v, want unavailable with the reason kept", v)
	}
	if _, ok := v.serverP95(opClaim); ok {
		t.Error("an unavailable view handed out a p95")
	}
}

// A route the server never served must not silently become a zero p95 — that
// would read as "infinitely fast" in the assertion table.
func TestServerViewMissingRouteHasNoP95(t *testing.T) {
	before, _ := parseMetrics([]byte(currentMetricsBody))
	after, _ := parseMetrics([]byte(currentMetricsBody))
	v := buildServerView(before, after)

	if _, ok := v.serverP95(opStatusPost); ok {
		t.Error("status-post route was absent from the scrape but yielded a p95")
	}
	if p95, ok := v.serverP95(opContextGet); !ok || p95 != 210 {
		t.Errorf("context p95 = %v (%v), want 210", p95, ok)
	}
	var row ServerRoute
	for _, r := range v.Routes {
		if r.Op == opStatusPost {
			row = r
		}
	}
	if !strings.Contains(row.Note, "never served it") {
		t.Errorf("absent route note = %q, want it to say the server never served it", row.Note)
	}
}

// claim / conflict / complete all ride one route, so the map must point them at
// the same key — the caveat elsewhere depends on it.
func TestOpRoutesShareThePatchRoute(t *testing.T) {
	if opRoutes[opClaim] != opRoutes[opComplete] || opRoutes[opClaim] != opRoutes[opClaimConflict] {
		t.Fatal("claim/conflict/complete must map to the same PATCH route pattern")
	}
	for _, op := range taskOps {
		if opRoutes[op] == "" {
			t.Errorf("op %q has no route mapping — its server-side view would silently vanish", op)
		}
	}
}

// The route rows are emitted in a fixed order so two baselines diff cleanly.
func TestServerViewRouteOrderIsStable(t *testing.T) {
	before, _ := parseMetrics([]byte(currentMetricsBody))
	first := buildServerView(before, before)
	for i := 0; i < 20; i++ {
		next := buildServerView(before, before)
		if len(first.Routes) != len(next.Routes) {
			t.Fatal("route row count changed between builds")
		}
		for j := range first.Routes {
			if first.Routes[j].Route != next.Routes[j].Route {
				t.Fatalf("route order changed at %d: %s vs %s", j, first.Routes[j].Route, next.Routes[j].Route)
			}
		}
	}
}

// An all-time (pre-TDM-42) server has no window_count at all. Its percentiles
// must still be usable, and the view must say plainly that they are all-time so
// nobody reads them as this scenario's numbers.
func TestServerViewAllTimeServerStillYieldsP95(t *testing.T) {
	before, _ := parseMetrics([]byte(legacyMetricsBody))
	after, _ := parseMetrics([]byte(legacyMetricsBody))
	v := buildServerView(before, after)

	if v.Windowed || v.PercentilesAreWindowed {
		t.Fatal("a server with no window_seconds was reported as windowed")
	}
	p95, ok := v.serverP95(opClaim)
	if !ok || p95 != 691 {
		t.Fatalf("all-time p95 = %v (%v), want 691 — an unwindowed server still has a server-side view", p95, ok)
	}
	if !strings.Contains(v.Note, "ALL-TIME") {
		t.Errorf("note = %q, want it to flag the percentiles as all-time", v.Note)
	}
}

// On a WINDOWED server an empty window means "no recent traffic", and stale or
// zero percentiles must not be reported as a fast pass.
func TestServerViewEmptyWindowHasNoP95(t *testing.T) {
	body := strings.Replace(currentMetricsBody, `"window_count":300`, `"window_count":0`, 1)
	after, err := parseMetrics([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	v := buildServerView(after, after)
	if _, ok := v.serverP95(opQueueList); ok {
		t.Fatal("a route with an empty recency window handed out a p95")
	}
	if _, ok := v.serverP95(opClaim); !ok {
		t.Error("a route WITH samples in the window lost its p95")
	}
}
