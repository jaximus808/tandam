package store

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// fakeDeliveriesServer is a minimal in-memory PostgREST standing in for
// webhook_deliveries. Like fakeActionsServer (claim_test.go) it applies each
// conditional PATCH under one lock — the row-level atomicity Postgres gives a
// single UPDATE — so these tests exercise the REAL supabaseStore lease path: the
// predicates that end up on the URL, the return=representation row count that
// decides winner vs loser, and the attempt_count compare-and-swap.
type fakeDeliveriesServer struct {
	mu   sync.Mutex
	rows map[string]map[string]any
	// patchQueries records every PATCH query string, so a test can assert the
	// predicates rather than only their effect.
	patchQueries []string
}

func newFakeDeliveriesServer() *fakeDeliveriesServer {
	return &fakeDeliveriesServer{rows: map[string]map[string]any{}}
}

func (f *fakeDeliveriesServer) add(row map[string]any) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rows[row["id"].(string)] = row
	return row
}

// matches applies the eq./in./lte./lt. filters this store actually emits.
func matchesRow(row map[string]any, q map[string][]string) bool {
	for key, vals := range q {
		switch key {
		case "select", "order", "limit", "offset":
			continue
		}
		if len(vals) == 0 {
			continue
		}
		v := vals[0]
		switch {
		case strings.HasPrefix(v, "eq."):
			want := strings.TrimPrefix(v, "eq.")
			if !scalarEquals(row[key], want) {
				return false
			}
		case strings.HasPrefix(v, "in."):
			set := strings.Split(strings.Trim(strings.TrimPrefix(v, "in."), "()"), ",")
			got, _ := row[key].(string)
			found := false
			for _, s := range set {
				if strings.Trim(s, `"`) == got {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		case strings.HasPrefix(v, "lte."), strings.HasPrefix(v, "lt."):
			op, want, _ := strings.Cut(v, ".")
			got, _ := row[key].(string)
			gt, gerr := time.Parse(time.RFC3339Nano, got)
			wt, werr := time.Parse(time.RFC3339Nano, want)
			// A NULL/unparsable row value never matches, mirroring Postgres.
			if gerr != nil || werr != nil {
				return false
			}
			if op == "lt" && !gt.Before(wt) {
				return false
			}
			if op == "lte" && gt.After(wt) {
				return false
			}
		}
	}
	return true
}

func scalarEquals(got any, want string) bool {
	switch v := got.(type) {
	case string:
		return v == want
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64) == want
	case int:
		return strconv.Itoa(v) == want
	case bool:
		return strconv.FormatBool(v) == want
	case nil:
		return false
	}
	return false
}

func (f *fakeDeliveriesServer) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !strings.HasSuffix(r.URL.Path, "/webhook_deliveries") {
			http.Error(w, `{"code":"404","message":"unexpected `+r.URL.Path+`"}`, 404)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()

		switch r.Method {
		case http.MethodGet:
			out := []any{}
			for _, row := range f.rows {
				if matchesRow(row, r.URL.Query()) {
					out = append(out, row)
				}
			}
			json.NewEncoder(w).Encode(out)
		case http.MethodPatch:
			f.patchQueries = append(f.patchQueries, r.URL.RawQuery)
			var patch map[string]any
			if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
				http.Error(w, `{"code":"400","message":"bad body"}`, 400)
				return
			}
			out := []any{}
			for _, row := range f.rows {
				if !matchesRow(row, r.URL.Query()) {
					continue
				}
				for k, v := range patch {
					row[k] = v
				}
				out = append(out, row)
			}
			json.NewEncoder(w).Encode(out)
		default:
			http.Error(w, `{"code":"405","message":"unexpected `+r.Method+`"}`, 405)
		}
	})
}

func dueDeliveryRow(id uuid.UUID, status string, attempts int, nextAttemptAt time.Time) map[string]any {
	return map[string]any{
		"id":              id.String(),
		"webhook_id":      uuid.New().String(),
		"canvas_id":       uuid.New().String(),
		"event_id":        uuid.New().String(),
		"event_type":      "task.approved",
		"payload":         map[string]any{"ticket": 36},
		"status":          status,
		"attempt_count":   attempts,
		"next_attempt_at": nextAttemptAt.UTC().Format(time.RFC3339Nano),
		"created_at":      nextAttemptAt.UTC().Format(time.RFC3339Nano),
	}
}

func newTestStore(t *testing.T, h http.Handler) (Store, func()) {
	t.Helper()
	srv := httptest.NewServer(h)
	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		srv.Close()
		t.Fatalf("NewSupabase: %v", err)
	}
	return st, srv.Close
}

// Leasing claims only rows that are due and retry-eligible, and stamps all three
// lease columns. The 'delivering' and not-yet-due rows must be left alone —
// leasing an in-flight row is a double send, and leasing an early one defeats
// the backoff.
func TestLeaseWebhookDeliveriesClaimsOnlyDueRows(t *testing.T) {
	fake := newFakeDeliveriesServer()
	now := time.Now().UTC()
	due := fake.add(dueDeliveryRow(uuid.New(), "pending", 0, now.Add(-time.Minute)))
	retry := fake.add(dueDeliveryRow(uuid.New(), "failed", 2, now.Add(-time.Hour)))
	early := fake.add(dueDeliveryRow(uuid.New(), "failed", 1, now.Add(time.Hour)))
	inflight := fake.add(dueDeliveryRow(uuid.New(), "delivering", 1, now.Add(-time.Hour)))

	st, done := newTestStore(t, fake.handler())
	defer done()

	leased, err := st.LeaseWebhookDeliveries(context.Background(), 10)
	if err != nil {
		t.Fatalf("LeaseWebhookDeliveries: %v", err)
	}
	if len(leased) != 2 {
		t.Fatalf("leased %d deliveries, want 2 (the due pending + the due failed)", len(leased))
	}

	byID := map[string]*WebhookDelivery{}
	for _, d := range leased {
		byID[d.ID.String()] = d
		if d.Status != "delivering" {
			t.Errorf("leased row status = %q, want delivering", d.Status)
		}
		if d.LastAttemptAt == nil {
			t.Error("last_attempt_at not stamped — the reaper has no lease clock to work from")
		}
	}
	if got := byID[due["id"].(string)]; got == nil || got.AttemptCount != 1 {
		t.Errorf("pending row leased with attempt_count %v, want 1", got)
	}
	if got := byID[retry["id"].(string)]; got == nil || got.AttemptCount != 3 {
		t.Errorf("failed row leased with attempt_count %v, want 3 (2 prior + this one)", got)
	}
	if got := early["status"].(string); got != "failed" {
		t.Errorf("a not-yet-due row was leased (status %q) — backoff defeated", got)
	}
	if got := inflight["status"].(string); got != "delivering" {
		t.Errorf("an in-flight row changed state to %q", got)
	}

	// The claim must be conditional, not a blind write: assert the predicates.
	if len(fake.patchQueries) == 0 {
		t.Fatal("no PATCH issued — the lease is not doing a conditional claim")
	}
	q := fake.patchQueries[0]
	for _, want := range []string{"status=in.", "next_attempt_at=lte.", "attempt_count=eq.", "id=eq."} {
		if !strings.Contains(q, want) {
			t.Errorf("lease PATCH query %q is missing predicate %q", q, want)
		}
	}
}

// Two workers polling the same queue must not both send the same delivery. The
// attempt_count compare-and-swap is what decides it: the loser's predicate no
// longer matches once the winner has incremented.
func TestLeaseWebhookDeliveriesConcurrentSingleWinner(t *testing.T) {
	fake := newFakeDeliveriesServer()
	now := time.Now().UTC()
	fake.add(dueDeliveryRow(uuid.New(), "pending", 0, now.Add(-time.Minute)))

	st, done := newTestStore(t, fake.handler())
	defer done()

	var (
		wg      sync.WaitGroup
		start   = make(chan struct{})
		results = make([][]*WebhookDelivery, 2)
		errs    = make([]error, 2)
	)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			results[i], errs[i] = st.LeaseWebhookDeliveries(context.Background(), 10)
		}(i)
	}
	close(start)
	wg.Wait()

	total := 0
	for i := range results {
		if errs[i] != nil {
			t.Fatalf("lease %d: %v", i, errs[i])
		}
		total += len(results[i])
	}
	if total != 1 {
		t.Fatalf("%d workers leased the same delivery — it would be sent twice", total)
	}
}

// Closing out an attempt is scoped to the lease: a result arriving from a worker
// whose row was already reaped and re-leased must not overwrite the new attempt.
func TestFinishWebhookDeliveryIsScopedToTheLease(t *testing.T) {
	fake := newFakeDeliveriesServer()
	now := time.Now().UTC()
	id := uuid.New()
	row := fake.add(dueDeliveryRow(id, "pending", 0, now.Add(-time.Minute)))

	st, done := newTestStore(t, fake.handler())
	defer done()
	ctx := context.Background()

	// Not leased yet → the write must find no row.
	if err := st.MarkWebhookDeliveryOK(ctx, id, WebhookDeliveryResult{}); err != nil {
		t.Fatalf("MarkWebhookDeliveryOK: %v", err)
	}
	if got := row["status"].(string); got != "pending" {
		t.Fatalf("status = %q, want pending — a non-leased row was written to", got)
	}

	if _, err := st.LeaseWebhookDeliveries(ctx, 1); err != nil {
		t.Fatalf("lease: %v", err)
	}
	code := 200
	if err := st.MarkWebhookDeliveryOK(ctx, id, WebhookDeliveryResult{ResponseStatus: &code, ResponseBody: "ok"}); err != nil {
		t.Fatalf("MarkWebhookDeliveryOK: %v", err)
	}
	if got := row["status"].(string); got != "ok" {
		t.Fatalf("status = %q, want ok", got)
	}
	if got := row["response_body"]; got != "ok" {
		t.Errorf("response_body = %v, want %q", got, "ok")
	}
}

// The reaper returns abandoned leases to the queue, and only those: a lease
// still inside the timeout belongs to a live worker.
func TestReapStuckWebhookDeliveries(t *testing.T) {
	fake := newFakeDeliveriesServer()
	now := time.Now().UTC()

	stuck := dueDeliveryRow(uuid.New(), "delivering", 1, now)
	stuck["last_attempt_at"] = now.Add(-10 * time.Minute).Format(time.RFC3339Nano)
	fake.add(stuck)

	fresh := dueDeliveryRow(uuid.New(), "delivering", 1, now)
	fresh["last_attempt_at"] = now.Add(-10 * time.Second).Format(time.RFC3339Nano)
	fake.add(fresh)

	st, done := newTestStore(t, fake.handler())
	defer done()

	n, err := st.ReapStuckWebhookDeliveries(context.Background(), 5*time.Minute)
	if err != nil {
		t.Fatalf("ReapStuckWebhookDeliveries: %v", err)
	}
	if n != 1 {
		t.Fatalf("reaped %d rows, want 1", n)
	}
	if got := stuck["status"].(string); got != "failed" {
		t.Errorf("stuck row status = %q, want failed", got)
	}
	if got := fresh["status"].(string); got != "delivering" {
		t.Errorf("a live lease was reaped (status %q)", got)
	}
}

// The event filter is normalized app-side (0038 leaves dedupe/sort to the app)
// and typo'd names are rejected rather than silently dropped — a webhook that
// never fires is the worst failure mode here.
func TestNormalizeWebhookEvents(t *testing.T) {
	got, err := NormalizeWebhookEvents([]string{"task.completed", "task.approved", "task.completed", " "})
	if err != nil {
		t.Fatalf("NormalizeWebhookEvents: %v", err)
	}
	want := []string{"task.approved", "task.completed"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v (deduped and sorted)", got, want)
		}
	}

	if _, err := NormalizeWebhookEvents([]string{"task.aproved"}); err == nil {
		t.Error("a typo'd event name was accepted")
	}
	if _, err := NormalizeWebhookEvents(nil); err == nil {
		t.Error("an empty event filter was accepted — such a webhook can never fire")
	}
}

// Read paths must not carry key material off the store. The projection used by
// the config reads omits the column outright; the write echoes are scrubbed.
func TestWebhookReadProjectionOmitsSecret(t *testing.T) {
	if strings.Contains(webhookReadCols, "secret") {
		t.Fatal("webhookReadCols selects the secret — a config list would leak the HMAC key")
	}
	if !strings.Contains(webhookSecretCols, "secret") {
		t.Fatal("webhookSecretCols must select the secret; it is the emit path's projection")
	}
	w := &Webhook{Secret: "whsec_abcdef1234", SecretLastFour: LastFour("whsec_abcdef1234")}
	if scrubSecret(w).Secret != "" {
		t.Error("scrubSecret left the key in place")
	}
	if w.SecretLastFour != "1234" {
		t.Errorf("SecretLastFour = %q, want the trailing 4 chars", w.SecretLastFour)
	}
	// json:"-" is the second belt: even a hand-rolled response can't leak it.
	blob, err := json.Marshal(&Webhook{Secret: "whsec_supersecret"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(blob), "supersecret") {
		t.Fatalf("Webhook JSON leaked the secret: %s", blob)
	}
}
