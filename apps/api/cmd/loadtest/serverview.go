package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// The server-side view: GET /api/metrics, scraped before and after each
// scenario.
//
// WHY BOTH VIEWS. The charter's latency targets are defined SERVER-SIDE — time
// spent inside the handler — and that is the number the server can be held to.
// The client-side number this tool measures is handler time PLUS the local
// network stack, TLS/keep-alive behaviour, the Go client's connection pool, and
// whatever else the load generator's own machine is doing while running 256
// goroutines. On localhost the gap is usually small, but it is never zero and it
// is not the server's fault. So both are reported and the assertion table is
// evaluated against BOTH, clearly labelled.
//
// WHAT A DELTA CAN AND CANNOT BE. Counters (claims, claim_conflicts) are
// monotonic, so before/after subtraction is exact. Percentiles are NOT
// subtractable: /api/metrics reports them over a sliding recency window shared
// with every other request the process served. The post-scenario percentiles are
// therefore reported as-is, annotated with the window length and the count
// delta, so a reader can judge how much of the window is this scenario's
// traffic.

// serverSummary mirrors one route/op row of /api/metrics.
type serverSummary struct {
	Count       uint64  `json:"count"`
	WindowCount int     `json:"window_count"`
	P50MS       float64 `json:"p50_ms"`
	P95MS       float64 `json:"p95_ms"`
	P99MS       float64 `json:"p99_ms"`
	MaxMS       float64 `json:"max_ms"`
}

// rawMetrics decodes /api/metrics permissively.
//
// TOLERANT BY DESIGN: this tool is routinely pointed at a server built from a
// different commit than the one it was compiled from (that is half the point of
// a baseline). An older build exposes `uptime_s` and no counters block; a newer
// one exposes `uptime_seconds`, `window_seconds`, `counters`, `ops` and
// `gauges`. Anything absent is reported as unavailable rather than as zero — a
// zero would silently read as "no claim conflicts happened".
type rawMetrics struct {
	UptimeSeconds *float64 `json:"uptime_seconds"`
	UptimeS       *float64 `json:"uptime_s"`
	WindowSeconds *float64 `json:"window_seconds"`
	Routes        []struct {
		Route  string `json:"route"`
		Method string `json:"method"`
		serverSummary
	} `json:"routes"`
	Ops      map[string]serverSummary `json:"ops"`
	Counters *struct {
		Claims         uint64 `json:"claims"`
		ClaimConflicts uint64 `json:"claim_conflicts"`
		TTLExpiries    uint64 `json:"ttl_expiries"`
	} `json:"counters"`
	Gauges map[string]int `json:"gauges"`
}

// serverScrape is one parsed /api/metrics response.
type serverScrape struct {
	Available         bool
	CountersAvailable bool
	// Windowed says whether this server's percentiles are recency-windowed
	// (TDM-42) or all-time. It decides how "does this route have samples" is
	// answered: on a windowed server an empty window means no recent traffic and
	// the percentiles are meaningless, while on an all-time server there is no
	// window field at all and the row's count is the only evidence there is.
	Windowed       bool
	WindowSeconds  float64
	Routes         map[string]serverSummary // key: "METHOD route-pattern"
	Ops            map[string]serverSummary
	Claims         uint64
	ClaimConflicts uint64
	TTLExpiries    uint64
	Gauges         map[string]int
	Note           string
}

func routeKeyOf(method, pattern string) string { return method + " " + pattern }

// parseMetrics turns a /api/metrics body into a scrape. Pure — unit tested
// against both the current and the pre-TDM-42 response shapes.
func parseMetrics(body []byte) (serverScrape, error) {
	var raw rawMetrics
	if err := json.Unmarshal(body, &raw); err != nil {
		return serverScrape{}, fmt.Errorf("decoding /api/metrics: %w", err)
	}
	out := serverScrape{
		Available: true,
		Routes:    make(map[string]serverSummary, len(raw.Routes)),
		Ops:       raw.Ops,
		Gauges:    raw.Gauges,
	}
	for _, r := range raw.Routes {
		out.Routes[routeKeyOf(r.Method, r.Route)] = r.serverSummary
	}
	if raw.WindowSeconds != nil {
		out.Windowed = true
		out.WindowSeconds = *raw.WindowSeconds
	}
	if raw.Counters != nil {
		out.CountersAvailable = true
		out.Claims = raw.Counters.Claims
		out.ClaimConflicts = raw.Counters.ClaimConflicts
		out.TTLExpiries = raw.Counters.TTLExpiries
	} else {
		out.Note = "this server exposes no counters block — it predates TDM-42, so claims / claim_conflicts could not be cross-checked"
	}
	return out, nil
}

// scrapeMetrics fetches GET /api/metrics. A server without the endpoint (404, or
// the SPA fallback) yields an unavailable scrape rather than an error: the
// benchmark still has a client-side story to tell.
func scrapeMetrics(base string, hc *http.Client) serverScrape {
	req, err := http.NewRequest(http.MethodGet, base+"/api/metrics", nil)
	if err != nil {
		return serverScrape{Note: err.Error()}
	}
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return serverScrape{Note: "scraping /api/metrics: " + err.Error()}
	}
	defer resp.Body.Close()
	body := make([]byte, 0, 64*1024)
	buf := make([]byte, 32*1024)
	for {
		n, err := resp.Body.Read(buf)
		body = append(body, buf[:n]...)
		if err != nil {
			break
		}
	}
	if resp.StatusCode != http.StatusOK {
		return serverScrape{Note: fmt.Sprintf("/api/metrics returned %d", resp.StatusCode)}
	}
	scrape, err := parseMetrics(body)
	if err != nil {
		return serverScrape{Note: "GET /api/metrics did not return metrics JSON (endpoint absent on this build?)"}
	}
	return scrape
}

// ── Results-file shape ────────────────────────────────────────────────────────

// ServerRoute is one route's server-side row in the results file.
type ServerRoute struct {
	Route string `json:"route"`
	// Op is the benchmark op this route serves, or "" for a route the benchmark
	// did not drive.
	Op string `json:"op,omitempty"`
	// CountTotal is the route's since-boot request count; CountDelta is how many
	// of them this scenario contributed.
	CountTotal  uint64  `json:"count_total"`
	CountDelta  int64   `json:"count_delta"`
	P50MS       float64 `json:"p50_ms"`
	P95MS       float64 `json:"p95_ms"`
	P99MS       float64 `json:"p99_ms"`
	MaxMS       float64 `json:"max_ms"`
	WindowCount int     `json:"window_count"`
	Note        string  `json:"note,omitempty"`
}

// ServerView is the server-side block of one scenario's result.
type ServerView struct {
	Available         bool    `json:"available"`
	CountersAvailable bool    `json:"counters_available"`
	Windowed          bool    `json:"windowed"`
	WindowSeconds     float64 `json:"window_seconds"`
	// PercentilesAreWindowed records whether the server's percentiles cover a
	// recency window or all traffic since boot. Either way they cover ALL of that
	// traffic, not only this scenario's — a reader of the file should not have to
	// know the metrics implementation to interpret the numbers.
	PercentilesAreWindowed bool          `json:"percentiles_are_windowed"`
	Routes                 []ServerRoute `json:"routes"`
	ClaimsDelta            int64         `json:"claims_delta"`
	ClaimConflictsDelta    int64         `json:"claim_conflicts_delta"`
	TTLExpiriesDelta       int64         `json:"ttl_expiries_delta"`
	Note                   string        `json:"note,omitempty"`
}

// opRoutes maps each benchmark op onto the chi route pattern that serves it.
//
// task_claim, claim_conflict and task_complete all share ONE route
// (PATCH /api/canvas/actions/{id}) because they are the same endpoint with
// different bodies. The server therefore cannot report a claim-only p95, and the
// server-side claim assertion is evaluated against a route whose samples include
// completes and conflicts. That is a real limitation of asserting a per-op target
// against per-route metrics, and it is annotated in the results file rather than
// papered over.
var opRoutes = map[string]string{
	opConnect:       "POST /api/mcp/auth",
	opQueueList:     "GET /api/canvas/actions",
	opTaskGet:       "GET /api/canvas/actions/{id}",
	opContextGet:    "GET /api/canvas/context",
	opClaim:         "PATCH /api/canvas/actions/{id}",
	opClaimConflict: "PATCH /api/canvas/actions/{id}",
	opClaimStale:    "PATCH /api/canvas/actions/{id}",
	opComplete:      "PATCH /api/canvas/actions/{id}",
	opStatusPost:    "POST /api/canvas/{code}/tasks/{id}/status",
	opSeedBatch:     "POST /api/canvas/actions/batch",
}

const sharedRouteNote = "shared route: these samples cover task_claim, claim_conflict AND task_complete — the server cannot separate them"

// buildServerView folds a before/after scrape pair into the results block. Pure
// — unit tested.
func buildServerView(before, after serverScrape) ServerView {
	if !after.Available {
		return ServerView{Available: false, Note: after.Note}
	}
	view := ServerView{
		Available:              true,
		CountersAvailable:      after.CountersAvailable,
		Windowed:               after.Windowed,
		WindowSeconds:          after.WindowSeconds,
		PercentilesAreWindowed: after.Windowed,
		Note:                   after.Note,
	}
	if !after.Windowed {
		view.Note = joinNotes(view.Note,
			"this server reports ALL-TIME percentiles (no recency window) — its route p95s include every request since the process booted, so read count_delta to judge how much of that is this scenario")
	}
	if after.CountersAvailable && before.CountersAvailable {
		view.ClaimsDelta = int64(after.Claims) - int64(before.Claims)
		view.ClaimConflictsDelta = int64(after.ClaimConflicts) - int64(before.ClaimConflicts)
		view.TTLExpiriesDelta = int64(after.TTLExpiries) - int64(before.TTLExpiries)
	}

	// One row per route the benchmark drives, in a stable order so two baselines
	// diff line-for-line.
	seen := map[string]bool{}
	for _, op := range append([]string{opConnect}, append(append([]string{}, taskOps...), opSeedBatch)...) {
		route, ok := opRoutes[op]
		if !ok || seen[route] {
			continue
		}
		seen[route] = true
		row := ServerRoute{Route: route, Op: op}
		if route == opRoutes[opClaim] {
			row.Op = opClaim
			row.Note = sharedRouteNote
		}
		s, present := after.Routes[route]
		if !present {
			row.Note = joinNotes(row.Note, "route absent from /api/metrics — the server never served it")
			view.Routes = append(view.Routes, row)
			continue
		}
		row.P50MS = s.P50MS
		row.P95MS = s.P95MS
		row.P99MS = s.P99MS
		row.MaxMS = s.MaxMS
		row.WindowCount = s.WindowCount
		row.CountTotal = s.Count
		row.CountDelta = int64(s.Count) - int64(before.Routes[route].Count)
		view.Routes = append(view.Routes, row)
	}
	return view
}

// serverP95 returns the server-side p95 for an op, and whether it is available.
//
// "Available" means the route has samples the percentile actually describes: on
// a windowed server that means samples inside the window (an empty window is
// stale, not fast), and on an all-time server it means the route was served at
// all. Anything else returns false so the assertion table skips rather than
// reporting a route the server never touched as an instant 0ms pass.
func (v ServerView) serverP95(op string) (float64, bool) {
	route, ok := opRoutes[op]
	if !ok || !v.Available {
		return 0, false
	}
	for _, r := range v.Routes {
		if r.Route != route {
			continue
		}
		if v.Windowed && r.WindowCount == 0 {
			return 0, false
		}
		if r.CountTotal == 0 {
			return 0, false
		}
		return r.P95MS, true
	}
	return 0, false
}

func joinNotes(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	return a + "; " + b
}

// scrapeTimeout is generous: /api/metrics sorts every series at scrape time and
// the box may be busy with 256 in-flight agent requests.
const scrapeTimeout = 20 * time.Second
