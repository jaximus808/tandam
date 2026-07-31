package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// The long poll (TDM-148) — ONE call that returns when there is work.
//
// WHY THIS EXISTS. An MCP agent has no sleep and no blocking call. Telling it to
// "poll queue_next on a backing-off interval" reliably fails: with no way to
// wait, the model ends its turn instead, and a human has to prompt it a second
// time to notice the approval that already happened. That is not a prompting
// problem, it is a missing primitive — so the WAITING moves to the server, where
// blocking is free, and the agent makes one call that answers when the queue has
// something in it.
//
// THE CONTRACT, in four lines:
//
//   - Ready work already there → answer IMMEDIATELY. Never make a caller wait for
//     an approval that landed before it asked.
//   - Nothing yet → block until a task enters the ready queue, then answer.
//   - Nothing within the timeout → answer 200 with status "timeout". A timeout is
//     NOT an error; it means "nothing yet, call again", and the caller must be
//     able to tell the two apart without parsing prose.
//   - The caller disappears → the wait ends with the request. No goroutine, no
//     registration, and no memory outlives an abandoned poll.
//
// HOW IT KNOWS (and why nothing polls the database). The server does NOT run a
// timer against Supabase. Every path that puts a task into the ready queue
// already announces itself in-process — emitTaskEvent fires task.approved from
// all four approval doors, and rewindTask lands a release/requeue/reopen back in
// 'approved' — so those same call sites signal the waiters parked here. A wait
// costs one store read on arrival, one per wake, and nothing at all in between.
//
// THE RACE THIS IS BUILT AROUND. "Task approved" and "agent started waiting" can
// happen in either order, and getting that wrong is the bug that would make this
// endpoint hang on exactly the approval it was waiting for. The fix is ordering
// plus a buffered slot: register the waiter FIRST, then read the queue. An
// approval that lands before the read shows up in the read; one that lands after
// the read is already sitting in this waiter's buffered channel. There is no
// window in which a signal can be dropped.
//
// SCOPE, honestly stated: the signal is IN-PROCESS. On a multi-instance
// deployment a waiter parked on instance A does not hear an approval served by
// instance B, and only finds it on its next call. That is survivable precisely
// because the wait is BOUNDED — the timeout turns the gap into added latency, not
// a hang — and Tandem runs single-instance today. Making it cross-instance is a
// Postgres LISTEN/NOTIFY (or a Redis fan-out) behind this same registry, with no
// change to the endpoint's contract.

const (
	// queueWaitDefaultTimeout is what a caller that names no timeout gets.
	//
	// 25 SECONDS, and the number is a compromise between two ceilings:
	//
	//   - Intermediaries. The tightest idle timeouts a request like this meets in
	//     the wild sit at 30s (GCP's HTTPS load balancer backend default, Heroku's
	//     router). Tandem's own path is clear — the Go server sets no WriteTimeout
	//     (cmd/server/main.go) and Caddy's reverse_proxy imposes no response
	//     deadline, which is why the WebSocket hub works through it — but a caller
	//     may sit behind a corporate proxy we will never see. Answering at 25s
	//     means the SERVER ends the wait, with a clean "call again", before any of
	//     those cut the connection and hand the agent an error it can't classify.
	//   - The MCP client above. A tool call that outlives the client's own
	//     per-tool timeout is worse than a timeout here: the wait is lost AND the
	//     agent sees a failure. 25s leaves generous headroom under the ~60s that
	//     MCP clients commonly allow.
	//
	// The cost of being conservative is one extra round trip per 25 idle seconds,
	// which is nothing next to an agent that gives up because its wait 502'd.
	queueWaitDefaultTimeout = 25 * time.Second
	// queueWaitMaxTimeout caps what a caller may ask for. A caller that knows its
	// path is clean can ask for longer; nobody gets to park a connection for
	// minutes and turn a waiter cap into a denial of service.
	queueWaitMaxTimeout = 60 * time.Second
	// queueWaitMinTimeout keeps timeout=0 from turning this into a busy-poll
	// endpoint. A caller that wants an instant answer should call the plain queue
	// read (GET /api/canvas/actions), not this.
	queueWaitMinTimeout = 1 * time.Second

	// maxQueueWaitersPerCanvas bounds how many waits one canvas can hold open.
	// A fleet is a handful of agents; 64 is far past any real fan-out and still
	// small enough that one canvas cannot exhaust the process.
	maxQueueWaitersPerCanvas = 64
	// maxQueueWaitersTotal bounds the whole process, so many small canvases can't
	// do what one canvas is capped from doing.
	maxQueueWaitersTotal = 512
)

// The two statuses this endpoint answers with. THE distinguishing field: both
// come back as HTTP 200, and `status` is what the caller branches on.
const (
	queueWaitReady   = "ready"
	queueWaitTimeout = "timeout"
)

// queueWaiters is the parked-waiter registry: canvas → the set of waiters
// currently blocked on it.
//
// Each waiter is a channel with ONE buffered slot. Buffered so a signal that
// arrives while the waiter is between its read and its select is kept rather than
// dropped; capacity one because the signal carries no information beyond "look
// again" — ten approvals and one approval mean the same thing to a waiter that is
// about to re-read the queue anyway.
//
// The zero value is usable, so a Handler built as a struct literal (as several
// tests do) still has a working registry.
type queueWaiters struct {
	mu    sync.Mutex
	rooms map[uuid.UUID]map[chan struct{}]struct{}
	total int
}

// add registers a waiter for a canvas and returns its channel plus the release
// func that removes it. ok=false means a cap was hit and NOTHING was registered.
//
// The release func is idempotent, and is the ONLY way a waiter leaves the
// registry — every caller defers it, so an abandoned wait cleans up on the same
// path as a satisfied one.
func (q *queueWaiters) add(canvasID uuid.UUID) (<-chan struct{}, func(), bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.total >= maxQueueWaitersTotal || len(q.rooms[canvasID]) >= maxQueueWaitersPerCanvas {
		return nil, nil, false
	}
	if q.rooms == nil {
		q.rooms = make(map[uuid.UUID]map[chan struct{}]struct{})
	}
	room := q.rooms[canvasID]
	if room == nil {
		room = make(map[chan struct{}]struct{})
		q.rooms[canvasID] = room
	}
	ch := make(chan struct{}, 1)
	room[ch] = struct{}{}
	q.total++

	var once sync.Once
	return ch, func() {
		once.Do(func() {
			q.mu.Lock()
			defer q.mu.Unlock()
			if room, ok := q.rooms[canvasID]; ok {
				if _, held := room[ch]; held {
					delete(room, ch)
					q.total--
				}
				if len(room) == 0 {
					delete(q.rooms, canvasID)
				}
			}
		})
	}, true
}

// signal wakes every waiter on a canvas.
//
// NEVER BLOCKS, by construction: each send is non-blocking onto a channel that
// already has a free slot or already holds a pending wake. That matters because
// this runs on the mutation path — an approve must not wait on a waiter, and a
// waiter that has gone away must not be able to stall the handler that woke it.
func (q *queueWaiters) signal(canvasID uuid.UUID) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for ch := range q.rooms[canvasID] {
		select {
		case ch <- struct{}{}:
		default: // a wake is already pending for this waiter
		}
	}
}

// count is every parked waiter in the process — the queue_waiters gauge, and the
// number that says whether abandoned waits are being cleaned up.
func (q *queueWaiters) count() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.total
}

// countFor is the per-canvas count (tests, and the cap's own accounting).
func (q *queueWaiters) countFor(canvasID uuid.UUID) int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.rooms[canvasID])
}

// signalQueueReady tells anyone waiting on this canvas that the ready queue may
// have changed. Call it AFTER the store write commits, never before: a waiter
// woken ahead of the write re-reads the old queue, sees nothing, and goes back to
// sleep having burned its wake.
//
// Cheap and non-blocking with zero waiters (the common case), so call sites don't
// need to guard it.
func (h *Handler) signalQueueReady(canvasID uuid.UUID) {
	h.waiters.signal(canvasID)
}

// QueueWaiterCount exposes the parked-waiter count for the metrics gauge. If this
// number climbs and never falls, waits are leaking — which is the whole reason it
// is published.
func (h *Handler) QueueWaiterCount() int { return h.waiters.count() }

// queueWaitMsg is the response. Both statuses use this one shape, so a caller
// parses once and branches on `status`.
type queueWaitMsg struct {
	Type   string `json:"type"`   // "queue.wait"
	Status string `json:"status"` // "ready" | "timeout"
	// Actions is the ready queue, in the SAME shape as GET /api/canvas/actions,
	// so whatever already projects that list can project this one unchanged.
	// Non-empty exactly when status is "ready"; always present (never null) so a
	// caller can range over it without a nil check.
	Actions []*store.Action `json:"actions"`
	// Count saves the caller a length check when it only wants to branch.
	Count          int    `json:"count"`
	WaitedMs       int64  `json:"waitedMs"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	Hint           string `json:"_hint"`
}

// GET /api/canvas/queue/wait?timeout=<seconds>&epicId=<uuid>&assignee=<who>
// (canvas JWT required; any role — waiting is a read.)
//
// Blocks until the canvas has approved, ready-to-work tasks, then returns them.
// See the file header for the contract and the ordering argument.
func (h *Handler) WaitForQueue(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	canvasID := CanvasIDFromCtx(ctx)

	timeout, err := parseQueueWaitTimeout(r.URL.Query().Get("timeout"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	epicID := strings.TrimSpace(r.URL.Query().Get("epicId"))
	if epicID != "" {
		if _, err := uuid.Parse(epicID); err != nil {
			writeError(w, http.StatusBadRequest, "epicId must be an epic action id")
			return
		}
	}
	// Same default as queue_next: an agent waits on the AGENT queue, so a human's
	// todo list never wakes a worker. "any" drops the filter.
	assignee := strings.TrimSpace(r.URL.Query().Get("assignee"))
	if assignee == "" {
		assignee = "agent"
	}

	start := time.Now()

	// ── Register BEFORE the first read. This is the race the ticket is about ──
	// Ordering here is what makes an approval that lands mid-request impossible to
	// miss: registered-then-read means an approval either shows up in the read or
	// is already buffered in `ready`.
	ready, release, ok := h.waiters.add(canvasID)
	if !ok {
		// Deliberately an ERROR, not a "timeout": a timeout invites an immediate
		// re-call, and re-calling into a full registry is a hot loop. 429 tells the
		// caller to back off and use the plain queue read meanwhile.
		w.Header().Set("Retry-After", "5")
		writeCodedError(w, http.StatusTooManyRequests, "too_many_waiters",
			"This canvas already has the maximum number of agents waiting on its queue. "+
				"Retry in a few seconds, or read the queue directly with queue_next instead of waiting.",
			map[string]string{"retryAfterSeconds": "5"})
		return
	}
	defer release()

	deadline := time.NewTimer(timeout)
	defer deadline.Stop()

	for {
		tasks, err := h.readyQueue(ctx, canvasID, epicID, assignee)
		if err != nil {
			// A cancelled context means the caller hung up mid-read: there is
			// nobody to answer, and this is not a server error.
			if ctx.Err() != nil {
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if len(tasks) > 0 {
			writeQueueWait(w, queueWaitReady, tasks, time.Since(start), timeout)
			return
		}

		select {
		case <-ready:
			// Something entered the queue — loop and re-read. A wake that turns out
			// not to match this caller's filters (another epic, a human's todo)
			// simply costs one read and goes back to waiting, which is why the loop
			// re-checks the deadline rather than answering "ready" on the signal.
		case <-deadline.C:
			// NOT an error. The queue is empty, the caller should call again.
			writeQueueWait(w, queueWaitTimeout, nil, time.Since(start), timeout)
			return
		case <-ctx.Done():
			// Client disconnected (or the server is shutting down). Return without
			// writing: `release` runs on the way out, so the waiter is gone. The
			// blocking goroutine IS the request goroutine — there is nothing else
			// to unwind, which is how an abandoned wait leaks nothing.
			return
		}
	}
}

// readyQueue is the ready-to-work queue, defined to be EXACTLY what queue_next
// lists: approved tasks for this assignee, optionally narrowed to one epic. Being
// the same query is the point — a wait that answers with work queue_next wouldn't
// show would hand an agent a task it then can't find.
func (h *Handler) readyQueue(ctx context.Context, canvasID uuid.UUID, epicID, assignee string) ([]*store.Action, error) {
	assigneeFilter := assignee
	if assignee == "any" {
		assigneeFilter = ""
	}
	actions, err := h.store.ListActions(ctx, canvasID, "approved", "task", assigneeFilter)
	if err != nil {
		return nil, err
	}
	if epicID == "" {
		return actions, nil
	}
	// The epic filter is applied here rather than in the store because epicId
	// lives in the action payload, not in a column — the same place queue_next
	// filters it.
	out := make([]*store.Action, 0, len(actions))
	for _, a := range actions {
		if decodeTaskPayload(a.Payload).EpicID == epicID {
			out = append(out, a)
		}
	}
	return out, nil
}

func writeQueueWait(w http.ResponseWriter, status string, tasks []*store.Action, waited, timeout time.Duration) {
	if tasks == nil {
		tasks = []*store.Action{}
	}
	hint := "Nothing approved within the wait window. This is NOT an error and NOT a failure — " +
		"it means 'nothing yet, call again'. Call this endpoint again to keep waiting; the human " +
		"has not approved anything yet."
	if status == queueWaitReady {
		hint = "Approved work is ready. Claim ONE task (task_claim) and work it, or — if you " +
			"dispatch to subagents — hand each ready task to a worker that claims its own."
	}
	writeJSON(w, http.StatusOK, queueWaitMsg{
		Type:           "queue.wait",
		Status:         status,
		Actions:        tasks,
		Count:          len(tasks),
		WaitedMs:       waited.Milliseconds(),
		TimeoutSeconds: int(timeout / time.Second),
		Hint:           hint,
	})
}

// parseQueueWaitTimeout reads ?timeout= in SECONDS.
//
// Out-of-range values are CLAMPED rather than refused (a caller asking for 600s
// wants the longest wait it can have, and the response reports the effective
// number back as timeoutSeconds), but garbage is a 400 — silently treating
// "?timeout=soon" as the default would hide a caller bug forever.
func parseQueueWaitTimeout(raw string) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return queueWaitDefaultTimeout, nil
	}
	secs, err := strconv.Atoi(raw)
	if err != nil {
		return 0, errQueueWaitTimeout
	}
	d := time.Duration(secs) * time.Second
	if d < queueWaitMinTimeout {
		return queueWaitMinTimeout, nil
	}
	if d > queueWaitMaxTimeout {
		return queueWaitMaxTimeout, nil
	}
	return d, nil
}

var errQueueWaitTimeout = &queueWaitParamError{
	"timeout must be a whole number of seconds (e.g. timeout=25); it is clamped to " +
		strconv.Itoa(int(queueWaitMinTimeout/time.Second)) + "–" +
		strconv.Itoa(int(queueWaitMaxTimeout/time.Second)),
}

type queueWaitParamError struct{ msg string }

func (e *queueWaitParamError) Error() string { return e.msg }
