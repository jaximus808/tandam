package api

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/metrics"
	"github.com/agentcanvas/api/internal/store"
)

// TDM-94 — the owner gate and the history reads.
//
// The gate is the part worth most of the test budget. Tandem has no admin model,
// so this is the FIRST route in the codebase that is neither public nor
// canvas-scoped, and its three refusals mean three different things (unset
// allowlist → 404, no credential → 401, wrong user → 403). Collapsing any pair of
// them either advertises that the console exists or tells a signed-in stranger to
// sign in again.

const testOwnerEmail = "owner@example.com"

// metricsHistFake serves the metrics-history reads. Every other Store method
// panics via the embedded nil interface, which is the convention in this package.
type metricsHistFake struct {
	store.Store
	users     map[uuid.UUID]*store.User
	snapshots []*store.MetricsSnapshot
	truncated bool
	runs      []*store.LoadtestRun
	published []metrics.LoadtestRunRow
	payload   json.RawMessage
	upsertErr error
}

func (f *metricsHistFake) GetUserByID(_ context.Context, id uuid.UUID) (*store.User, error) {
	if u, ok := f.users[id]; ok {
		return u, nil
	}
	return nil, store.ErrUserNotFound
}

func (f *metricsHistFake) ListMetricsSnapshots(_ context.Context, _ time.Time, _ int) ([]*store.MetricsSnapshot, bool, error) {
	return f.snapshots, f.truncated, nil
}

func (f *metricsHistFake) GetMetricsSnapshotPayload(_ context.Context, _ time.Time) (json.RawMessage, time.Time, error) {
	if len(f.payload) == 0 {
		return nil, time.Time{}, store.ErrMetricsSnapshotNotFound
	}
	return f.payload, time.Date(2026, 7, 30, 4, 0, 0, 0, time.UTC), nil
}

func (f *metricsHistFake) ListLoadtestRuns(_ context.Context, scenario string, _ int) ([]*store.LoadtestRun, error) {
	if scenario == "" {
		return f.runs, nil
	}
	out := []*store.LoadtestRun{}
	for _, r := range f.runs {
		if r.Scenario == scenario {
			out = append(out, r)
		}
	}
	return out, nil
}

func (f *metricsHistFake) UpsertLoadtestRuns(_ context.Context, rows []metrics.LoadtestRunRow) error {
	if f.upsertErr != nil {
		return f.upsertErr
	}
	f.published = append(f.published, rows...)
	return nil
}

// metricsHistHarness wires the real router (so the middleware chain under test is
// the one that ships) with the allowlist set to testOwnerEmail. Returns the
// router, the owner's session cookie and a non-owner's.
func metricsHistHarness(t *testing.T, fake *metricsHistFake) (http.Handler, string, string) {
	t.Helper()
	t.Setenv(metricsOwnerEnv, "  Owner@Example.com , other@example.com ")

	ownerID, strangerID := uuid.New(), uuid.New()
	if fake.users == nil {
		fake.users = map[uuid.UUID]*store.User{}
	}
	fake.users[ownerID] = &store.User{ID: ownerID, Email: testOwnerEmail}
	fake.users[strangerID] = &store.User{ID: strangerID, Email: "stranger@example.com"}

	authSvc := auth.NewService("test-secret-for-tdm-94", time.Hour)
	ownerTok, err := authSvc.IssueSession(ownerID, time.Hour)
	if err != nil {
		t.Fatalf("issue owner session: %v", err)
	}
	strangerTok, err := authSvc.IssueSession(strangerID, time.Hour)
	if err != nil {
		t.Fatalf("issue stranger session: %v", err)
	}
	r := NewRouter(fake, nil, authSvc, nil, false, nil, "", t.TempDir(), "", nil, nil)
	return r, ownerTok, strangerTok
}

func metricsReq(method, url, cookie, body string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, url, nil)
	} else {
		r = httptest.NewRequest(method, url, strings.NewReader(body))
	}
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: cookie})
	}
	return r
}

// ── the gate ──────────────────────────────────────────────────────────────────

func TestMetricsHistoryGate(t *testing.T) {
	fake := &metricsHistFake{}
	r, owner, stranger := metricsHistHarness(t, fake)

	cases := []struct {
		name, cookie string
		want         int
		why          string
	}{
		{"owner", owner, http.StatusOK, "the allowlisted user reads the history"},
		{"signed-in stranger", stranger, http.StatusForbidden,
			"a valid credential that isn't an owner is a 403 — a 401 would tell them to sign in again, which cannot help"},
		{"anonymous", "", http.StatusUnauthorized, "no credential at all is a 401"},
		{"garbage cookie", "not-a-jwt", http.StatusUnauthorized, "an unparseable session resolves to no user"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r.ServeHTTP(w, metricsReq("GET", "/api/metrics/history", tc.cookie, ""))
			if w.Code != tc.want {
				t.Errorf("GET /api/metrics/history as %s = %d, want %d — %s: %s",
					tc.name, w.Code, tc.want, tc.why, w.Body)
			}
		})
	}
}

// The allowlist is matched case-insensitively and whitespace-tolerantly, because
// the var is hand-typed and "Owner@Example.com " must not lock the operator out of
// their own console.
func TestMetricsOwnerEmailsNormalizes(t *testing.T) {
	t.Setenv(metricsOwnerEnv, " A@b.com ,, B@C.com,")
	got := metricsOwnerEmails()
	if len(got) != 2 || got[0] != "a@b.com" || got[1] != "b@c.com" {
		t.Fatalf("metricsOwnerEmails() = %v, want [a@b.com b@c.com]", got)
	}
	t.Setenv(metricsOwnerEnv, "   ")
	if got := metricsOwnerEmails(); got != nil {
		t.Fatalf("a blank allowlist must parse as none, got %v", got)
	}
}

// Unset allowlist 404s the whole subtree, including the POST. Fails closed:
// forgetting the var on a deployment can never expose the history, and never
// admits that the console exists.
func TestMetricsHistoryHiddenWhenAllowlistUnset(t *testing.T) {
	fake := &metricsHistFake{}
	r, owner, _ := metricsHistHarness(t, fake)
	t.Setenv(metricsOwnerEnv, "")

	for _, path := range []string{"/api/metrics/history", "/api/metrics/history/latest", "/api/metrics/loadtest"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, metricsReq("GET", path, owner, ""))
		if w.Code != http.StatusNotFound {
			t.Errorf("GET %s with no allowlist = %d, want 404", path, w.Code)
		}
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, metricsReq("POST", "/api/metrics/loadtest", owner, `{"run":{"run_id":"x"}}`))
	if w.Code != http.StatusNotFound {
		t.Errorf("POST /api/metrics/loadtest with no allowlist = %d, want 404", w.Code)
	}
}

// The live /api/metrics stays OPEN — the gate above must not have leaked onto it.
// (It is only registered when a registry is wired, so with none it is a 404 for a
// different reason; the point here is that adding the history subtree did not
// change its auth posture.)
func TestLiveMetricsEndpointStaysOpen(t *testing.T) {
	reg := metrics.NewRegistry()
	t.Setenv(metricsOwnerEnv, testOwnerEmail)
	r := NewRouter(&metricsHistFake{}, nil, auth.NewService("s3cret-for-tdm-94", time.Hour), nil, false, nil, "", t.TempDir(), "", reg, nil)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/metrics", nil)) // no credential
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/metrics (open by design) = %d, want 200: %s", w.Code, w.Body)
	}
}

// ── the series read ───────────────────────────────────────────────────────────

func snap(at time.Time, boot time.Time, p95 float64, conflicts int64) *store.MetricsSnapshot {
	return &store.MetricsSnapshot{
		CapturedAt:       at,
		ProcessStartedAt: boot,
		RouteP95MS:       p95,
		RouteP95Route:    "/api/canvas/actions/{id}",
		RouteP95Method:   "PATCH",
		ClaimConflicts:   conflicts,
		WSClients:        3,
	}
}

func TestMetricsHistoryFindsRestarts(t *testing.T) {
	bootA := time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC)
	bootB := bootA.Add(2 * time.Hour)
	fake := &metricsHistFake{snapshots: []*store.MetricsSnapshot{
		snap(bootA.Add(1*time.Hour), bootA, 40, 5),
		snap(bootA.Add(90*time.Minute), bootA, 42, 6),
		// A deploy: new boot time, counters back to a smaller value.
		snap(bootB.Add(1*time.Minute), bootB, 12, 0),
		snap(bootB.Add(2*time.Minute), bootB, 14, 1),
	}}
	r, owner, _ := metricsHistHarness(t, fake)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, metricsReq("GET", "/api/metrics/history?hours=6", owner, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("history = %d: %s", w.Code, w.Body)
	}
	var got metricsHistoryResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Count != 4 || len(got.Snapshots) != 4 {
		t.Fatalf("count = %d / %d snapshots, want 4", got.Count, len(got.Snapshots))
	}
	if got.WindowHours != 6 {
		t.Errorf("WindowHours = %v, want the requested 6", got.WindowHours)
	}
	// Exactly ONE restart, at index 2. The first row must never be reported as a
	// restart — it is where the window begins, not where the process changed, and
	// reporting it would put a phantom deploy marker on every chart.
	if len(got.Restarts) != 1 {
		t.Fatalf("Restarts = %+v, want exactly one (index 2)", got.Restarts)
	}
	if got.Restarts[0].Index != 2 || !got.Restarts[0].ProcessStartedAt.Equal(bootB) {
		t.Errorf("restart = %+v, want index 2 at boot %s", got.Restarts[0], bootB)
	}
	// Counters must arrive CUMULATIVE — differencing them is the consumer's job,
	// because only the consumer knows what to do at the restart boundary.
	if got.Snapshots[1].ClaimConflicts != 6 {
		t.Errorf("ClaimConflicts = %d, want the raw cumulative 6", got.Snapshots[1].ClaimConflicts)
	}
}

func TestMetricsHistoryRejectsBadHours(t *testing.T) {
	r, owner, _ := metricsHistHarness(t, &metricsHistFake{})
	for _, bad := range []string{"0", "-3", "soon"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, metricsReq("GET", "/api/metrics/history?hours="+bad, owner, ""))
		if w.Code != http.StatusBadRequest {
			t.Errorf("hours=%s = %d, want 400", bad, w.Code)
		}
	}
	// An absurd window is CLAMPED rather than refused — the caller gets everything
	// that exists, which is what they meant.
	w := httptest.NewRecorder()
	r.ServeHTTP(w, metricsReq("GET", "/api/metrics/history?hours=99999999", owner, ""))
	if w.Code != http.StatusOK {
		t.Errorf("an over-wide window should clamp, got %d: %s", w.Code, w.Body)
	}
}

func TestMetricsHistoryCSVExport(t *testing.T) {
	boot := time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC)
	fake := &metricsHistFake{snapshots: []*store.MetricsSnapshot{
		snap(boot.Add(time.Hour), boot, 41.5, 2),
	}}
	r, owner, _ := metricsHistHarness(t, fake)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, metricsReq("GET", "/api/metrics/history?format=CSV", owner, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("csv export = %d: %s", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Errorf("Content-Type = %q, want text/csv", ct)
	}
	// A download, not a page: the whole point is that the data leaves the app.
	if cd := w.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment;") {
		t.Errorf("Content-Disposition = %q, want an attachment", cd)
	}
	rows, err := csv.NewReader(strings.NewReader(w.Body.String())).ReadAll()
	if err != nil {
		t.Fatalf("export is not valid CSV: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d CSV rows, want header + 1", len(rows))
	}
	if rows[0][0] != "captured_at" || rows[0][5] != "route_p95_ms" {
		t.Errorf("header = %v, want the snapshot column names", rows[0])
	}
	// Floats must be plain decimals, not Go's exponent form, or a spreadsheet
	// reads them as text.
	if rows[1][5] != "41.5" {
		t.Errorf("route_p95_ms rendered as %q, want 41.5", rows[1][5])
	}
	if rows[1][10] != "2" {
		t.Errorf("claim_conflicts rendered as %q, want 2", rows[1][10])
	}
}

func TestMetricsSnapshotLatest(t *testing.T) {
	fake := &metricsHistFake{}
	r, owner, _ := metricsHistHarness(t, fake)

	// Nothing captured yet is the expected state on a young process (or before
	// 0040 is applied) — a 404, not a 500.
	w := httptest.NewRecorder()
	r.ServeHTTP(w, metricsReq("GET", "/api/metrics/history/latest", owner, ""))
	if w.Code != http.StatusNotFound {
		t.Fatalf("no snapshots yet = %d, want 404: %s", w.Code, w.Body)
	}

	fake.payload = json.RawMessage(`{"routes":[{"route":"/api/x","method":"GET","p99_ms":9}]}`)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, metricsReq("GET", "/api/metrics/history/latest", owner, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("latest = %d: %s", w.Code, w.Body)
	}
	var got struct {
		CapturedAt time.Time       `json:"capturedAt"`
		Snapshot   json.RawMessage `json:"snapshot"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The forensic detail the series projection drops must survive intact — this
	// endpoint exists precisely to answer "which route was slow".
	if !strings.Contains(string(got.Snapshot), "/api/x") {
		t.Errorf("payload lost its route detail: %s", got.Snapshot)
	}

	w = httptest.NewRecorder()
	r.ServeHTTP(w, metricsReq("GET", "/api/metrics/history/latest?at=yesterday", owner, ""))
	if w.Code != http.StatusBadRequest {
		t.Errorf("?at=yesterday = %d, want 400", w.Code)
	}
}

// ── loadtest history ──────────────────────────────────────────────────────────

func TestLoadtestRunsReadAndFilter(t *testing.T) {
	at := time.Date(2026, 7, 29, 6, 25, 0, 0, time.UTC)
	fake := &metricsHistFake{runs: []*store.LoadtestRun{
		{RunID: "aaa", Scenario: "agents-64", StartedAt: at, LiveAgents: 64, TaskOpsPerSec: 31.5, ErrorRate: 0.02, GitRev: "deadbeef"},
		{RunID: "aaa", Scenario: "agents-8", StartedAt: at, LiveAgents: 8, TaskOpsPerSec: 44},
	}}
	r, owner, _ := metricsHistHarness(t, fake)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, metricsReq("GET", "/api/metrics/loadtest", owner, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("loadtest history = %d: %s", w.Code, w.Body)
	}
	var got struct {
		Count int                  `json:"count"`
		Runs  []*store.LoadtestRun `json:"runs"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Count != 2 {
		t.Fatalf("count = %d, want 2", got.Count)
	}

	// Narrowing to one scenario is the read that makes a regression visible: the
	// series worth comparing is per concurrency point, not per run.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, metricsReq("GET", "/api/metrics/loadtest?scenario=agents-64", owner, ""))
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Count != 1 || got.Runs[0].Scenario != "agents-64" {
		t.Fatalf("scenario filter returned %+v", got.Runs)
	}

	w = httptest.NewRecorder()
	r.ServeHTTP(w, metricsReq("GET", "/api/metrics/loadtest?format=csv", owner, ""))
	rows, err := csv.NewReader(strings.NewReader(w.Body.String())).ReadAll()
	if err != nil {
		t.Fatalf("loadtest csv: %v", err)
	}
	if len(rows) != 3 || rows[0][3] != "scenario" {
		t.Fatalf("loadtest csv shape wrong: %v", rows)
	}
}

func TestPublishLoadtest(t *testing.T) {
	fake := &metricsHistFake{}
	r, owner, stranger := metricsHistHarness(t, fake)

	body := `{"schema":"tandem.loadtest.v1","run":{"run_id":"r1","started_at":"2026-07-29T06:25:00Z","git_rev":"abc"},
	          "scenarios":[{"name":"agents-64","live_agents":64,"task_ops_per_sec":30,
	                        "ops":{"task_claim":{"count":19,"errors":1,"p95_ms":80}}}]}`

	w := httptest.NewRecorder()
	r.ServeHTTP(w, metricsReq("POST", "/api/metrics/loadtest", owner, body))
	if w.Code != http.StatusOK {
		t.Fatalf("publish = %d: %s", w.Code, w.Body)
	}
	if len(fake.published) != 1 || fake.published[0].Scenario != "agents-64" {
		t.Fatalf("stored %+v, want one agents-64 row", fake.published)
	}
	if fake.published[0].ClaimP95MS != 80 || fake.published[0].RunID != "r1" {
		t.Errorf("published row lost detail: %+v", fake.published[0])
	}

	// Publishing is a WRITE behind the same gate: a signed-in stranger must not be
	// able to poison the baseline history.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, metricsReq("POST", "/api/metrics/loadtest", stranger, body))
	if w.Code != http.StatusForbidden {
		t.Errorf("publish as a stranger = %d, want 403", w.Code)
	}

	for _, tc := range []struct{ name, body string }{
		{"not json", "hello"},
		{"no scenarios", `{"run":{"run_id":"r2"},"scenarios":[]}`},
	} {
		w = httptest.NewRecorder()
		r.ServeHTTP(w, metricsReq("POST", "/api/metrics/loadtest", owner, tc.body))
		if w.Code != http.StatusBadRequest {
			t.Errorf("publish %s = %d, want 400: %s", tc.name, w.Code, w.Body)
		}
	}
}
