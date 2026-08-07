package api

import (
	"context"
	"encoding/json"
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
// And the fifth line, added by TDM-2, because "the human has answered" and "the
// human has approved" are not the same fact:
//
//   - The work being waited on is REJECTED → answer 200 with status "rejected"
//     and the reasons. A gate can be answered with a no, and an agent told
//     nothing waits out its timeout and calls straight back for an approval that
//     is never coming. Ready still wins when both are true.
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

	// queueWaitStreakGrace bridges the GAP BETWEEN POLLS (TDM-151).
	//
	// A waiting agent is not one connection, it is a chain of them: the wait
	// answers "timeout" at 25s and the agent immediately calls again, so for a few
	// hundred milliseconds nothing is registered even though the agent never
	// stopped waiting. Reporting that gap as "not waiting" would make the fleet
	// view flicker waiting → idle → waiting once per poll, and would reset the
	// "waiting for 4m" clock every 25 seconds — the same lie about duration TDM-112
	// fixed for claims.
	//
	// So a wait that ends in a TIMEOUT keeps its identity's streak alive for this
	// long. Every other ending — the caller disconnected, the caller got work, the
	// read failed — ends the streak IMMEDIATELY, because in none of those cases is
	// anyone still parked. That asymmetry is the whole honesty argument: the grace
	// only ever covers a gap the agent has already announced it will close, and an
	// agent that dies mid-wait (the failure this exists to catch) stops reading as
	// waiting within one roster read, not within this window.
	//
	// 10s is ~40% of the default timeout: far longer than any real re-call gap,
	// far shorter than the wait itself, so a dead orchestrator cannot hide in it.
	queueWaitStreakGrace = 10 * time.Second
	// maxWaitStreaksPerCanvas bounds the identity bookkeeping above, which — unlike
	// the waiter registry — outlives its connection by `grace`. A caller cycling
	// through invented agent names can't grow it without bound: past the cap,
	// waits still work, they just aren't attributed to a name on the roster.
	maxWaitStreaksPerCanvas = 128
)

// How a wait ended. The ONLY input to whether the identity keeps reading as
// waiting — see queueWaitStreakGrace.
type waitEnd int

const (
	// waitEndGone: nobody is parked any more, full stop. Disconnect, an answer
	// carrying work, or an error. The identity stops reading as waiting at once.
	waitEndGone waitEnd = iota
	// waitEndTimeout: answered "nothing yet, call again". The agent is expected
	// back within milliseconds, so its streak survives the gap.
	waitEndTimeout
)

// The three statuses this endpoint answers with. THE distinguishing field: all
// come back as HTTP 200, and `status` is what the caller branches on.
const (
	queueWaitReady   = "ready"
	queueWaitTimeout = "timeout"
	// queueWaitRejected is the answer that is NOT work (TDM-2): the human
	// answered the batch this agent is waiting on by saying no, and the wait ends
	// with the reasons instead of with tasks. It is a third status rather than a
	// "ready" carrying zero tasks precisely so a caller that only knows the
	// original two cannot mistake it for either — an unknown status reads as
	// "something happened, look at the board", which is the correct fallback,
	// whereas a "ready" with an empty list would read as a server bug.
	queueWaitRejected = "rejected"
)

// rejectedTask is one rejection as a waiter is told about it — the wire shape of
// queueWaitMsg.Rejected, fixed by the epic's contract A.
//
// It is a SNAPSHOT taken at rejection time, not a pointer into the board: by the
// time a waiter reads it the human may have already re-proposed the ticket, and
// the answer to "why did my wait end" must stay the reason that ended it.
type rejectedTask struct {
	ID       uuid.UUID `json:"id"`
	TicketID string    `json:"ticketId,omitempty"` // "TDM-42"
	Title    string    `json:"title"`
	// Reason is the rejecting human's words, VERBATIM. Optional, because the
	// reject endpoint does not require one — an empty reason is an honest "they
	// gave none", never a placeholder.
	Reason string `json:"reason,omitempty"`
	// By is server-derived provenance ("human", or "anonymous" on a public
	// canvas), never read off a request body.
	By string    `json:"by,omitempty"`
	At time.Time `json:"at"`
	// epicID is the narrowing a waiter's ?epicId= filter matches against. NOT on
	// the wire: it is the same value as the task's payload epicId, which the
	// caller already knows because it is the filter it asked with.
	epicID string
}

// rejectedTaskFromEvent projects the task-event assembled in emitTaskEvent onto
// the waiter's shape. One source for both channels — the webhook body and the
// parked waiter learn the same facts from the same struct, so they cannot drift.
func rejectedTaskFromEvent(ev taskEvent) rejectedTask {
	rt := rejectedTask{
		ID:       ev.Task.ID,
		TicketID: ev.Task.TicketID,
		Title:    ev.Task.Title,
		At:       ev.Timestamp,
		epicID:   ev.Task.EpicID,
	}
	if ev.Rejected != nil {
		rt.Reason, rt.By = ev.Rejected.Reason, ev.Rejected.By
	}
	// Belt and braces: the reason also lands in actions.error, so a call site that
	// forgets the withRejected option still tells the waiter WHY.
	if rt.Reason == "" {
		rt.Reason = ev.Task.Error
	}
	return rt
}

// queueWaiter is one parked wait.
//
// `ready` is a channel with ONE buffered slot. Buffered so a signal that arrives
// while the waiter is between its read and its select is kept rather than
// dropped; capacity one because the WAKE carries no information beyond "look
// again" — ten approvals and one approval mean the same thing to a waiter that
// is about to re-read the queue anyway.
//
// `rejected` is the exception that proves that rule (TDM-2), and it is why a
// waiter is a struct now and not a bare channel. A rejection is NOT discoverable
// by re-reading the ready queue — the rejected task is precisely the one that is
// no longer in it — so the facts have to travel WITH the wake. They are appended
// here, under queueWaiters.mu, and drained by the waiter itself.
type queueWaiter struct {
	ready chan struct{}
	// rejected accumulates rejections that landed since this wait began, in
	// arrival order. Guarded by queueWaiters.mu — the waiter goroutine only ever
	// touches it through takeRejections. Capped at maxPendingRejections.
	rejected []rejectedTask
}

// maxPendingRejections bounds one waiter's rejection buffer. A human rejecting
// more than this many tasks inside a single 25-second wait is not a scenario, it
// is a bulk action; the waiter is answering with "your batch was rejected" either
// way, and the overflow is dropped rather than allowed to grow a per-connection
// slice without limit.
const maxPendingRejections = 50

// queueWaiters is the parked-waiter registry: canvas → the set of waiters
// currently blocked on it.
//
// The zero value is usable, so a Handler built as a struct literal (as several
// tests do) still has a working registry.
type queueWaiters struct {
	mu    sync.Mutex
	rooms map[uuid.UUID]map[*queueWaiter]struct{}
	total int
	// streaks is the IDENTITY side of the registry (TDM-151): canvas → asserted
	// agent name → the continuous wait that name is on. Separate from `rooms`
	// because a waiting AGENT and a parked CONNECTION are not the same lifetime —
	// see queueWaitStreakGrace. Purely in-process, like the rooms above: a
	// restart forgets every wait, which is the correct answer, because a restart
	// also dropped every connection.
	streaks map[uuid.UUID]map[string]*waitStreak
}

// waitStreak is one identity's continuous wait: when it started, what it is
// waiting for, and whether it is parked right now.
type waitStreak struct {
	// since is the start of the CURRENT streak and is never pushed forward by a
	// re-poll — the honest "waiting for 4m", for the same reason firstClaimedAt
	// exists on a claim (TDM-112).
	since time.Time
	// epicID is the narrowing this identity last waited with ("" = the whole
	// queue), so the board can say what it is parked on and not just that it is.
	epicID string
	// parked is how many of this identity's connections are registered right now.
	// Normally 0 or 1; >1 only if one name runs two waits at once.
	parked int
	// endedAt is when the last of them ended in a TIMEOUT — the start of the
	// grace window. Zero while parked > 0.
	endedAt time.Time
}

// waiting reports whether this streak still reads as waiting at `now`.
func (s *waitStreak) waiting(now time.Time) bool {
	return s.parked > 0 || now.Sub(s.endedAt) < queueWaitStreakGrace
}

// add registers a waiter for a canvas and returns it plus the release func that
// removes it. ok=false means a cap was hit and NOTHING was registered.
//
// `agent` is the caller's asserted identity (the X-Tandem-Agent header, the same
// string it claims tasks under) and may be empty: a wait with no identity still
// works, it just can't be attributed to a row on the roster. `epicID` is the
// narrowing it is waiting on, for display only.
//
// The release func is idempotent, and is the ONLY way a waiter leaves the
// registry — every caller defers it, so an abandoned wait cleans up on the same
// path as a satisfied one. It takes how the wait ENDED, which is what decides
// whether the identity keeps reading as waiting; the deferred call passes
// waitEndGone, so a path that forgets to say otherwise fails towards "not
// waiting" rather than towards a ghost.
//
// started (and release's own bool) report whether the canvas's WAITING SET
// actually moved — this identity was not waiting a moment ago, or has stopped —
// so the board is told when the answer changed and not once per re-poll.
func (q *queueWaiters) add(canvasID uuid.UUID, agent, epicID string) (waiter *queueWaiter, release func(waitEnd) bool, started, ok bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.total >= maxQueueWaitersTotal || len(q.rooms[canvasID]) >= maxQueueWaitersPerCanvas {
		return nil, nil, false, false
	}
	if q.rooms == nil {
		q.rooms = make(map[uuid.UUID]map[*queueWaiter]struct{})
	}
	room := q.rooms[canvasID]
	if room == nil {
		room = make(map[*queueWaiter]struct{})
		q.rooms[canvasID] = room
	}
	wt := &queueWaiter{ready: make(chan struct{}, 1)}
	room[wt] = struct{}{}
	q.total++

	now := time.Now().UTC()
	// An anonymous wait has no identity to attribute, so it moves the count and
	// nothing else — hence `started` is true for it, and no streak is kept.
	started = agent == ""
	if agent != "" {
		q.pruneStreaksLocked(canvasID, now)
		byName := q.streaks[canvasID]
		s := byName[agent]
		if s == nil && (byName == nil || len(byName) < maxWaitStreaksPerCanvas) {
			if q.streaks == nil {
				q.streaks = make(map[uuid.UUID]map[string]*waitStreak)
			}
			if byName == nil {
				byName = make(map[string]*waitStreak)
				q.streaks[canvasID] = byName
			}
			s = &waitStreak{since: now}
			byName[agent] = s
			started = true
		}
		if s != nil {
			s.parked++
			s.epicID = epicID
			s.endedAt = time.Time{}
		}
	}

	var once sync.Once
	ended := false
	return wt, func(how waitEnd) bool {
		once.Do(func() {
			q.mu.Lock()
			defer q.mu.Unlock()
			if room, ok := q.rooms[canvasID]; ok {
				if _, held := room[wt]; held {
					delete(room, wt)
					q.total--
				}
				if len(room) == 0 {
					delete(q.rooms, canvasID)
				}
			}
			ended = agent == ""
			s := q.streaks[canvasID][agent]
			if agent == "" || s == nil {
				return
			}
			if s.parked > 0 {
				s.parked--
			}
			if s.parked > 0 {
				return // another connection under this name is still parked
			}
			if how == waitEndTimeout {
				// Answered "nothing yet" — the agent calls straight back, so hold
				// the streak open across the gap rather than blinking it off.
				s.endedAt = time.Now().UTC()
				return
			}
			// Gone: disconnected, or handed work. Not waiting, as of now.
			delete(q.streaks[canvasID], agent)
			if len(q.streaks[canvasID]) == 0 {
				delete(q.streaks, canvasID)
			}
			ended = true
		})
		return ended
	}, started, true
}

// pruneStreaksLocked drops identities whose grace window has passed. Called on
// every add and every read, so the bookkeeping is cleaned by use rather than by
// a sweeper goroutine. Caller holds q.mu.
func (q *queueWaiters) pruneStreaksLocked(canvasID uuid.UUID, now time.Time) {
	byName := q.streaks[canvasID]
	for name, s := range byName {
		if !s.waiting(now) {
			delete(byName, name)
		}
	}
	if len(byName) == 0 {
		delete(q.streaks, canvasID)
	}
}

// waitingWatch is one identity's live wait, as the roster reads it.
type waitingWatch struct {
	Since  time.Time
	EpicID string
}

// waitingOn is the roster's read: who is parked on this canvas's queue right
// now, keyed by the identity they asserted, plus how many parked waiters carried
// NO identity (real waits nobody can name, counted so the board never has to
// choose between inventing an agent and pretending nothing is there).
//
// Computed at read time from live connections, so it cannot outlive them: a
// waiter that disconnected is already out of `rooms`, an identity past its grace
// window is pruned here, and a restarted process answers "nobody".
func (q *queueWaiters) waitingOn(canvasID uuid.UUID, now time.Time) (map[string]waitingWatch, int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.pruneStreaksLocked(canvasID, now)
	attributed := 0
	out := make(map[string]waitingWatch, len(q.streaks[canvasID]))
	for name, s := range q.streaks[canvasID] {
		out[name] = waitingWatch{Since: s.since, EpicID: s.epicID}
		attributed += s.parked
	}
	// Parked connections minus the ones an identity accounts for. Never negative:
	// every streak's `parked` counts a connection that is still in the room.
	anonymous := len(q.rooms[canvasID]) - attributed
	if anonymous < 0 {
		anonymous = 0
	}
	return out, anonymous
}

// isWaiting answers the one question the delayed push needs: does this identity
// still read as waiting? (Cheap map lookup, no allocation.)
func (q *queueWaiters) isWaiting(canvasID uuid.UUID, agent string, now time.Time) bool {
	if agent == "" {
		return false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	s := q.streaks[canvasID][agent]
	return s != nil && s.waiting(now)
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
	q.wakeLocked(canvasID)
}

// wakeLocked pokes every waiter on a canvas. Caller holds q.mu.
func (q *queueWaiters) wakeLocked(canvasID uuid.UUID) {
	for wt := range q.rooms[canvasID] {
		select {
		case wt.ready <- struct{}{}:
		default: // a wake is already pending for this waiter
		}
	}
}

// signalRejected hands one rejection to every waiter on a canvas, then wakes
// them (TDM-2).
//
// APPEND-THEN-WAKE, in that order and under one lock: a waiter that woke first
// and read an empty buffer would go straight back to sleep having burned the
// wake, which is the same ordering bug the register-then-read dance at the top
// of WaitForQueue exists to avoid on the ready side.
//
// EVERY waiter gets a copy, including ones whose ?epicId= filter does not match.
// Filtering happens at the drain, where the waiter's own filter lives — a
// rejection is a few strings, and centralising the filter here would mean the
// registry had to track each waiter's narrowing and keep it correct.
//
// Non-blocking, like signal: this runs on the mutation path, after the reject has
// already committed.
func (q *queueWaiters) signalRejected(canvasID uuid.UUID, rt rejectedTask) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for wt := range q.rooms[canvasID] {
		if len(wt.rejected) < maxPendingRejections {
			wt.rejected = append(wt.rejected, rt)
		}
	}
	q.wakeLocked(canvasID)
}

// takeRejections drains what this waiter has been handed, keeping only what its
// epic filter matches ("" = the whole canvas).
//
// It DRAINS rather than peeks — including the entries the filter rejected — so a
// waiter narrowed to one epic is not woken over and over by rejections in
// another. Those are not its business, and re-reading them on every wake would
// turn one unrelated rejection into a wake per loop iteration.
func (q *queueWaiters) takeRejections(wt *queueWaiter, epicID string) []rejectedTask {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(wt.rejected) == 0 {
		return nil
	}
	pending := wt.rejected
	wt.rejected = nil
	if epicID == "" {
		return pending
	}
	out := make([]rejectedTask, 0, len(pending))
	for _, rt := range pending {
		if rt.epicID == epicID {
			out = append(out, rt)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
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

// signalQueueRejected tells anyone waiting on this canvas that a task they may
// be waiting on was rejected, and hands them the reason (TDM-2). Same ordering
// rule as signalQueueReady — call it AFTER the state write commits — and the
// same "cheap with zero waiters" property, so the reject path does not guard it.
func (h *Handler) signalQueueRejected(canvasID uuid.UUID, rt rejectedTask) {
	h.waiters.signalRejected(canvasID, rt)
}

// QueueWaiterCount exposes the parked-waiter count for the metrics gauge. If this
// number climbs and never falls, waits are leaking — which is the whole reason it
// is published.
func (h *Handler) QueueWaiterCount() int { return h.waiters.count() }

// ── Telling the board (TDM-151) ──────────────────────────────────────────────
//
// An agent parked here and an agent that quietly died look identical to a human
// unless the board is told, and told BOTH ways. So the waiting set is pushed
// when it changes: someone starts waiting, and — the direction that matters —
// someone stops. The message carries no roster; it says "the waiting set moved",
// and the client re-reads GET /api/canvas/agents, which computes waiting from
// live connections and therefore can't disagree with the server.

// fleetWaitingMsg is that ping. Its own `type`, deliberately NOT the "activity"
// lifecycle message: no action moved, and an activity feed listing "an agent
// waited" over and over would bury the facts that are about work.
type fleetWaitingMsg struct {
	Type string    `json:"type"` // "fleet.waiting"
	At   time.Time `json:"at"`
	// Waiting is parked connections on this canvas at the moment of the push —
	// a hint for a client that only wants a number, not the roster's answer.
	Waiting int `json:"waiting"`
}

func (h *Handler) broadcastFleetWaiting(canvasID uuid.UUID) {
	if h.hub == nil {
		return // no WS surface (handler tests, or a hub-less build)
	}
	data, err := json.Marshal(fleetWaitingMsg{
		Type: "fleet.waiting", At: time.Now().UTC(), Waiting: h.waiters.countFor(canvasID),
	})
	if err != nil {
		return
	}
	h.hub.Broadcast(canvasID, data)
}

// waitRecheckSlack keeps the delayed check strictly AFTER the grace window it is
// checking, so a streak that expired at the boundary is already gone when we look.
const waitRecheckSlack = 500 * time.Millisecond

// recheckFleetWaiting handles the one transition nothing else observes: a wait
// that timed out and never came back. The streak is held open for `grace` on the
// assumption the agent re-calls immediately; if it doesn't, no connection opens
// and no connection closes, so there is no event to push from. This one timer,
// armed per timeout answer, closes that hole — and only pushes if the identity
// really did stop waiting, so a healthy poll loop generates no extra traffic.
func (h *Handler) recheckFleetWaiting(canvasID uuid.UUID, agent string) {
	if h.hub == nil || agent == "" {
		return
	}
	time.AfterFunc(queueWaitStreakGrace+waitRecheckSlack, func() {
		if h.waiters.isWaiting(canvasID, agent, time.Now().UTC()) {
			return // came back, as a live agent does
		}
		h.broadcastFleetWaiting(canvasID)
	})
}

// queueWaitMsg is the response. Both statuses use this one shape, so a caller
// parses once and branches on `status`.
type queueWaitMsg struct {
	Type   string `json:"type"`   // "queue.wait"
	Status string `json:"status"` // "ready" | "timeout" | "rejected"
	// Actions is the ready queue, in the SAME shape as GET /api/canvas/actions,
	// so whatever already projects that list can project this one unchanged.
	// Non-empty exactly when status is "ready"; always present (never null) so a
	// caller can range over it without a nil check.
	Actions []*store.Action `json:"actions"`
	// Rejected is the verdicts that ended the wait, present exactly when status
	// is "rejected" and omitted otherwise — a caller that has never heard of this
	// status sees a field it does not know rather than an empty one it might
	// misread. Contract A (TDM-2).
	Rejected []rejectedTask `json:"rejected,omitempty"`
	// Count saves the caller a length check when it only wants to branch. It
	// counts whatever the answer CARRIES: ready tasks on "ready", rejections on
	// "rejected", zero on "timeout".
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
	// WHO is waiting (TDM-151). The same identity the caller claims tasks under
	// (X-Tandem-Agent — see provenance.go), read straight off the request rather
	// than via the author context, so this works with or without the Provenance
	// middleware. Client-asserted, exactly like claimedBy: an agent picks its own
	// name here as it does everywhere else. Empty is fine — the wait works, it
	// just shows on the board as an unattributed waiter instead of a named row.
	agent, _ := assertedAgent(r)

	// ── Register BEFORE the first read. This is the race the ticket is about ──
	// Ordering here is what makes an approval that lands mid-request impossible to
	// miss: registered-then-read means an approval either shows up in the read or
	// is already buffered in `ready`.
	waiter, release, started, ok := h.waiters.add(canvasID, agent, epicID)
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
	// How this wait ended decides whether the agent keeps reading as waiting on
	// the board. It stays waitEndGone unless a path below says otherwise, so a
	// disconnect — or any future early return — leaves NO ghost behind.
	ending := waitEndGone
	defer func() {
		if release(ending) {
			h.broadcastFleetWaiting(canvasID)
		}
		if ending == waitEndTimeout {
			// The streak is alive on grace, betting the agent calls straight back.
			// If it doesn't (the "said it would wait, then ended its turn" failure),
			// nothing else would tell the board — so check once the window closes.
			h.recheckFleetWaiting(canvasID, agent)
		}
	}()
	if started {
		h.broadcastFleetWaiting(canvasID)
	}

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
			writeQueueWait(w, queueWaitReady, tasks, nil, time.Since(start), timeout)
			return
		}
		// READY WINS, which is why this sits below the read and not above it
		// (contract A). An agent that has both approved work and a rejection
		// waiting should be sent to WORK; the rejection is still on the board, and
		// on its next wait it gets told. The reverse order would park a fleet on a
		// verdict while approved tickets sat unclaimed.
		if rejected := h.waiters.takeRejections(waiter, epicID); len(rejected) > 0 {
			writeQueueWait(w, queueWaitRejected, nil, rejected, time.Since(start), timeout)
			return
		}

		select {
		case <-waiter.ready:
			// Something entered the queue — loop and re-read. A wake that turns out
			// not to match this caller's filters (another epic, a human's todo)
			// simply costs one read and goes back to waiting, which is why the loop
			// re-checks the deadline rather than answering "ready" on the signal.
		case <-deadline.C:
			// NOT an error. The queue is empty, the caller should call again.
			ending = waitEndTimeout
			writeQueueWait(w, queueWaitTimeout, nil, nil, time.Since(start), timeout)
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

func writeQueueWait(w http.ResponseWriter, status string, tasks []*store.Action, rejected []rejectedTask, waited, timeout time.Duration) {
	if tasks == nil {
		tasks = []*store.Action{}
	}
	hint := "Nothing approved within the wait window. This is NOT an error and NOT a failure — " +
		"it means 'nothing yet, call again'. Call this endpoint again to keep waiting; the human " +
		"has not approved anything yet."
	count := len(tasks)
	switch status {
	case queueWaitReady:
		hint = "Approved work is ready. Claim ONE task (task_claim) and work it, or — if you " +
			"dispatch to subagents — hand each ready task to a worker that claims its own."
	case queueWaitRejected:
		count = len(rejected)
		// The one hint that has to stop an agent doing the obvious thing. A wait
		// that ends is normally a wait that found work, and an agent that skims
		// will re-propose or start coding; say plainly that this is a NO, that the
		// reason is the brief, and that re-proposing the same ticket lands the same
		// way (the same rule task_get's `review` block states).
		hint = "REJECTED, not approved — the human said no to work you are waiting on, and the " +
			"`reason` on each entry is their words verbatim. Do NOT start this work and do NOT " +
			"re-propose it unchanged: it will be rejected again. Read the reason, fix the plan it " +
			"condemns (task_amend the neighbours it also applies to), and tell the human what you " +
			"changed. If you are still expecting other approvals, call this endpoint again."
	}
	writeJSON(w, http.StatusOK, queueWaitMsg{
		Type:           "queue.wait",
		Status:         status,
		Actions:        tasks,
		Rejected:       rejected,
		Count:          count,
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
