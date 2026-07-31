package metrics

import (
	"context"
	"encoding/json"
	"sort"
	"time"
)

// TDM-94: the persistence half of this package.
//
// The Registry above is deliberately in-memory — a recency-weighted ring that
// dies with the process. That is the right shape for "how is this process
// behaving right now" and the wrong shape for every question with a "since" in
// it: is p95 claim latency worse than last week, did the deploy an hour ago move
// fan-out, is the claim-conflict rate climbing as the fleet grows. Those need a
// SERIES, and a series needs rows.
//
// The Collector is the seam that produces them: on an interval it takes the same
// Snapshot the open endpoint serves, projects it to a flat row, and hands it to a
// sink. It adds nothing to the hot path — a scrape is one Snapshot() call and one
// INSERT on a timer, off every request goroutine.
//
// # What the Registry does NOT stop being
//
// The Registry stays the source of truth for the live numbers, and the collector
// stays a pure reader of it: no method here records anything, so metrics cannot
// become wrong because persistence is off, slow, or failing. A sink error is
// logged and dropped — a gap in the history, never a dropped request.
//
// # Privacy
//
// SnapshotRow is a projection of Snapshot and can only ever be as revealing as
// the open endpoint already is: route PATTERNS, process-wide scalars, gauge
// counts. Nothing canvas-shaped exists in this package to leak. The reason the
// READ path is nonetheless gated (see api.RequireMetricsOwner) is different: the
// accumulated series exposes deploy timing and load ceilings, which is business
// information the instantaneous snapshot does not give away.

// DefaultSnapshotInterval is how often the collector scrapes.
//
// 60s is chosen against the Registry's 300s percentile window: scraping much
// faster than the window mostly re-reads the same samples (adjacent p95s are
// correlated, so the extra rows carry little information), and scraping slower
// than the window leaves blind spots where a latency spike lived entirely between
// two scrapes and is invisible forever. One scrape per fifth of the window keeps
// every spike represented in at least four rows while costing 1,440 rows/day.
const DefaultSnapshotInterval = time.Minute

// DefaultRetention is how much history is kept. See 0040_metrics_history.sql for
// the sizing argument; the short version is that 30 days covers "since the last
// deploy" and "versus last week", which are the only questions asked of it.
const DefaultRetention = 30 * 24 * time.Hour

// pruneEvery bounds how often the retention DELETE runs. Pruning on every scrape
// would issue 1,440 DELETEs a day to remove ~1,440 rows — the same work in
// hourly batches, with 1/60th the round-trips. Retention is a storage bound, not
// a deadline, so being up to an hour late is free.
const pruneEvery = time.Hour

// SnapshotRow is one persisted scrape: the Snapshot's headline numbers flattened
// into columns, plus the whole snapshot as JSON.
//
// BOTH, on purpose. The columns are what a 30-day chart reads, so that read is an
// index scan over scalars rather than a jsonb parse per row. Payload is what
// answers a question nobody extracted a column for — which route regressed, what
// the p99 was, which gauges existed — without a backfill. The columns are a
// projection of Payload and never a second source of truth.
type SnapshotRow struct {
	CapturedAt time.Time
	// ProcessStartedAt is the boot time of the process that produced the row, and
	// the field that makes the series readable. Counters below are cumulative
	// since boot and percentiles come from a ring that starts empty, so two rows
	// are comparable only while this is unchanged; where it changes, the process
	// restarted and a consumer must BREAK the series instead of diffing across it
	// (a naive diff reads as a large negative spike). It is also the deploy
	// marker: a deploy is exactly a change here.
	ProcessStartedAt time.Time
	UptimeSeconds    float64
	WindowSeconds    float64

	// RequestsTotal is the sum of every route's since-boot count. Cumulative.
	RequestsTotal uint64
	// RouteP95MS is the WORST route p95 in the window, with the route pattern and
	// method it belongs to — one headline "slowest thing anyone is hitting"
	// number. Routes with no samples in the window are ignored rather than
	// counted as 0ms, which would otherwise make an idle process look fast.
	RouteP95MS     float64
	RouteP95Route  string
	RouteP95Method string
	// FanoutP95MS is the WebSocket broadcast fan-out p95 (OpBroadcastFanout) —
	// invisible to the request-latency middleware because the hub loop is off the
	// request path, and the number that decides whether a fleet feels live.
	FanoutP95MS float64

	Claims         uint64
	ClaimConflicts uint64
	TTLExpiries    uint64
	FencedWrites   uint64
	WebhookOK      uint64
	WebhookFailed  uint64
	WebhookDead    uint64

	// WSClients is a GAUGE, not a counter: plot it as-is, never as a delta.
	WSClients int

	// Payload is the full Snapshot as served by the endpoint at CapturedAt.
	Payload json.RawMessage
}

// SnapshotSink is the persistence seam — narrow on purpose, so this package
// never learns what a database is and the store never learns what a percentile
// is. *store.Store implements it.
type SnapshotSink interface {
	InsertMetricsSnapshot(ctx context.Context, row SnapshotRow) error
	// PruneMetricsSnapshots deletes rows captured strictly before `before` and
	// reports how many went.
	PruneMetricsSnapshots(ctx context.Context, before time.Time) (int, error)
}

// ExtractRow projects a Snapshot onto the persisted row shape. Pure and
// total — no clock, no I/O — so the projection is testable on its own and the
// same function serves the collector and any backfill.
func ExtractRow(snap Snapshot) SnapshotRow {
	row := SnapshotRow{
		CapturedAt:       snap.GeneratedAt,
		ProcessStartedAt: snap.StartedAt,
		UptimeSeconds:    snap.UptimeSeconds,
		WindowSeconds:    snap.WindowSeconds,
		Claims:           snap.Counters.Claims,
		ClaimConflicts:   snap.Counters.ClaimConflicts,
		TTLExpiries:      snap.Counters.TTLExpiries,
		FencedWrites:     snap.Counters.FencedWrites,
		WebhookOK:        snap.Counters.WebhookOK,
		WebhookFailed:    snap.Counters.WebhookFailed,
		WebhookDead:      snap.Counters.WebhookDead,
		WSClients:        snap.Gauges[GaugeWSClients],
	}

	// Worst windowed route p95. Rows with WindowCount == 0 report p95 0 because
	// there is nothing in the window to summarize, not because they are fast, so
	// they are skipped. Ties break on route then method so the same snapshot
	// always yields the same row (map iteration order must not leak into data).
	best := -1
	for i, r := range snap.Routes {
		if r.WindowCount == 0 {
			continue
		}
		if best < 0 {
			best = i
			continue
		}
		b := snap.Routes[best]
		switch {
		case r.P95MS > b.P95MS:
			best = i
		case r.P95MS < b.P95MS:
		case r.Route != b.Route:
			if r.Route < b.Route {
				best = i
			}
		case r.Method < b.Method:
			best = i
		}
	}
	if best >= 0 {
		row.RouteP95MS = snap.Routes[best].P95MS
		row.RouteP95Route = snap.Routes[best].Route
		row.RouteP95Method = snap.Routes[best].Method
	}
	for _, r := range snap.Routes {
		row.RequestsTotal += r.Count
	}
	if fan, ok := snap.Ops[OpBroadcastFanout]; ok {
		row.FanoutP95MS = fan.P95MS
	}

	// Payload failing to marshal is not a reason to lose the row: the columns are
	// the part the charts read, so fall back to an empty object (the column is
	// NOT NULL) rather than dropping the scrape.
	if raw, err := json.Marshal(snap); err == nil {
		row.Payload = raw
	} else {
		row.Payload = json.RawMessage(`{}`)
	}
	return row
}

// GaugeWSClients is the gauge name the router registers for the hub's connected
// client count. Named here so the extraction and the router agree on the string.
const GaugeWSClients = "ws_clients"

// GaugeQueueWaiters is how many agents are parked on the queue long poll right
// now (TDM-148). Published because a wait that is never cleaned up is invisible
// otherwise: this number rising and never falling is the signature of leaked
// waiters, and is the difference between noticing that in a graph and noticing it
// when the process runs out of memory.
const GaugeQueueWaiters = "queue_waiters"

// Collector scrapes a Registry into a SnapshotSink on an interval, and enforces
// the retention window.
type Collector struct {
	reg       *Registry
	sink      SnapshotSink
	interval  time.Duration
	retention time.Duration
	now       func() time.Time
	logf      func(format string, args ...any)
}

// CollectorOption configures a Collector.
type CollectorOption func(*Collector)

// WithInterval sets the scrape interval. Non-positive values are ignored.
func WithInterval(d time.Duration) CollectorOption {
	return func(c *Collector) {
		if d > 0 {
			c.interval = d
		}
	}
}

// WithRetention sets how long rows are kept. ZERO DISABLES PRUNING — history
// grows forever, which is a deliberate choice a caller can make (a tiny local
// database, or an operator who wants to prune out of band), not a mistake to be
// silently corrected. Negative values are ignored.
func WithRetention(d time.Duration) CollectorOption {
	return func(c *Collector) {
		if d >= 0 {
			c.retention = d
		}
	}
}

// WithLogger replaces the log sink (nil-safe: ignored).
func WithLogger(logf func(format string, args ...any)) CollectorOption {
	return func(c *Collector) {
		if logf != nil {
			c.logf = logf
		}
	}
}

// withCollectorClock is test-only: drives CapturedAt/prune cutoffs
// deterministically. (Named apart from the metrics_test.go withClock helper,
// which drives a *Registry's clock rather than a collector's.)
func withCollectorClock(now func() time.Time) CollectorOption {
	return func(c *Collector) {
		if now != nil {
			c.now = now
		}
	}
}

// NewCollector builds a collector. It returns nil when there is nothing to do —
// no registry (metrics off) or no sink — so main can wire it unconditionally and
// Run on the nil value is a no-op, the same nil-tolerance the Registry has.
func NewCollector(reg *Registry, sink SnapshotSink, opts ...CollectorOption) *Collector {
	if reg == nil || sink == nil {
		return nil
	}
	c := &Collector{
		reg:       reg,
		sink:      sink,
		interval:  DefaultSnapshotInterval,
		retention: DefaultRetention,
		now:       time.Now,
		logf:      func(string, ...any) {},
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// Run scrapes until ctx is cancelled. Blocking; call it in a goroutine.
//
// It does NOT scrape immediately at boot: at t=0 every histogram is empty and
// every counter is 0, so that row is a guaranteed-useless outlier that also
// resets nothing (the deltas a consumer computes would start from a fabricated
// zero). The first row lands one interval in, describing a process that has
// actually served something.
func (c *Collector) Run(ctx context.Context) {
	if c == nil {
		return
	}
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	lastPrune := c.now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := c.scrape(ctx); err != nil {
				// A gap in the history, not a failed request. Logged so a
				// permanently-broken sink (missing migration, revoked key) is
				// visible rather than silently producing an empty chart.
				c.logf("metrics collector: snapshot insert failed: %v", err)
			}
			if c.retention <= 0 {
				continue
			}
			if now := c.now(); now.Sub(lastPrune) >= pruneEvery {
				lastPrune = now
				if _, err := c.sink.PruneMetricsSnapshots(ctx, now.Add(-c.retention)); err != nil {
					c.logf("metrics collector: retention prune failed: %v", err)
				}
			}
		}
	}
}

// scrape takes one snapshot and persists it.
func (c *Collector) scrape(ctx context.Context) error {
	row := ExtractRow(c.reg.Snapshot())
	// The Registry's clock is its own (tests drive it); the row's CapturedAt must
	// still be a real wall-clock instant for the series to be readable, so an
	// unset GeneratedAt is backfilled rather than stored as the zero time.
	if row.CapturedAt.IsZero() {
		row.CapturedAt = c.now().UTC()
	}
	return c.sink.InsertMetricsSnapshot(ctx, row)
}

// ── loadtest run history ──────────────────────────────────────────────────────

// LoadtestRunRow is one scenario's result from a cmd/loadtest run, flattened for
// storage.
//
// GRAIN IS THE SCENARIO, not the run: one invocation measures several
// concurrency points (agents-8, agents-64, …) and the series worth charting is
// per-point, because "ops/sec at 64 agents" is where a regression or a raised
// ceiling shows. Rolling a run into one row would average the points together and
// hide exactly that.
type LoadtestRunRow struct {
	RunID    string
	Scenario string
	Schema   string

	StartedAt  time.Time
	FinishedAt time.Time
	API        string
	GitRev     string
	GitDirty   bool

	LiveAgents      int
	MeasuredSeconds float64
	TaskOpsPerSec   float64
	ErrorRate       float64
	ClaimP95MS      float64
	QueueP95MS      float64

	AssertionsPassed int
	AssertionsFailed int
	Aborted          bool
	Skipped          bool
	Notes            string

	Payload json.RawMessage
}

// LoadtestReport is the subset of cmd/loadtest's Results that the ingest path
// reads.
//
// DELIBERATELY PARTIAL, and re-declared here rather than imported: the producer
// is package main in cmd/loadtest and cannot be imported at all, and even if it
// could, coupling the ingest endpoint to the full struct would make every
// harness-side field addition a server change. Unknown fields are ignored, so a
// newer loadtest build can always publish to an older server; `schema` is carried
// through so a reader can tell whether two rows mean the same thing.
type LoadtestReport struct {
	Schema string `json:"schema"`
	Run    struct {
		RunID     string   `json:"run_id"`
		StartedAt string   `json:"started_at"`
		API       string   `json:"api"`
		GitRev    string   `json:"git_rev"`
		GitDirty  bool     `json:"git_dirty"`
		Notes     []string `json:"notes"`
	} `json:"run"`
	Scenarios []LoadtestScenario `json:"scenarios"`
}

// LoadtestScenario is one concurrency point as published.
type LoadtestScenario struct {
	Name            string  `json:"name"`
	Skipped         bool    `json:"skipped"`
	SkipReason      string  `json:"skip_reason"`
	StartedAt       string  `json:"started_at"`
	FinishedAt      string  `json:"finished_at"`
	MeasuredSeconds float64 `json:"measured_seconds"`
	LiveAgents      int     `json:"live_agents"`
	TaskOpsPerSec   float64 `json:"task_ops_per_sec"`
	Ops             map[string]struct {
		Count  int     `json:"count"`
		Errors int     `json:"errors"`
		P95MS  float64 `json:"p95_ms"`
	} `json:"ops"`
	AssertionSummary struct {
		Passed int `json:"passed"`
		Failed int `json:"failed"`
	} `json:"assertion_summary"`
	Aborted     bool   `json:"aborted"`
	AbortReason string `json:"abort_reason"`

	// raw keeps this scenario's original JSON so payload round-trips every field
	// the struct above ignores.
	raw json.RawMessage
}

// ParseLoadtestReport decodes a published baseline file into rows, one per
// scenario.
//
// It is lenient by design — a baseline is evidence, and refusing a whole run
// because one scenario aborted or one timestamp is malformed would throw away the
// finding. Malformed timestamps fall back to the run's start; a scenario with no
// name is the only thing dropped, since (run_id, scenario) is its identity.
// Returns nil rows (no error) for a report with no scenarios.
func ParseLoadtestReport(raw []byte) ([]LoadtestRunRow, error) {
	var rep LoadtestReport
	if err := json.Unmarshal(raw, &rep); err != nil {
		return nil, err
	}
	// Re-walk for the per-scenario raw JSON: encoding/json cannot both decode into
	// a struct and hand back the original bytes for a nested element.
	var rawTop struct {
		Scenarios []json.RawMessage `json:"scenarios"`
	}
	_ = json.Unmarshal(raw, &rawTop)

	runStart := parseLoadtestTime(rep.Run.StartedAt, time.Time{})
	notes := ""
	if len(rep.Run.Notes) > 0 {
		notes = joinLines(rep.Run.Notes)
	}

	out := make([]LoadtestRunRow, 0, len(rep.Scenarios))
	for i, sc := range rep.Scenarios {
		if sc.Name == "" {
			continue
		}
		if i < len(rawTop.Scenarios) {
			sc.raw = rawTop.Scenarios[i]
		}
		if len(sc.raw) == 0 {
			sc.raw = json.RawMessage(`{}`)
		}
		started := parseLoadtestTime(sc.StartedAt, runStart)
		row := LoadtestRunRow{
			RunID:            rep.Run.RunID,
			Scenario:         sc.Name,
			Schema:           rep.Schema,
			StartedAt:        started,
			FinishedAt:       parseLoadtestTime(sc.FinishedAt, started),
			API:              rep.Run.API,
			GitRev:           rep.Run.GitRev,
			GitDirty:         rep.Run.GitDirty,
			LiveAgents:       sc.LiveAgents,
			MeasuredSeconds:  sc.MeasuredSeconds,
			TaskOpsPerSec:    sc.TaskOpsPerSec,
			AssertionsPassed: sc.AssertionSummary.Passed,
			AssertionsFailed: sc.AssertionSummary.Failed,
			Aborted:          sc.Aborted,
			Skipped:          sc.Skipped,
			Notes:            firstNonEmpty(sc.AbortReason, sc.SkipReason, notes),
			Payload:          sc.raw,
		}
		var ok, errs int
		for name, st := range sc.Ops {
			ok += st.Count
			errs += st.Errors
			switch name {
			case "task_claim":
				row.ClaimP95MS = st.P95MS
			case "queue_list":
				row.QueueP95MS = st.P95MS
			}
		}
		if ok+errs > 0 {
			row.ErrorRate = float64(errs) / float64(ok+errs)
		}
		out = append(out, row)
	}
	// Stable order so a re-publish writes the same rows in the same sequence.
	sort.SliceStable(out, func(i, j int) bool { return out[i].Scenario < out[j].Scenario })
	return out, nil
}

// LoadtestSink persists published baselines. Separate from SnapshotSink because
// the two have different writers (a timer vs an authenticated POST) and nothing
// needs both.
type LoadtestSink interface {
	// UpsertLoadtestRuns writes rows, replacing any with the same
	// (run_id, scenario) so re-publishing a baseline is idempotent.
	UpsertLoadtestRuns(ctx context.Context, rows []LoadtestRunRow) error
}

func parseLoadtestTime(s string, fallback time.Time) time.Time {
	if s == "" {
		return fallback
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC()
	}
	return fallback
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func joinLines(vals []string) string {
	out := ""
	for i, v := range vals {
		if i > 0 {
			out += "\n"
		}
		out += v
	}
	return out
}
