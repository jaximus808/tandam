package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/agentcanvas/api/internal/metrics"
	postgrest "github.com/supabase-community/postgrest-go"
)

// Metrics history storage (migration 0040 / TDM-94): the persisted series behind
// GET /api/metrics/history, plus the cmd/loadtest baseline run history.
//
// DEPENDENCY DIRECTION. This file imports internal/metrics, not the other way
// round, and that is the deliberate choice: the row types (metrics.SnapshotRow,
// metrics.LoadtestRunRow) and the projection that produces them are metrics
// domain knowledge — "the worst windowed route p95", "counters are cumulative
// since boot" — so they live with the registry that defines those meanings. This
// file only knows columns. internal/metrics imports nothing from store, so the
// graph stays acyclic and a metrics-only test needs no database.
//
// PRIVACY. Nothing here is keyed by canvas, and metrics_snapshots has no
// canvas_id column to key by. Route strings are chi ROUTE PATTERNS; every counter
// is a process-wide scalar. That is the same guarantee the open /api/metrics
// endpoint already makes — persisting it must not widen it. The READ path is
// nonetheless owner-gated (api.RequireMetricsOwner) because the accumulated
// series discloses deploy timing and load ceilings, which a single instantaneous
// snapshot does not.

// metricsSnapshotCols is the read projection. `payload` is EXCLUDED: it is a few
// KB of jsonb per row and a 30-day read is ~43k rows, so selecting it would turn
// a chart request into hundreds of megabytes over the wire to render numbers that
// are already in the scalar columns. Payload exists for one-row forensics
// (GetMetricsSnapshotPayload), not for the series.
const metricsSnapshotCols = "id,captured_at,process_started_at,uptime_seconds,window_seconds," +
	"requests_total,route_p95_ms,route_p95_route,route_p95_method,fanout_p95_ms," +
	"claims,claim_conflicts,ttl_expiries,fenced_writes,webhook_ok,webhook_failed,webhook_dead,ws_clients"

const loadtestRunCols = "id,run_id,scenario,schema_version,started_at,finished_at,api,git_rev,git_dirty," +
	"live_agents,measured_seconds,task_ops_per_sec,error_rate,claim_p95_ms,queue_p95_ms," +
	"assertions_passed,assertions_failed,aborted,skipped,notes,created_at"

// maxMetricsSnapshotRows bounds one history read regardless of the window asked
// for. At the 60s default scrape this is ~5 days of rows; a wider window still
// returns (the newest rows, so the chart is current) rather than erroring, which
// is why the response reports `truncated` instead of failing. It exists so a
// stray ?hours=100000 cannot ask Supabase for the whole table.
const maxMetricsSnapshotRows = 7200

// ── DB row types ──────────────────────────────────────────────────────────────

type dbMetricsSnapshot struct {
	ID               string  `json:"id"`
	CapturedAt       string  `json:"captured_at"`
	ProcessStartedAt string  `json:"process_started_at"`
	UptimeSeconds    float64 `json:"uptime_seconds"`
	WindowSeconds    float64 `json:"window_seconds"`
	RequestsTotal    int64   `json:"requests_total"`
	RouteP95MS       float64 `json:"route_p95_ms"`
	RouteP95Route    string  `json:"route_p95_route"`
	RouteP95Method   string  `json:"route_p95_method"`
	FanoutP95MS      float64 `json:"fanout_p95_ms"`
	Claims           int64   `json:"claims"`
	ClaimConflicts   int64   `json:"claim_conflicts"`
	TTLExpiries      int64   `json:"ttl_expiries"`
	FencedWrites     int64   `json:"fenced_writes"`
	WebhookOK        int64   `json:"webhook_ok"`
	WebhookFailed    int64   `json:"webhook_failed"`
	WebhookDead      int64   `json:"webhook_dead"`
	WSClients        int     `json:"ws_clients"`
}

type dbLoadtestRun struct {
	ID               string  `json:"id"`
	RunID            string  `json:"run_id"`
	Scenario         string  `json:"scenario"`
	SchemaVersion    string  `json:"schema_version"`
	StartedAt        string  `json:"started_at"`
	FinishedAt       string  `json:"finished_at"`
	API              string  `json:"api"`
	GitRev           string  `json:"git_rev"`
	GitDirty         bool    `json:"git_dirty"`
	LiveAgents       int     `json:"live_agents"`
	MeasuredSeconds  float64 `json:"measured_seconds"`
	TaskOpsPerSec    float64 `json:"task_ops_per_sec"`
	ErrorRate        float64 `json:"error_rate"`
	ClaimP95MS       float64 `json:"claim_p95_ms"`
	QueueP95MS       float64 `json:"queue_p95_ms"`
	AssertionsPassed int     `json:"assertions_passed"`
	AssertionsFailed int     `json:"assertions_failed"`
	Aborted          bool    `json:"aborted"`
	Skipped          bool    `json:"skipped"`
	Notes            string  `json:"notes"`
	CreatedAt        string  `json:"created_at"`
}

// MetricsSnapshot is one persisted scrape as read back for charting.
//
// The counter fields are CUMULATIVE SINCE THE PROCESS BOOTED (see
// ProcessStartedAt) — a consumer plots per-interval deltas and must break the
// series wherever ProcessStartedAt changes. The store returns them raw rather
// than pre-differenced on purpose: differencing needs a decision about what to do
// at a restart boundary, and that decision belongs to whoever is drawing the
// chart, not to the read.
type MetricsSnapshot struct {
	CapturedAt time.Time `json:"capturedAt"`
	// ProcessStartedAt is the series-break marker AND the deploy marker: counters
	// reset and histograms empty wherever it changes.
	ProcessStartedAt time.Time `json:"processStartedAt"`
	UptimeSeconds    float64   `json:"uptimeSeconds"`
	WindowSeconds    float64   `json:"windowSeconds"`
	RequestsTotal    int64     `json:"requestsTotal"`
	RouteP95MS       float64   `json:"routeP95Ms"`
	RouteP95Route    string    `json:"routeP95Route"`
	RouteP95Method   string    `json:"routeP95Method"`
	FanoutP95MS      float64   `json:"fanoutP95Ms"`
	Claims           int64     `json:"claims"`
	ClaimConflicts   int64     `json:"claimConflicts"`
	TTLExpiries      int64     `json:"ttlExpiries"`
	FencedWrites     int64     `json:"fencedWrites"`
	WebhookOK        int64     `json:"webhookOk"`
	WebhookFailed    int64     `json:"webhookFailed"`
	WebhookDead      int64     `json:"webhookDead"`
	WSClients        int       `json:"wsClients"`
}

// LoadtestRun is one (run, scenario) baseline as read back for the run history.
type LoadtestRun struct {
	RunID            string    `json:"runId"`
	Scenario         string    `json:"scenario"`
	SchemaVersion    string    `json:"schemaVersion"`
	StartedAt        time.Time `json:"startedAt"`
	FinishedAt       time.Time `json:"finishedAt"`
	API              string    `json:"api"`
	GitRev           string    `json:"gitRev"`
	GitDirty         bool      `json:"gitDirty"`
	LiveAgents       int       `json:"liveAgents"`
	MeasuredSeconds  float64   `json:"measuredSeconds"`
	TaskOpsPerSec    float64   `json:"taskOpsPerSec"`
	ErrorRate        float64   `json:"errorRate"`
	ClaimP95MS       float64   `json:"claimP95Ms"`
	QueueP95MS       float64   `json:"queueP95Ms"`
	AssertionsPassed int       `json:"assertionsPassed"`
	AssertionsFailed int       `json:"assertionsFailed"`
	Aborted          bool      `json:"aborted"`
	Skipped          bool      `json:"skipped"`
	Notes            string    `json:"notes"`
	CreatedAt        time.Time `json:"createdAt"`
}

func toMetricsSnapshot(r dbMetricsSnapshot) *MetricsSnapshot {
	return &MetricsSnapshot{
		CapturedAt:       parseTime(r.CapturedAt),
		ProcessStartedAt: parseTime(r.ProcessStartedAt),
		UptimeSeconds:    r.UptimeSeconds,
		WindowSeconds:    r.WindowSeconds,
		RequestsTotal:    r.RequestsTotal,
		RouteP95MS:       r.RouteP95MS,
		RouteP95Route:    r.RouteP95Route,
		RouteP95Method:   r.RouteP95Method,
		FanoutP95MS:      r.FanoutP95MS,
		Claims:           r.Claims,
		ClaimConflicts:   r.ClaimConflicts,
		TTLExpiries:      r.TTLExpiries,
		FencedWrites:     r.FencedWrites,
		WebhookOK:        r.WebhookOK,
		WebhookFailed:    r.WebhookFailed,
		WebhookDead:      r.WebhookDead,
		WSClients:        r.WSClients,
	}
}

func toLoadtestRun(r dbLoadtestRun) *LoadtestRun {
	return &LoadtestRun{
		RunID:            r.RunID,
		Scenario:         r.Scenario,
		SchemaVersion:    r.SchemaVersion,
		StartedAt:        parseTime(r.StartedAt),
		FinishedAt:       parseTime(r.FinishedAt),
		API:              r.API,
		GitRev:           r.GitRev,
		GitDirty:         r.GitDirty,
		LiveAgents:       r.LiveAgents,
		MeasuredSeconds:  r.MeasuredSeconds,
		TaskOpsPerSec:    r.TaskOpsPerSec,
		ErrorRate:        r.ErrorRate,
		ClaimP95MS:       r.ClaimP95MS,
		QueueP95MS:       r.QueueP95MS,
		AssertionsPassed: r.AssertionsPassed,
		AssertionsFailed: r.AssertionsFailed,
		Aborted:          r.Aborted,
		Skipped:          r.Skipped,
		Notes:            r.Notes,
		CreatedAt:        parseTime(r.CreatedAt),
	}
}

// ── metrics_snapshots ─────────────────────────────────────────────────────────

// InsertMetricsSnapshot appends one scrape. Implements metrics.SnapshotSink.
//
// return=minimal: the collector has nothing to do with the stored row, and asking
// PostgREST to echo a few KB of payload back on every scrape is pure waste.
func (s *supabaseStore) InsertMetricsSnapshot(_ context.Context, row metrics.SnapshotRow) error {
	payload := row.Payload
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	insert := map[string]any{
		"captured_at":        tsFmt(row.CapturedAt),
		"process_started_at": tsFmt(row.ProcessStartedAt),
		"uptime_seconds":     row.UptimeSeconds,
		"window_seconds":     row.WindowSeconds,
		"requests_total":     row.RequestsTotal,
		"route_p95_ms":       row.RouteP95MS,
		"route_p95_route":    row.RouteP95Route,
		"route_p95_method":   row.RouteP95Method,
		"fanout_p95_ms":      row.FanoutP95MS,
		"claims":             row.Claims,
		"claim_conflicts":    row.ClaimConflicts,
		"ttl_expiries":       row.TTLExpiries,
		"fenced_writes":      row.FencedWrites,
		"webhook_ok":         row.WebhookOK,
		"webhook_failed":     row.WebhookFailed,
		"webhook_dead":       row.WebhookDead,
		"ws_clients":         row.WSClients,
		"payload":            payload,
	}
	return s.exec(s.client.From("metrics_snapshots").Insert(insert, false, "", "minimal", ""))
}

// PruneMetricsSnapshots enforces retention. Implements metrics.SnapshotSink.
func (s *supabaseStore) PruneMetricsSnapshots(_ context.Context, before time.Time) (int, error) {
	_, count, err := s.client.From("metrics_snapshots").
		Delete("", "exact").
		Lt("captured_at", tsFmt(before)).
		Execute()
	if err != nil {
		return 0, err
	}
	return int(count), nil
}

// ListMetricsSnapshots returns snapshots captured at or after `since`, OLDEST
// FIRST — chart order, so the caller never has to reverse a 43k-row slice.
//
// The row cap is applied to the NEWEST rows (order desc + limit, then reversed)
// so an over-wide window degrades to "the most recent maxMetricsSnapshotRows",
// which is the useful half. `truncated` tells the caller the window was clipped
// so it can say so rather than silently mislabel the x-axis.
func (s *supabaseStore) ListMetricsSnapshots(_ context.Context, since time.Time, limit int) (rows []*MetricsSnapshot, truncated bool, err error) {
	if limit <= 0 || limit > maxMetricsSnapshotRows {
		limit = maxMetricsSnapshotRows
	}
	var dbRows []dbMetricsSnapshot
	q := s.client.From("metrics_snapshots").Select(metricsSnapshotCols, "", false)
	if !since.IsZero() {
		q = q.Gte("captured_at", tsFmt(since))
	}
	if _, err := q.
		Order("captured_at", &postgrest.OrderOpts{Ascending: false}).
		Limit(limit, "").
		ExecuteTo(&dbRows); err != nil {
		return nil, false, err
	}
	out := make([]*MetricsSnapshot, 0, len(dbRows))
	for i := len(dbRows) - 1; i >= 0; i-- { // desc → asc
		out = append(out, toMetricsSnapshot(dbRows[i]))
	}
	return out, len(dbRows) == limit, nil
}

// GetMetricsSnapshotPayload returns the newest snapshot's full stored payload —
// the forensic read the series projection leaves out ("which route was slow at
// 04:00", "what was the p99"). One row, so the jsonb cost is bounded.
func (s *supabaseStore) GetMetricsSnapshotPayload(_ context.Context, at time.Time) (json.RawMessage, time.Time, error) {
	var rows []struct {
		CapturedAt string          `json:"captured_at"`
		Payload    json.RawMessage `json:"payload"`
	}
	q := s.client.From("metrics_snapshots").Select("captured_at,payload", "", false)
	if !at.IsZero() {
		q = q.Lte("captured_at", tsFmt(at))
	}
	if _, err := q.
		Order("captured_at", &postgrest.OrderOpts{Ascending: false}).
		Limit(1, "").
		ExecuteTo(&rows); err != nil {
		return nil, time.Time{}, err
	}
	if len(rows) == 0 {
		return nil, time.Time{}, ErrMetricsSnapshotNotFound
	}
	return rows[0].Payload, parseTime(rows[0].CapturedAt), nil
}

// ── loadtest_runs ─────────────────────────────────────────────────────────────

// UpsertLoadtestRuns writes published baseline rows. Implements
// metrics.LoadtestSink.
//
// UPSERT on (run_id, scenario) rather than insert: publishing is a retryable HTTP
// call and a baseline file can legitimately be re-POSTed (a failed -publish, a
// backfill of the files already in cmd/loadtest/baselines/). Doubling the history
// on a retry would corrupt the exact comparison this table exists to make. One
// bulk call, not a loop — same reason the batch paths in supabase.go take one
// round trip.
func (s *supabaseStore) UpsertLoadtestRuns(_ context.Context, rows []metrics.LoadtestRunRow) error {
	if len(rows) == 0 {
		return nil
	}
	insert := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		if row.RunID == "" || row.Scenario == "" {
			// The unique key IS the identity; a row without one cannot be
			// deduplicated and would accumulate a duplicate on every republish.
			return fmt.Errorf("loadtest run: run_id and scenario are required (got %q/%q)", row.RunID, row.Scenario)
		}
		payload := row.Payload
		if len(payload) == 0 {
			payload = json.RawMessage(`{}`)
		}
		insert = append(insert, map[string]any{
			"run_id":            row.RunID,
			"scenario":          row.Scenario,
			"schema_version":    row.Schema,
			"started_at":        tsFmt(row.StartedAt),
			"finished_at":       tsFmt(row.FinishedAt),
			"api":               row.API,
			"git_rev":           row.GitRev,
			"git_dirty":         row.GitDirty,
			"live_agents":       row.LiveAgents,
			"measured_seconds":  row.MeasuredSeconds,
			"task_ops_per_sec":  row.TaskOpsPerSec,
			"error_rate":        row.ErrorRate,
			"claim_p95_ms":      row.ClaimP95MS,
			"queue_p95_ms":      row.QueueP95MS,
			"assertions_passed": row.AssertionsPassed,
			"assertions_failed": row.AssertionsFailed,
			"aborted":           row.Aborted,
			"skipped":           row.Skipped,
			"notes":             row.Notes,
			"payload":           payload,
		})
	}
	return s.exec(s.client.From("loadtest_runs").
		Insert(insert, true, "run_id,scenario", "minimal", ""))
}

// ListLoadtestRuns returns the baseline history NEWEST FIRST — this one is read
// as a table, not a left-to-right chart, and "what did the last run say" is the
// question asked of it. Pass scenario="" for every scenario.
func (s *supabaseStore) ListLoadtestRuns(_ context.Context, scenario string, limit int) ([]*LoadtestRun, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	q := s.client.From("loadtest_runs").Select(loadtestRunCols, "", false)
	if scenario != "" {
		q = q.Eq("scenario", scenario)
	}
	var dbRows []dbLoadtestRun
	if _, err := q.
		Order("started_at", &postgrest.OrderOpts{Ascending: false}).
		Limit(limit, "").
		ExecuteTo(&dbRows); err != nil {
		return nil, err
	}
	out := make([]*LoadtestRun, 0, len(dbRows))
	for _, r := range dbRows {
		out = append(out, toLoadtestRun(r))
	}
	return out, nil
}
