package metrics

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// TDM-94 — the persistence half. Two things are worth testing and they are
// different in kind:
//
//   - ExtractRow is a pure projection, so it is tested by asserting on the
//     numbers it produces. The interesting cases are all about what NOT to
//     believe: a route with no samples in the window reports p95 0, and treating
//     that as "fast" would make an idle process the winner of every chart.
//   - the Collector is a timer plus a sink, so it is tested for the sequence of
//     calls it makes, with a fake clock and a fake sink. No database, because the
//     package deliberately does not know what one is.

// fakeSink records what the collector writes.
type fakeSink struct {
	mu       sync.Mutex
	rows     []SnapshotRow
	prunes   []time.Time
	insErr   error
	pruneErr error
}

func (f *fakeSink) InsertMetricsSnapshot(_ context.Context, row SnapshotRow) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.insErr != nil {
		return f.insErr
	}
	f.rows = append(f.rows, row)
	return nil
}

func (f *fakeSink) PruneMetricsSnapshots(_ context.Context, before time.Time) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prunes = append(f.prunes, before)
	return 0, f.pruneErr
}

func (f *fakeSink) snapshot() ([]SnapshotRow, []time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]SnapshotRow(nil), f.rows...), append([]time.Time(nil), f.prunes...)
}

// ── ExtractRow ────────────────────────────────────────────────────────────────

func TestExtractRowFlattensSnapshot(t *testing.T) {
	reg := NewRegistry()
	clk := withClock(reg)
	reg.RegisterGauge(GaugeWSClients, func() int { return 7 })

	reg.Record("GET", "/api/fast", 5*time.Millisecond)
	reg.Record("GET", "/api/fast", 6*time.Millisecond)
	reg.Record("POST", "/api/slow", 300*time.Millisecond)
	reg.ObserveBroadcast(12 * time.Millisecond)
	reg.IncClaim()
	reg.IncClaim()
	reg.IncClaimConflict()
	reg.IncTTLExpiry()
	reg.IncFencedWrite()
	reg.ObserveWebhookDelivery(WebhookOutcomeOK)
	reg.ObserveWebhookDelivery(WebhookOutcomeDead)

	row := ExtractRow(reg.Snapshot())

	if row.RequestsTotal != 3 {
		t.Errorf("RequestsTotal = %d, want 3 (sum of every route's count)", row.RequestsTotal)
	}
	// The headline latency must be the WORST route, not the busiest one: /api/fast
	// has more traffic, /api/slow is what someone is waiting on.
	if row.RouteP95Route != "/api/slow" || row.RouteP95Method != "POST" {
		t.Errorf("worst route = %s %s, want POST /api/slow", row.RouteP95Method, row.RouteP95Route)
	}
	if row.RouteP95MS < 299 || row.RouteP95MS > 301 {
		t.Errorf("RouteP95MS = %v, want ~300", row.RouteP95MS)
	}
	if row.FanoutP95MS < 11 || row.FanoutP95MS > 13 {
		t.Errorf("FanoutP95MS = %v, want ~12", row.FanoutP95MS)
	}
	if row.WSClients != 7 {
		t.Errorf("WSClients = %d, want 7 (gauge is pulled, not a delta)", row.WSClients)
	}
	if row.Claims != 2 || row.ClaimConflicts != 1 || row.TTLExpiries != 1 || row.FencedWrites != 1 {
		t.Errorf("counters = %+v, want claims 2 / conflicts 1 / ttl 1 / fenced 1", row)
	}
	if row.WebhookOK != 1 || row.WebhookDead != 1 || row.WebhookFailed != 0 {
		t.Errorf("webhook counters = ok %d failed %d dead %d, want 1/0/1", row.WebhookOK, row.WebhookFailed, row.WebhookDead)
	}
	if !row.ProcessStartedAt.Equal(clk.now().UTC()) {
		t.Errorf("ProcessStartedAt = %s, want the registry's boot time %s", row.ProcessStartedAt, clk.now().UTC())
	}
	if row.WindowSeconds != DefaultWindow.Seconds() {
		t.Errorf("WindowSeconds = %v, want %v", row.WindowSeconds, DefaultWindow.Seconds())
	}

	// Payload must be the whole snapshot, so a question nobody extracted a column
	// for is still answerable later.
	var back Snapshot
	if err := json.Unmarshal(row.Payload, &back); err != nil {
		t.Fatalf("payload is not the snapshot JSON: %v", err)
	}
	if len(back.Routes) != 2 {
		t.Errorf("payload carried %d routes, want both", len(back.Routes))
	}
}

// A route whose samples have all aged out of the window reports p95 0 — because
// there is nothing to summarize, NOT because it is fast. Counting it would make
// every idle route the "best" one and the headline number meaningless.
func TestExtractRowIgnoresRoutesWithNoWindowSamples(t *testing.T) {
	reg := NewRegistry()
	clk := withClock(reg)

	reg.Record("GET", "/api/stale", 900*time.Millisecond)
	clk.advance(DefaultWindow + time.Second) // ages the sample out
	reg.Record("GET", "/api/live", 40*time.Millisecond)

	row := ExtractRow(reg.Snapshot())
	if row.RouteP95Route != "/api/live" {
		t.Fatalf("worst route = %q, want /api/live — a windowless route must not win with a p95 of 0", row.RouteP95Route)
	}
	// Count is deliberately NOT windowed, so the stale route still contributes.
	if row.RequestsTotal != 2 {
		t.Errorf("RequestsTotal = %d, want 2 (counts are since-boot, not windowed)", row.RequestsTotal)
	}
}

func TestExtractRowEmptyRegistry(t *testing.T) {
	row := ExtractRow(NewRegistry().Snapshot())
	if row.RouteP95Route != "" || row.RouteP95MS != 0 {
		t.Errorf("empty registry produced a worst route %q/%v, want none", row.RouteP95Route, row.RouteP95MS)
	}
	if string(row.Payload) == "" {
		t.Error("payload must never be empty — the column is NOT NULL")
	}
}

// Two routes tied on p95 must always resolve the same way: map iteration order
// must not leak into stored data, or the same snapshot yields different rows.
func TestExtractRowTieBreakIsDeterministic(t *testing.T) {
	first := ""
	for i := 0; i < 30; i++ {
		reg := NewRegistry()
		withClock(reg)
		reg.Record("GET", "/api/bbb", 50*time.Millisecond)
		reg.Record("GET", "/api/aaa", 50*time.Millisecond)
		reg.Record("POST", "/api/aaa", 50*time.Millisecond)
		got := ExtractRow(reg.Snapshot()).RouteP95Route
		if i == 0 {
			first = got
			continue
		}
		if got != first {
			t.Fatalf("tie broke to %q then %q — not deterministic", first, got)
		}
	}
	if first != "/api/aaa" {
		t.Errorf("tie broke to %q, want the lexicographically smaller /api/aaa", first)
	}
}

// ── Collector ─────────────────────────────────────────────────────────────────

func TestNewCollectorNilWhenNothingToDo(t *testing.T) {
	if c := NewCollector(nil, &fakeSink{}); c != nil {
		t.Error("no registry (metrics off) should give no collector")
	}
	if c := NewCollector(NewRegistry(), nil); c != nil {
		t.Error("no sink should give no collector")
	}
	// Run on the nil value must be a no-op, so main can wire it unconditionally.
	var nilCollector *Collector
	nilCollector.Run(context.Background())
}

func TestCollectorScrapesOnInterval(t *testing.T) {
	reg := NewRegistry()
	withClock(reg)
	reg.Record("GET", "/api/thing", 20*time.Millisecond)
	sink := &fakeSink{}

	c := NewCollector(reg, sink, WithInterval(time.Millisecond), WithRetention(0))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)

	waitFor(t, "a scrape", func() bool {
		rows, _ := sink.snapshot()
		return len(rows) >= 2
	})
	cancel()

	rows, prunes := sink.snapshot()
	if rows[0].RouteP95Route != "/api/thing" {
		t.Errorf("scraped row lost the route: %+v", rows[0])
	}
	if len(prunes) != 0 {
		t.Errorf("retention 0 must never prune, got %d prune calls", len(prunes))
	}
}

// A failing sink is a gap in the history, never a stalled collector: it must keep
// scraping so the series resumes the moment the sink recovers.
func TestCollectorKeepsRunningWhenSinkFails(t *testing.T) {
	reg := NewRegistry()
	withClock(reg)
	sink := &fakeSink{insErr: context.DeadlineExceeded}

	var mu sync.Mutex
	logged := 0
	c := NewCollector(reg, sink,
		WithInterval(time.Millisecond),
		WithRetention(0),
		WithLogger(func(string, ...any) { mu.Lock(); logged++; mu.Unlock() }),
	)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)

	waitFor(t, "repeated insert failures to be logged", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return logged >= 3
	})
}

func TestCollectorPrunesOnceAnHour(t *testing.T) {
	reg := NewRegistry()
	withClock(reg)
	sink := &fakeSink{}

	// A clock the test advances by an hour per read, so every tick crosses the
	// pruneEvery threshold and the retention cutoff is checkable.
	var mu sync.Mutex
	base := time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC)
	calls := 0
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		calls++
		return base.Add(time.Duration(calls) * time.Hour)
	}

	c := NewCollector(reg, sink,
		WithInterval(time.Millisecond),
		WithRetention(48*time.Hour),
		withCollectorClock(clock),
	)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)

	waitFor(t, "a prune", func() bool {
		_, prunes := sink.snapshot()
		return len(prunes) >= 1
	})
	cancel()

	_, prunes := sink.snapshot()
	// The cutoff must be retention behind the clock, not in front of it — a sign
	// error here silently deletes the whole table.
	if !prunes[0].Before(base) {
		t.Errorf("prune cutoff %s is not retention-behind the clock (base %s)", prunes[0], base)
	}
}

// ── ParseLoadtestReport ───────────────────────────────────────────────────────

// A trimmed but structurally faithful cmd/loadtest results file: two scenarios,
// one of them skipped, matching the shape of cmd/loadtest/baselines/*.json.
const loadtestFixture = `{
  "schema": "tandem.loadtest.v1",
  "run": {
    "run_id": "782255d8",
    "started_at": "2026-07-29T06:25:28.105783Z",
    "finished_at": "2026-07-29T06:28:23.452796Z",
    "api": "http://localhost:7891",
    "git_rev": "b75a4765c1d7fbd2c1dddc41f60f990944b9a981",
    "git_dirty": true,
    "notes": ["agents-8: op \"context_get\" could not be measured", "second note"]
  },
  "scenarios": [
    {
      "name": "agents-64",
      "started_at": "2026-07-29T06:26:00Z",
      "finished_at": "2026-07-29T06:28:00Z",
      "measured_seconds": 120,
      "live_agents": 64,
      "task_ops_per_sec": 31.4,
      "ops": {
        "task_claim": {"count": 90, "errors": 10, "p95_ms": 412.5},
        "queue_list": {"count": 100, "errors": 0, "p95_ms": 88.25}
      },
      "assertion_summary": {"passed": 4, "failed": 2},
      "extra_field_the_server_does_not_know": 1
    },
    {
      "name": "agents-8",
      "skipped": true,
      "skip_reason": "gated by the previous scenario",
      "started_at": "not a timestamp",
      "ops": {}
    }
  ]
}`

func TestParseLoadtestReport(t *testing.T) {
	rows, err := ParseLoadtestReport([]byte(loadtestFixture))
	if err != nil {
		t.Fatalf("ParseLoadtestReport: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want one per scenario", len(rows))
	}
	// Sorted by scenario for a stable re-publish.
	if rows[0].Scenario != "agents-64" || rows[1].Scenario != "agents-8" {
		t.Fatalf("rows not in stable scenario order: %s, %s", rows[0].Scenario, rows[1].Scenario)
	}

	got := rows[0]
	if got.RunID != "782255d8" || got.Schema != "tandem.loadtest.v1" {
		t.Errorf("provenance lost: run %q schema %q", got.RunID, got.Schema)
	}
	if got.GitRev == "" || !got.GitDirty {
		t.Errorf("git provenance lost: rev %q dirty %v", got.GitRev, got.GitDirty)
	}
	if got.LiveAgents != 64 || got.TaskOpsPerSec != 31.4 || got.MeasuredSeconds != 120 {
		t.Errorf("throughput fields wrong: %+v", got)
	}
	if got.ClaimP95MS != 412.5 || got.QueueP95MS != 88.25 {
		t.Errorf("gated op p95s wrong: claim %v queue %v", got.ClaimP95MS, got.QueueP95MS)
	}
	// 10 errors against 190 successes ACROSS EVERY OP — the same definition
	// cmd/loadtest's errorRate() uses, where `count` excludes errors. Getting this
	// wrong (dividing by one op's count, or by count alone) would silently inflate
	// or deflate every stored run.
	if got.ErrorRate < 0.049 || got.ErrorRate > 0.051 {
		t.Errorf("ErrorRate = %v, want 0.05 = 10/(190+10)", got.ErrorRate)
	}
	if got.AssertionsPassed != 4 || got.AssertionsFailed != 2 {
		t.Errorf("assertion tally wrong: %d/%d", got.AssertionsPassed, got.AssertionsFailed)
	}
	// Payload must round-trip fields the server's struct never declared, which is
	// the whole reason the ingest shape is allowed to be partial.
	var raw map[string]any
	if err := json.Unmarshal(got.Payload, &raw); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	if _, ok := raw["extra_field_the_server_does_not_know"]; !ok {
		t.Error("payload dropped a field the ingest struct does not declare")
	}

	// A skipped scenario is STORED — "this point could not run" is the finding,
	// and a missing row would read as a point never attempted.
	skipped := rows[1]
	if !skipped.Skipped || skipped.Notes != "gated by the previous scenario" {
		t.Errorf("skipped scenario mangled: %+v", skipped)
	}
	// Its unparseable started_at falls back to the run's start rather than the
	// zero time, so it still sorts into the history.
	if skipped.StartedAt.IsZero() {
		t.Error("bad timestamp should fall back to the run start, not the zero time")
	}
}

func TestParseLoadtestReportRejectsNonJSON(t *testing.T) {
	if _, err := ParseLoadtestReport([]byte("not json at all")); err == nil {
		t.Fatal("want an error for a non-JSON body")
	}
}

func TestParseLoadtestReportSkipsUnnamedScenarios(t *testing.T) {
	rows, err := ParseLoadtestReport([]byte(`{"run":{"run_id":"x"},"scenarios":[{"name":""},{"name":"ok"}]}`))
	if err != nil {
		t.Fatalf("ParseLoadtestReport: %v", err)
	}
	// (run_id, scenario) IS the dedup key, so a nameless scenario cannot be
	// upserted and would duplicate on every republish.
	if len(rows) != 1 || rows[0].Scenario != "ok" {
		t.Fatalf("got %+v, want only the named scenario", rows)
	}
}

// waitFor polls cond until it holds, so the timer-driven tests don't sleep for a
// fixed duration.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}
