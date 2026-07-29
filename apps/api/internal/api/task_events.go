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
// EXACTLY THREE EVENTS EXIST, and every emit call site is in action_handler.go:
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
//
// WHAT DELIBERATELY FIRES NOTHING (the negative half of the contract, and the
// half a regression would break silently):
//
//   - approved → executing (a claim). Claiming is not a queue transition anyone
//     outside the canvas needs pushed; the claimant already knows.
//   - proposed → rejected, and DELETE. Rejection/deletion are the human saying
//     "no" — there is no work to hand off, and no event name for it.
//   - payload-only edits (retitling a task). The state machine didn't move.
//   - executing → approved via ReleaseAction, and failed → approved via
//     RequeueAction. Both put a task back in the queue, but neither is an
//     APPROVAL: the gate was already passed once, and re-firing task.approved
//     would make a fleet subscribed to it re-run work it already picked up.
//     If re-queueing needs a notification it wants its own event name, not a
//     second approval.
//   - a SELF-takeover of an expired claim (the same agent restamping). See
//     store.ClaimOutcome — nothing changed hands.
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
// handler test, and any deployment that doesn't construct an Emitter), and this
// becomes a no-op. Non-task actions are skipped here rather than at each call
// site — approving an EPIC is not a task entering the queue; its tasks each get
// their own event from the cascade.
//
// It is EmitAsync-shaped on purpose: the caller has already persisted the state
// change and (usually) already written the response. A webhook config read must
// never sit in a canvas mutation's latency, and a failed emit must never fail a
// mutation that already committed. Corollary: every call site must sit AFTER the
// store write returns nil — a rolled-back write that still notified the world
// is the one failure mode this feature can't recover from.
func (h *Handler) emitTaskEvent(canvasID uuid.UUID, eventType string, a *store.Action, opts ...func(*taskEvent)) {
	if h.events == nil || a == nil || a.Type != "task" {
		return
	}
	// The event id is minted HERE, not inside the emitter, so the same id can be
	// both the delivery rows' fan-out key and a field a receiver can read. See
	// webhooks.EmitWithEventID.
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
	h.events.EmitAsyncWithEventID(canvasID, eventID, eventType, ev)
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
