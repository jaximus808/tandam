package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	postgrest "github.com/supabase-community/postgrest-go"
)

// Outbound-webhook storage (migration 0038): per-canvas endpoint config plus the
// delivery queue the worker in internal/webhooks leases from.
//
// SECRET HANDLING. webhooks.secret is the HMAC key and therefore stored in
// plaintext — there is nothing to compare a hash against. The mitigation is a
// projection discipline enforced here, not a convention callers have to
// remember:
//   - every SELECT whose rows leave the store with key material intact asks for
//     webhookReadCols, which omits `secret`;
//   - the two reads that need the key material — ListWebhooksForEvent and
//     GetWebhookWithSecret — ask for webhookSecretCols and are documented as
//     emit/deliver-path-only;
//   - mutations return the full row (PostgREST's return=representation can't be
//     projected through this client), so their results are run through
//     scrubSecret before leaving the store;
//   - Webhook.Secret is `json:"-"`, a second belt for anything that slips past.
//
// ListWebhooks is the one deliberate exception to the projection half of that
// rule, and it is worth spelling out because it reads like a violation. The
// config list in the web UI shows the TRAILING 4 CHARS of each secret (the
// mitigation migration 0038 names, and the only way to tell two configs on the
// same URL apart), and last-four lives nowhere but the column itself — there is
// no stored/generated `secret_last_four`, and PostgREST cannot project
// `right(secret,4)`. So ListWebhooks selects the secret, derives
// SecretLastFour, and scrubs the key material IN THE SAME LOOP, before any row
// is appended to the result. Nothing with a populated Secret is ever returned
// from it, and `json:"-"` still means a slip could not serialize anyway. The
// alternative — a generated column — would couple this feature's UI to a second
// migration landing first, for a value that is four characters wide.
const (
	webhookReadCols   = "id,canvas_id,url,events,enabled,name,description,created_by,created_at,updated_at"
	webhookSecretCols = webhookReadCols + ",secret"
)

// WebhookSecretPrefix namespaces webhook signing secrets. It exists for the same
// reason PATPrefix does: a secret that turns up in a log or a support ticket is
// immediately identifiable as what it is (and as what it is NOT — a PAT, a claim
// token, a canvas code). Receivers see it verbatim as their HMAC key.
const WebhookSecretPrefix = "whsec_"

// GenerateWebhookSecret mints a webhook signing key: WebhookSecretPrefix + 32
// random bytes (hex) = 256 bits, the same budget as a PAT and far more than
// HMAC-SHA256 needs. crypto/rand, obviously — this key is the only thing
// standing between a receiver and a forged task.completed.
//
// The server ALWAYS generates it. There is no path for a client to supply one:
// a caller-chosen secret is a caller-chosen weak secret, and it would also mean
// accepting key material on a request body that gets logged by proxies.
func GenerateWebhookSecret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Errorf("crypto/rand: %w", err))
	}
	return WebhookSecretPrefix + hex.EncodeToString(b)
}

// scrubSecret blanks the key material on a config that came back from a write
// echo, keeping the last-four hint the UI shows. Returns w for chaining.
func scrubSecret(w *Webhook) *Webhook {
	if w == nil {
		return nil
	}
	w.Secret = ""
	return w
}

// deliveryCols is every column of webhook_deliveries. Deliveries carry no
// secret, so there is one projection.
const deliveryCols = "id,webhook_id,canvas_id,event_id,event_type,payload,status," +
	"attempt_count,last_attempt_at,next_attempt_at,response_status,response_body,error,created_at"

// KnownWebhookEvents is the MVP event vocabulary, mirroring the
// webhooks_events_known CHECK in migration 0038. Kept here (not in the webhooks
// package) so the store can validate before a round trip and so config handlers
// have one list to render.
var KnownWebhookEvents = []string{"task.approved", "task.completed", "task.claim_expired"}

// IsKnownWebhookEvent reports whether e is one of KnownWebhookEvents.
func IsKnownWebhookEvent(e string) bool {
	for _, k := range KnownWebhookEvents {
		if k == e {
			return true
		}
	}
	return false
}

// NormalizeWebhookEvents de-duplicates and sorts an event filter — the
// app-enforced half of the events contract (migration 0038 leaves dedupe/sort to
// the app and only CHECKs membership + non-emptiness). Unknown names are
// returned as an error rather than silently dropped: a typo'd event that is
// quietly discarded produces a webhook that never fires, the worst failure mode
// for this feature.
func NormalizeWebhookEvents(events []string) ([]string, error) {
	seen := map[string]bool{}
	out := make([]string, 0, len(events))
	for _, e := range events {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		if !IsKnownWebhookEvent(e) {
			return nil, fmt.Errorf("unknown webhook event %q (known: %s)", e, strings.Join(KnownWebhookEvents, ", "))
		}
		if seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("webhook must subscribe to at least one event (known: %s)", strings.Join(KnownWebhookEvents, ", "))
	}
	sort.Strings(out)
	return out, nil
}

// ── DB row types ────────────────────────────────────────────────────────────

type dbWebhook struct {
	ID          string   `json:"id"`
	CanvasID    string   `json:"canvas_id"`
	URL         string   `json:"url"`
	Secret      string   `json:"secret"` // populated ONLY by the emit-path select
	Events      []string `json:"events"`
	Enabled     bool     `json:"enabled"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	CreatedBy   string   `json:"created_by"`
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
}

type dbWebhookDelivery struct {
	ID             string          `json:"id"`
	WebhookID      string          `json:"webhook_id"`
	CanvasID       string          `json:"canvas_id"`
	EventID        string          `json:"event_id"`
	EventType      string          `json:"event_type"`
	Payload        json.RawMessage `json:"payload"`
	Status         string          `json:"status"`
	AttemptCount   int             `json:"attempt_count"`
	LastAttemptAt  *string         `json:"last_attempt_at"`
	NextAttemptAt  string          `json:"next_attempt_at"`
	ResponseStatus *int            `json:"response_status"`
	ResponseBody   *string         `json:"response_body"`
	Error          *string         `json:"error"`
	CreatedAt      string          `json:"created_at"`
}

func toWebhook(d dbWebhook) *Webhook {
	id, _ := uuid.Parse(d.ID)
	canvasID, _ := uuid.Parse(d.CanvasID)
	events := d.Events
	if events == nil {
		events = []string{}
	}
	return &Webhook{
		ID: id, CanvasID: canvasID, URL: d.URL,
		Secret:         d.Secret,
		SecretLastFour: LastFour(d.Secret),
		Events:         events, Enabled: d.Enabled,
		Name: d.Name, Description: d.Description, CreatedBy: d.CreatedBy,
		CreatedAt: parseTime(d.CreatedAt), UpdatedAt: parseTime(d.UpdatedAt),
	}
}

func toWebhookDelivery(d dbWebhookDelivery) *WebhookDelivery {
	id, _ := uuid.Parse(d.ID)
	webhookID, _ := uuid.Parse(d.WebhookID)
	canvasID, _ := uuid.Parse(d.CanvasID)
	eventID, _ := uuid.Parse(d.EventID)
	del := &WebhookDelivery{
		ID: id, WebhookID: webhookID, CanvasID: canvasID, EventID: eventID,
		EventType: d.EventType, Payload: d.Payload, Status: d.Status,
		AttemptCount:   d.AttemptCount,
		NextAttemptAt:  parseTime(d.NextAttemptAt),
		ResponseStatus: d.ResponseStatus,
		CreatedAt:      parseTime(d.CreatedAt),
	}
	if len(del.Payload) == 0 {
		del.Payload = json.RawMessage("{}")
	}
	if d.LastAttemptAt != nil && *d.LastAttemptAt != "" {
		t := parseTime(*d.LastAttemptAt)
		del.LastAttemptAt = &t
	}
	if d.ResponseBody != nil {
		del.ResponseBody = *d.ResponseBody
	}
	if d.Error != nil {
		del.Error = *d.Error
	}
	return del
}

// tsFmt renders a timestamp the way every other conditional-update predicate in
// this store does (RFC3339 with nanos, UTC) so lexical and temporal ordering
// agree on both sides of the wire.
func tsFmt(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// ── Config CRUD ─────────────────────────────────────────────────────────────

func (s *supabaseStore) CreateWebhook(_ context.Context, canvasID uuid.UUID, w *Webhook) (*Webhook, error) {
	events, err := NormalizeWebhookEvents(w.Events)
	if err != nil {
		return nil, err
	}
	createdBy := w.CreatedBy
	if createdBy == "" {
		createdBy = "user"
	}
	row := map[string]any{
		"canvas_id":   canvasID.String(),
		"url":         w.URL,
		"secret":      w.Secret,
		"events":      events,
		"enabled":     w.Enabled,
		"name":        w.Name,
		"description": w.Description,
		"created_by":  createdBy,
	}
	var rows []dbWebhook
	if _, err := s.client.From("webhooks").
		Insert(row, false, "", "representation", "").
		ExecuteTo(&rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("create webhook: no row returned")
	}
	return scrubSecret(toWebhook(rows[0])), nil
}

// ListWebhooks backs the config list in the web UI. It selects the secret ONLY
// to derive SecretLastFour and scrubs it in the same breath — see the secret
// handling note at the top of this file for why that exception exists and why
// it is safe. No row leaves here with key material on it.
func (s *supabaseStore) ListWebhooks(_ context.Context, canvasID uuid.UUID) ([]*Webhook, error) {
	var rows []dbWebhook
	if _, err := s.client.From("webhooks").
		Select(webhookSecretCols, "", false).
		Eq("canvas_id", canvasID.String()).
		Order("created_at", &postgrest.OrderOpts{Ascending: true}).
		ExecuteTo(&rows); err != nil {
		return nil, err
	}
	out := make([]*Webhook, 0, len(rows))
	for _, r := range rows {
		out = append(out, scrubSecret(toWebhook(r)))
	}
	return out, nil
}

// GetWebhook is ListWebhooks for one row, and carries the same
// select-then-scrub exception so a single read and a list agree on what
// SecretLastFour contains (UpdateWebhook falls back to this when a PATCH
// changes nothing — without it, a no-op save would blank the hint in the UI).
func (s *supabaseStore) GetWebhook(_ context.Context, canvasID, id uuid.UUID) (*Webhook, error) {
	var rows []dbWebhook
	if _, err := s.client.From("webhooks").
		Select(webhookSecretCols, "", false).
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrWebhookNotFound
	}
	return scrubSecret(toWebhook(rows[0])), nil
}

func (s *supabaseStore) UpdateWebhook(_ context.Context, canvasID, id uuid.UUID, patch WebhookPatch) (*Webhook, error) {
	upd := map[string]any{}
	if patch.URL != nil {
		upd["url"] = *patch.URL
	}
	if patch.Secret != nil {
		// Rotation is a plain column UPDATE — no versioning for MVP (0038).
		upd["secret"] = *patch.Secret
	}
	if patch.Events != nil {
		events, err := NormalizeWebhookEvents(*patch.Events)
		if err != nil {
			return nil, err
		}
		upd["events"] = events
	}
	if patch.Enabled != nil {
		upd["enabled"] = *patch.Enabled
	}
	if patch.Name != nil {
		upd["name"] = *patch.Name
	}
	if patch.Description != nil {
		upd["description"] = *patch.Description
	}
	if len(upd) == 0 {
		return s.GetWebhook(context.Background(), canvasID, id)
	}
	var rows []dbWebhook
	if _, err := s.client.From("webhooks").
		Update(upd, "representation", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrWebhookNotFound
	}
	return scrubSecret(toWebhook(rows[0])), nil
}

func (s *supabaseStore) DeleteWebhook(_ context.Context, canvasID, id uuid.UUID) error {
	// Deliveries FK webhooks ON DELETE CASCADE, so the log goes with the config.
	var rows []dbWebhook
	if _, err := s.client.From("webhooks").
		Delete("representation", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows); err != nil {
		return err
	}
	if len(rows) == 0 {
		return ErrWebhookNotFound
	}
	return nil
}

func (s *supabaseStore) CountWebhooks(_ context.Context, canvasID uuid.UUID) (int, error) {
	_, count, err := s.client.From("webhooks").
		Select("id", "exact", true).
		Eq("canvas_id", canvasID.String()).
		Execute()
	if err != nil {
		return 0, err
	}
	return int(count), nil
}

// ListWebhooksForEvent is the ONLY read that loads secrets. Its results feed the
// signer directly and must never reach a response writer.
func (s *supabaseStore) ListWebhooksForEvent(_ context.Context, canvasID uuid.UUID, eventType string) ([]*Webhook, error) {
	var rows []dbWebhook
	if _, err := s.client.From("webhooks").
		Select(webhookSecretCols, "", false).
		Eq("canvas_id", canvasID.String()).
		Eq("enabled", "true").
		// events @> ARRAY[eventType] — the containment predicate the TEXT[]
		// filter exists for (migration 0038), evaluated in Postgres rather than
		// pulling every config back to filter in Go.
		Contains("events", []string{eventType}).
		ExecuteTo(&rows); err != nil {
		return nil, err
	}
	out := make([]*Webhook, 0, len(rows))
	for _, r := range rows {
		out = append(out, toWebhook(r))
	}
	return out, nil
}

// GetWebhookWithSecret is the delivery worker's lookup — the second of the two
// reads that load key material. Same rule: emit/deliver path only.
func (s *supabaseStore) GetWebhookWithSecret(_ context.Context, id uuid.UUID) (*Webhook, error) {
	var rows []dbWebhook
	if _, err := s.client.From("webhooks").
		Select(webhookSecretCols, "", false).
		Eq("id", id.String()).
		ExecuteTo(&rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrWebhookNotFound
	}
	return toWebhook(rows[0]), nil
}

// ── Delivery queue ──────────────────────────────────────────────────────────

// CreateWebhookDeliveries bulk-inserts the fan-out. A repeated fan-out of the
// same source event trips UNIQUE(webhook_id, event_id) — Postgres error 23505,
// which we swallow and report as "nothing new", because that unique index IS the
// producer-side idempotency guarantee (0038): re-emitting must be a no-op, not an
// error and not a duplicate notification.
//
// (PostgREST's `resolution=ignore-duplicates` isn't reachable through this
// client — Insert only offers merge-duplicates, which would RESET an already-
// delivered row back to pending. Swallowing 23505 gives the ON CONFLICT DO
// NOTHING semantics the schema asks for; the cost is that a partially-new batch
// is retried row-by-row.)
func (s *supabaseStore) CreateWebhookDeliveries(_ context.Context, deliveries []*WebhookDelivery) (int, error) {
	if len(deliveries) == 0 {
		return 0, nil
	}
	rows := make([]map[string]any, 0, len(deliveries))
	for _, d := range deliveries {
		rows = append(rows, webhookDeliveryRow(d))
	}
	err := s.exec(s.client.From("webhook_deliveries").Insert(rows, false, "", "minimal", ""))
	if err == nil {
		return len(deliveries), nil
	}
	if !isUniqueViolation(err) {
		return 0, err
	}
	if len(deliveries) == 1 {
		return 0, nil // the only row was a duplicate
	}
	// Mixed batch: the whole INSERT rolled back, so replay it per row and count
	// the ones that were genuinely new. Rare (only on a re-emit), so a loop is
	// the right cost.
	inserted := 0
	for _, d := range deliveries {
		err := s.exec(s.client.From("webhook_deliveries").Insert(webhookDeliveryRow(d), false, "", "minimal", ""))
		switch {
		case err == nil:
			inserted++
		case isUniqueViolation(err):
			// already fanned out to this webhook — no-op
		default:
			return inserted, err
		}
	}
	return inserted, nil
}

func webhookDeliveryRow(d *WebhookDelivery) map[string]any {
	payload := d.Payload
	if len(payload) == 0 {
		payload = json.RawMessage("{}")
	}
	row := map[string]any{
		"webhook_id": d.WebhookID.String(),
		"canvas_id":  d.CanvasID.String(),
		"event_id":   d.EventID.String(),
		"event_type": d.EventType,
		"payload":    payload,
	}
	if d.ID != uuid.Nil {
		row["id"] = d.ID.String()
	}
	return row
}

// isUniqueViolation detects Postgres 23505 through postgrest-go's flattened
// error string ("(23505) duplicate key value…").
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "23505")
}

// LeaseWebhookDeliveries implements strategy (a) from migration 0038: a
// conditional PATCH claim in the 0032 atomic-claim mould.
//
// It is deliberately two steps. The read picks the due ids (ordered oldest-due
// first, so a backlog drains fairly); the per-row PATCH is what actually leases,
// and its WHERE clause is the race guard:
//
//	id = <id> AND status IN ('pending','failed')
//	         AND next_attempt_at <= <now> AND attempt_count = <n seen by the read>
//
// The attempt_count equality makes the claim a compare-and-swap: PostgREST can't
// express `attempt_count = attempt_count + 1`, so the new value is computed in Go
// from what the read saw, and a racing leaser that already incremented it makes
// this predicate fail instead of double-leasing. A 0-row PATCH means "someone
// else got it" and the row is silently skipped.
//
// last_attempt_at is stamped HERE, at the start of the attempt, because it
// doubles as the lease clock for ReapStuckWebhookDeliveries (0038).
func (s *supabaseStore) LeaseWebhookDeliveries(_ context.Context, limit int) ([]*WebhookDelivery, error) {
	if limit <= 0 {
		return nil, nil
	}
	now := time.Now().UTC()
	var due []dbWebhookDelivery
	if _, err := s.client.From("webhook_deliveries").
		Select("id,attempt_count", "", false).
		In("status", []string{"pending", "failed"}).
		Lte("next_attempt_at", tsFmt(now)).
		Order("next_attempt_at", &postgrest.OrderOpts{Ascending: true}).
		Limit(limit, "").
		ExecuteTo(&due); err != nil {
		return nil, err
	}

	leased := make([]*WebhookDelivery, 0, len(due))
	for _, d := range due {
		var rows []dbWebhookDelivery
		_, err := s.client.From("webhook_deliveries").
			Update(map[string]any{
				"status":          "delivering",
				"last_attempt_at": tsFmt(now),
				"attempt_count":   d.AttemptCount + 1,
			}, "representation", "").
			Eq("id", d.ID).
			In("status", []string{"pending", "failed"}).
			Lte("next_attempt_at", tsFmt(now)).
			Eq("attempt_count", fmt.Sprint(d.AttemptCount)).
			ExecuteTo(&rows)
		if err != nil {
			return leased, err
		}
		if len(rows) == 1 {
			leased = append(leased, toWebhookDelivery(rows[0]))
		}
	}
	return leased, nil
}

func (s *supabaseStore) MarkWebhookDeliveryOK(_ context.Context, id uuid.UUID, res WebhookDeliveryResult) error {
	return s.finishWebhookDelivery(id, "ok", nil, res)
}

func (s *supabaseStore) MarkWebhookDeliveryFailed(_ context.Context, id uuid.UUID, nextAttemptAt time.Time, res WebhookDeliveryResult) error {
	return s.finishWebhookDelivery(id, "failed", &nextAttemptAt, res)
}

func (s *supabaseStore) MarkWebhookDeliveryDead(_ context.Context, id uuid.UUID, res WebhookDeliveryResult) error {
	return s.finishWebhookDelivery(id, "dead", nil, res)
}

// finishWebhookDelivery closes out a leased attempt. Scoped to
// status='delivering' so a reaped-and-relet row can't be stomped by the corpse
// of the attempt that abandoned it.
func (s *supabaseStore) finishWebhookDelivery(id uuid.UUID, status string, nextAttemptAt *time.Time, res WebhookDeliveryResult) error {
	upd := map[string]any{
		"status":          status,
		"response_status": res.ResponseStatus,
		"response_body":   nullableStr(res.ResponseBody),
		"error":           nullableStr(res.Error),
	}
	if nextAttemptAt != nil {
		upd["next_attempt_at"] = tsFmt(*nextAttemptAt)
	}
	return s.exec(s.client.From("webhook_deliveries").
		Update(upd, "minimal", "").
		Eq("id", id.String()).
		Eq("status", "delivering"))
}

func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ReapStuckWebhookDeliveries recovers rows abandoned mid-flight. last_attempt_at
// is the lease clock (0038): a 'delivering' row older than olderThan belongs to a
// worker that died, so it goes back to 'failed' with next_attempt_at = now —
// immediately retryable, and its attempt_count already counted the lost attempt,
// so a permanently-crashing send still exhausts its budget and dead-letters.
func (s *supabaseStore) ReapStuckWebhookDeliveries(_ context.Context, olderThan time.Duration) (int, error) {
	if olderThan <= 0 {
		return 0, nil
	}
	now := time.Now().UTC()
	var rows []dbWebhookDelivery
	if _, err := s.client.From("webhook_deliveries").
		Update(map[string]any{
			"status":          "failed",
			"next_attempt_at": tsFmt(now),
			"error":           "worker lease expired (no result recorded)",
		}, "representation", "").
		Eq("status", "delivering").
		Lt("last_attempt_at", tsFmt(now.Add(-olderThan))).
		ExecuteTo(&rows); err != nil {
		return 0, err
	}
	return len(rows), nil
}

func (s *supabaseStore) ListWebhookDeliveries(_ context.Context, canvasID uuid.UUID, webhookID *uuid.UUID, status string, limit int) ([]*WebhookDelivery, error) {
	if limit <= 0 {
		limit = 50
	}
	q := s.client.From("webhook_deliveries").
		Select(deliveryCols, "", false).
		Eq("canvas_id", canvasID.String())
	if webhookID != nil {
		q = q.Eq("webhook_id", webhookID.String())
	}
	if status != "" {
		q = q.Eq("status", status)
	}
	var rows []dbWebhookDelivery
	if _, err := q.
		Order("created_at", &postgrest.OrderOpts{Ascending: false}).
		Limit(limit, "").
		ExecuteTo(&rows); err != nil {
		return nil, err
	}
	out := make([]*WebhookDelivery, 0, len(rows))
	for _, r := range rows {
		out = append(out, toWebhookDelivery(r))
	}
	return out, nil
}

// RetryWebhookDelivery is the human "Retry" button on the dead-letter list: it
// puts one delivery back on the queue for the worker to pick up on its next
// poll. Same delivery id, so a receiver that DID apply the original still
// dedupes it (0038's replay contract); fresh signature and timestamp, so it
// isn't a stale replay either.
//
// It resets attempt_count to 0, which is the whole point and not an oversight.
// A dead row has already spent its budget, so leaving the counter alone would
// make "Retry" mean "make exactly one more attempt and die again" — every
// transient failure would need a second click. A human pressing retry has
// (usually) just fixed their endpoint, and wants the same backoff budget a
// fresh event gets. The cost is that attempt_count reads as "attempts in the
// current cycle" rather than "attempts ever", which is what the UI labels it.
//
// The previous attempt's error/response are cleared for the same reason: the
// row now describes a pending attempt, and a stale 502 sitting next to
// status='pending' is a lie the dead-letter list would happily render.
//
// Scoped by canvas_id (this is reachable from a canvas-scoped UI, so the canvas
// is half the authorization) AND by status: only 'failed' and 'dead' are
// retryable. 'delivering' is in flight and re-queueing it would race the worker
// that holds the lease; 'ok' already succeeded and re-sending it would be a
// duplicate notification the caller never asked for; 'pending' is already
// queued. A zero-row result is reported as ErrWebhookDeliveryNotRetryable
// rather than split into 404/409, because distinguishing them costs a second
// round trip to tell a human two things they'd act on identically.
func (s *supabaseStore) RetryWebhookDelivery(_ context.Context, canvasID, id uuid.UUID) (*WebhookDelivery, error) {
	var rows []dbWebhookDelivery
	if _, err := s.client.From("webhook_deliveries").
		Update(map[string]any{
			"status":          "pending",
			"attempt_count":   0,
			"next_attempt_at": tsFmt(time.Now().UTC()),
			"error":           nil,
			"response_status": nil,
			"response_body":   nil,
		}, "representation", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()).
		In("status", []string{"failed", "dead"}).
		ExecuteTo(&rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrWebhookDeliveryNotRetryable
	}
	return toWebhookDelivery(rows[0]), nil
}
