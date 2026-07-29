package webhooks

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// countingObserver is the metrics seam stand-in. metrics.Registry implements the
// same single method (ObserveWebhookDelivery), which is the whole interface —
// the worker hands it an outcome string and nothing identifying.
type countingObserver struct {
	mu     sync.Mutex
	counts map[string]int
}

func newCountingObserver() *countingObserver {
	return &countingObserver{counts: map[string]int{}}
}

func (o *countingObserver) ObserveWebhookDelivery(outcome string) {
	o.mu.Lock()
	o.counts[outcome]++
	o.mu.Unlock()
}

func (o *countingObserver) get(outcome string) int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.counts[outcome]
}

func (o *countingObserver) snapshot() map[string]int {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := map[string]int{}
	for k, v := range o.counts {
		out[k] = v
	}
	return out
}

// observedWorker is testWorker plus the metrics seam.
func observedWorker(f *fakeStore, clock *time.Time, obs DeliveryObserver) *Worker {
	return NewWorker(f,
		WithSender(NewSender(WithAllowPrivateTargets(true))),
		WithClock(func() time.Time { return *clock }),
		WithLogger(func(string, ...any) {}),
		WithObserver(obs),
	)
}

func TestObserverCountsSuccessfulDelivery(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	seedHookAndDelivery(f, srv.URL)
	obs := newCountingObserver()

	observedWorker(f, &clock, obs).Tick(context.Background())

	if got := obs.snapshot(); got[OutcomeOK] != 1 || got[OutcomeFailed] != 0 || got[OutcomeDead] != 0 {
		t.Errorf("outcomes = %v, want exactly one %q", got, OutcomeOK)
	}
}

// A flapping receiver must show up as webhook_failed climbing while
// webhook_dead stays flat — that is the difference between "retry later" and
// "give up", and the reason the two are separate counters. Walk the whole
// budget: three retryable failures, then the dead letter.
func TestObserverCountsRetriesThenDeadLetter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "receiver is down", http.StatusInternalServerError)
	}))
	defer srv.Close()

	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	seedHookAndDelivery(f, srv.URL)
	obs := newCountingObserver()
	w := observedWorker(f, &clock, obs)

	for i, delay := range RetrySchedule {
		start := clock
		w.Tick(context.Background())
		if got := obs.get(OutcomeFailed); got != i+1 {
			t.Fatalf("after attempt %d: failed = %d, want %d", i+1, got, i+1)
		}
		if got := obs.get(OutcomeDead); got != 0 {
			t.Fatalf("after attempt %d: dead = %d, want 0 (budget remains)", i+1, got)
		}
		clock = start.Add(delay)
	}

	w.Tick(context.Background()) // final attempt: budget spent
	got := obs.snapshot()
	if got[OutcomeFailed] != len(RetrySchedule) {
		t.Errorf("failed = %d, want %d", got[OutcomeFailed], len(RetrySchedule))
	}
	if got[OutcomeDead] != 1 {
		t.Errorf("dead = %d, want 1", got[OutcomeDead])
	}
	if got[OutcomeOK] != 0 {
		t.Errorf("ok = %d, want 0", got[OutcomeOK])
	}
}

// A 4xx is fatal on the first attempt: dead immediately, never counted failed.
func TestObserverCountsNonRetryableAsDead(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad request", http.StatusBadRequest)
	}))
	defer srv.Close()

	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	seedHookAndDelivery(f, srv.URL)
	obs := newCountingObserver()

	observedWorker(f, &clock, obs).Tick(context.Background())

	if got := obs.snapshot(); got[OutcomeDead] != 1 || got[OutcomeFailed] != 0 {
		t.Errorf("outcomes = %v, want exactly one %q", got, OutcomeDead)
	}
}

// A delivery whose config vanished (or was disabled) is terminal without ever
// being sent — still a dead letter as far as the numbers go.
func TestObserverCountsDeletedConfigAsDead(t *testing.T) {
	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	f.addDelivery(&store.WebhookDelivery{
		WebhookID: uuid.New(), CanvasID: uuid.New(), EventID: uuid.New(),
		EventType: EventTaskApproved,
	})
	obs := newCountingObserver()

	observedWorker(f, &clock, obs).Tick(context.Background())

	if got := obs.snapshot(); got[OutcomeDead] != 1 {
		t.Errorf("outcomes = %v, want one %q for a delivery with no config", got, OutcomeDead)
	}
}

// No observer wired (metrics disabled) must change nothing.
func TestWorkerWithoutObserver(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	_, d := seedHookAndDelivery(f, srv.URL)

	testWorker(t, f, &clock).Tick(context.Background())

	if got := f.get(d.ID); got.Status != "ok" {
		t.Errorf("status = %q, want ok with no observer wired", got.Status)
	}
}
