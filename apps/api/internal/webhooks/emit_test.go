package webhooks

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/agentcanvas/api/internal/store"
)

// Emit fans out to every enabled, subscribed webhook on the canvas — and to
// nothing else. The three negative cases (disabled, unsubscribed, other canvas)
// are the ones a filter bug would silently get wrong.
func TestEmitFansOutToMatchingWebhooksOnly(t *testing.T) {
	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	canvasID := uuid.New()

	want1 := f.addHook(&store.Webhook{CanvasID: canvasID, URL: "https://a.example/hook", Secret: "s1",
		Events: []string{EventTaskApproved, EventTaskCompleted}, Enabled: true})
	want2 := f.addHook(&store.Webhook{CanvasID: canvasID, URL: "https://b.example/hook", Secret: "s2",
		Events: []string{EventTaskApproved}, Enabled: true})
	f.addHook(&store.Webhook{CanvasID: canvasID, URL: "https://disabled.example", Secret: "s3",
		Events: []string{EventTaskApproved}, Enabled: false})
	f.addHook(&store.Webhook{CanvasID: canvasID, URL: "https://other-event.example", Secret: "s4",
		Events: []string{EventTaskCompleted}, Enabled: true})
	f.addHook(&store.Webhook{CanvasID: uuid.New(), URL: "https://other-canvas.example", Secret: "s5",
		Events: []string{EventTaskApproved}, Enabled: true})

	n, err := NewEmitter(f).Emit(context.Background(), canvasID, EventTaskApproved,
		map[string]any{"task": map[string]any{"ticket": 36}})
	if err != nil {
		t.Fatalf("Emit: %v", err)
	}
	if n != 2 {
		t.Fatalf("enqueued %d deliveries, want 2", n)
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.deliveries) != 2 {
		t.Fatalf("stored %d delivery rows, want 2", len(f.deliveries))
	}
	targets := map[uuid.UUID]bool{}
	var eventIDs []uuid.UUID
	for _, d := range f.deliveries {
		targets[d.WebhookID] = true
		eventIDs = append(eventIDs, d.EventID)
		if d.Status != "pending" {
			t.Errorf("delivery status = %q, want pending", d.Status)
		}
		if d.CanvasID != canvasID {
			t.Errorf("delivery canvas_id = %s, want %s (denormalized for the canvas-scoped UI lists)", d.CanvasID, canvasID)
		}
		if d.EventType != EventTaskApproved {
			t.Errorf("delivery event_type = %q, want %q", d.EventType, EventTaskApproved)
		}
		if d.ID == uuid.Nil {
			t.Error("delivery id not minted — the receiver has nothing to dedupe on")
		}
	}
	if !targets[want1.ID] || !targets[want2.ID] {
		t.Errorf("fan-out hit the wrong webhooks: %v", targets)
	}
	// ONE event_id for the whole fan-out — the "who did we tell about this" key
	// and the idempotency key of the insert.
	if eventIDs[0] != eventIDs[1] {
		t.Errorf("fan-out used %d distinct event_ids, want 1 shared", len(eventIDs))
	}
	if eventIDs[0] == uuid.Nil {
		t.Error("event_id not minted")
	}
}

// Re-running the SAME fan-out (same event_id) is a no-op per webhook — that is
// what UNIQUE(webhook_id, event_id) buys, and what makes a retried enqueue safe.
func TestCreateDeliveriesIsIdempotentPerEvent(t *testing.T) {
	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	canvasID, webhookID, eventID := uuid.New(), uuid.New(), uuid.New()

	row := func() []*store.WebhookDelivery {
		return []*store.WebhookDelivery{{
			ID: uuid.New(), WebhookID: webhookID, CanvasID: canvasID,
			EventID: eventID, EventType: EventTaskApproved,
		}}
	}
	if n, err := f.CreateWebhookDeliveries(context.Background(), row()); err != nil || n != 1 {
		t.Fatalf("first insert = (%d, %v), want (1, nil)", n, err)
	}
	if n, err := f.CreateWebhookDeliveries(context.Background(), row()); err != nil || n != 0 {
		t.Fatalf("replayed insert = (%d, %v), want (0, nil) — the unique key must swallow it", n, err)
	}
	if len(f.deliveries) != 1 {
		t.Fatalf("stored %d rows, want 1", len(f.deliveries))
	}
}

// A canvas with no webhooks is the overwhelmingly common case: Emit must be a
// silent no-op, not an error, so call sites never need to special-case it.
func TestEmitNoWebhooksIsNoOp(t *testing.T) {
	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	n, err := NewEmitter(f).Emit(context.Background(), uuid.New(), EventTaskCompleted, nil)
	if err != nil || n != 0 {
		t.Fatalf("Emit on a canvas with no webhooks = (%d, %v), want (0, nil)", n, err)
	}
}

// An unknown event name is rejected loudly rather than enqueued: the DB CHECK
// would reject it anyway, and a webhook that silently never fires is the worst
// failure mode for this feature.
func TestEmitRejectsUnknownEvent(t *testing.T) {
	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	canvasID := uuid.New()
	f.addHook(&store.Webhook{CanvasID: canvasID, URL: "https://a.example", Secret: "s",
		Events: []string{EventTaskApproved}, Enabled: true})

	if _, err := NewEmitter(f).Emit(context.Background(), canvasID, "task.aproved", nil); err == nil {
		t.Fatal("Emit accepted a typo'd event name")
	}
	if len(f.deliveries) != 0 {
		t.Errorf("a rejected emit still enqueued %d rows", len(f.deliveries))
	}
}

// The stored payload is the exact request body, so it must always be a JSON
// object — a nil payload becomes {}, never `null`.
func TestEmitPayloadMarshalling(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want string
	}{
		{"nil becomes an empty object", nil, `{}`},
		{"typed nil map becomes an empty object", map[string]any(nil), `{}`},
		{"struct marshals normally", struct {
			Ticket int `json:"ticket"`
		}{36}, `{"ticket":36}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := marshalPayload(tc.in)
			if err != nil {
				t.Fatalf("marshalPayload: %v", err)
			}
			if string(got) != tc.want {
				t.Fatalf("marshalPayload = %s, want %s", got, tc.want)
			}
		})
	}
}

// The event vocabulary must stay in step with the CHECK in migration 0038 —
// emitting a name the DB rejects would fail at insert time, in the background,
// where nobody sees it.
func TestEventConstantsMatchSchema(t *testing.T) {
	for _, e := range []string{EventTaskApproved, EventTaskCompleted, EventTaskClaimExpired, EventTaskReturned} {
		if !store.IsKnownWebhookEvent(e) {
			t.Errorf("event %q is not in store.KnownWebhookEvents (the 0038 CHECK, widened by 0043)", e)
		}
	}
	// The count is the tripwire, and it is meant to fail: adding a constant
	// without widening the CHECK ships an event the DB rejects at insert time, in
	// a background goroutine, where nobody sees it. If you are here because this
	// line failed, write the migration before you change the number.
	if len(store.KnownWebhookEvents) != 4 {
		t.Errorf("KnownWebhookEvents has %d entries, want 4 — widen the CHECK in a migration first",
			len(store.KnownWebhookEvents))
	}
}

// TDM-37: the caller supplies the event id so the SAME id can be both the
// fan-out key on the delivery rows and a field inside the payload. If Emit
// minted its own, one logical event would carry two ids and nothing could join a
// receiver's report back to the delivery log.
func TestEmitWithEventIDUsesTheCallersID(t *testing.T) {
	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	canvasID := uuid.New()
	f.addHook(&store.Webhook{CanvasID: canvasID, URL: "https://a.example/hook", Secret: "s1",
		Events: []string{EventTaskApproved}, Enabled: true})
	f.addHook(&store.Webhook{CanvasID: canvasID, URL: "https://b.example/hook", Secret: "s2",
		Events: []string{EventTaskApproved}, Enabled: true})

	eventID := uuid.New()
	n, err := NewEmitter(f).EmitWithEventID(context.Background(), canvasID, eventID, EventTaskApproved,
		map[string]any{"event_id": eventID.String(), "type": EventTaskApproved})
	if err != nil {
		t.Fatalf("EmitWithEventID: %v", err)
	}
	if n != 2 {
		t.Fatalf("enqueued %d, want 2", n)
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	for _, d := range f.deliveries {
		if d.EventID != eventID {
			t.Errorf("delivery event_id = %s, want the caller's %s", d.EventID, eventID)
		}
		// The payload a receiver sees must name the same event.
		var body map[string]any
		if err := json.Unmarshal(d.Payload, &body); err != nil {
			t.Fatalf("payload: %v", err)
		}
		if body["event_id"] != eventID.String() {
			t.Errorf("payload event_id = %v, want %s", body["event_id"], eventID)
		}
	}
}

// Re-emitting with the SAME event id is a genuine no-op — the stronger
// idempotency a caller gets by owning the id (UNIQUE(webhook_id, event_id)).
func TestEmitWithEventIDIsIdempotent(t *testing.T) {
	clock := time.Unix(vectorTimestamp, 0).UTC()
	f := newFakeStore(func() time.Time { return clock })
	canvasID := uuid.New()
	f.addHook(&store.Webhook{CanvasID: canvasID, URL: "https://a.example/hook", Secret: "s1",
		Events: []string{EventTaskCompleted}, Enabled: true})

	em := NewEmitter(f)
	eventID := uuid.New()
	for i := 0; i < 2; i++ {
		if _, err := em.EmitWithEventID(context.Background(), canvasID, eventID, EventTaskCompleted, nil); err != nil {
			t.Fatalf("emit #%d: %v", i, err)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.deliveries) != 1 {
		t.Fatalf("stored %d delivery rows for one event id, want 1", len(f.deliveries))
	}
}
