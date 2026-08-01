// Package webhooks is the outbound-webhook half of the task queue: an Emitter
// that fans a canvas event out onto the delivery queue, and a Worker that leases
// due deliveries, signs them, sends them, and retries or dead-letters them.
//
// Storage contract: supabase/migrations/0038_webhooks.sql. Wire contract:
// sign.go (header names, what is signed, receiver verification).
//
// Split of responsibilities:
//
//	Emitter  runs in the request path. Cheap: one SELECT of matching configs,
//	         one bulk INSERT of delivery rows. Never sends anything.
//	Worker   runs as a background loop in the server process. Owns all HTTP.
//
// The queue between them is what makes an event survive a receiver being down —
// and what keeps a slow receiver from ever slowing a canvas mutation.
package webhooks

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"

	"github.com/agentcanvas/api/internal/store"
)

// The event vocabulary, mirroring the CHECK in migration 0038 (widened once, by
// 0043). TDM-37 wires these to the task-queue transitions; nothing else may be
// emitted (the DB rejects it, which is the point — a typo'd event name that
// silently never fires is the worst failure mode here).
const (
	// EventTaskApproved — a task entered the ready-to-work queue.
	EventTaskApproved = "task.approved"
	// EventTaskCompleted — a task finished and its result was recorded.
	EventTaskCompleted = "task.completed"
	// EventTaskClaimExpired — an agent's claim on a task went stale and was
	// released.
	EventTaskClaimExpired = "task.claim_expired"
	// EventTaskReturned — FINISHED work was put back in the ready queue: a
	// reviewer agent's rework bounce, or a human reopening a done task (TDM-170).
	// It is the retraction of a task.completed a receiver has already been sent —
	// the one transition that falsifies an event we already published — which is
	// why it is a new name and not a second task.approved. See task_events.go.
	EventTaskReturned = "task.returned"
)

// EmitStore is the slice of the store an Emitter uses.
type EmitStore interface {
	ListWebhooksForEvent(ctx context.Context, canvasID uuid.UUID, eventType string) ([]*store.Webhook, error)
	CreateWebhookDeliveries(ctx context.Context, deliveries []*store.WebhookDelivery) (int, error)
}

// Emitter turns a canvas event into queued deliveries.
type Emitter struct {
	store EmitStore
	logf  func(format string, args ...any)
	// asyncTimeout bounds a detached EmitAsync so a wedged DB call can't leak a
	// goroutine for the life of the process.
	asyncTimeout time.Duration
}

// NewEmitter builds an Emitter over the store.
func NewEmitter(st EmitStore) *Emitter {
	return &Emitter{store: st, logf: log.Printf, asyncTimeout: 10 * time.Second}
}

// Emit fans one canvas event out onto the delivery queue: one row per ENABLED
// webhook on the canvas whose event filter contains eventType, all sharing a
// single freshly-minted event_id. It returns how many deliveries were newly
// enqueued (0 is the common, entirely normal case — most canvases have no
// webhooks).
//
// Signature:
//
//	emitter.Emit(ctx, canvasID, webhooks.EventTaskApproved, payload)
//
// TDM-37's handlers do NOT call this one — they call EmitAsyncWithEventID, so
// the id in the row and the id in the payload are the same id. See below.
//
// payload is marshaled once and stored verbatim; it becomes the REQUEST BODY of
// every delivery, byte for byte, and is what the signature covers. It is
// therefore the whole public schema of the event — the event type and delivery
// id ride headers (Tandem-Event / Tandem-Delivery-Id), so a payload wants the
// domain facts: task id, ticket, title, state, claimant, result. Any struct or
// map that marshals to a JSON object works; a nil payload becomes `{}`.
//
// IDEMPOTENCY. The single event_id shared by the fan-out, combined with
// UNIQUE(webhook_id, event_id), makes a re-run of the same *Emit call* a no-op
// per webhook. Note the scope: each Emit CALL mints a new event_id, so calling
// Emit twice for the same task approval sends two notifications. Dedupe at the
// call site (emit from the one place the transition happens), not here — the
// store has no way to tell a duplicate emit from a legitimate re-approval.
func (e *Emitter) Emit(ctx context.Context, canvasID uuid.UUID, eventType string, payload any) (int, error) {
	// ONE freshly-minted event id for the whole fan-out — the "who did we tell
	// about this approval" key, and the idempotency key of the insert.
	return e.EmitWithEventID(ctx, canvasID, uuid.New(), eventType, payload)
}

// EmitWithEventID is Emit with the event id supplied by the caller instead of
// minted here.
//
// Why the seam exists (TDM-37): the delivery row's event_id is the only handle
// an operator has on "one logical event, fanned out to N endpoints" — but a
// receiver never sees that column. It sees the PAYLOAD (plus the delivery-id and
// event-type headers). For a receiver to correlate two notifications as the same
// event, the id has to be INSIDE the payload — and the payload is marshaled by
// the caller, before Emit runs. Minting inside Emit would therefore give one
// event two different ids: one in the row, a different one in the bytes, and no
// way to join a receiver's report back to the delivery log.
//
// So the caller mints once, stamps it into the payload it builds, and passes the
// same id here. Everything else is identical to Emit — including the
// UNIQUE(webhook_id, event_id) idempotency guarantee, which this makes *stronger*
// for callers that derive a stable id: re-emitting with the same id is a genuine
// no-op rather than a second notification.
func (e *Emitter) EmitWithEventID(ctx context.Context, canvasID, eventID uuid.UUID, eventType string, payload any) (int, error) {
	if !store.IsKnownWebhookEvent(eventType) {
		return 0, fmt.Errorf("unknown webhook event %q", eventType)
	}

	hooks, err := e.store.ListWebhooksForEvent(ctx, canvasID, eventType)
	if err != nil {
		return 0, fmt.Errorf("list webhooks: %w", err)
	}
	if len(hooks) == 0 {
		return 0, nil
	}

	body, err := marshalPayload(payload)
	if err != nil {
		return 0, fmt.Errorf("marshal payload: %w", err)
	}

	deliveries := make([]*store.WebhookDelivery, 0, len(hooks))
	for _, h := range hooks {
		deliveries = append(deliveries, &store.WebhookDelivery{
			// Mint the delivery id here rather than letting the DB default it:
			// it is the value the receiver dedupes on, and having it in hand
			// makes the enqueue traceable in logs without a read-back.
			ID:        uuid.New(),
			WebhookID: h.ID,
			CanvasID:  canvasID,
			EventID:   eventID,
			EventType: eventType,
			Payload:   body,
		})
	}

	n, err := e.store.CreateWebhookDeliveries(ctx, deliveries)
	if err != nil {
		return n, fmt.Errorf("enqueue deliveries: %w", err)
	}
	return n, nil
}

// EmitAsync is Emit detached from the caller's request: it runs on its own
// goroutine with its own timeout and logs failures instead of returning them.
// This is what a mutation handler should call — a canvas write must not fail, or
// wait, because someone's webhook config row is slow to read.
//
// It deliberately does NOT inherit the request context: that context is
// cancelled the moment the HTTP response is written, which would abort the
// enqueue it is racing.
func (e *Emitter) EmitAsync(canvasID uuid.UUID, eventType string, payload any) {
	e.EmitAsyncWithEventID(canvasID, uuid.New(), eventType, payload)
}

// EmitAsyncWithEventID is EmitAsync over EmitWithEventID — the handler-side
// call. Every task-lifecycle emit in internal/api goes through this one: the
// handler mints the event id, stamps it into the payload envelope, and hands
// both here. See EmitWithEventID for why the id is the caller's to mint.
func (e *Emitter) EmitAsyncWithEventID(canvasID, eventID uuid.UUID, eventType string, payload any) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), e.asyncTimeout)
		defer cancel()
		if _, err := e.EmitWithEventID(ctx, canvasID, eventID, eventType, payload); err != nil {
			e.logf("webhooks: emit %s for canvas %s: %v", eventType, canvasID, err)
		}
	}()
}

// marshalPayload renders the caller's payload to the bytes that will be stored,
// sent, and signed. nil (and a payload that marshals to `null`) becomes `{}` so
// the column's NOT NULL DEFAULT '{}' shape holds and receivers always get an
// object.
func marshalPayload(payload any) (json.RawMessage, error) {
	if payload == nil {
		return json.RawMessage("{}"), nil
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	if len(b) == 0 || string(b) == "null" {
		return json.RawMessage("{}"), nil
	}
	return b, nil
}
