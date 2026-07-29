package api

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/metrics"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/webhooks"
	"github.com/google/uuid"
)

// TDM-42 — the counters behind /api/metrics that no latency histogram can show.
//
// The thing under test is the HOOK POINT, not the arithmetic (that is covered in
// internal/metrics): claims, claim_conflicts and ttl_expiries all hang off
// Handler.claimTask, the single function BOTH task-start surfaces funnel through
// — the MCP/web PATCH (UpdateActionState → claimAction) and the inbound status
// API a CI job curls (ReportTaskStatus → statusStarted). If a future change
// forks those two paths, these tests fail on the surface that stopped counting.

// metricsHarness is newStatusHarness with a live registry attached.
func metricsHarness(t *testing.T, tasks ...*store.Action) (*Handler, *statusFakeStore, *metrics.Registry, uuid.UUID) {
	t.Helper()
	canvasID := uuid.New()
	fake := &statusFakeStore{
		canvas:  &store.Canvas{ID: canvasID, Code: statusCanvasCode, Visibility: "public", PublicRole: "write"},
		actions: map[uuid.UUID]*store.Action{},
		role:    "write",
	}
	for _, a := range tasks {
		fake.actions[a.ID] = a
	}
	reg := metrics.NewRegistry()
	return NewHandler(fake, nil, nil, WithMetrics(reg)), fake, reg, canvasID
}

func counters(reg *metrics.Registry) metrics.Counters { return reg.Snapshot().Counters }

// patchState drives the MCP/web surface: PATCH /api/canvas/actions/{id}.
func patchState(t *testing.T, h *Handler, canvasID, id uuid.UUID, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.UpdateActionState(w, canvasRequest(t, "PATCH", "/api/canvas/actions/"+id.String(), body, canvasID, id.String()))
	return w
}

// A won claim counts once, on both surfaces.
func TestMetricsCountsClaimsFromBothSurfaces(t *testing.T) {
	viaPatch := statusTask("approved", "")
	viaStatus := statusTask("approved", "")
	h, _, reg, canvasID := metricsHarness(t, viaPatch, viaStatus)

	if w := patchState(t, h, canvasID, viaPatch.ID, map[string]any{"state": "executing", "agentName": "agent-a"}); w.Code != 200 {
		t.Fatalf("PATCH claim = %d: %s", w.Code, w.Body)
	}
	if got := counters(reg); got.Claims != 1 || got.ClaimConflicts != 0 {
		t.Fatalf("after the MCP claim: %+v, want claims 1 / conflicts 0", got)
	}

	if w := postStatus(t, h, canvasID, viaStatus.ID, map[string]any{"state": "started", "agent": "ci-github"}); w.Code != 200 {
		t.Fatalf("status-API claim = %d: %s", w.Code, w.Body)
	}
	if got := counters(reg); got.Claims != 2 {
		t.Errorf("after the status-API claim: claims = %d, want 2 (both surfaces count)", got.Claims)
	}
}

// The contention signal: a claim lost to a rival holder increments
// claim_conflicts and NOT claims — on both surfaces.
func TestMetricsCountsClaimConflicts(t *testing.T) {
	held := statusTask("executing", "agent-a")
	heldToo := statusTask("executing", "agent-a")
	h, _, reg, canvasID := metricsHarness(t, held, heldToo)

	if w := patchState(t, h, canvasID, held.ID, map[string]any{"state": "executing", "agentName": "agent-b"}); w.Code != 409 {
		t.Fatalf("rival PATCH claim = %d, want 409: %s", w.Code, w.Body)
	}
	if w := postStatus(t, h, canvasID, heldToo.ID, map[string]any{"state": "started", "agent": "ci-github"}); w.Code != 409 {
		t.Fatalf("rival status-API claim = %d, want 409: %s", w.Code, w.Body)
	}

	got := counters(reg)
	if got.ClaimConflicts != 2 {
		t.Errorf("claim_conflicts = %d, want 2", got.ClaimConflicts)
	}
	if got.Claims != 0 {
		t.Errorf("claims = %d, want 0 — a lost claim is not a claim", got.Claims)
	}
}

// A named claimant re-asserting its OWN claim is idempotent, not contention:
// the store hands the claim back, so it counts as a claim and not a conflict.
func TestMetricsIdempotentReclaimIsNotAConflict(t *testing.T) {
	own := statusTask("executing", "ci-github")
	h, _, reg, canvasID := metricsHarness(t, own)

	if w := postStatus(t, h, canvasID, own.ID, map[string]any{"state": "started", "agent": "ci-github"}); w.Code != 200 {
		t.Fatalf("self-reclaim = %d, want 200: %s", w.Code, w.Body)
	}
	got := counters(reg)
	if got.Claims != 1 || got.ClaimConflicts != 0 {
		t.Errorf("counters = %+v, want claims 1 / conflicts 0", got)
	}
}

// Claim expiry is LAZY — evaluated inside the atomic claim, no sweeper — so the
// takeover reported by ClaimOutcome.ExpiredClaimBy is the only moment a lapsed
// claim is observable. A takeover is both a claim AND a ttl_expiry.
func TestMetricsCountsTTLExpiryTakeover(t *testing.T) {
	task := statusTask("approved", "")
	h, fake, reg, canvasID := metricsHarness(t, task)
	fake.claimOutcome = store.ClaimOutcome{Version: 2, ExpiredClaimBy: "agent-gone", ExpiredClaimAt: time.Now().UTC().Add(-time.Hour)}

	if w := postStatus(t, h, canvasID, task.ID, map[string]any{"state": "started", "agent": "ci-github"}); w.Code != 200 {
		t.Fatalf("takeover = %d, want 200: %s", w.Code, w.Body)
	}
	got := counters(reg)
	if got.TTLExpiries != 1 {
		t.Errorf("ttl_expiries = %d, want 1", got.TTLExpiries)
	}
	if got.Claims != 1 {
		t.Errorf("claims = %d, want 1 — a takeover is also a claim", got.Claims)
	}
}

// An ordinary claim off the queue reports no expiry, so nothing may be counted.
func TestMetricsOrdinaryClaimIsNotATTLExpiry(t *testing.T) {
	task := statusTask("approved", "")
	h, _, reg, canvasID := metricsHarness(t, task)

	postStatus(t, h, canvasID, task.ID, map[string]any{"state": "started", "agent": "ci-github"})

	if got := counters(reg); got.TTLExpiries != 0 {
		t.Errorf("ttl_expiries = %d, want 0", got.TTLExpiries)
	}
}

// Failures that are NOT contention (missing task, wrong state) must leave the
// conflict counter alone — otherwise a caller bug reads as fleet contention.
func TestMetricsNonContentionFailuresAreNotConflicts(t *testing.T) {
	proposed := statusTask("proposed", "")
	h, _, reg, canvasID := metricsHarness(t, proposed)

	// Wrong state.
	if w := postStatus(t, h, canvasID, proposed.ID, map[string]any{"state": "started", "agent": "ci"}); w.Code != 409 {
		t.Fatalf("illegal-state claim = %d, want 409: %s", w.Code, w.Body)
	}
	// Unknown task.
	if w := postStatus(t, h, canvasID, uuid.New(), map[string]any{"state": "started", "agent": "ci"}); w.Code != 404 {
		t.Fatalf("unknown-task claim = %d, want 404: %s", w.Code, w.Body)
	}

	got := counters(reg)
	if got.ClaimConflicts != 0 || got.Claims != 0 {
		t.Errorf("counters = %+v, want all zero", got)
	}
}

// A Handler with no registry (METRICS_ENABLED=false, and every existing handler
// test) must behave identically — the counter calls are nil-receiver no-ops.
func TestMetricsNilRegistryHandlerStillClaims(t *testing.T) {
	task := statusTask("approved", "")
	h, _, _, canvasID := newStatusHarness(t, task)

	if w := postStatus(t, h, canvasID, task.ID, map[string]any{"state": "started", "agent": "ci-github"}); w.Code != 200 {
		t.Fatalf("claim without metrics = %d, want 200: %s", w.Code, w.Body)
	}
}

// ── Route wiring ─────────────────────────────────────────────────────────────

// GET /api/metrics is registered only when a registry is wired, needs NO
// credential (open by design), and reports the routes the middleware saw — as
// PATTERNS. The last part is the privacy guarantee for an unauthenticated
// endpoint: a request to a concrete canvas action must not put its id on the
// public metrics page.
func TestMetricsEndpointWiring(t *testing.T) {
	authSvc := auth.NewService("test-secret-for-tdm-42", time.Hour)
	reg := metrics.NewRegistry()
	r := NewRouter(&fleetFakeStore{}, nil, authSvc, nil, false, nil, "", t.TempDir(), "", reg, nil)

	// Drive one authenticated request so the registry has a row to report.
	token, err := authSvc.Issue(uuid.New(), "read", nil)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	req := httptest.NewRequest("GET", "/api/canvas/agents", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(httptest.NewRecorder(), req)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/metrics", nil)) // no auth header
	if w.Code != 200 {
		t.Fatalf("GET /api/metrics = %d: %s", w.Code, w.Body)
	}
	var snap metrics.Snapshot
	if err := json.Unmarshal(w.Body.Bytes(), &snap); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, w.Body)
	}
	var found bool
	for _, row := range snap.Routes {
		if row.Route == "/api/canvas/agents" {
			found = true
		}
	}
	if !found {
		t.Errorf("middleware recorded nothing for the request just made: %+v", snap.Routes)
	}
	if strings.Contains(w.Body.String(), token) {
		t.Error("the caller's token leaked into the open metrics endpoint")
	}
}

// A nil registry is METRICS_ENABLED=false: the endpoint is not registered and
// the middleware is a pass-through, so the rest of the API is unaffected.
func TestMetricsEndpointAbsentWhenDisabled(t *testing.T) {
	authSvc := auth.NewService("test-secret-for-tdm-42", time.Hour)
	r := NewRouter(&fleetFakeStore{}, nil, authSvc, nil, false, nil, "", t.TempDir(), "", nil, nil)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/metrics", nil))
	if w.Code != 404 {
		t.Errorf("GET /api/metrics with metrics off = %d, want 404", w.Code)
	}

	token, err := authSvc.Issue(uuid.New(), "read", nil)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	req := httptest.NewRequest("GET", "/api/canvas/agents", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Errorf("GET /api/canvas/agents with metrics off = %d, want 200", w.Code)
	}
}

// The webhook worker reports outcomes as strings across a package boundary, so
// the two vocabularies have to agree — a typo would silently zero a counter.
func TestWebhookOutcomeConstantsMatchMetrics(t *testing.T) {
	pairs := [][2]string{
		{webhooks.OutcomeOK, metrics.WebhookOutcomeOK},
		{webhooks.OutcomeFailed, metrics.WebhookOutcomeFailed},
		{webhooks.OutcomeDead, metrics.WebhookOutcomeDead},
	}
	for _, p := range pairs {
		if p[0] != p[1] {
			t.Errorf("webhooks outcome %q != metrics outcome %q", p[0], p[1])
		}
	}
}
