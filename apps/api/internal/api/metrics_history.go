package api

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/metrics"
	"github.com/agentcanvas/api/internal/store"
)

// TDM-94 — the read side of the metrics history (migration 0040).
//
// GET /api/metrics is a live, OPEN, in-memory snapshot: aggregates only, gone at
// restart. These endpoints serve the SERIES behind it, which is a different thing
// in two ways that both matter:
//
//   - it survives restarts, so "is p95 claim latency worse than last week" and
//     "what changed since the last deploy" become answerable at all;
//   - it is NOT open. The instantaneous snapshot gives away nothing an
//     unauthenticated caller couldn't infer by timing a few requests. The
//     accumulated series does: restart times are a deploy log, task_ops_per_sec
//     over time is a capacity ceiling, error_rate under load is a weakness map.
//     None of that is user data, all of it is operator business, so the read is
//     behind an owner allowlist.
//
// Endpoints (all owner-gated):
//
//	GET  /api/metrics/history            the snapshot series (?hours, ?format=csv)
//	GET  /api/metrics/history/latest     one snapshot's full stored payload
//	GET  /api/metrics/loadtest           cmd/loadtest baseline run history (?scenario, ?format=csv)
//	POST /api/metrics/loadtest           publish a baseline file (cmd/loadtest -publish)

// metricsOwnerEnv names the allowlist: a comma-separated list of the email
// addresses allowed to read the metrics history and publish baselines.
//
// AN ENV VAR RATHER THAN A DB ROLE, and read here rather than threaded through
// config.Config, for the same reason GH_STATUS_TOKEN is (see github_status.go):
// this is deployment-operator configuration for a single-operator console, not a
// product concept. Tandem has no admin/superuser model — "owner" everywhere else
// in this codebase means *canvas* owner — and inventing a users.is_admin column
// to gate one page would be a schema commitment to a role hierarchy nobody has
// designed. An allowlist is the smallest thing that is actually a gate, and it
// can be deleted without a migration when a real role model arrives.
const metricsOwnerEnv = "METRICS_OWNER_EMAILS"

// metricsOwnerEmails parses the allowlist, lowercased and trimmed. Read per
// request rather than cached at boot so flipping the var takes a restart of
// nothing (and so a test can set it) — the cost is one small env read on a route
// nobody hammers.
func metricsOwnerEmails() []string {
	raw := os.Getenv(metricsOwnerEnv)
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if e := strings.ToLower(strings.TrimSpace(p)); e != "" {
			out = append(out, e)
		}
	}
	return out
}

// RequireMetricsOwner gates the metrics-history routes on the METRICS_OWNER_EMAILS
// allowlist. Layer it AFTER OptionalUser, which is what resolves the credential.
//
// OptionalUser and not RequireUser on purpose: RequireUser accepts a session
// COOKIE only, and one of these routes is called by a CLI (cmd/loadtest
// -publish). OptionalUser also accepts a personal access token and an OAuth
// access token, so the same gate serves the browser page and `-publish` with a
// TANDEM_PAT, with no second credential concept.
//
// The three refusals are deliberately different:
//
//	404 — the allowlist is UNSET. The feature is not configured on this
//	      deployment, and a 403 would advertise that a metrics console exists
//	      here. Fails closed: forgetting the var never exposes the history.
//	401 — no credential at all. Sign in (or send a token).
//	403 — a real, valid user who is not an owner. Their credential is fine; the
//	      answer is still no, and saying so beats a misleading 401 that invites
//	      them to re-authenticate.
func RequireMetricsOwner(s store.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			owners := metricsOwnerEmails()
			if len(owners) == 0 {
				http.NotFound(w, r)
				return
			}
			uid, ok := UserIDFromCtx(r.Context())
			if !ok {
				writeError(w, http.StatusUnauthorized, "not signed in")
				return
			}
			user, err := s.GetUserByID(r.Context(), uid)
			if err != nil || user == nil {
				// A live credential whose user row cannot be read is not an
				// authorization decision we can make — refuse rather than guess.
				writeError(w, http.StatusForbidden, "metrics history is restricted")
				return
			}
			email := strings.ToLower(strings.TrimSpace(user.Email))
			for _, owner := range owners {
				if email != "" && email == owner {
					next.ServeHTTP(w, r)
					return
				}
			}
			writeError(w, http.StatusForbidden, "metrics history is restricted")
		})
	}
}

// defaultHistoryHours is the window when none is asked for: one day, the
// "what has this deploy been doing" question.
const defaultHistoryHours = 24

// maxHistoryHours caps the requested window at ~90 days — comfortably wider than
// the 30-day retention, so the cap never truncates real data and exists only to
// keep an absurd ?hours from turning into an unbounded timestamp.
const maxHistoryHours = 24 * 90

// metricsHistoryResponse is the series plus the two things a chart would
// otherwise have to derive, computed here because both are cheap server-side and
// both are easy to get wrong client-side.
type metricsHistoryResponse struct {
	Since       time.Time `json:"since"`
	Until       time.Time `json:"until"`
	WindowHours float64   `json:"windowHours"`
	Count       int       `json:"count"`
	// Truncated means the row cap clipped the window and Since is not really where
	// the returned data begins — say so rather than mislabel the axis.
	Truncated bool `json:"truncated"`
	// Restarts are the boundaries where process_started_at changed, i.e. where the
	// cumulative counters reset and the histograms emptied. A consumer MUST break
	// its lines here instead of diffing across (a diff across a restart reads as a
	// large negative spike), and since a deploy is exactly a restart, these double
	// as the deploy markers that answer "what changed since the last deploy".
	Restarts  []metricsRestart         `json:"restarts"`
	Snapshots []*store.MetricsSnapshot `json:"snapshots"`
}

type metricsRestart struct {
	// At is the first snapshot captured by the new process, so it is an upper
	// bound on the restart instant (the true restart is between At and the
	// previous snapshot).
	At               time.Time `json:"at"`
	ProcessStartedAt time.Time `json:"processStartedAt"`
	// Index into Snapshots, so a chart can break the line without re-scanning.
	Index int `json:"index"`
}

// MetricsHistory serves GET /api/metrics/history.
//
//	?hours=24        window, default 24, capped at maxHistoryHours
//	?format=csv      download the same rows as CSV instead of JSON
//
// Counters are returned CUMULATIVE, not pre-differenced. Differencing requires
// deciding what happens at a restart boundary, and that decision belongs to the
// consumer — which is why Restarts is handed over too, rather than the server
// silently picking one interpretation and shipping numbers nobody can check.
func (h *Handler) MetricsHistory(w http.ResponseWriter, r *http.Request) {
	hours := defaultHistoryHours
	if raw := strings.TrimSpace(r.URL.Query().Get("hours")); raw != "" {
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "hours must be a positive number")
			return
		}
		if parsed > maxHistoryHours {
			parsed = maxHistoryHours
		}
		hours = int(parsed)
		if hours < 1 {
			hours = 1
		}
	}
	now := time.Now().UTC()
	since := now.Add(-time.Duration(hours) * time.Hour)

	rows, truncated, err := h.store.ListMetricsSnapshots(r.Context(), since, 0)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read metrics history")
		return
	}

	if strings.EqualFold(r.URL.Query().Get("format"), "csv") {
		writeMetricsHistoryCSV(w, now, rows)
		return
	}
	writeJSON(w, http.StatusOK, metricsHistoryResponse{
		Since:       since,
		Until:       now,
		WindowHours: float64(hours),
		Count:       len(rows),
		Truncated:   truncated,
		Restarts:    findRestarts(rows),
		Snapshots:   rows,
	})
}

// findRestarts reports every point where the writing process changed.
//
// The FIRST row is not a restart: it is where the returned window begins, which
// says nothing about whether the process restarted there. Reporting it would put
// a phantom deploy marker at the left edge of every chart.
func findRestarts(rows []*store.MetricsSnapshot) []metricsRestart {
	out := []metricsRestart{}
	for i := 1; i < len(rows); i++ {
		if !rows[i].ProcessStartedAt.Equal(rows[i-1].ProcessStartedAt) {
			out = append(out, metricsRestart{
				At:               rows[i].CapturedAt,
				ProcessStartedAt: rows[i].ProcessStartedAt,
				Index:            i,
			})
		}
	}
	return out
}

// MetricsSnapshotLatest serves GET /api/metrics/history/latest — the full stored
// payload of one snapshot (newest, or the newest at/before ?at=RFC3339).
//
// This is the forensic read the series omits: the chart plots one headline route
// p95, and when it spikes the next question is "which route", which only the
// payload answers. Kept as a separate endpoint because it is a few KB of jsonb —
// fine for one row, ruinous across 43k of them, which is why the series
// projection excludes it.
func (h *Handler) MetricsSnapshotLatest(w http.ResponseWriter, r *http.Request) {
	var at time.Time
	if raw := strings.TrimSpace(r.URL.Query().Get("at")); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "at must be an RFC3339 timestamp")
			return
		}
		at = parsed.UTC()
	}
	payload, capturedAt, err := h.store.GetMetricsSnapshotPayload(r.Context(), at)
	if errors.Is(err, store.ErrMetricsSnapshotNotFound) {
		// Expected on a process younger than one scrape interval, or before 0040
		// has been applied — not a server fault.
		writeError(w, http.StatusNotFound, "no metrics snapshot has been captured yet")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read metrics snapshot")
		return
	}
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"capturedAt": capturedAt,
		"snapshot":   payload,
	})
}

// LoadtestRuns serves GET /api/metrics/loadtest — the baseline run history,
// newest first. ?scenario=agents-64 narrows to one concurrency point (the series
// worth comparing); ?format=csv downloads it.
func (h *Handler) LoadtestRuns(w http.ResponseWriter, r *http.Request) {
	scenario := strings.TrimSpace(r.URL.Query().Get("scenario"))
	limit := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	runs, err := h.store.ListLoadtestRuns(r.Context(), scenario, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read loadtest history")
		return
	}
	if strings.EqualFold(r.URL.Query().Get("format"), "csv") {
		writeLoadtestCSV(w, time.Now().UTC(), runs)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"count": len(runs),
		"runs":  runs,
	})
}

// maxLoadtestBody caps a published baseline. A 64-agent run's JSON is ~100 KB;
// 8 MiB leaves room for a much bigger scenario set while keeping a bad POST from
// buffering unbounded.
const maxLoadtestBody = 8 << 20

// PublishLoadtest serves POST /api/metrics/loadtest: the body is a cmd/loadtest
// results file (the same JSON as cmd/loadtest/baselines/*.json), and each scenario
// in it becomes one row of the run history.
//
// IDEMPOTENT — the store upserts on (run_id, scenario). Publishing is a network
// call at the end of a long, expensive run, so it has to be safe to retry, and the
// two baselines already sitting in the repo have to be safe to backfill twice.
//
// The endpoint accepts the FILE rather than a hand-built row set so nothing has to
// stay in sync: `curl --data-binary @baseline.json` backfills history that predates
// this feature, and cmd/loadtest -publish posts the identical bytes it wrote to
// disk.
func (h *Handler) PublishLoadtest(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxLoadtestBody+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "could not read request body")
		return
	}
	if len(body) > maxLoadtestBody {
		writeError(w, http.StatusRequestEntityTooLarge, "loadtest results too large")
		return
	}
	rows, err := metrics.ParseLoadtestReport(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "not a loadtest results file: "+err.Error())
		return
	}
	if len(rows) == 0 {
		writeError(w, http.StatusBadRequest, "loadtest results contained no named scenarios")
		return
	}
	if err := h.store.UpsertLoadtestRuns(r.Context(), rows); err != nil {
		writeError(w, http.StatusInternalServerError, "could not store loadtest results: "+err.Error())
		return
	}
	scenarios := make([]string, 0, len(rows))
	for _, row := range rows {
		scenarios = append(scenarios, row.Scenario)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"stored":    len(rows),
		"runId":     rows[0].RunID,
		"scenarios": scenarios,
	})
}

// ── CSV export ────────────────────────────────────────────────────────────────
//
// Why the server renders the CSV rather than the page building it from the JSON
// it already has: the point of export is that the data can LEAVE the app, and a
// client-side blob is only reachable from the page. A URL is scriptable —
// `curl -H 'Authorization: Bearer tdm_pat_…' '…/history?hours=168&format=csv'`
// drops the last week into a spreadsheet or a notebook with no browser involved.
// Same rows, same names as the JSON fields, so the two exports are checkable
// against each other.

func csvDownloadHeader(w http.ResponseWriter, name string, at time.Time) {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf("attachment; filename=%q", fmt.Sprintf("%s-%s.csv", name, at.Format("20060102-150405"))))
}

func writeMetricsHistoryCSV(w http.ResponseWriter, at time.Time, rows []*store.MetricsSnapshot) {
	csvDownloadHeader(w, "tandem-metrics", at)
	cw := csv.NewWriter(w)
	defer cw.Flush()
	_ = cw.Write([]string{
		"captured_at", "process_started_at", "uptime_seconds", "window_seconds",
		"requests_total", "route_p95_ms", "route_p95_route", "route_p95_method", "fanout_p95_ms",
		"claims", "claim_conflicts", "ttl_expiries", "fenced_writes",
		"webhook_ok", "webhook_failed", "webhook_dead", "ws_clients",
	})
	for _, s := range rows {
		_ = cw.Write([]string{
			s.CapturedAt.UTC().Format(time.RFC3339),
			s.ProcessStartedAt.UTC().Format(time.RFC3339),
			f(s.UptimeSeconds), f(s.WindowSeconds),
			strconv.FormatInt(s.RequestsTotal, 10),
			f(s.RouteP95MS), s.RouteP95Route, s.RouteP95Method, f(s.FanoutP95MS),
			strconv.FormatInt(s.Claims, 10),
			strconv.FormatInt(s.ClaimConflicts, 10),
			strconv.FormatInt(s.TTLExpiries, 10),
			strconv.FormatInt(s.FencedWrites, 10),
			strconv.FormatInt(s.WebhookOK, 10),
			strconv.FormatInt(s.WebhookFailed, 10),
			strconv.FormatInt(s.WebhookDead, 10),
			strconv.Itoa(s.WSClients),
		})
	}
}

func writeLoadtestCSV(w http.ResponseWriter, at time.Time, runs []*store.LoadtestRun) {
	csvDownloadHeader(w, "tandem-loadtest", at)
	cw := csv.NewWriter(w)
	defer cw.Flush()
	_ = cw.Write([]string{
		"started_at", "finished_at", "run_id", "scenario", "schema_version", "api",
		"git_rev", "git_dirty", "live_agents", "measured_seconds", "task_ops_per_sec",
		"error_rate", "claim_p95_ms", "queue_p95_ms",
		"assertions_passed", "assertions_failed", "aborted", "skipped", "notes",
	})
	for _, r := range runs {
		_ = cw.Write([]string{
			r.StartedAt.UTC().Format(time.RFC3339),
			r.FinishedAt.UTC().Format(time.RFC3339),
			r.RunID, r.Scenario, r.SchemaVersion, r.API,
			r.GitRev, strconv.FormatBool(r.GitDirty),
			strconv.Itoa(r.LiveAgents), f(r.MeasuredSeconds), f(r.TaskOpsPerSec),
			f(r.ErrorRate), f(r.ClaimP95MS), f(r.QueueP95MS),
			strconv.Itoa(r.AssertionsPassed), strconv.Itoa(r.AssertionsFailed),
			strconv.FormatBool(r.Aborted), strconv.FormatBool(r.Skipped),
			// Notes are multi-line (one loadtest note per line); encoding/csv
			// quotes them, so they survive as one field.
			r.Notes,
		})
	}
}

// f formats a float without an exponent and without trailing zero noise, so the
// CSV opens cleanly in a spreadsheet ("1.5", not "1.5000000000000002e+00").
func f(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
