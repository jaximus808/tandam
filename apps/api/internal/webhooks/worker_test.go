package webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/agentcanvas/api/internal/store"
)

// ── fake store ──────────────────────────────────────────────────────────────
//
// An in-memory stand-in for the delivery queue: enough of Postgres' behavior to
// exercise the worker's transitions (lease increments attempt_count and stamps
// the lease clock; ok/failed/dead are terminal writes) without a DB. No network,
// no Supabase.

type fakeStore struct {
	mu         sync.Mutex
	hooks      map[uuid.UUID]*store.Webhook
	deliveries map[uuid.UUID]*store.WebhookDelivery
	// leaseErr, when set, makes LeaseWebhookDeliveries fail.
	leaseErr error
	// hookErr, when set, makes GetWebhookWithSecret fail for every id.
	hookErr error
	now     func() time.Time
}

func newFakeStore(now func() time.Time) *fakeStore {
	return &fakeStore{
		hooks:      map[uuid.UUID]*store.Webhook{},
		deliveries: map[uuid.UUID]*store.WebhookDelivery{},
		now:        now,
	}
}

func (f *fakeStore) addHook(h *store.Webhook) *store.Webhook {
	f.mu.Lock()
	defer f.mu.Unlock()
	if h.ID == uuid.Nil {
		h.ID = uuid.New()
	}
	f.hooks[h.ID] = h
	return h
}

func (f *fakeStore) addDelivery(d *store.WebhookDelivery) *store.WebhookDelivery {
	f.mu.Lock()
	defer f.mu.Unlock()
	if d.ID == uuid.Nil {
		d.ID = uuid.New()
	}
	if d.Status == "" {
		d.Status = "pending"
	}
	if len(d.Payload) == 0 {
		d.Payload = json.RawMessage(`{}`)
	}
	f.deliveries[d.ID] = d
	return d
}

func (f *fakeStore) get(id uuid.UUID) store.WebhookDelivery {
	f.mu.Lock()
	defer f.mu.Unlock()
	return *f.deliveries[id]
}

func (f *fakeStore) ListWebhooksForEvent(_ context.Context, canvasID uuid.UUID, eventType string) ([]*store.Webhook, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*store.Webhook
	for _, h := range f.hooks {
		if h.CanvasID == canvasID && h.Enabled && h.WantsEvent(eventType) {
			out = append(out, h)
		}
	}
	return out, nil
}

func (f *fakeStore) CreateWebhookDeliveries(_ context.Context, ds []*store.WebhookDelivery) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	inserted := 0
	for _, d := range ds {
		// UNIQUE(webhook_id, event_id) — a repeat fan-out is a no-op.
		dup := false
		for _, existing := range f.deliveries {
			if existing.WebhookID == d.WebhookID && existing.EventID == d.EventID {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		cp := *d
		if cp.ID == uuid.Nil {
			cp.ID = uuid.New()
		}
		cp.Status = "pending"
		f.deliveries[cp.ID] = &cp
		inserted++
	}
	return inserted, nil
}

func (f *fakeStore) LeaseWebhookDeliveries(_ context.Context, limit int) ([]*store.WebhookDelivery, error) {
	if f.leaseErr != nil {
		return nil, f.leaseErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	var out []*store.WebhookDelivery
	for _, d := range f.deliveries {
		if len(out) >= limit {
			break
		}
		if d.Status != "pending" && d.Status != "failed" {
			continue
		}
		if d.NextAttemptAt.After(now) {
			continue
		}
		// Same three writes the conditional PATCH makes.
		d.Status = "delivering"
		d.AttemptCount++
		stamp := now
		d.LastAttemptAt = &stamp
		cp := *d
		out = append(out, &cp)
	}
	return out, nil
}

func (f *fakeStore) GetWebhookWithSecret(_ context.Context, id uuid.UUID) (*store.Webhook, error) {
	if f.hookErr != nil {
		return nil, f.hookErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	h, ok := f.hooks[id]
	if !ok {
		return nil, store.ErrWebhookNotFound
	}
	return h, nil
}

func (f *fakeStore) MarkWebhookDeliveryOK(_ context.Context, id uuid.UUID, res store.WebhookDeliveryResult) error {
	return f.finish(id, "ok", nil, res)
}

func (f *fakeStore) MarkWebhookDeliveryFailed(_ context.Context, id uuid.UUID, next time.Time, res store.WebhookDeliveryResult) error {
	return f.finish(id, "failed", &next, res)
}

func (f *fakeStore) MarkWebhookDeliveryDead(_ context.Context, id uuid.UUID, res store.WebhookDeliveryResult) error {
	return f.finish(id, "dead", nil, res)
}

func (f *fakeStore) finish(id uuid.UUID, status string, next *time.Time, res store.WebhookDeliveryResult) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, ok := f.deliveries[id]
	if !ok || d.Status != "delivering" {
		return nil // scoped to the lease, exactly like the real UPDATE
	}
	d.Status = status
	d.ResponseStatus = res.ResponseStatus
	d.ResponseBody = res.ResponseBody
	d.Error = res.Error
	if next != nil {
		d.NextAttemptAt = *next
	}
	return nil
}

func (f *fakeStore) ReapStuckWebhookDeliveries(_ context.Context, olderThan time.Duration) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cutoff := f.now().Add(-olderThan)
	n := 0
	for _, d := range f.deliveries {
		if d.Status == "delivering" && d.LastAttemptAt != nil && d.LastAttemptAt.Before(cutoff) {
			d.Status = "failed"
			d.NextAttemptAt = f.now()
			d.Error = "worker lease expired (no result recorded)"
			n++
		}
	}
	return n, nil
}

// ── helpers ─────────────────────────────────────────────────────────────────

// errTransient stands in for a Supabase blip.
var errTransient = errors.New("supabase unavailable")

// testWorker wires a worker to a fake store and a frozen, movable clock.
func testWorker(t *testing.T, f *fakeStore, clock *time.Time) *Worker {
	t.Helper()
	return NewWorker(f,
		WithSender(NewSender(WithAllowPrivateTargets(true))),
		WithClock(func() time.Time { return *clock }),
		WithLogger(func(string, ...any) {}),
	)
}

func seedHookAndDelivery(f *fakeStore, url string) (*store.Webhook, *store.WebhookDelivery) {
	canvasID := uuid.New()
	h := f.addHook(&store.Webhook{
		CanvasID: canvasID, URL: url, Secret: vectorSecret,
		Events: []string{EventTaskApproved}, Enabled: true,
	})
	d := f.addDelivery(&store.WebhookDelivery{
		WebhookID: h.ID, CanvasID: canvasID, EventID: uuid.New(),
		EventType: EventTaskApproved,
		Payload:   json.RawMessage(vectorBody),
	})
	return h, d
}

// ── tests ───────────────────────────────────────────────────────────────────

// The end-to-end happy path, asserted from the RECEIVER's side: the four
// headers arrive, and the signature verifies against the raw body the receiver
// actually read (not a re-marshal of it).
func TestDeliverSignsAndSucceeds(t *testing.T) {
	var (
		gotHeaders http.Header
		gotBody    []byte
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeaders = r.Header.Clone()
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	_, d := seedHookAndDelivery(f, srv.URL)

	testWorker(t, f, &clock).Tick(context.Background())

	if string(gotBody) != vectorBody {
		t.Fatalf("receiver got body %q, want the stored payload verbatim %q", gotBody, vectorBody)
	}
	if got := gotHeaders.Get(HeaderEvent); got != EventTaskApproved {
		t.Errorf("%s = %q, want %q", HeaderEvent, got, EventTaskApproved)
	}
	if got := gotHeaders.Get(HeaderDeliveryID); got != d.ID.String() {
		t.Errorf("%s = %q, want the delivery id %q", HeaderDeliveryID, got, d.ID)
	}
	ts, err := strconv.ParseInt(gotHeaders.Get(HeaderTimestamp), 10, 64)
	if err != nil {
		t.Fatalf("%s = %q, not a unix timestamp", HeaderTimestamp, gotHeaders.Get(HeaderTimestamp))
	}
	if ts != vectorTimestamp {
		t.Errorf("%s = %d, want %d", HeaderTimestamp, ts, vectorTimestamp)
	}
	// The receiver-side check, verbatim: recompute over <ts>.<raw body>.
	if !VerifyWithin(vectorSecret, ts, gotBody, gotHeaders.Get(HeaderSignature), clock, ReplayWindow) {
		t.Fatalf("signature %q did not verify over the received bytes", gotHeaders.Get(HeaderSignature))
	}

	final := f.get(d.ID)
	if final.Status != "ok" {
		t.Errorf("status = %q, want ok", final.Status)
	}
	if final.ResponseStatus == nil || *final.ResponseStatus != http.StatusNoContent {
		t.Errorf("response_status = %v, want 204", final.ResponseStatus)
	}
	if final.AttemptCount != 1 {
		t.Errorf("attempt_count = %d, want 1", final.AttemptCount)
	}
}

// The retry schedule, walked one tick at a time against a movable clock: a 500
// on each attempt must reschedule at +1m, then +10m, then +1h, and the fourth
// failure must dead-letter instead of scheduling a fifth.
func TestRetryScheduleProgressionThenDeadLetter(t *testing.T) {
	var attempts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		http.Error(w, "receiver is down", http.StatusInternalServerError)
	}))
	defer srv.Close()

	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	_, d := seedHookAndDelivery(f, srv.URL)
	w := testWorker(t, f, &clock)

	want := []time.Duration{1 * time.Minute, 10 * time.Minute, 1 * time.Hour}
	for i, delay := range want {
		attemptStart := clock
		w.Tick(context.Background())

		got := f.get(d.ID)
		if got.Status != "failed" {
			t.Fatalf("after attempt %d: status = %q, want failed (budget not spent yet)", i+1, got.Status)
		}
		if got.AttemptCount != i+1 {
			t.Fatalf("after attempt %d: attempt_count = %d, want %d", i+1, got.AttemptCount, i+1)
		}
		if wantNext := attemptStart.Add(delay); !got.NextAttemptAt.Equal(wantNext) {
			t.Fatalf("after attempt %d: next_attempt_at = %s, want %s (+%s)",
				i+1, got.NextAttemptAt, wantNext, delay)
		}

		// A tick BEFORE the backoff elapses must not re-lease the row: the whole
		// point of next_attempt_at is that a failing receiver isn't hammered.
		clock = attemptStart.Add(delay - time.Second)
		w.Tick(context.Background())
		if got := f.get(d.ID); got.AttemptCount != i+1 {
			t.Fatalf("attempt %d retried early: attempt_count = %d, want %d", i+1, got.AttemptCount, i+1)
		}

		clock = attemptStart.Add(delay)
	}

	// Fourth (final) attempt.
	w.Tick(context.Background())
	final := f.get(d.ID)
	if final.Status != "dead" {
		t.Fatalf("after the 4th attempt: status = %q, want dead", final.Status)
	}
	if final.AttemptCount != MaxAttempts {
		t.Errorf("attempt_count = %d, want MaxAttempts (%d)", final.AttemptCount, MaxAttempts)
	}
	if attempts != MaxAttempts {
		t.Errorf("receiver saw %d requests, want %d (1 initial + %d retries)",
			attempts, MaxAttempts, len(RetrySchedule))
	}
	if final.ResponseStatus == nil || *final.ResponseStatus != http.StatusInternalServerError {
		t.Errorf("dead letter lost its last response status: %v", final.ResponseStatus)
	}
	if final.ResponseBody == "" {
		t.Error("dead letter lost the last response body — the UI has nothing to show")
	}

	// Terminal means terminal: further ticks must not resurrect it.
	clock = clock.Add(24 * time.Hour)
	w.Tick(context.Background())
	if got := f.get(d.ID); got.AttemptCount != MaxAttempts || got.Status != "dead" {
		t.Fatalf("dead delivery was re-leased: status %q, attempts %d", got.Status, got.AttemptCount)
	}
}

// NextRetryDelay is the schedule in pure form — assert it directly so a change
// to the constants is caught even if the worker is refactored.
func TestNextRetryDelay(t *testing.T) {
	tests := []struct {
		attemptsMade int
		want         time.Duration
		ok           bool
	}{
		{1, 1 * time.Minute, true},
		{2, 10 * time.Minute, true},
		{3, 1 * time.Hour, true},
		{4, 0, false}, // budget spent → dead letter
		{9, 0, false},
		{0, 1 * time.Minute, true}, // defensive: treated as "after the first"
	}
	for _, tc := range tests {
		got, ok := NextRetryDelay(tc.attemptsMade)
		if got != tc.want || ok != tc.ok {
			t.Errorf("NextRetryDelay(%d) = (%s, %v), want (%s, %v)",
				tc.attemptsMade, got, ok, tc.want, tc.ok)
		}
	}
	if MaxAttempts != 4 {
		t.Errorf("MaxAttempts = %d, want 4 (first attempt + 3 retries)", MaxAttempts)
	}
}

// A 4xx is the receiver saying "never send me this" — dead-letter on the first
// attempt rather than spending an hour of budget re-sending a rejected payload.
func TestNonRetryableStatusDeadLettersImmediately(t *testing.T) {
	var attempts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		http.Error(w, "bad signature, go away", http.StatusUnauthorized)
	}))
	defer srv.Close()

	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	_, d := seedHookAndDelivery(f, srv.URL)

	testWorker(t, f, &clock).Tick(context.Background())

	got := f.get(d.ID)
	if got.Status != "dead" {
		t.Fatalf("status = %q, want dead (401 is not retryable)", got.Status)
	}
	if got.AttemptCount != 1 || attempts != 1 {
		t.Errorf("attempts = %d (receiver saw %d), want exactly 1", got.AttemptCount, attempts)
	}
}

// 429 is the one 4xx that IS retryable — it means "later", not "never".
func TestTooManyRequestsIsRetried(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	_, d := seedHookAndDelivery(f, srv.URL)

	testWorker(t, f, &clock).Tick(context.Background())

	got := f.get(d.ID)
	if got.Status != "failed" {
		t.Fatalf("status = %q, want failed (429 is retryable)", got.Status)
	}
	if want := clock.Add(RetrySchedule[0]); !got.NextAttemptAt.Equal(want) {
		t.Errorf("next_attempt_at = %s, want %s", got.NextAttemptAt, want)
	}
}

// Redirects are not followed (SSRF bypass) and count as permanent failures.
func TestRedirectIsNotFollowedAndIsFatal(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	}))
	defer srv.Close()

	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	_, d := seedHookAndDelivery(f, srv.URL)

	testWorker(t, f, &clock).Tick(context.Background())

	if hits != 1 {
		t.Fatalf("receiver hit %d times, want 1 (redirect must not be followed)", hits)
	}
	got := f.get(d.ID)
	if got.Status != "dead" {
		t.Errorf("status = %q, want dead", got.Status)
	}
	if got.Error == "" {
		t.Error("expected the redirect to be recorded as the failure reason")
	}
}

// A response body larger than the 2 KB cap must be truncated before it is
// stored — a hostile endpoint can't use the delivery log as free storage.
func TestResponseBodyTruncated(t *testing.T) {
	huge := make([]byte, 64<<10)
	for i := range huge {
		huge[i] = 'x'
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write(huge)
	}))
	defer srv.Close()

	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	_, d := seedHookAndDelivery(f, srv.URL)

	testWorker(t, f, &clock).Tick(context.Background())

	if got := len(f.get(d.ID).ResponseBody); got > MaxResponseBytes {
		t.Fatalf("stored response body = %d bytes, want <= %d", got, MaxResponseBytes)
	}
}

// A config disabled (or unsubscribed) after the row was enqueued must not be
// sent to, and must not sit in the queue forever either.
func TestDisabledWebhookIsNotSentAndIsTerminal(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	h, d := seedHookAndDelivery(f, srv.URL)
	h.Enabled = false

	testWorker(t, f, &clock).Tick(context.Background())

	if hits != 0 {
		t.Fatalf("sent to a disabled webhook (%d hits)", hits)
	}
	if got := f.get(d.ID); got.Status != "dead" {
		t.Errorf("status = %q, want dead", got.Status)
	}
}

// A delivery whose config was deleted between enqueue and lease is terminal:
// there is no URL and no key, so no retry can ever help.
func TestMissingWebhookConfigIsTerminal(t *testing.T) {
	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	d := f.addDelivery(&store.WebhookDelivery{
		WebhookID: uuid.New(), CanvasID: uuid.New(), EventID: uuid.New(),
		EventType: EventTaskApproved,
	})

	testWorker(t, f, &clock).Tick(context.Background())

	got := f.get(d.ID)
	if got.Status != "dead" {
		t.Fatalf("status = %q, want dead", got.Status)
	}
	if got.AttemptCount != 1 {
		t.Errorf("attempt_count = %d, want 1", got.AttemptCount)
	}
}

// A transient store failure loading the config schedules a retry rather than
// dead-lettering — but the attempt still counts, so a permanently broken store
// exhausts the budget instead of looping forever.
func TestTransientConfigLoadErrorRetriesWithinBudget(t *testing.T) {
	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	f.hookErr = errTransient
	d := f.addDelivery(&store.WebhookDelivery{
		WebhookID: uuid.New(), CanvasID: uuid.New(), EventID: uuid.New(),
		EventType: EventTaskApproved,
	})
	w := testWorker(t, f, &clock)

	w.Tick(context.Background())
	got := f.get(d.ID)
	if got.Status != "failed" {
		t.Fatalf("status = %q, want failed (retryable)", got.Status)
	}
	if want := clock.Add(RetrySchedule[0]); !got.NextAttemptAt.Equal(want) {
		t.Errorf("next_attempt_at = %s, want %s", got.NextAttemptAt, want)
	}

	// Burn the rest of the budget: it must end 'dead', not loop.
	for _, delay := range RetrySchedule {
		clock = clock.Add(delay)
		w.Tick(context.Background())
	}
	if final := f.get(d.ID); final.Status != "dead" || final.AttemptCount != MaxAttempts {
		t.Fatalf("final = (%s, %d attempts), want (dead, %d)", final.Status, final.AttemptCount, MaxAttempts)
	}
}

// A lease failure is logged and skipped, not fatal — the next tick retries.
func TestLeaseErrorIsSurvivable(t *testing.T) {
	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	f.leaseErr = errTransient
	testWorker(t, f, &clock).Tick(context.Background()) // must not panic
}

// A row abandoned mid-flight (worker crashed after leasing) is returned to the
// queue by the reaper once its lease clock ages past the timeout.
func TestReapStuckDelivery(t *testing.T) {
	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	stale := clock.Add(-10 * time.Minute)
	d := f.addDelivery(&store.WebhookDelivery{
		WebhookID: uuid.New(), CanvasID: uuid.New(), EventID: uuid.New(),
		EventType: EventTaskApproved, Status: "delivering",
		AttemptCount: 1, LastAttemptAt: &stale,
	})

	testWorker(t, f, &clock).reap(context.Background())

	got := f.get(d.ID)
	if got.Status != "failed" {
		t.Fatalf("status = %q, want failed (reaped back to the queue)", got.Status)
	}
	if got.AttemptCount != 1 {
		t.Errorf("attempt_count = %d, want 1 — the lost attempt still counts against the budget", got.AttemptCount)
	}
}

// Run must return promptly on context cancellation (graceful shutdown).
func TestRunStopsOnContextCancel(t *testing.T) {
	clock := time.Now().UTC()
	f := newFakeStore(func() time.Time { return clock })
	w := NewWorker(f,
		WithPollInterval(time.Millisecond),
		WithSender(NewSender(WithAllowPrivateTargets(true))),
		WithLogger(func(string, ...any) {}),
	)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after context cancellation")
	}
}
