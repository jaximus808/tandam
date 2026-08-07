package api

import (
	"encoding/json"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/webhooks"
	"github.com/google/uuid"
)

// Outbound task-lifecycle events (TDM-37) — the handler half of the webhook
// feature. internal/webhooks owns the queue and the wire; this file owns WHEN an
// event fires and WHAT it says.
//
// EXACTLY FIVE EVENTS EXIST. Four are emitted from action_handler.go; the
// fourth in this list from task_move.go:
//
//	task.approved       a task entered the ready-to-work queue by passing the
//	                    approval gate. Four paths, all fanning one event per
//	                    task: ProposeAction / ProposeActionsBatch (born
//	                    approved — human state:"approved", or the 'auto'/'epic'
//	                    approval policy), ApproveAction, ApproveActionsBatch,
//	                    and the epic cascade both approve paths run.
//	task.completed      a task reached a TERMINAL state — 'done' or 'failed'.
//	task.claim_expired  an agent's claim lapsed past the TTL and the task was
//	                    taken over by another agent.
//	task.returned       FINISHED work went back to the ready queue: done →
//	                    approved, by a reviewer agent's rework bounce or a
//	                    human's reopen. See "the fourth event" below.
//	task.rejected       a PROPOSED task was rejected at the human gate, with the
//	                    reason. See "the fifth event" below.
//
// WHAT DELIBERATELY FIRES NOTHING (the negative half of the contract, and the
// half a regression would break silently):
//
//   - approved → executing (a claim). Claiming is not a queue transition anyone
//     outside the canvas needs pushed; the claimant already knows.
//   - DELETE. Deleting a card is the human taking it off the board entirely;
//     there is nobody to tell and nothing to tell them about. (Rejection USED to
//     be listed here beside it, on the argument that "there is no work to hand
//     off". TDM-2 kept the premise and reversed the conclusion — see the fifth
//     event.)
//   - payload-only edits (retitling a task). The state machine didn't move.
//   - executing → approved via ReleaseAction, and failed → approved via
//     RequeueAction. Both put a task back in the queue, but neither is an
//     APPROVAL: the gate was already passed once, and re-firing task.approved
//     would make a fleet subscribed to it re-run work it already picked up.
//     They do not fire task.returned either — see the boundary below.
//   - a SELF-takeover of an expired claim (the same agent restamping). See
//     store.ClaimOutcome — nothing changed hands.
//
// ── THE FOURTH EVENT: task.returned (TDM-170) ────────────────────────────────
//
// THE HOLE IT CLOSES. TDM-154's rework bounce moves finished work done →
// approved. In-process that wakes a parked queue_wait (rewindTask signals
// queue-ready), so a LIVE orchestrator hears it — but no webhook fired, so a
// WEBHOOK-LAUNCHED orchestrator did not. The two documented orchestration modes
// disagreed about whether a bounce is an event, which made the webhook recipe
// quietly incomplete for any canvas on 'peer': a reviewer says "redo this", the
// ticket sits in the ready queue, and nothing ever relaunches to pick it up.
//
// WHY A NEW NAME RATHER THAN A SECOND task.approved. The paragraph above already
// contains the argument: re-firing task.approved for a re-queue would tell a
// subscribed fleet that something passed the gate when nothing did, and this
// file has said since TDM-37 that if a re-queue ever needs a notification "it
// wants its own event name, not a second approval". This is that name. It is
// also the safe direction to grow in — an existing config's `events` array does
// not contain task.returned, so no receiver that exists today starts getting
// deliveries it never asked for. (The cost of that safety, and it is real: an
// existing webhook must be edited to tick the new box. Configs created from here
// on get it by default, since an omitted filter means KnownWebhookEvents.)
//
// WHERE THE BOUNDARY IS, and it is not "every path back into the queue". Only
// done → approved fires. Release (executing → approved) and requeue (failed →
// approved) stay silent, as they always have, and the difference is not scope
// laziness:
//
//   - A bounce RETRACTS AN EVENT WE ALREADY SENT. task.completed means "finished
//     and it will not move again on its own"; done → approved makes that false.
//     A receiver told the work was done and never told otherwise holds a belief
//     the board no longer supports — that is the defect, and it is unique to
//     this transition.
//   - A release never contradicted anything: the work was never finished, so no
//     terminal event was ever published. A requeue follows a task.completed with
//     state:"failed" — the receiver was already told, correctly, and the retry is
//     someone acting on that.
//
// BOTH DOORS FIRE IT — the reviewer's ReworkAction and the human's board reopen.
// They are the same transition and the same fact to a receiver, and
// review_feedback.go deliberately does not tell them apart either; the payload's
// `returned.by` says which it was, which is all a receiver needs to branch on.
//
// A RECEIVER MUST BE ABLE TO TELL A BOUNCE FROM A FRESH APPROVAL, or a
// relaunched orchestrator treats returned work as new work. Two independent
// signals: the event TYPE (a different name and a different Tandem-Event header,
// so a receiver that never subscribes cannot be confused at all), and the
// `returned` block in the body — `from`, `by`, and the reviewer's `reason`
// verbatim. Note what the block does NOT require anyone to do: the queue is
// still the work order. `reason` is a courtesy copy so a listener can log why it
// woke; the agent that picks the ticket up reads it off task_get's `review`
// block, which is the durable channel (review_feedback.go).
//
// ── THE FIFTH EVENT: task.rejected (TDM-2) ───────────────────────────────────
//
// THE HOLE IT CLOSES. A human rejects a proposed task with a reason. Until
// TDM-2, that verdict reached exactly nobody outside the browser tab it was
// clicked in: no webhook, no audit entry, and — the one that actually strands an
// agent — no wake for the orchestrator parked on queue_wait. The agent that
// proposed the batch is, by the documented loop, sitting on queue_wait for the
// human's answer. It got one. It was not told. It waits out its timeout, calls
// again, and waits for an approval that is never coming, while the human who
// typed the reason reasonably believes they have replied.
//
// WHY IT IS AN EVENT DESPITE HANDING OVER NO WORK, which is the argument this
// file used for years to keep rejection silent. Both halves of "there is no work
// to hand off, and no event name for it" were true; only the second was a
// reason. A coordination plane's job is to end waits, not only to start them,
// and a verdict that closes a ticket ends one just as surely as an approval that
// opens it. The same reasoning already appears above for task.completed on a
// FAILED task: silence is the worse failure for a receiver that is waiting,
// because it hangs precisely on the cases that need attention.
//
// WHAT A RECEIVER MUST NOT DO WITH IT, and it is the inverse of every other
// event here: do not launch a worker. task.approved / task.returned mean "there
// is work"; task.rejected means "this ticket is dead — stop waiting for it".
// That is exactly why it is a new name rather than a reuse: a fleet subscribed
// to task.approved must never see a rejection arrive on that channel. The
// `rejected` block carries `by` and the human's `reason` VERBATIM, the same text
// task_get's `review` block hands the proposing agent, so a listener can log why
// it woke without a round trip.
//
// THE IN-PROCESS HALF IS THE POINT, and it does not depend on webhooks at all.
// emitTaskEvent below signals the canvas's queue waiters on a rejection just as
// it does on an approval, and WaitForQueue answers a woken waiter with
// status:"rejected" and the reasons (queue_wait.go). A canvas with no webhook
// configured — which is most of them — gets the whole behaviour.
//
// FAILED TASKS FIRE task.completed, with task.state = "failed" and the error
// text in task.error. The vocabulary has no task.failed (it is CHECK-constrained
// in migration 0038), so the alternative was silence — and silence is the worse
// failure for a coordination plane: a receiver waiting for a terminal event
// would hang forever on exactly the tasks that need attention. "completed" here
// means "the task is finished and will not move again on its own"; `state` says
// how it finished, so a receiver that only cares about success branches on one
// field.
//
// WHY THERE IS NO `attempt` IN THE BODY. The delivery payload is marshaled once,
// stored verbatim, and re-sent byte-for-byte on every retry — that identity is
// what the HMAC covers (see webhooks/sign.go). A per-attempt counter inside the
// body would force a re-marshal per attempt and break the stored-payload
// contract. It is not lost information: the attempt is already conveyed
// per-attempt on the wire, since Tandem-Delivery-Id is stable across retries
// while Tandem-Timestamp is not — a receiver that dedupes on the delivery id (as
// sign.go instructs) sees a repeat delivery id and knows it is a retry.

// TaskEventEmitter is the emit seam handlers use — the one method of
// *webhooks.Emitter the task lifecycle needs. Handlers depend on this interface,
// not the concrete emitter, so a test can record events without a store or a
// delivery queue behind them.
type TaskEventEmitter interface {
	EmitAsyncWithEventID(canvasID, eventID uuid.UUID, eventType string, payload any)
}

// Compile-time proof the real emitter satisfies the seam.
var _ TaskEventEmitter = (*webhooks.Emitter)(nil)

// taskEvent is the ENTIRE public schema of a Tandem webhook — what a receiver
// gets as the request body, and what the signature covers.
//
//	{
//	  "event_id":  "8f0a…",              // one id for the whole fan-out
//	  "type":      "task.approved",
//	  "timestamp": "2026-07-29T09:41:02.114Z",
//	  "canvas_id": "3c11…",
//	  "task":      { … see taskEventTask … }
//	}
//
// The envelope is snake_case (it is wire vocabulary, matching the Tandem-* header
// names and the delivery columns); `task` mirrors the canvas API's camelCase
// action shape so a receiver can hand it straight to the same code that reads
// GET /api/canvas/actions/{id}.
type taskEvent struct {
	EventID   uuid.UUID     `json:"event_id"`
	Type      string        `json:"type"`
	Timestamp time.Time     `json:"timestamp"`
	CanvasID  uuid.UUID     `json:"canvas_id"`
	Task      taskEventTask `json:"task"`
	// ExpiredClaim is present on task.claim_expired ONLY. It has to exist
	// separately from Task: by the time the expiry is observable the task has
	// already been restamped to the NEW claimant, so Task.ClaimedBy names who
	// holds it now, and the agent that went dark — the actual subject of the
	// event — would otherwise be unrecoverable from the payload.
	ExpiredClaim *taskEventExpiredClaim `json:"expired_claim,omitempty"`
	// Returned is present on task.returned ONLY, for the same reason
	// ExpiredClaim exists: the rewind has already cleared the claim and the
	// result off the row, so the task projection alone cannot say where the work
	// came back FROM or who sent it.
	Returned *taskEventReturned `json:"returned,omitempty"`
	// Rejected is present on task.rejected ONLY. Unlike the two blocks above it
	// is not recovering something the row lost — task.error IS the reason — but
	// WHO rejected is nowhere on the row, and a receiver reading `error` cannot
	// tell a rejection reason from a failed task's error text. One named block
	// per event type keeps that unambiguous.
	Rejected *taskEventRejected `json:"rejected,omitempty"`
}

// taskEventTask is a deliberately compact projection of the task — the fields a
// receiver routes on, not a dump of the stored payload (which can carry a whole
// task body plus linkedIds and would bloat every delivery row).
type taskEventTask struct {
	ID       uuid.UUID `json:"id"`
	TicketID string    `json:"ticketId,omitempty"` // "TDM-42"
	Title    string    `json:"title"`
	State    string    `json:"state"`
	EpicID   string    `json:"epicId,omitempty"`
	Assignee string    `json:"assignee,omitempty"`
	// ClaimedBy is the agent currently holding the task, when one does.
	ClaimedBy string `json:"claimedBy,omitempty"`
	// Result is the completion summary an agent writes on 'done'.
	Result string `json:"result,omitempty"`
	// Error is the failure reason on 'failed' — the counterpart to Result, and
	// the reason a task.completed with state:"failed" is actionable rather than
	// just a notification that something went wrong somewhere.
	Error string `json:"error,omitempty"`
}

type taskEventExpiredClaim struct {
	ClaimedBy string    `json:"claimed_by"`
	ClaimedAt time.Time `json:"claimed_at,omitempty"`
}

// taskEventReturned is the discriminator on task.returned: what a receiver needs
// to tell returned work from newly approved work without a second call.
type taskEventReturned struct {
	// From is the state the task came BACK from — "done" today, and the field
	// exists so it can stay honest if that ever widens.
	From string `json:"from"`
	// By is server-derived provenance, the same vocabulary as authoredBy:
	// "agent:<name>" for a reviewer's bounce, "human" for a board reopen,
	// "anonymous" on a public canvas. Never read off a request body.
	By string `json:"by,omitempty"`
	// Reason is the reviewer's reason (required on the rework door) or the
	// human's optional reopen note, VERBATIM. It is the same text task_get's
	// `review` block hands the agent that picks the ticket up — carried here so a
	// listener can log WHY it woke without a round trip, not so anything decides
	// off it.
	Reason string `json:"reason,omitempty"`
}

// taskEventRejected is the discriminator on task.rejected: who said no, and why.
type taskEventRejected struct {
	// From is the state the task was rejected OUT of — "proposed" today, and the
	// field exists (as it does on `returned`) so it can stay honest if the state
	// machine ever grows a second door into 'rejected'.
	From string `json:"from"`
	// By is server-derived provenance, the same vocabulary as authoredBy:
	// "human" for the signed-in person who pressed reject, "anonymous" on a
	// public canvas. Never read off a request body. In practice it is always a
	// person — RejectAction refuses anyone the server cannot see as a human, and
	// the 'peer' policy deliberately does not relax that.
	By string `json:"by,omitempty"`
	// Reason is the human's rejection reason, VERBATIM and optional (the reject
	// endpoint does not require one). It is the same text that lands in
	// actions.error and that task_get's `review` block hands the proposing agent.
	Reason string `json:"reason,omitempty"`
}

// taskEventFields are the payload keys the projection reads. Everything else in
// the stored payload stays out of the event.
type taskEventFields struct {
	Title    string `json:"title"`
	EpicID   string `json:"epicId"`
	Assignee string `json:"assignee"`
}

// newTaskEventTask projects a stored action onto the wire shape.
func newTaskEventTask(a *store.Action) taskEventTask {
	var f taskEventFields
	_ = json.Unmarshal(a.Payload, &f)
	t := taskEventTask{
		ID:       a.ID,
		Title:    f.Title,
		State:    a.State,
		EpicID:   f.EpicID,
		Assignee: f.Assignee,
	}
	if a.Ticket != nil {
		t.TicketID = store.TicketID(*a.Ticket)
	}
	if a.ClaimedBy != nil {
		t.ClaimedBy = *a.ClaimedBy
	}
	if a.Result != nil {
		t.Result = *a.Result
	}
	if a.Error != nil {
		t.Error = *a.Error
	}
	return t
}

// emitTaskEvent enqueues one outbound event for one task.
//
// NIL-SAFE BY DESIGN: h.events is nil whenever webhooks aren't wired (every
// handler test, and any deployment that doesn't construct an Emitter), and the
// EMIT becomes a no-op — the long-poll wake below it does not, since that is a
// canvas behaviour rather than a webhook one. Non-task actions are skipped here
// rather than at each call site — approving an EPIC is not a task entering the
// queue; its tasks each get their own event from the cascade.
//
// It is EmitAsync-shaped on purpose: the caller has already persisted the state
// change and (usually) already written the response. A webhook config read must
// never sit in a canvas mutation's latency, and a failed emit must never fail a
// mutation that already committed. Corollary: every call site must sit AFTER the
// store write returns nil — a rolled-back write that still notified the world
// is the one failure mode this feature can't recover from.
func (h *Handler) emitTaskEvent(canvasID uuid.UUID, eventType string, a *store.Action, opts ...func(*taskEvent)) {
	if a == nil || a.Type != "task" {
		return
	}
	// The event id is minted HERE, not inside the emitter, so the same id can be
	// both the delivery rows' fan-out key and a field a receiver can read. See
	// webhooks.EmitWithEventID.
	//
	// The projection is built BEFORE the h.events nil check (TDM-2) because the
	// long-poll wake below reads it: `ev` is the one place the task facts and the
	// caller's opts (who rejected, with what reason) are assembled, and building
	// it twice — once for waiters, once for receivers — is how the two would
	// eventually disagree. It costs a uuid and one payload unmarshal on a path
	// that has already committed a database write.
	eventID := uuid.New()
	ev := taskEvent{
		EventID:   eventID,
		Type:      eventType,
		Timestamp: time.Now().UTC(),
		CanvasID:  canvasID,
		Task:      newTaskEventTask(a),
	}
	for _, opt := range opts {
		opt(&ev)
	}
	// THE LONG-POLL WAKE (TDM-148), and it sits ABOVE the h.events nil check on
	// purpose: waking an agent that is waiting for work is a property of the
	// canvas, not of whether anyone configured outbound webhooks. Hanging this off
	// the emitter would mean waiters only ever wake on canvases with webhooks
	// wired — which is neither of the deployments this runs in.
	//
	// This is THE reason the wait endpoint needs no timer against the database:
	// every approval door in action_handler.go already funnels through here, so
	// they all signal by construction, and a door added later inherits it.
	switch eventType {
	case webhooks.EventTaskApproved:
		h.signalQueueReady(canvasID)
	case webhooks.EventTaskRejected:
		// The OTHER answer a parked agent can get (TDM-2). Same funnel, same
		// argument, opposite news: a waiter woken by this one is told the ticket is
		// dead and why, rather than handed work. Carrying the facts on the signal
		// (instead of leaving the waiter to re-read the board) is what makes the
		// reason reach it — a rejected task is not in the ready queue the waiter
		// re-reads, so there would otherwise be nothing for it to find.
		h.signalQueueRejected(canvasID, rejectedTaskFromEvent(ev))
	}
	if h.events == nil {
		return
	}
	h.events.EmitAsyncWithEventID(canvasID, eventID, eventType, ev)
}

// withReturned attaches the bounce facts to a task.returned.
func withReturned(from, by, reason string) func(*taskEvent) {
	return func(ev *taskEvent) {
		ev.Returned = &taskEventReturned{From: from, By: by, Reason: reason}
	}
}

// withRejected attaches the verdict to a task.rejected.
func withRejected(from, by, reason string) func(*taskEvent) {
	return func(ev *taskEvent) {
		ev.Rejected = &taskEventRejected{From: from, By: by, Reason: reason}
	}
}

// withExpiredClaim attaches the lapsed-claim facts to a task.claim_expired.
func withExpiredClaim(outcome store.ClaimOutcome) func(*taskEvent) {
	return func(ev *taskEvent) {
		ev.ExpiredClaim = &taskEventExpiredClaim{
			ClaimedBy: outcome.ExpiredClaimBy,
			ClaimedAt: outcome.ExpiredClaimAt,
		}
	}
}

// emitTaskApprovedEach fans one task.approved out per task in a batch —
// approve-batch and the epic cascade both approve N tasks in ONE round trip, but
// a receiver subscribes to task-level events, so N approvals are N events (never
// one "batch approved" event; a receiver would have to fan it out itself, and
// the per-task idempotency key would be gone).
func (h *Handler) emitTaskApprovedEach(canvasID uuid.UUID, actions []*store.Action) {
	for _, a := range actions {
		h.emitTaskEvent(canvasID, webhooks.EventTaskApproved, a)
	}
}
