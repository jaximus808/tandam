package webhooks

import (
	"context"
	"errors"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/agentcanvas/api/internal/store"
)

// RetrySchedule is the wait BEFORE each retry, indexed by the number of
// attempts already made: after attempt 1 fails wait 1m, after 2 wait 10m, after
// 3 wait 1h. Four total attempts (the first + three retries); when the fourth
// fails there is no entry left and the delivery is dead-lettered.
//
// The spread is deliberately wide rather than a tight exponential: the failure
// this exists to survive is "the receiver is down / being deployed", which is
// measured in minutes-to-an-hour, not seconds. A tight schedule would spend the
// whole budget inside the same outage.
//
// (Migration 0038's comments float a 5-attempt 10s/1m/5m/30m/2h schedule as a
// suggestion. The shipped schedule is this one; where they disagree, this wins.)
var RetrySchedule = []time.Duration{
	1 * time.Minute,
	10 * time.Minute,
	1 * time.Hour,
}

// MaxAttempts is the total attempt budget: the first attempt plus one per entry
// in RetrySchedule.
var MaxAttempts = len(RetrySchedule) + 1

// NextRetryDelay returns how long to wait before the next attempt, given how
// many attempts have already been made (1-based: pass 1 right after the first
// attempt failed). ok=false means the budget is spent and the delivery must be
// dead-lettered.
//
// Pure and exported so the schedule can be asserted directly, without a clock or
// a queue.
func NextRetryDelay(attemptsMade int) (time.Duration, bool) {
	if attemptsMade < 1 {
		attemptsMade = 1
	}
	idx := attemptsMade - 1
	if idx >= len(RetrySchedule) {
		return 0, false
	}
	return RetrySchedule[idx], true
}

// Defaults for the worker loop.
const (
	// DefaultPollInterval is how often the queue is polled for due deliveries.
	// Cheap: one indexed SELECT against webhook_deliveries_due_idx, which is
	// partial on the two retry-eligible states so it stays queue-sized.
	DefaultPollInterval = 5 * time.Second
	// DefaultBatchSize bounds how many deliveries one tick leases.
	DefaultBatchSize = 20
	// DefaultConcurrency bounds simultaneous in-flight HTTP sends.
	DefaultConcurrency = 4
	// DefaultLeaseTimeout is how long a 'delivering' row may sit before the
	// reaper assumes the worker that leased it died (0038's 5 minutes). Well
	// above RequestTimeout, so a merely-slow attempt is never reaped out from
	// under itself.
	DefaultLeaseTimeout = 5 * time.Minute
	// DefaultReapInterval is how often the stuck-lease sweep runs. Rare on
	// purpose: it is a crash-recovery path, and 0038 deliberately leaves
	// 'delivering' out of the due index, so the sweep is a scan.
	DefaultReapInterval = 1 * time.Minute
)

// WorkerStore is the slice of the store the delivery worker uses.
type WorkerStore interface {
	LeaseWebhookDeliveries(ctx context.Context, limit int) ([]*store.WebhookDelivery, error)
	GetWebhookWithSecret(ctx context.Context, id uuid.UUID) (*store.Webhook, error)
	MarkWebhookDeliveryOK(ctx context.Context, id uuid.UUID, res store.WebhookDeliveryResult) error
	MarkWebhookDeliveryFailed(ctx context.Context, id uuid.UUID, nextAttemptAt time.Time, res store.WebhookDeliveryResult) error
	MarkWebhookDeliveryDead(ctx context.Context, id uuid.UUID, res store.WebhookDeliveryResult) error
	ReapStuckWebhookDeliveries(ctx context.Context, olderThan time.Duration) (int, error)
}

// Delivery outcomes reported to a DeliveryObserver. These mirror the three
// terminal-for-this-attempt branches below: delivered, will be retried,
// dead-lettered.
const (
	OutcomeOK     = "ok"
	OutcomeFailed = "failed"
	OutcomeDead   = "dead"
)

// DeliveryObserver is the optional metrics seam (TDM-42): the worker reports
// each attempt's outcome and nothing else — no URL, no canvas, no payload, so
// an observer can be wired to an open endpoint. Declared here rather than
// importing the metrics package, keeping the dependency pointing one way.
//
// OPTIONAL and nil-safe in the emitter style: nil means nobody is counting.
type DeliveryObserver interface {
	ObserveWebhookDelivery(outcome string)
}

// Worker is the background delivery loop: lease due deliveries → sign + send →
// record ok / schedule retry / dead-letter.
type Worker struct {
	store  WorkerStore
	sender *Sender
	// observer counts delivery outcomes. Optional; see DeliveryObserver.
	observer DeliveryObserver

	pollInterval time.Duration
	batchSize    int
	concurrency  int
	leaseTimeout time.Duration
	reapInterval time.Duration

	now  func() time.Time
	logf func(format string, args ...any)

	// lastLeaseErrLog throttles the "lease deliveries" error log. The poll runs
	// every few seconds, so an unapplied migration or a Supabase outage would
	// otherwise emit the same line ~17k times an hour and bury everything else.
	mu              sync.Mutex
	lastLeaseErrLog time.Time
}

// WorkerOption customizes NewWorker.
type WorkerOption func(*Worker)

// WithSender swaps the HTTP sender (tests point it at an httptest server with
// the private-address guard relaxed).
func WithSender(s *Sender) WorkerOption { return func(w *Worker) { w.sender = s } }

// WithPollInterval sets how often the queue is polled.
func WithPollInterval(d time.Duration) WorkerOption {
	return func(w *Worker) { w.pollInterval = d }
}

// WithBatchSize sets how many deliveries one tick leases.
func WithBatchSize(n int) WorkerOption { return func(w *Worker) { w.batchSize = n } }

// WithClock replaces the clock (tests assert the scheduled next_attempt_at).
func WithClock(now func() time.Time) WorkerOption { return func(w *Worker) { w.now = now } }

// WithObserver attaches the delivery-outcome metrics seam. Pass nil (or omit)
// to count nothing.
func WithObserver(o DeliveryObserver) WorkerOption {
	return func(w *Worker) { w.observer = o }
}

// WithLogger replaces the log sink (tests silence it).
func WithLogger(logf func(string, ...any)) WorkerOption {
	return func(w *Worker) { w.logf = logf }
}

// NewWorker builds the delivery worker. It does nothing until Run is called.
func NewWorker(st WorkerStore, opts ...WorkerOption) *Worker {
	w := &Worker{
		store:        st,
		sender:       NewSender(),
		pollInterval: DefaultPollInterval,
		batchSize:    DefaultBatchSize,
		concurrency:  DefaultConcurrency,
		leaseTimeout: DefaultLeaseTimeout,
		reapInterval: DefaultReapInterval,
		now:          func() time.Time { return time.Now().UTC() },
		logf:         log.Printf,
	}
	for _, opt := range opts {
		opt(w)
	}
	return w
}

// Run polls until ctx is cancelled. Mirrors the hub goroutine in cmd/server:
// started with `go worker.Run(ctx)` at boot, stopped by cancelling ctx during
// graceful shutdown. Returns when ctx is done; in-flight attempts are bounded by
// RequestTimeout, and anything cut off mid-send is recovered by the next
// process's reaper (that is what the lease clock is for).
func (w *Worker) Run(ctx context.Context) {
	w.logf("webhooks: delivery worker started (poll %s, %d attempts, backoff %v)",
		w.pollInterval, MaxAttempts, RetrySchedule)

	poll := time.NewTicker(w.pollInterval)
	defer poll.Stop()
	reap := time.NewTicker(w.reapInterval)
	defer reap.Stop()

	for {
		select {
		case <-ctx.Done():
			w.logf("webhooks: delivery worker stopped")
			return
		case <-reap.C:
			w.reap(ctx)
		case <-poll.C:
			w.Tick(ctx)
		}
	}
}

// Tick runs one poll cycle: lease a batch and deliver it. Exported so tests can
// drive the worker deterministically instead of waiting on a ticker.
func (w *Worker) Tick(ctx context.Context) {
	batch, err := w.store.LeaseWebhookDeliveries(ctx, w.batchSize)
	if err != nil {
		w.logLeaseErr(err)
		// Fall through: a partial lease still returns the rows it claimed, and
		// dropping them here would strand them until the reaper.
	}
	if len(batch) == 0 {
		return
	}

	// A canvas with several webhooks pointing at the same config fans out to the
	// same target; cache the config per tick so N deliveries aren't N lookups.
	cache := &webhookCache{store: w.store}

	sem := make(chan struct{}, w.concurrency)
	var wg sync.WaitGroup
	for _, d := range batch {
		wg.Add(1)
		sem <- struct{}{}
		go func(d *store.WebhookDelivery) {
			defer wg.Done()
			defer func() { <-sem }()
			w.deliver(ctx, cache, d)
		}(d)
	}
	wg.Wait()
}

// logLeaseErr emits at most one poll-failure line per minute. The most likely
// cause is migration 0038 not being applied yet, which is a state the process
// can sit in for a while.
func (w *Worker) logLeaseErr(err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	now := w.now()
	if !w.lastLeaseErrLog.IsZero() && now.Sub(w.lastLeaseErrLog) < time.Minute {
		return
	}
	w.lastLeaseErrLog = now
	w.logf("webhooks: lease deliveries: %v (suppressing repeats for 1m — is migration 0038 applied?)", err)
}

// reap returns leases abandoned by a crashed worker to the queue.
func (w *Worker) reap(ctx context.Context) {
	n, err := w.store.ReapStuckWebhookDeliveries(ctx, w.leaseTimeout)
	if err != nil {
		w.logf("webhooks: reap stuck deliveries: %v", err)
		return
	}
	if n > 0 {
		w.logf("webhooks: requeued %d delivery(s) stuck in 'delivering'", n)
	}
}

// deliver performs one leased attempt and writes its outcome back.
//
// The row arrives with attempt_count ALREADY incremented for this attempt (the
// lease stamps it), so d.AttemptCount is "attempts made including this one" —
// exactly what NextRetryDelay expects.
func (w *Worker) deliver(ctx context.Context, cache *webhookCache, d *store.WebhookDelivery) {
	hook, err := cache.get(ctx, d.WebhookID)
	switch {
	case errors.Is(err, store.ErrWebhookNotFound):
		// Config deleted between enqueue and lease. The FK cascade normally
		// takes the delivery with it, so this is a race, not a steady state —
		// terminal either way, and never worth a retry.
		w.finish(ctx, d, store.WebhookDeliveryResult{Error: "webhook config no longer exists"}, false)
		return
	case err != nil:
		// Transient store failure: leave the budget alone by scheduling a retry
		// if there is one. (The attempt was already counted by the lease; that
		// is the conservative direction — a permanently broken store exhausts
		// the budget and dead-letters rather than looping forever.)
		w.finish(ctx, d, store.WebhookDeliveryResult{Error: "load webhook config: " + err.Error()}, true)
		return
	}
	if !hook.Enabled || !hook.WantsEvent(d.EventType) {
		// Disabled or unsubscribed after the row was enqueued. Honour the
		// current config: don't send, and don't leave it in the queue forever.
		w.finish(ctx, d, store.WebhookDeliveryResult{Error: "webhook disabled or no longer subscribed to " + d.EventType}, false)
		return
	}

	body := []byte(d.Payload)
	if len(body) == 0 {
		body = []byte("{}")
	}
	att := w.sender.Send(ctx, hook.URL, hook.Secret, d.ID, d.EventType, body, w.now())

	res := store.WebhookDeliveryResult{
		ResponseBody: truncate(att.Body, MaxResponseBytes),
		Error:        att.Err,
	}
	if att.StatusCode != 0 {
		code := att.StatusCode
		res.ResponseStatus = &code
	}

	if att.OK {
		// Counted on the DELIVERY outcome, not on the bookkeeping write: the
		// receiver did get it even if marking the row afterwards fails.
		w.observe(OutcomeOK)
		if err := w.store.MarkWebhookDeliveryOK(ctx, d.ID, res); err != nil {
			w.logf("webhooks: mark delivery %s ok: %v", d.ID, err)
		}
		return
	}
	w.finish(ctx, d, res, att.Retryable)
}

// observe reports a delivery outcome to the optional metrics seam.
func (w *Worker) observe(outcome string) {
	if w.observer != nil {
		w.observer.ObserveWebhookDelivery(outcome)
	}
}

// finish records a failed attempt: schedule the next retry if the failure is
// retryable AND budget remains, otherwise dead-letter.
func (w *Worker) finish(ctx context.Context, d *store.WebhookDelivery, res store.WebhookDeliveryResult, retryable bool) {
	if retryable {
		if delay, ok := NextRetryDelay(d.AttemptCount); ok {
			next := w.now().Add(delay)
			// A retryable failure with budget left: counted as failed, not dead.
			// The distinction is the whole point — webhook_failed climbing while
			// webhook_dead stays flat is a receiver flapping, not a broken config.
			w.observe(OutcomeFailed)
			if err := w.store.MarkWebhookDeliveryFailed(ctx, d.ID, next, res); err != nil {
				w.logf("webhooks: mark delivery %s failed: %v", d.ID, err)
			}
			return
		}
	}
	// Dead letter: budget spent, or a failure retrying cannot fix (4xx, blocked
	// target, redirect, deleted/disabled config).
	w.observe(OutcomeDead)
	if err := w.store.MarkWebhookDeliveryDead(ctx, d.ID, res); err != nil {
		w.logf("webhooks: mark delivery %s dead: %v", d.ID, err)
		return
	}
	w.logf("webhooks: delivery %s dead-lettered after %d attempt(s) (event %s, status %s, err %q)",
		d.ID, d.AttemptCount, d.EventType, statusText(res.ResponseStatus), res.Error)
}

// webhookCache memoizes config lookups within one tick.
type webhookCache struct {
	store WorkerStore
	mu    sync.Mutex
	hooks map[uuid.UUID]*store.Webhook
	errs  map[uuid.UUID]error
}

func (c *webhookCache) get(ctx context.Context, id uuid.UUID) (*store.Webhook, error) {
	c.mu.Lock()
	if h, ok := c.hooks[id]; ok {
		c.mu.Unlock()
		return h, nil
	}
	if err, ok := c.errs[id]; ok {
		c.mu.Unlock()
		return nil, err
	}
	c.mu.Unlock()

	h, err := c.store.GetWebhookWithSecret(ctx, id)

	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		if c.errs == nil {
			c.errs = map[uuid.UUID]error{}
		}
		c.errs[id] = err
		return nil, err
	}
	if c.hooks == nil {
		c.hooks = map[uuid.UUID]*store.Webhook{}
	}
	c.hooks[id] = h
	return h, nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func statusText(code *int) string {
	if code == nil {
		return "none"
	}
	return strconv.Itoa(*code)
}
