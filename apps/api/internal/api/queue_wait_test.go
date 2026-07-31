package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/webhooks"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// TDM-148 — the long poll. These tests are written against the two failure modes
// that would make the endpoint worse than useless:
//
//  1. hanging on an approval that already happened (the race), and
//  2. leaking a parked waiter when the caller goes away.
//
// Everything blocking runs through `runWait`, which fails the test rather than
// hanging the suite if the handler never answers.

// ── harness ──────────────────────────────────────────────────────────────────

type queueFakeStore struct {
	store.Store
	mu    sync.Mutex
	tasks []*store.Action
	// filters records the (state, type, assignee) triple of every ListActions
	// call, so a test can prove the wait reads the SAME queue queue_next does.
	filters []string
}

func (f *queueFakeStore) ListActions(_ context.Context, _ uuid.UUID, stateFilter, typeFilter, assigneeFilter string) ([]*store.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.filters = append(f.filters, stateFilter+"/"+typeFilter+"/"+assigneeFilter)
	out := make([]*store.Action, 0, len(f.tasks))
	for _, a := range f.tasks {
		if stateFilter != "" && a.State != stateFilter {
			continue
		}
		if typeFilter != "" && a.Type != typeFilter {
			continue
		}
		if assigneeFilter != "" && decodeTaskPayload(a.Payload).Assignee != assigneeFilter {
			continue
		}
		out = append(out, a)
	}
	return out, nil
}

// publish makes a task visible to readers — what an approval commits before it
// signals.
func (f *queueFakeStore) publish(a *store.Action) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tasks = append(f.tasks, a)
}

func (f *queueFakeStore) seenFilters() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.filters...)
}

// readyQueueTask is a ready-to-work agent task, optionally inside an epic.
func readyQueueTask(title, epicID string) *store.Action {
	payload := map[string]any{"title": title, "assignee": "agent"}
	if epicID != "" {
		payload["epicId"] = epicID
	}
	raw, _ := json.Marshal(payload)
	return &store.Action{ID: uuid.New(), Type: "task", State: "approved", Payload: raw}
}

// waitRequest is a GET on the long poll, with the canvas claims the JWT
// middleware would have put in context.
func waitRequest(t *testing.T, canvasID uuid.UUID, query string) *http.Request {
	t.Helper()
	return canvasRequest(t, "GET", "/api/canvas/queue/wait"+query, nil, canvasID, "")
}

// runWait calls the handler on its own goroutine and returns a channel that
// closes when it answers. A handler that never returns fails the test at the
// caller's deadline instead of hanging `go test`.
func runWait(h *Handler, r *http.Request) (*httptest.ResponseRecorder, <-chan struct{}) {
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.WaitForQueue(w, r)
	}()
	return w, done
}

func mustAnswer(t *testing.T, done <-chan struct{}, within time.Duration, what string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(within):
		t.Fatalf("%s: the wait never answered within %s", what, within)
	}
}

func decodeWait(t *testing.T, w *httptest.ResponseRecorder) queueWaitMsg {
	t.Helper()
	var msg queueWaitMsg
	if err := json.Unmarshal(w.Body.Bytes(), &msg); err != nil {
		t.Fatalf("decode response %q: %v", w.Body.String(), err)
	}
	return msg
}

// awaitParked blocks until n waiters are registered on the canvas — the moment
// the handler is genuinely asleep and a signal is meaningful.
func awaitParked(t *testing.T, h *Handler, canvasID uuid.UUID, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if h.waiters.countFor(canvasID) == n {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("waiters on canvas = %d, want %d (the handler never parked)", h.waiters.countFor(canvasID), n)
}

// ── 1. THE RACE: work that is already approved must answer instantly ─────────

// The single most likely bug in a long poll: an agent that calls a second after
// the human clicked approve waits out the whole timeout for an approval that has
// already happened. The read happens BEFORE any blocking, so this returns at once.
func TestQueueWaitReturnsImmediatelyWhenWorkIsAlreadyApproved(t *testing.T) {
	canvasID := uuid.New()
	f := &queueFakeStore{}
	f.publish(readyQueueTask("already approved", ""))
	h := NewHandler(f, nil, nil)

	start := time.Now()
	w, done := runWait(h, waitRequest(t, canvasID, ""))
	// Generous, but far below the 25s default: a regression that blocks here
	// fails the test rather than passing slowly.
	mustAnswer(t, done, 2*time.Second, "already-approved work")

	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	msg := decodeWait(t, w)
	if msg.Status != queueWaitReady {
		t.Fatalf("status %q, want %q — approved work was already there", msg.Status, queueWaitReady)
	}
	if msg.Count != 1 || len(msg.Actions) != 1 {
		t.Fatalf("count=%d actions=%d, want 1 ready task", msg.Count, len(msg.Actions))
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("took %s to answer with work that was already approved", elapsed)
	}
	// And it read the queue queue_next reads: approved / task / agent.
	if got := f.seenFilters(); len(got) != 1 || got[0] != "approved/task/agent" {
		t.Fatalf("ListActions filters = %v, want one [approved/task/agent]", got)
	}
	// Nothing parked: an immediate answer must not leave a registration behind.
	if n := h.waiters.count(); n != 0 {
		t.Fatalf("%d waiter(s) still parked after an immediate answer", n)
	}
}

// The other half of the same race: the approval lands AFTER the waiter has
// parked. The waiter must wake on the event — and within a second, not on the
// next timeout.
func TestQueueWaitWakesOnApprovalWithoutPollingTheDatabase(t *testing.T) {
	canvasID := uuid.New()
	f := &queueFakeStore{}
	h := NewHandler(f, nil, nil) // NOTE: no emitter wired — see below

	w, done := runWait(h, waitRequest(t, canvasID, "?timeout=30"))
	awaitParked(t, h, canvasID, 1)

	// Between parking and the approval, the handler must have read the queue
	// exactly once. A server that polls its own database on a timer would show a
	// climbing count here; this asserts it stays at the single arrival read.
	time.Sleep(150 * time.Millisecond)
	if got := f.seenFilters(); len(got) != 1 {
		t.Fatalf("%d store reads while parked, want 1 — the wait must be event-driven, not a timer", len(got))
	}

	// The approval: commit first, then announce — the order every call site uses.
	task := readyQueueTask("approved while you waited", "")
	f.publish(task)
	// h.events is nil here on purpose: waking a waiting agent is a property of
	// the canvas, NOT of whether outbound webhooks happen to be configured.
	h.emitTaskEvent(canvasID, webhooks.EventTaskApproved, task)

	mustAnswer(t, done, time.Second, "approval while parked")
	msg := decodeWait(t, w)
	if msg.Status != queueWaitReady || msg.Count != 1 {
		t.Fatalf("status=%q count=%d, want ready with 1 task (body %s)", msg.Status, msg.Count, w.Body.String())
	}
	if n := h.waiters.count(); n != 0 {
		t.Fatalf("%d waiter(s) still parked after answering", n)
	}
}

// ── 2. A timeout is an answer, not a failure ─────────────────────────────────

func TestQueueWaitTimeoutIsDistinguishableFromAnError(t *testing.T) {
	canvasID := uuid.New()
	h := NewHandler(&queueFakeStore{}, nil, nil)

	w, done := runWait(h, waitRequest(t, canvasID, "?timeout=1"))
	mustAnswer(t, done, 3*time.Second, "empty queue")

	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 — a timeout is NOT an error (body %s)", w.Code, w.Body.String())
	}
	msg := decodeWait(t, w)
	if msg.Status != queueWaitTimeout {
		t.Fatalf("status %q, want %q", msg.Status, queueWaitTimeout)
	}
	if msg.Count != 0 || len(msg.Actions) != 0 {
		t.Fatalf("a timeout must carry no work, got %d", msg.Count)
	}
	if msg.TimeoutSeconds != 1 {
		t.Fatalf("timeoutSeconds = %d, want the effective 1", msg.TimeoutSeconds)
	}
	if msg.WaitedMs < 500 {
		t.Fatalf("waitedMs = %d — it returned early instead of waiting out the window", msg.WaitedMs)
	}
	// `actions` must serialize as [] and never null: a caller ranges over it
	// without a nil check.
	if !strings.Contains(w.Body.String(), `"actions":[]`) {
		t.Fatalf("empty queue must serialize actions as [], got %s", w.Body.String())
	}
	// The body has to SAY it, too — the caller is a model, and "timeout" reading
	// as failure is exactly how this feature dies in the field.
	if !strings.Contains(msg.Hint, "call again") {
		t.Fatalf("the timeout hint must tell the caller to call again, got %q", msg.Hint)
	}
}

// ── 3. Cleanup: an abandoned wait leaks nothing ──────────────────────────────

func TestQueueWaitReleasesTheWaiterWhenTheClientDisconnects(t *testing.T) {
	canvasID := uuid.New()
	h := NewHandler(&queueFakeStore{}, nil, nil)

	r := waitRequest(t, canvasID, "?timeout=60")
	ctx, cancel := context.WithCancel(r.Context())
	w, done := runWait(h, r.WithContext(ctx))
	awaitParked(t, h, canvasID, 1)

	cancel() // what net/http does when the client hangs up

	// It must return on the disconnect, NOT sit out the 60s window.
	mustAnswer(t, done, 2*time.Second, "client disconnect")
	if n := h.waiters.count(); n != 0 {
		t.Fatalf("%d waiter(s) survived the disconnect — this is the goroutine/memory leak", n)
	}
	if w.Body.Len() != 0 {
		t.Fatalf("nothing should be written to a client that hung up, got %s", w.Body.String())
	}
}

// Registering and releasing many waits leaves the registry EMPTY — including its
// per-canvas rooms, so a busy canvas doesn't leave a map entry behind per canvas
// that ever waited.
func TestQueueWaiterRegistryEmptiesCompletely(t *testing.T) {
	var q queueWaiters
	canvasID := uuid.New()
	releases := make([]func(waitEnd) bool, 0, 20)
	for i := 0; i < 20; i++ {
		_, release, _, ok := q.add(canvasID, "", "")
		if !ok {
			t.Fatalf("waiter %d refused below the cap", i)
		}
		releases = append(releases, release)
	}
	if q.count() != 20 {
		t.Fatalf("count = %d, want 20", q.count())
	}
	for _, release := range releases {
		release(waitEndGone)
		release(waitEndGone) // idempotent: a double release must not corrupt the count
	}
	if q.count() != 0 || q.countFor(canvasID) != 0 {
		t.Fatalf("registry not empty: total=%d canvas=%d", q.count(), q.countFor(canvasID))
	}
	q.mu.Lock()
	rooms := len(q.rooms)
	q.mu.Unlock()
	if rooms != 0 {
		t.Fatalf("%d empty room(s) left behind — the per-canvas map must be pruned", rooms)
	}
	// Signalling a canvas nobody waits on is a no-op, not a panic.
	q.signal(canvasID)
}

// ── 4. Bounded waiters ───────────────────────────────────────────────────────

func TestQueueWaitBoundsConcurrentWaitersPerCanvas(t *testing.T) {
	canvasID := uuid.New()
	other := uuid.New()
	f := &queueFakeStore{}
	f.publish(readyQueueTask("work on the other canvas", ""))
	h := NewHandler(f, nil, nil)

	// Fill the canvas's cap without spawning 64 goroutines.
	releases := make([]func(waitEnd) bool, 0, maxQueueWaitersPerCanvas)
	for i := 0; i < maxQueueWaitersPerCanvas; i++ {
		_, release, _, ok := h.waiters.add(canvasID, "", "")
		if !ok {
			t.Fatalf("waiter %d refused below the per-canvas cap", i)
		}
		releases = append(releases, release)
	}

	w, done := runWait(h, waitRequest(t, canvasID, "?timeout=60"))
	mustAnswer(t, done, 2*time.Second, "over-cap wait")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d, want 429 (body %s)", w.Code, w.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode 429 body: %v", err)
	}
	if body["error"] != "too_many_waiters" {
		t.Fatalf("429 must carry a code to branch on, got %v", body)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Fatalf("a 429 must say when to come back")
	}

	// A DIFFERENT canvas is unaffected — the cap is per canvas, not a global gate
	// one busy board can close on everyone.
	w2, done2 := runWait(h, waitRequest(t, other, ""))
	mustAnswer(t, done2, 2*time.Second, "other canvas")
	if w2.Code != http.StatusOK || decodeWait(t, w2).Status != queueWaitReady {
		t.Fatalf("other canvas got %d %s", w2.Code, w2.Body.String())
	}

	for _, release := range releases {
		release(waitEndGone)
	}
	if n := h.waiters.count(); n != 0 {
		t.Fatalf("%d waiter(s) left after releasing the cap", n)
	}
}

// ── 5. Filters + parameters ──────────────────────────────────────────────────

// epicId narrows the wait to the batch an orchestrator just proposed: an
// approval in a DIFFERENT epic must not end the wait, or the orchestrator wakes
// up to work that isn't its own.
func TestQueueWaitEpicFilterIgnoresOtherEpics(t *testing.T) {
	canvasID := uuid.New()
	mine, theirs := uuid.New().String(), uuid.New().String()
	f := &queueFakeStore{}
	h := NewHandler(f, nil, nil)

	w, done := runWait(h, waitRequest(t, canvasID, "?timeout=1&epicId="+mine))
	awaitParked(t, h, canvasID, 1)

	// Someone else's batch gets approved — a real signal, wrong epic.
	strangers := readyQueueTask("not your batch", theirs)
	f.publish(strangers)
	h.emitTaskEvent(canvasID, webhooks.EventTaskApproved, strangers)

	mustAnswer(t, done, 3*time.Second, "foreign epic approval")
	if msg := decodeWait(t, w); msg.Status != queueWaitTimeout {
		t.Fatalf("status %q, want timeout — an approval in another epic must not end the wait", msg.Status)
	}

	// Now the caller's own batch: same endpoint, same filter, answers with work.
	f.publish(readyQueueTask("your batch", mine))
	w2, done2 := runWait(h, waitRequest(t, canvasID, "?timeout=5&epicId="+mine))
	mustAnswer(t, done2, 2*time.Second, "own epic approval")
	msg := decodeWait(t, w2)
	if msg.Status != queueWaitReady || msg.Count != 1 {
		t.Fatalf("status=%q count=%d, want ready with only the caller's task", msg.Status, msg.Count)
	}
}

func TestQueueWaitParameterHandling(t *testing.T) {
	canvasID := uuid.New()

	t.Run("garbage timeout is a 400", func(t *testing.T) {
		h := NewHandler(&queueFakeStore{}, nil, nil)
		w, done := runWait(h, waitRequest(t, canvasID, "?timeout=soon"))
		mustAnswer(t, done, time.Second, "bad timeout")
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status %d, want 400", w.Code)
		}
		if h.waiters.count() != 0 {
			t.Fatalf("a refused request must register no waiter")
		}
	})

	t.Run("garbage epicId is a 400", func(t *testing.T) {
		h := NewHandler(&queueFakeStore{}, nil, nil)
		w, done := runWait(h, waitRequest(t, canvasID, "?epicId=not-a-uuid"))
		mustAnswer(t, done, time.Second, "bad epicId")
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status %d, want 400", w.Code)
		}
	})

	t.Run("an over-long timeout is clamped and reported", func(t *testing.T) {
		f := &queueFakeStore{}
		f.publish(readyQueueTask("ready", ""))
		h := NewHandler(f, nil, nil)
		w, done := runWait(h, waitRequest(t, canvasID, "?timeout=9999"))
		mustAnswer(t, done, 2*time.Second, "clamped timeout")
		if got := decodeWait(t, w).TimeoutSeconds; got != int(queueWaitMaxTimeout/time.Second) {
			t.Fatalf("timeoutSeconds = %d, want the clamped %d", got, int(queueWaitMaxTimeout/time.Second))
		}
	})

	t.Run("assignee=any drops the filter", func(t *testing.T) {
		f := &queueFakeStore{}
		human := readyQueueTask("a human todo", "")
		human.Payload = json.RawMessage(`{"title":"a human todo","assignee":"human"}`)
		f.publish(human)
		h := NewHandler(f, nil, nil)

		// Default (agent): a human's todo must not wake a worker.
		w, done := runWait(h, waitRequest(t, canvasID, "?timeout=1"))
		mustAnswer(t, done, 3*time.Second, "human todo, agent queue")
		if msg := decodeWait(t, w); msg.Status != queueWaitTimeout {
			t.Fatalf("a human todo ended an agent's wait: %q", msg.Status)
		}
		// assignee=any: same row, now in scope.
		w2, done2 := runWait(h, waitRequest(t, canvasID, "?timeout=5&assignee=any"))
		mustAnswer(t, done2, 2*time.Second, "human todo, any queue")
		if msg := decodeWait(t, w2); msg.Status != queueWaitReady {
			t.Fatalf("assignee=any should see it, got %q", msg.Status)
		}
	})
}

func TestParseQueueWaitTimeout(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want time.Duration
		err  bool
	}{
		{"", queueWaitDefaultTimeout, false},
		{"10", 10 * time.Second, false},
		{"0", queueWaitMinTimeout, false},
		{"-4", queueWaitMinTimeout, false},
		{"99999", queueWaitMaxTimeout, false},
		{" 30 ", 30 * time.Second, false},
		{"soon", 0, true},
		{"25.5", 0, true},
	} {
		got, err := parseQueueWaitTimeout(tc.raw)
		if tc.err {
			if err == nil {
				t.Errorf("parseQueueWaitTimeout(%q) = %v, want an error", tc.raw, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseQueueWaitTimeout(%q): %v", tc.raw, err)
		} else if got != tc.want {
			t.Errorf("parseQueueWaitTimeout(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}
	// The default must clear the tightest common proxy idle timeout (30s) with
	// room to spare, and stay under a typical MCP client's per-tool timeout.
	if queueWaitDefaultTimeout >= 30*time.Second {
		t.Errorf("default wait %v does not clear a 30s intermediary idle timeout", queueWaitDefaultTimeout)
	}
	if queueWaitMaxTimeout > 60*time.Second {
		t.Errorf("max wait %v is long enough to be cut by a client timeout", queueWaitMaxTimeout)
	}
}

// ── 6. Wiring: which state changes wake a waiter ─────────────────────────────

// Every door into the ready queue funnels through emitTaskEvent, so the wake is
// asserted there — including the negative half, since waking on a completion
// would spin an agent through a store read for work that isn't there.
func TestOnlyApprovalWakesQueueWaiters(t *testing.T) {
	canvasID := uuid.New()
	task := readyQueueTask("t", "")
	epic := &store.Action{ID: uuid.New(), Type: "epic", State: "approved", Payload: json.RawMessage(`{"title":"batch"}`)}

	for _, tc := range []struct {
		name      string
		eventType string
		action    *store.Action
		wake      bool
	}{
		{"task approved", webhooks.EventTaskApproved, task, true},
		{"task completed", webhooks.EventTaskCompleted, task, false},
		{"claim expired", webhooks.EventTaskClaimExpired, task, false},
		{"epic approved", webhooks.EventTaskApproved, epic, false},
		{"nil action", webhooks.EventTaskApproved, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHandler(&queueFakeStore{}, nil, nil) // no emitter wired
			ready, release, _, ok := h.waiters.add(canvasID, "", "")
			if !ok {
				t.Fatal("could not register a waiter")
			}
			defer release(waitEndGone)
			h.emitTaskEvent(canvasID, tc.eventType, tc.action)
			select {
			case <-ready:
				if !tc.wake {
					t.Fatalf("%s woke a waiter; only work entering the ready queue should", tc.name)
				}
			default:
				if tc.wake {
					t.Fatalf("%s did not wake the waiter", tc.name)
				}
			}
		})
	}
}

// Releasing a stuck task puts it back in the ready queue, so it must wake a
// waiter too — even though it deliberately fires no task.approved webhook.
func TestReleasingATaskWakesQueueWaiters(t *testing.T) {
	canvasID := uuid.New()
	task := humanTask("executing")
	task.ClaimedBy = ptr("worker-that-died")
	h := NewHandler(newMoveStore(task), nil, nil)

	ready, release, _, ok := h.waiters.add(canvasID, "", "")
	if !ok {
		t.Fatal("could not register a waiter")
	}
	defer release(waitEndGone)

	w := httptest.NewRecorder()
	r := canvasRequest(t, "POST", "/api/canvas/actions/"+task.ID.String()+"/release", nil, canvasID, task.ID.String())
	h.ReleaseAction(w, r.WithContext(WithAuthor(r.Context(), AuthorHuman)))
	if w.Code != http.StatusOK {
		t.Fatalf("release status %d (body %s)", w.Code, w.Body.String())
	}
	select {
	case <-ready:
	default:
		t.Fatal("a released task went back to 'approved' without waking anyone waiting for work")
	}
}

// ── 7. The route ─────────────────────────────────────────────────────────────

func TestQueueWaitRouteIsGetOnlyAndRequiresACanvasToken(t *testing.T) {
	router := NewRouter(nil, nil, auth.NewService("test-secret-for-tdm-148", time.Hour), nil, false, nil, "", t.TempDir(), "", nil, nil)
	mux, ok := router.(*chi.Mux)
	if !ok {
		t.Fatal("NewRouter no longer returns a *chi.Mux; this route-walk test needs updating")
	}
	seen := map[string]bool{}
	if err := chi.Walk(mux, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if strings.Contains(route, "/queue/") {
			seen[method+" "+route] = true
		}
		return nil
	}); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if !seen["GET /api/canvas/queue/wait"] {
		t.Fatalf("the long-poll route is missing; found %v", seen)
	}
	for r := range seen {
		if !strings.HasPrefix(r, "GET ") {
			t.Errorf("%s is a non-GET queue route — waiting is a read", r)
		}
	}

	// And it is behind the canvas JWT, like every other canvas read: no token,
	// no wait (and, importantly, no parked waiter for an unauthenticated caller).
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/canvas/queue/wait", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated wait = %d, want 401 (body %s)", w.Code, w.Body.String())
	}
}

// A last sanity check on the shape TDM-149 codes against: `actions` is the SAME
// projection GET /api/canvas/actions returns, so the gateway reuses its mapping.
func TestQueueWaitActionsMatchTheListShape(t *testing.T) {
	canvasID := uuid.New()
	task := readyQueueTask("shape check", "")
	task.Ticket = ptr(148)
	f := &queueFakeStore{}
	f.publish(task)
	h := NewHandler(f, nil, nil)

	w, done := runWait(h, waitRequest(t, canvasID, ""))
	mustAnswer(t, done, 2*time.Second, "shape check")

	var envelope struct {
		Actions []map[string]any `json:"actions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The same read, through the ordinary list endpoint.
	lw := httptest.NewRecorder()
	h.ListActions(lw, canvasRequest(t, "GET", "/api/canvas/actions?type=task&state=approved&assignee=agent", nil, canvasID, ""))
	var listed struct {
		Actions []map[string]any `json:"actions"`
	}
	if err := json.Unmarshal(lw.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if fmt.Sprint(envelope.Actions) != fmt.Sprint(listed.Actions) {
		t.Fatalf("the wait's actions diverge from the list endpoint's:\n wait: %v\n list: %v", envelope.Actions, listed.Actions)
	}
}

// ── 8. WHO is waiting (TDM-151) ──────────────────────────────────────────────
//
// The board's claim is that you can look at it and see what the fleet is doing.
// An agent parked on the queue and an agent that silently died were, until this,
// the same picture — which is how an orchestrator that said it would wait and
// then ended its turn went unnoticed until a human happened to look.
//
// So these tests are written against the INVERSE failure, which is the dangerous
// one: waiting that is displayed but not real. Showing nothing is always
// recoverable; showing a waiting agent that isn't there recreates the exact bug.
// Every case below therefore asks "does this stop reading as waiting" first.

// waitRequestAs is a wait that asserts an agent identity, the way the gateway
// does on every canvas call (X-Tandem-Agent — see provenance.go).
func waitRequestAs(t *testing.T, canvasID uuid.UUID, agent, query string) *http.Request {
	t.Helper()
	r := waitRequest(t, canvasID, query)
	r.Header.Set(AgentIdentityHeader, agent)
	return r
}

// The happy path: a parked orchestrator is visibly parked, under its own name,
// with what it is waiting for and since when.
func TestWaitingAgentIsVisibleOnTheRoster(t *testing.T) {
	canvasID := uuid.New()
	h := NewHandler(&queueFakeStore{}, nil, nil)

	r := waitRequestAs(t, canvasID, "opus-orchestrator", "?timeout=60")
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	_, done := runWait(h, r.WithContext(ctx))
	awaitParked(t, h, canvasID, 1)

	waiting, anon := h.waiters.waitingOn(canvasID, time.Now().UTC())
	if anon != 0 {
		t.Fatalf("anonymous waits = %d, want 0 — the identity was asserted", anon)
	}
	watch, ok := waiting["opus-orchestrator"]
	if !ok {
		t.Fatalf("the parked agent is not in the waiting set: %+v", waiting)
	}
	if watch.Since.IsZero() {
		t.Fatal("a wait with no start time can't answer 'waiting since when'")
	}
	if watch.EpicID != "" {
		t.Fatalf("epicId = %q, want empty — this wait named no epic", watch.EpicID)
	}

	// And it lands on the roster as a WAITING agent: not working, not idle.
	agents := []*store.Agent{{ID: uuid.New(), Name: "opus-orchestrator", Role: "planner", CreatedAt: time.Now().UTC()}}
	roster := buildRoster(agents, nil, waiting, anon, time.Now().UTC())
	if len(roster.Agents) != 1 || roster.Agents[0].Waiting == nil {
		t.Fatalf("roster does not show the agent waiting: %+v", roster.Agents[0])
	}
	if got := roster.Agents[0].Waiting.Scope; got != "queue" {
		t.Fatalf("scope = %q, want queue", got)
	}
	if roster.Counts.Waiting != 1 || roster.Counts.Idle != 0 || roster.Counts.Working != 0 {
		t.Fatalf("counts = %+v, want exactly one waiting agent", roster.Counts)
	}

	cancel()
	mustAnswer(t, done, 2*time.Second, "waiting agent")
}

// THE TICKET'S OWN CONDITION, stated as a test: with nobody parked, the board
// must not imply anyone is. No agent carries a waiting block and no count is
// non-zero — including for an agent that is registered, online, and idle.
func TestNothingWaitingImpliesNobodyWaiting(t *testing.T) {
	canvasID := uuid.New()
	h := NewHandler(&queueFakeStore{}, nil, nil)

	waiting, anon := h.waiters.waitingOn(canvasID, time.Now().UTC())
	if len(waiting) != 0 || anon != 0 {
		t.Fatalf("a canvas nobody is waiting on reported %d waits (+%d anonymous)", len(waiting), anon)
	}
	agents := []*store.Agent{{ID: uuid.New(), Name: "idle-agent", Status: "online", CreatedAt: time.Now().UTC()}}
	roster := buildRoster(agents, nil, waiting, anon, time.Now().UTC())
	if roster.Agents[0].Waiting != nil {
		t.Fatalf("an idle agent must not read as waiting: %+v", roster.Agents[0].Waiting)
	}
	if roster.Counts.Waiting != 0 || roster.Counts.WaitingUnattributed != 0 {
		t.Fatalf("counts = %+v, want no waiting", roster.Counts)
	}
	if roster.Counts.Idle != 1 {
		t.Fatalf("idle = %d, want 1", roster.Counts.Idle)
	}
}

// A waiter that hangs up must stop reading as waiting AT ONCE — no grace, no
// lingering row. This is the ghost the feature would otherwise create: the agent
// is gone, and the board would still be pointing at it.
func TestDisconnectedWaiterStopsReadingAsWaiting(t *testing.T) {
	canvasID := uuid.New()
	h := NewHandler(&queueFakeStore{}, nil, nil)

	r := waitRequestAs(t, canvasID, "ghost-orchestrator", "?timeout=60")
	ctx, cancel := context.WithCancel(r.Context())
	_, done := runWait(h, r.WithContext(ctx))
	awaitParked(t, h, canvasID, 1)

	cancel() // the agent's process died / the connection dropped
	mustAnswer(t, done, 2*time.Second, "disconnect")

	waiting, anon := h.waiters.waitingOn(canvasID, time.Now().UTC())
	if len(waiting) != 0 || anon != 0 {
		t.Fatalf("a disconnected agent still reads as waiting: %+v (+%d anonymous)", waiting, anon)
	}
}

// The same rule for the other non-timeout ending: a wait that ANSWERS with work
// is over. The agent is claiming, not waiting.
func TestAnsweredWaitStopsReadingAsWaiting(t *testing.T) {
	canvasID := uuid.New()
	f := &queueFakeStore{}
	f.publish(readyQueueTask("already approved", ""))
	h := NewHandler(f, nil, nil)

	_, done := runWait(h, waitRequestAs(t, canvasID, "worker-1", "?timeout=60"))
	mustAnswer(t, done, 2*time.Second, "ready answer")

	if waiting, _ := h.waiters.waitingOn(canvasID, time.Now().UTC()); len(waiting) != 0 {
		t.Fatalf("an agent that was handed work still reads as waiting: %+v", waiting)
	}
}

// A long wait is a CHAIN of polls, and the gap between them is not a pause in
// waiting. The streak has to survive it — otherwise the fleet view blinks
// waiting → idle → waiting every 25 seconds and the "waiting for 6m" clock
// resets each time, which is the duration lie TDM-112 already fixed for claims.
func TestWaitingSurvivesTheGapBetweenPolls(t *testing.T) {
	canvasID := uuid.New()
	h := NewHandler(&queueFakeStore{}, nil, nil)

	_, done := runWait(h, waitRequestAs(t, canvasID, "patient-planner", "?timeout=1"))
	mustAnswer(t, done, 3*time.Second, "first poll")
	if n := h.waiters.count(); n != 0 {
		t.Fatalf("%d connection(s) still parked after the answer", n)
	}

	waiting, _ := h.waiters.waitingOn(canvasID, time.Now().UTC())
	first, ok := waiting["patient-planner"]
	if !ok {
		t.Fatal("the agent stopped reading as waiting in the gap between two polls")
	}

	// The re-call must not restart the clock.
	_, done2 := runWait(h, waitRequestAs(t, canvasID, "patient-planner", "?timeout=1"))
	mustAnswer(t, done2, 3*time.Second, "second poll")
	waiting, _ = h.waiters.waitingOn(canvasID, time.Now().UTC())
	second, ok := waiting["patient-planner"]
	if !ok {
		t.Fatal("the agent vanished from the waiting set on its second poll")
	}
	if !second.Since.Equal(first.Since) {
		t.Fatalf("waiting-since moved from %s to %s — each re-poll must not reset the clock",
			first.Since, second.Since)
	}
}

// …but the gap is BOUNDED. An agent that times out and never calls back (it
// said it would wait, then ended its turn — the failure this whole ticket
// exists to catch) drops out of the waiting set when the grace window passes.
func TestAWaiterThatNeverComesBackExpires(t *testing.T) {
	canvasID := uuid.New()
	h := NewHandler(&queueFakeStore{}, nil, nil)

	_, done := runWait(h, waitRequestAs(t, canvasID, "quitter", "?timeout=1"))
	mustAnswer(t, done, 3*time.Second, "only poll")
	if waiting, _ := h.waiters.waitingOn(canvasID, time.Now().UTC()); len(waiting) != 1 {
		t.Fatalf("inside the grace window the agent should still read as waiting, got %+v", waiting)
	}

	// Age the streak past its grace rather than sleeping through it.
	h.waiters.mu.Lock()
	h.waiters.streaks[canvasID]["quitter"].endedAt = time.Now().UTC().Add(-queueWaitStreakGrace - time.Second)
	h.waiters.mu.Unlock()

	waiting, anon := h.waiters.waitingOn(canvasID, time.Now().UTC())
	if len(waiting) != 0 || anon != 0 {
		t.Fatalf("an agent that never came back still reads as waiting: %+v", waiting)
	}
	// …and the bookkeeping is gone with it, not just hidden from the answer.
	h.waiters.mu.Lock()
	leftover := len(h.waiters.streaks)
	h.waiters.mu.Unlock()
	if leftover != 0 {
		t.Fatalf("%d expired streak map(s) left behind", leftover)
	}
}

// Waiting is per-PROCESS liveness and must not outlive the process, because the
// connections it describes didn't either. A restart is modelled here the only
// honest way: a new registry, which is exactly what a new process gets.
func TestWaitingDoesNotSurviveARestart(t *testing.T) {
	canvasID := uuid.New()
	h := NewHandler(&queueFakeStore{}, nil, nil)

	r := waitRequestAs(t, canvasID, "pre-restart", "?timeout=60")
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	_, done := runWait(h, r.WithContext(ctx))
	awaitParked(t, h, canvasID, 1)
	if waiting, _ := h.waiters.waitingOn(canvasID, time.Now().UTC()); len(waiting) != 1 {
		t.Fatalf("setup: expected one waiter, got %+v", waiting)
	}

	restarted := NewHandler(&queueFakeStore{}, nil, nil)
	waiting, anon := restarted.waiters.waitingOn(canvasID, time.Now().UTC())
	if len(waiting) != 0 || anon != 0 {
		t.Fatalf("a fresh process reported %d waiting agent(s) — waiting must not be stored", len(waiting))
	}
	roster := buildRoster(
		[]*store.Agent{{ID: uuid.New(), Name: "pre-restart", CreatedAt: time.Now().UTC()}},
		nil, waiting, anon, time.Now().UTC())
	if roster.Agents[0].Waiting != nil {
		t.Fatal("a restarted server must not resurrect a wait it is not holding")
	}

	cancel()
	mustAnswer(t, done, 2*time.Second, "pre-restart wait")
}

// A wait that asserts no identity is real but unattributable. It is COUNTED, so
// the board doesn't under-report presence — and no agent is invented for it,
// because a name nobody sent is the one thing worse than no name at all.
func TestAnonymousWaitIsCountedNotInvented(t *testing.T) {
	canvasID := uuid.New()
	h := NewHandler(&queueFakeStore{}, nil, nil)

	r := waitRequest(t, canvasID, "?timeout=60") // no X-Tandem-Agent
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	_, done := runWait(h, r.WithContext(ctx))
	awaitParked(t, h, canvasID, 1)

	waiting, anon := h.waiters.waitingOn(canvasID, time.Now().UTC())
	if len(waiting) != 0 {
		t.Fatalf("an anonymous wait was attributed to %+v", waiting)
	}
	if anon != 1 {
		t.Fatalf("anonymous waits = %d, want 1", anon)
	}
	roster := buildRoster(nil, nil, waiting, anon, time.Now().UTC())
	if len(roster.Agents) != 0 {
		t.Fatalf("an anonymous wait invented an agent row: %+v", roster.Agents)
	}
	if roster.Counts.WaitingUnattributed != 1 || roster.Counts.Waiting != 0 {
		t.Fatalf("counts = %+v, want one unattributed wait", roster.Counts)
	}

	cancel()
	mustAnswer(t, done, 2*time.Second, "anonymous wait")
}

// An orchestrator waiting on ITS batch says so: "waiting for TDM-… to be
// approved" is a different fact from "waiting for anything at all".
func TestWaitScopedToAnEpicSaysWhatItIsWaitingFor(t *testing.T) {
	canvasID := uuid.New()
	epicID := uuid.New().String()
	h := NewHandler(&queueFakeStore{}, nil, nil)

	r := waitRequestAs(t, canvasID, "epic-planner", "?timeout=60&epicId="+epicID)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	_, done := runWait(h, r.WithContext(ctx))
	awaitParked(t, h, canvasID, 1)

	waiting, anon := h.waiters.waitingOn(canvasID, time.Now().UTC())
	roster := buildRoster(nil, nil, waiting, anon, time.Now().UTC())
	if len(roster.Agents) != 1 || roster.Agents[0].Waiting == nil {
		t.Fatalf("expected one waiting agent, got %+v", roster.Agents)
	}
	// Waiting with no agents row still lists: an unregistered identity that is
	// holding a connection open is exactly who a human needs to see.
	if roster.Agents[0].Registered {
		t.Fatal("an identity with no agents row must be reported registered:false")
	}
	if got := roster.Agents[0].Waiting; got.Scope != "epic" || got.EpicID != epicID {
		t.Fatalf("waiting = %+v, want scope=epic on %s", got, epicID)
	}

	cancel()
	mustAnswer(t, done, 2*time.Second, "epic-scoped wait")
}

// A waiting agent also holding a claim reads as WORKING: what it holds is the
// more urgent fact, and it must not be double-counted.
func TestWorkingBeatsWaitingInTheCounts(t *testing.T) {
	now := time.Now().UTC()
	claimedAt := now.Add(-time.Minute)
	agents := []*store.Agent{{ID: uuid.New(), Name: "busy", CreatedAt: now}}
	executing := []*store.Action{{
		ID: uuid.New(), Type: "task", State: "executing",
		ClaimedBy: ptr("busy"), ClaimedAt: &claimedAt, Payload: json.RawMessage(`{"title":"in flight"}`),
	}}
	waiting := map[string]waitingWatch{"busy": {Since: now.Add(-2 * time.Minute)}}

	roster := buildRoster(agents, executing, waiting, 0, now)
	if roster.Counts.Working != 1 || roster.Counts.Waiting != 0 || roster.Counts.Idle != 0 {
		t.Fatalf("counts = %+v, want the agent counted once, as working", roster.Counts)
	}
	if roster.Agents[0].Waiting == nil {
		t.Fatal("the wait itself should still be reported on the row")
	}
}
