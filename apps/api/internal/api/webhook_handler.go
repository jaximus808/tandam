package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/webhooks"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// Outbound-webhook CONFIG (TDM-39). The CRUD behind the Webhooks section of the
// canvas settings panel, plus the delivery log and dead-letter retry that sit
// under it.
//
// ── Why these routes are shaped the way they are ────────────────────────────
//
// This is the one part of the webhook feature that must NOT be reachable by an
// agent. A webhook config names an endpoint and mints a signing secret; an agent
// that can create one can point a canvas at a server it controls and receive
// every task event on that board, signed and looking authentic. Migration 0038
// says it plainly: "human-set in the web UI only." So the surface is built to
// make that structural rather than aspirational.
//
// THE GATE, precisely: every route below lives in the RequireUser group in
// routes.go and additionally calls requireCanvasOwner. That is two independent
// conditions:
//
//  1. RequireUser accepts a valid SESSION COOKIE and nothing else. Look at
//     sessionUserID in middleware.go — it reads r.Cookie(sessionCookieName) and
//     never consults the Authorization header. This is the important half. The
//     credentials an agent actually holds — a canvas JWT from /api/mcp/auth, a
//     personal access token (tdm_pat_…), an OAuth access token (tdm_oat_…) — all
//     fail it. That is a deliberate divergence from the OptionalUser /
//     RequireCanvasByCode routes, which accept a PAT precisely SO an agent can
//     act as the user. Here we want the opposite, so we use the one middleware
//     in the codebase that a bearer token cannot satisfy.
//  2. requireCanvasOwner then requires the session user to be the canvas OWNER.
//     Not "has write access", not "is a member" — the owner. Webhook config is
//     canvas infrastructure, like visibility and deletion, and it sits with them.
//
// THE HONEST LIMIT. "The human in the browser" is not something HTTP can prove,
// and this does not prove it. A session cookie is a bearer credential like any
// other: a browser-driving agent, or anything running inside the user's browser
// with access to that cookie, presents exactly the same request a human does.
// What the gate DOES guarantee is that none of the credentials Tandem issues to
// agents — the entire MCP/PAT/OAuth surface, which is how every agent in this
// system authenticates — can reach these routes. An agent would have to escape
// its own credential model and steal a browser session, at which point it can
// also delete the canvas. That is the strongest separation expressible today,
// and the gap is worth naming rather than papering over.
//
// Belt and braces beyond the gate: there is no MCP tool for any of this (the
// gateway's tool list in apps/mcp-gateway/src/tools.ts has no webhook entry, and
// none of these paths sit under /api/canvas/* where a canvas JWT is accepted),
// and the CLIENT NEVER SUPPLIES THE SECRET — the server mints it and shows it
// once. See CreateCanvasWebhook.

// maxWebhooksPerCanvas is the app-enforced per-canvas cap. Migration 0038
// deliberately leaves this to the app (a DB trigger for a bound nobody will hit
// is not worth its maintenance), and suggests 5. A cap exists at all because
// every enabled config multiplies the delivery rows a single task transition
// writes, and because 5 endpoints is already well past "I have a use case" and
// into "something is creating these in a loop".
const maxWebhooksPerCanvas = 5

// Field bounds. url is generous (query strings on receiver endpoints are common
// and legitimate); name/description are labels for a list, not documents.
const (
	maxWebhookURLLen         = 2000
	maxWebhookNameLen        = 80
	maxWebhookDescriptionLen = 500
)

// maxDeliveryPageSize caps the delivery log page. The dead-letter list is
// something a human scans, not a data export.
const (
	defaultDeliveryPageSize = 50
	maxDeliveryPageSize     = 200
)

// webhookWithSecret is the create/rotate response: the config as every other
// read returns it, plus the plaintext secret — the ONLY two moments it is ever
// sent anywhere. The embedded *store.Webhook declares Secret as `json:"-"`; the
// outer field here is shallower, so it wins, and the value is the freshly
// generated one rather than anything read back from the DB.
type webhookWithSecret struct {
	*store.Webhook
	Secret string `json:"secret"`
	Note   string `json:"_note"`
}

const secretShownOnceNote = "Copy this signing secret now — it won't be shown again. " +
	"Your receiver verifies each delivery with it: HMAC-SHA256 over \"<Tandem-Timestamp>.<raw body>\", compared to the Tandem-Signature header."

// requireWebhookOwner is requireCanvasOwner with a message that names what the
// caller was actually trying to do. requireCanvasOwner's own 403 talks about
// sharing, which would be a confusing thing to read after a failed webhook save.
func (h *Handler) requireWebhookOwner(w http.ResponseWriter, r *http.Request) (*store.Canvas, bool) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		// Unreachable through the router (RequireUser answers first), but a
		// handler that trusts its middleware is one refactor away from being an
		// open endpoint.
		writeError(w, http.StatusUnauthorized, "not signed in")
		return nil, false
	}
	canvas, err := h.store.GetCanvasByCode(r.Context(), chi.URLParam(r, "code"))
	if err != nil {
		writeError(w, http.StatusNotFound, "canvas not found")
		return nil, false
	}
	if canvas.OwnerUserID == nil || *canvas.OwnerUserID != uid {
		writeError(w, http.StatusForbidden, "only the canvas owner can manage webhooks")
		return nil, false
	}
	return canvas, true
}

// ── Config CRUD ─────────────────────────────────────────────────────────────

// GET /api/canvases/{code}/webhooks — the config list.
//
// Secrets are not in this response and cannot be: the store scrubs the key
// material off every row before returning it, and store.Webhook.Secret is
// `json:"-"` regardless. What the UI gets is secretLastFour, enough to tell two
// configs on the same URL apart.
func (h *Handler) ListCanvasWebhooks(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireWebhookOwner(w, r)
	if !ok {
		return
	}
	hooks, err := h.store.ListWebhooks(r.Context(), canvas.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"webhooks": hooks,
		// The vocabulary the UI renders as checkboxes. Served rather than
		// hard-coded in the web app so a 4th event type is one Go constant and
		// not a two-repo change with a window where they disagree.
		"knownEvents": store.KnownWebhookEvents,
		"maxWebhooks": maxWebhooksPerCanvas,
	})
}

// POST /api/canvases/{code}/webhooks — create a config.
// Body: { url, name?, description?, events?, enabled? }.
//
// THE SERVER GENERATES THE SECRET. There is deliberately no way for a caller to
// supply one: a client-chosen key is a client-chosen weak key, and accepting key
// material on a request body means it lands in every proxy log between here and
// the browser. The plaintext is returned exactly once, in this response, and
// then only its last four characters are ever readable again — same lifecycle as
// a personal access token (token_handler.go), for the same reasons.
func (h *Handler) CreateCanvasWebhook(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireWebhookOwner(w, r)
	if !ok {
		return
	}
	var body struct {
		URL         string   `json:"url"`
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Events      []string `json:"events"`
		Enabled     *bool    `json:"enabled"`
		// NOTE: no Secret field, on purpose. A client that posts one is not
		// rejected — it is ignored, which is the same outcome and one less way
		// to fail a form.
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}

	url, name, description, ok := validateWebhookFields(w, body.URL, body.Name, body.Description)
	if !ok {
		return
	}
	// An omitted filter means "everything", which is what someone wiring up a
	// receiver for the first time wants. An explicitly empty one is a mistake
	// (NormalizeWebhookEvents rejects it) — that's what `enabled` is for.
	events := body.Events
	if events == nil {
		events = store.KnownWebhookEvents
	}
	events, err := store.NormalizeWebhookEvents(events)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}

	// Cap check before the insert. This is a read-then-write and therefore
	// racy in principle: two simultaneous creates at n=4 both see room and both
	// land. That is fine and deliberately not worth a DB trigger — the failure
	// mode is 6 webhooks on a canvas belonging to one person who double-clicked,
	// not an unbounded fan-out.
	count, err := h.store.CountWebhooks(r.Context(), canvas.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if count >= maxWebhooksPerCanvas {
		writeError(w, http.StatusConflict,
			"this canvas already has the maximum of "+strconv.Itoa(maxWebhooksPerCanvas)+
				" webhooks — delete one before adding another")
		return
	}

	secret := store.GenerateWebhookSecret()
	created, err := h.store.CreateWebhook(r.Context(), canvas.ID, &store.Webhook{
		URL: url, Secret: secret, Events: events, Enabled: enabled,
		Name: name, Description: description, CreatedBy: "user",
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, webhookWithSecret{
		Webhook: created, Secret: secret, Note: secretShownOnceNote,
	})
}

// PATCH /api/canvases/{code}/webhooks/{id} — partial update of url / events /
// enabled / name / description.
//
// The body decodes straight into store.WebhookPatch, whose Secret field is
// `json:"-"`. That is not incidental: it means a caller CANNOT set a secret
// through this route even if the handler forgot to guard it, because encoding/json
// will not populate the field. Rotation is its own route, below, so that
// replacing key material is always an explicit act with a response the user has
// to acknowledge.
func (h *Handler) UpdateCanvasWebhook(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireWebhookOwner(w, r)
	if !ok {
		return
	}
	id, ok := parseWebhookID(w, r)
	if !ok {
		return
	}
	var patch store.WebhookPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	// Defence in depth against a future edit that drops the `json:"-"` tag.
	patch.Secret = nil

	if patch.URL != nil {
		url, _, _, ok := validateWebhookFields(w, *patch.URL, "", "")
		if !ok {
			return
		}
		patch.URL = &url
	}
	if patch.Name != nil {
		name := strings.TrimSpace(*patch.Name)
		if len(name) > maxWebhookNameLen {
			writeError(w, http.StatusBadRequest, "name is too long (max 80 characters)")
			return
		}
		patch.Name = &name
	}
	if patch.Description != nil {
		description := strings.TrimSpace(*patch.Description)
		if len(description) > maxWebhookDescriptionLen {
			writeError(w, http.StatusBadRequest, "description is too long (max 500 characters)")
			return
		}
		patch.Description = &description
	}
	// Events are normalized (deduped, sorted, membership-checked) inside the
	// store so the emit-path filter and the config agree; a typo comes back as a
	// 400 here rather than as a webhook that silently never fires.
	updated, err := h.store.UpdateWebhook(r.Context(), canvas.ID, id, patch)
	if err != nil {
		writeWebhookErr(w, err, "could not update webhook")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// POST /api/canvases/{code}/webhooks/{id}/rotate — mint a new signing secret.
//
// Separate from PATCH because rotation is destructive in a way a field edit
// isn't: the moment it returns, every delivery is signed with the new key and a
// receiver still holding the old one rejects all of them. Migration 0038 accepts
// that (no dual-secret window at this scale), which makes it all the more
// important that the act is explicit and the response is the only copy of the
// new key.
func (h *Handler) RotateCanvasWebhookSecret(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireWebhookOwner(w, r)
	if !ok {
		return
	}
	id, ok := parseWebhookID(w, r)
	if !ok {
		return
	}
	secret := store.GenerateWebhookSecret()
	updated, err := h.store.UpdateWebhook(r.Context(), canvas.ID, id, store.WebhookPatch{Secret: &secret})
	if err != nil {
		writeWebhookErr(w, err, "could not rotate webhook secret")
		return
	}
	writeJSON(w, http.StatusOK, webhookWithSecret{
		Webhook: updated, Secret: secret,
		Note: "Update your receiver with this secret now — it won't be shown again, " +
			"and deliveries are already being signed with it.",
	})
}

// DELETE /api/canvases/{code}/webhooks/{id}. The delivery log goes with it
// (webhook_deliveries FKs webhooks ON DELETE CASCADE), including any dead
// letters — deleting the config is the one way to clear them.
func (h *Handler) DeleteCanvasWebhook(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireWebhookOwner(w, r)
	if !ok {
		return
	}
	id, ok := parseWebhookID(w, r)
	if !ok {
		return
	}
	if err := h.store.DeleteWebhook(r.Context(), canvas.ID, id); err != nil {
		writeWebhookErr(w, err, "could not delete webhook")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// ── Deliveries ──────────────────────────────────────────────────────────────

// GET /api/canvases/{code}/webhooks/deliveries?status=&webhookId=&limit=
//
// Backs two lists in one endpoint: `?status=dead` is the dead-letter list, no
// status at all is the recent-activity list. Both are canvas-scoped reads
// straight off webhook_deliveries_canvas_idx.
//
// Deliveries carry no key material — but they DO carry the payload that was
// signed and, for a failed attempt, the receiver's response body. Both are
// things the canvas owner is entitled to see and nobody else is, which is why
// this sits behind the same owner gate as the config rather than being a
// read-for-any-member route.
func (h *Handler) ListCanvasWebhookDeliveries(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireWebhookOwner(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()

	status := strings.TrimSpace(q.Get("status"))
	switch status {
	case "", "pending", "delivering", "ok", "failed", "dead":
	default:
		writeError(w, http.StatusBadRequest,
			"status must be one of pending, delivering, ok, failed, dead (or omitted for all)")
		return
	}

	var webhookID *uuid.UUID
	if raw := strings.TrimSpace(q.Get("webhookId")); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid webhookId")
			return
		}
		webhookID = &id
	}

	limit := defaultDeliveryPageSize
	if raw := strings.TrimSpace(q.Get("limit")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		if n > maxDeliveryPageSize {
			n = maxDeliveryPageSize
		}
		limit = n
	}

	deliveries, err := h.store.ListWebhookDeliveries(r.Context(), canvas.ID, webhookID, status, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deliveries": deliveries})
}

// POST /api/canvases/{code}/webhooks/deliveries/{id}/retry — put one failed or
// dead-lettered delivery back on the queue.
//
// It does not send anything: the response means "re-queued", and the worker
// picks it up on its next poll. Doing the HTTP here would put a 5-second request
// to someone else's server inside a click handler, and would need the whole
// signing path duplicated outside the worker.
func (h *Handler) RetryCanvasWebhookDelivery(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireWebhookOwner(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid delivery id")
		return
	}
	delivery, err := h.store.RetryWebhookDelivery(r.Context(), canvas.ID, id)
	if err != nil {
		if errors.Is(err, store.ErrWebhookDeliveryNotRetryable) {
			writeError(w, http.StatusNotFound,
				"delivery not found on this canvas, or it isn't in a retryable state "+
					"(only failed and dead deliveries can be retried)")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"delivery": delivery})
}

// ── Shared bits ─────────────────────────────────────────────────────────────

func parseWebhookID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid webhook id")
		return uuid.Nil, false
	}
	return id, true
}

// validateWebhookFields trims and bounds the three free-text fields, and runs
// the URL through the same syntactic guard the delivery sender uses, so an
// unusable endpoint is a 400 on the form rather than a dead letter an hour
// later. It deliberately does NOT resolve DNS — see webhooks.ValidateTargetURL.
func validateWebhookFields(w http.ResponseWriter, rawURL, rawName, rawDescription string) (url, name, description string, ok bool) {
	url = strings.TrimSpace(rawURL)
	if url == "" {
		writeError(w, http.StatusBadRequest, "url is required")
		return "", "", "", false
	}
	if len(url) > maxWebhookURLLen {
		writeError(w, http.StatusBadRequest, "url is too long (max 2000 characters)")
		return "", "", "", false
	}
	if err := webhooks.ValidateTargetURL(url); err != nil {
		writeError(w, http.StatusBadRequest, "url must be an absolute http(s) URL with a host")
		return "", "", "", false
	}
	name = strings.TrimSpace(rawName)
	if len(name) > maxWebhookNameLen {
		writeError(w, http.StatusBadRequest, "name is too long (max 80 characters)")
		return "", "", "", false
	}
	description = strings.TrimSpace(rawDescription)
	if len(description) > maxWebhookDescriptionLen {
		writeError(w, http.StatusBadRequest, "description is too long (max 500 characters)")
		return "", "", "", false
	}
	return url, name, description, true
}

// writeWebhookErr maps store errors onto status codes. A bad event name comes
// back from NormalizeWebhookEvents inside the store, so it has to be recognised
// as a 400 rather than swallowed as a 500 — otherwise the single most likely
// user mistake reads as a server bug.
func writeWebhookErr(w http.ResponseWriter, err error, fallback string) {
	switch {
	case errors.Is(err, store.ErrWebhookNotFound):
		writeError(w, http.StatusNotFound, "webhook not found on this canvas")
	case strings.Contains(err.Error(), "unknown webhook event"),
		strings.Contains(err.Error(), "at least one event"):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, fallback+": "+err.Error())
	}
}
