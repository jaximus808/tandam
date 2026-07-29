package api

import (
	"bytes"
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
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// TDM-39 — webhook config + dead-letter UI, API half.
//
// The security-critical property here is not any single handler's behaviour: it
// is that NO agent-held credential reaches ANY of these routes. A webhook config
// names an endpoint and mints a signing secret, so an agent that could create
// one could redirect a canvas's whole task stream to a server it controls and
// sign it authentically. Migration 0038 forbids an MCP surface for this; these
// tests are what stops that rule from decaying into a comment.
//
// TestWebhookRoutesRejectEveryAgentCredential is therefore written to catch
// routes that DON'T EXIST YET: it walks the real router and applies the
// assertion to every registered path containing "webhook". Adding a webhook
// route outside the owner-only group fails it without anyone remembering to
// extend a list.

// ── Fake store ───────────────────────────────────────────────────────────────

// webhookFakeStore implements the slice of the store these handlers touch, and
// models the two behaviours the tests actually depend on: the canvas-scoping of
// every mutation, and the retry state machine.
type webhookFakeStore struct {
	store.Store
	mu sync.Mutex

	canvas *store.Canvas
	hooks  map[uuid.UUID]*store.Webhook
	// order preserves insertion order so list assertions are stable.
	order      []uuid.UUID
	deliveries map[uuid.UUID]*store.WebhookDelivery

	// patUsers / oauthUsers mirror the real token lookups so the agent-credential
	// tests exercise a LIVE token, not a rejected-because-unknown one. A test
	// that passes only because the token was garbage proves nothing.
	patUsers   map[string]uuid.UUID
	oauthUsers map[string]uuid.UUID
	role       string

	// lastPatch records what UpdateWebhook was handed — the only way to assert
	// that a client-supplied secret never became a patch.
	lastPatch *store.WebhookPatch
	// leakSecret makes ListWebhooks return rows WITH key material, simulating a
	// store-layer regression, so the API-layer leak test is meaningful.
	leakSecret bool
	// listErr / countErr force the error paths.
	countErr error
}

func (f *webhookFakeStore) GetCanvasByCode(_ context.Context, code string) (*store.Canvas, error) {
	if f.canvas != nil && f.canvas.Code == code {
		return f.canvas, nil
	}
	return nil, store.ErrCanvasNotFound
}

func (f *webhookFakeStore) ResolveCanvasRole(_ context.Context, _ *store.Canvas, _ *uuid.UUID) (string, error) {
	return f.role, nil
}

func (f *webhookFakeStore) UserIDByTokenHash(_ context.Context, hash string) (uuid.UUID, error) {
	if uid, ok := f.patUsers[hash]; ok {
		return uid, nil
	}
	return uuid.Nil, store.ErrInvalidToken
}

func (f *webhookFakeStore) OAuthUserByAccessHash(_ context.Context, hash string) (uuid.UUID, string, error) {
	if uid, ok := f.oauthUsers[hash]; ok {
		return uid, "claude-ai", nil
	}
	return uuid.Nil, "", store.ErrInvalidGrant
}

func (f *webhookFakeStore) HasLiveOAuthGrant(_ context.Context, _ uuid.UUID, _ string) (bool, error) {
	return true, nil
}

func (f *webhookFakeStore) CreateWebhook(_ context.Context, canvasID uuid.UUID, in *store.Webhook) (*store.Webhook, error) {
	events, err := store.NormalizeWebhookEvents(in.Events)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	w := *in
	w.ID = uuid.New()
	w.CanvasID = canvasID
	w.Events = events
	w.SecretLastFour = store.LastFour(in.Secret)
	w.CreatedAt = time.Now().UTC()
	w.UpdatedAt = w.CreatedAt
	stored := w
	f.hooks[w.ID] = &stored
	f.order = append(f.order, w.ID)
	// The real store scrubs key material off every write echo.
	out := w
	out.Secret = ""
	return &out, nil
}

func (f *webhookFakeStore) ListWebhooks(_ context.Context, canvasID uuid.UUID) ([]*store.Webhook, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []*store.Webhook{}
	for _, id := range f.order {
		w := f.hooks[id]
		if w == nil || w.CanvasID != canvasID {
			continue
		}
		copied := *w
		if !f.leakSecret {
			copied.Secret = ""
		}
		out = append(out, &copied)
	}
	return out, nil
}

func (f *webhookFakeStore) CountWebhooks(_ context.Context, canvasID uuid.UUID) (int, error) {
	if f.countErr != nil {
		return 0, f.countErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, w := range f.hooks {
		if w.CanvasID == canvasID {
			n++
		}
	}
	return n, nil
}

func (f *webhookFakeStore) GetWebhook(_ context.Context, canvasID, id uuid.UUID) (*store.Webhook, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w, ok := f.hooks[id]
	if !ok || w.CanvasID != canvasID {
		return nil, store.ErrWebhookNotFound
	}
	copied := *w
	copied.Secret = ""
	return &copied, nil
}

func (f *webhookFakeStore) UpdateWebhook(_ context.Context, canvasID, id uuid.UUID, patch store.WebhookPatch) (*store.Webhook, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastPatch = &patch
	w, ok := f.hooks[id]
	if !ok || w.CanvasID != canvasID {
		return nil, store.ErrWebhookNotFound
	}
	if patch.URL != nil {
		w.URL = *patch.URL
	}
	if patch.Secret != nil {
		w.Secret = *patch.Secret
		w.SecretLastFour = store.LastFour(*patch.Secret)
	}
	if patch.Events != nil {
		events, err := store.NormalizeWebhookEvents(*patch.Events)
		if err != nil {
			return nil, err
		}
		w.Events = events
	}
	if patch.Enabled != nil {
		w.Enabled = *patch.Enabled
	}
	if patch.Name != nil {
		w.Name = *patch.Name
	}
	if patch.Description != nil {
		w.Description = *patch.Description
	}
	w.UpdatedAt = time.Now().UTC()
	out := *w
	out.Secret = ""
	return &out, nil
}

func (f *webhookFakeStore) DeleteWebhook(_ context.Context, canvasID, id uuid.UUID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	w, ok := f.hooks[id]
	if !ok || w.CanvasID != canvasID {
		return store.ErrWebhookNotFound
	}
	delete(f.hooks, id)
	return nil
}

func (f *webhookFakeStore) ListWebhookDeliveries(_ context.Context, canvasID uuid.UUID, webhookID *uuid.UUID, status string, limit int) ([]*store.WebhookDelivery, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []*store.WebhookDelivery{}
	for _, d := range f.deliveries {
		if d.CanvasID != canvasID {
			continue
		}
		if webhookID != nil && d.WebhookID != *webhookID {
			continue
		}
		if status != "" && d.Status != status {
			continue
		}
		if len(out) >= limit {
			break
		}
		copied := *d
		out = append(out, &copied)
	}
	return out, nil
}

func (f *webhookFakeStore) RetryWebhookDelivery(_ context.Context, canvasID, id uuid.UUID) (*store.WebhookDelivery, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, ok := f.deliveries[id]
	if !ok || d.CanvasID != canvasID {
		return nil, store.ErrWebhookDeliveryNotRetryable
	}
	// Mirrors the conditional PATCH in the real store: only failed/dead match.
	if d.Status != "failed" && d.Status != "dead" {
		return nil, store.ErrWebhookDeliveryNotRetryable
	}
	d.Status = "pending"
	d.AttemptCount = 0
	d.NextAttemptAt = time.Now().UTC()
	d.Error = ""
	d.ResponseStatus = nil
	d.ResponseBody = ""
	copied := *d
	return &copied, nil
}

func (f *webhookFakeStore) storedHook(id uuid.UUID) *store.Webhook {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hooks[id]
}

func (f *webhookFakeStore) hookCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.hooks)
}

// ── Harness ──────────────────────────────────────────────────────────────────

const webhookCanvasCode = "WBHKTEST"

// webhookHarness builds the REAL router over the fake store. Everything here
// goes through the actual middleware chain — RequireUser included — because the
// middleware IS the feature under test.
type webhookHarness struct {
	r       http.Handler
	mux     *chi.Mux
	fake    *webhookFakeStore
	authSvc *auth.Service
	// ownerCookie is a session for the canvas owner; strangerCookie is a session
	// for a signed-in user who does not own it.
	ownerCookie    string
	strangerCookie string
	canvasID       uuid.UUID
}

func newWebhookHarness(t *testing.T) *webhookHarness {
	t.Helper()
	canvasID := uuid.New()
	ownerID := uuid.New()
	fake := &webhookFakeStore{
		canvas: &store.Canvas{
			ID: canvasID, Code: webhookCanvasCode,
			Visibility: "public", PublicRole: "write",
			OwnerUserID: &ownerID,
		},
		hooks:      map[uuid.UUID]*store.Webhook{},
		deliveries: map[uuid.UUID]*store.WebhookDelivery{},
		patUsers:   map[string]uuid.UUID{},
		oauthUsers: map[string]uuid.UUID{},
		role:       "write",
	}
	authSvc := auth.NewService("test-secret-for-tdm-39", time.Hour)
	r := NewRouter(fake, nil, authSvc, nil, false, nil, "", t.TempDir(), "", false, nil)
	mux, ok := r.(*chi.Mux)
	if !ok {
		t.Fatalf("NewRouter no longer returns a *chi.Mux; the route-walk test needs updating")
	}
	owner, err := authSvc.IssueSession(ownerID, time.Hour)
	if err != nil {
		t.Fatalf("issue owner session: %v", err)
	}
	stranger, err := authSvc.IssueSession(uuid.New(), time.Hour)
	if err != nil {
		t.Fatalf("issue stranger session: %v", err)
	}
	return &webhookHarness{
		r: r, mux: mux, fake: fake, authSvc: authSvc,
		ownerCookie: owner, strangerCookie: stranger, canvasID: canvasID,
	}
}

func webhookURL(suffix string) string {
	return "/api/canvases/" + webhookCanvasCode + "/webhooks" + suffix
}

// do issues a request with an optional session cookie and/or bearer token.
func (h *webhookHarness) do(t *testing.T, method, url, cookie, bearer string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, url, reader)
	req.Header.Set("Content-Type", "application/json")
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: cookie})
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	h.r.ServeHTTP(w, req)
	return w
}

// owner issues a request as the signed-in canvas owner — the only caller these
// routes accept.
func (h *webhookHarness) owner(t *testing.T, method, url string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return h.do(t, method, url, h.ownerCookie, "", body)
}

func decodeBody(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON (%d): %s", w.Code, w.Body)
	}
	return out
}

// createHook is the happy-path create used as a fixture by the other tests.
func (h *webhookHarness) createHook(t *testing.T, url, name string) (id uuid.UUID, secret string) {
	t.Helper()
	w := h.owner(t, "POST", webhookURL(""), map[string]any{"url": url, "name": name})
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201: %s", w.Code, w.Body)
	}
	body := decodeBody(t, w)
	secret, _ = body["secret"].(string)
	parsed, err := uuid.Parse(fmt.Sprint(body["id"]))
	if err != nil {
		t.Fatalf("create response has no usable id: %s", w.Body)
	}
	return parsed, secret
}

// ── THE assertion: no agent credential reaches any webhook route ─────────────

// agentCredential is a credential an agent can actually obtain in this system.
// Every one of them must bounce off every webhook route.
type agentCredential struct {
	name string
	// bearer is resolved per-harness because a canvas JWT has to be minted
	// against that harness's canvas id.
	bearer func(h *webhookHarness, t *testing.T) string
	// wantCode is 401 for all of these: RequireUser answers before any handler
	// runs, and it only ever speaks 401.
	wantCode int
}

func agentCredentials() []agentCredential {
	return []agentCredential{
		{
			name: "no credential at all",
			bearer: func(*webhookHarness, *testing.T) string {
				return ""
			},
			wantCode: http.StatusUnauthorized,
		},
		{
			// The credential every MCP client holds: a canvas JWT with FULL
			// WRITE ROLE, minted by POST /api/mcp/auth. It authorizes every
			// mutation on the board. It must not authorize this.
			name: "canvas JWT with write role (what an MCP agent holds)",
			bearer: func(h *webhookHarness, t *testing.T) string {
				tok, err := h.authSvc.Issue(h.canvasID, "write", nil)
				if err != nil {
					t.Fatalf("issue canvas token: %v", err)
				}
				return tok
			},
			wantCode: http.StatusUnauthorized,
		},
		{
			// A LIVE personal access token belonging to the canvas OWNER. This
			// is the sharpest case: same human, same account, full access — but
			// presented as a bearer, which is how the stdio gateway forwards it.
			// If webhook config accepted a PAT, an agent configured with the
			// user's TANDEM_TOKEN could create webhooks as them.
			name: "live PAT owned by the canvas owner",
			bearer: func(h *webhookHarness, t *testing.T) string {
				pat := store.PATPrefix + "deadbeefdeadbeefdeadbeef"
				h.fake.patUsers[store.HashToken(pat)] = *h.fake.canvas.OwnerUserID
				return pat
			},
			wantCode: http.StatusUnauthorized,
		},
		{
			// The hosted claude.ai connector's credential, also owned by the
			// canvas owner. Same argument as the PAT.
			name: "live OAuth access token owned by the canvas owner",
			bearer: func(h *webhookHarness, t *testing.T) string {
				oat := store.OAuthAccessPrefix + "deadbeefdeadbeefdeadbeef"
				h.fake.oauthUsers[store.HashToken(oat)] = *h.fake.canvas.OwnerUserID
				return oat
			},
			wantCode: http.StatusUnauthorized,
		},
		{
			name: "garbage bearer",
			bearer: func(*webhookHarness, *testing.T) string {
				return "not-a-token-at-all"
			},
			wantCode: http.StatusUnauthorized,
		},
	}
}

// webhookRoutes walks the REAL router and returns every registered (method,
// path) whose pattern mentions webhooks, with the path params filled in.
//
// Walking rather than listing is the point: a future route added outside the
// owner-only group is picked up automatically. A hand-maintained list is exactly
// the artefact that goes stale the one time it matters.
func (h *webhookHarness) webhookRoutes(t *testing.T) []struct{ Method, Path string } {
	t.Helper()
	var out []struct{ Method, Path string }
	err := chi.Walk(h.mux, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !strings.Contains(strings.ToLower(route), "webhook") {
			return nil
		}
		path := strings.ReplaceAll(route, "{code}", webhookCanvasCode)
		path = strings.ReplaceAll(path, "{id}", uuid.New().String())
		path = strings.TrimSuffix(path, "/")
		out = append(out, struct{ Method, Path string }{method, path})
		return nil
	})
	if err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	return out
}

// The security assertion, applied to every webhook route the router knows about
// and every credential an agent can hold.
func TestWebhookRoutesRejectEveryAgentCredential(t *testing.T) {
	probe := newWebhookHarness(t)
	routes := probe.webhookRoutes(t)
	if len(routes) < 7 {
		t.Fatalf("found %d webhook routes, expected at least 7 — did the route walk break?", len(routes))
	}

	for _, cred := range agentCredentials() {
		for _, route := range routes {
			t.Run(cred.name+" "+route.Method+" "+route.Path, func(t *testing.T) {
				h := newWebhookHarness(t)
				// Pre-seed a config so a "successful" call would have something
				// real to mutate — a 404-shaped pass would be a false negative.
				h.createHook(t, "https://example.com/hook", "seed")
				before := h.fake.hookCount()

				bearer := cred.bearer(h, t)
				w := h.do(t, route.Method, route.Path, "", bearer,
					map[string]any{"url": "https://attacker.example/steal", "enabled": true})

				if w.Code != cred.wantCode {
					t.Fatalf("%s %s with %s = %d, want %d: %s",
						route.Method, route.Path, cred.name, w.Code, cred.wantCode, w.Body)
				}
				if got := h.fake.hookCount(); got != before {
					t.Fatalf("%s reached the store: webhook count %d -> %d", cred.name, before, got)
				}
			})
		}
	}
}

// A signed-in user who is NOT the owner gets 403 — the second half of the gate.
// RequireUser lets them in (they have a real session); requireWebhookOwner is
// what stops them.
func TestWebhookRoutesRejectNonOwnerSession(t *testing.T) {
	probe := newWebhookHarness(t)
	for _, route := range probe.webhookRoutes(t) {
		t.Run(route.Method+" "+route.Path, func(t *testing.T) {
			h := newWebhookHarness(t)
			h.createHook(t, "https://example.com/hook", "seed")
			before := h.fake.hookCount()

			w := h.do(t, route.Method, route.Path, h.strangerCookie, "",
				map[string]any{"url": "https://attacker.example/steal"})
			if w.Code != http.StatusForbidden {
				t.Fatalf("%s %s as a non-owner = %d, want 403: %s",
					route.Method, route.Path, w.Code, w.Body)
			}
			if got := h.fake.hookCount(); got != before {
				t.Fatalf("a non-owner reached the store: webhook count %d -> %d", before, got)
			}
		})
	}
}

// An unowned (anonymous) canvas has no owner, so nobody can configure webhooks
// on it. Worth pinning because `canvas.OwnerUserID == nil` compared against a
// real uid is the kind of thing a refactor turns into "nil means anyone".
func TestWebhookRoutesRejectUnownedCanvas(t *testing.T) {
	h := newWebhookHarness(t)
	h.fake.canvas.OwnerUserID = nil

	w := h.owner(t, "GET", webhookURL(""), nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("list on an unowned canvas = %d, want 403: %s", w.Code, w.Body)
	}
}

// ── Secret lifecycle ─────────────────────────────────────────────────────────

// The server mints the secret, returns it exactly once, and never again.
func TestCreateWebhookReturnsServerGeneratedSecretOnce(t *testing.T) {
	h := newWebhookHarness(t)

	w := h.owner(t, "POST", webhookURL(""), map[string]any{
		"url": "https://hooks.example.com/tandem", "name": "CI",
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201: %s", w.Code, w.Body)
	}
	body := decodeBody(t, w)

	secret, _ := body["secret"].(string)
	if secret == "" {
		t.Fatal("create response has no secret — the user has nothing to paste into their receiver")
	}
	if !strings.HasPrefix(secret, store.WebhookSecretPrefix) {
		t.Errorf("secret = %q, want the %q prefix", secret, store.WebhookSecretPrefix)
	}
	// 32 random bytes as hex, plus the prefix.
	if len(secret) != len(store.WebhookSecretPrefix)+64 {
		t.Errorf("secret length = %d, want %d — entropy shrank", len(secret), len(store.WebhookSecretPrefix)+64)
	}
	if note, _ := body["_note"].(string); !strings.Contains(note, "won't be shown again") {
		t.Errorf("_note = %q, want the shown-once warning", note)
	}

	id, _ := uuid.Parse(fmt.Sprint(body["id"]))
	if stored := h.fake.storedHook(id); stored == nil || stored.Secret != secret {
		t.Fatal("the secret returned to the user is not the secret that was stored — signatures would never verify")
	}

	// And it is gone from every subsequent read.
	lw := h.owner(t, "GET", webhookURL(""), nil)
	if lw.Code != http.StatusOK {
		t.Fatalf("list = %d: %s", lw.Code, lw.Body)
	}
	if strings.Contains(lw.Body.String(), secret) {
		t.Fatalf("the list response contains the plaintext secret: %s", lw.Body)
	}
	if !strings.Contains(lw.Body.String(), `"secretLastFour"`) {
		t.Errorf("list response has no secretLastFour — the UI can't tell two configs apart: %s", lw.Body)
	}
}

// Two creates must not produce the same key.
func TestCreateWebhookSecretsAreUnique(t *testing.T) {
	h := newWebhookHarness(t)
	_, a := h.createHook(t, "https://example.com/a", "a")
	_, b := h.createHook(t, "https://example.com/b", "b")
	if a == b {
		t.Fatal("two webhooks were minted the same secret")
	}
}

// A client-supplied secret is ignored, not honoured. The server-generated key is
// what gets stored, so a caller cannot pin a webhook to a key it chose.
func TestCreateWebhookIgnoresClientSuppliedSecret(t *testing.T) {
	h := newWebhookHarness(t)
	const planted = "whsec_attacker_chosen_key"

	w := h.owner(t, "POST", webhookURL(""), map[string]any{
		"url": "https://hooks.example.com/tandem", "secret": planted,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201: %s", w.Code, w.Body)
	}
	body := decodeBody(t, w)
	if got, _ := body["secret"].(string); got == planted {
		t.Fatal("the server echoed the client's secret back — it was accepted")
	}
	id, _ := uuid.Parse(fmt.Sprint(body["id"]))
	if stored := h.fake.storedHook(id); stored.Secret == planted {
		t.Fatal("the client's chosen secret was stored")
	}
}

// PATCH cannot rotate. store.WebhookPatch.Secret is `json:"-"`, and the handler
// nils it besides; both belts are asserted through the wire.
func TestUpdateWebhookCannotSetSecret(t *testing.T) {
	h := newWebhookHarness(t)
	id, original := h.createHook(t, "https://example.com/hook", "hook")

	w := h.owner(t, "PATCH", webhookURL("/"+id.String()), map[string]any{
		"secret": "whsec_attacker_chosen_key",
		"name":   "renamed",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("patch = %d, want 200: %s", w.Code, w.Body)
	}
	if h.fake.lastPatch == nil || h.fake.lastPatch.Secret != nil {
		t.Fatal("a client-supplied secret reached the store as a patch field")
	}
	if stored := h.fake.storedHook(id); stored.Secret != original {
		t.Fatalf("the secret changed through PATCH: %q -> %q", original, stored.Secret)
	}
	if stored := h.fake.storedHook(id); stored.Name != "renamed" {
		t.Errorf("name = %q, want renamed — the rest of the patch should still apply", stored.Name)
	}
}

// Rotation replaces the key, returns the new one once, and the old one stops
// being anywhere.
func TestRotateWebhookSecretReturnsNewSecretOnce(t *testing.T) {
	h := newWebhookHarness(t)
	id, original := h.createHook(t, "https://example.com/hook", "hook")

	w := h.owner(t, "POST", webhookURL("/"+id.String()+"/rotate"), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("rotate = %d, want 200: %s", w.Code, w.Body)
	}
	body := decodeBody(t, w)
	rotated, _ := body["secret"].(string)
	if rotated == "" {
		t.Fatal("rotate returned no secret")
	}
	if rotated == original {
		t.Fatal("rotate returned the SAME secret — nothing was rotated")
	}
	if !strings.HasPrefix(rotated, store.WebhookSecretPrefix) {
		t.Errorf("rotated secret = %q, want the %q prefix", rotated, store.WebhookSecretPrefix)
	}
	if stored := h.fake.storedHook(id); stored.Secret != rotated {
		t.Fatal("the rotated secret shown to the user is not the one stored")
	}

	// Once. A second read never shows it again.
	lw := h.owner(t, "GET", webhookURL(""), nil)
	if strings.Contains(lw.Body.String(), rotated) {
		t.Fatalf("the list response contains the rotated secret: %s", lw.Body)
	}
	if strings.Contains(lw.Body.String(), original) {
		t.Fatalf("the list response contains the OLD secret: %s", lw.Body)
	}
}

// Rotating a webhook that doesn't exist on this canvas is a 404, not a
// silently-created config.
func TestRotateUnknownWebhookIs404(t *testing.T) {
	h := newWebhookHarness(t)
	w := h.owner(t, "POST", webhookURL("/"+uuid.New().String()+"/rotate"), nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("rotate unknown = %d, want 404: %s", w.Code, w.Body)
	}
}

// Even if the store layer regressed and started handing back key material, the
// API must not serialize it. store.Webhook.Secret is `json:"-"`; this proves the
// tag is load-bearing rather than decorative.
func TestListWebhooksNeverSerializesSecretEvenIfTheStoreLeaksIt(t *testing.T) {
	h := newWebhookHarness(t)
	_, secret := h.createHook(t, "https://example.com/hook", "hook")
	h.fake.leakSecret = true // simulate a store-layer regression

	w := h.owner(t, "GET", webhookURL(""), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d: %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), secret) {
		t.Fatalf("plaintext secret serialized into the list response: %s", w.Body)
	}
	if strings.Contains(w.Body.String(), `"secret"`) {
		t.Fatalf("a `secret` key appeared in the list response: %s", w.Body)
	}
}

// ── Cap ──────────────────────────────────────────────────────────────────────

func TestCreateWebhookEnforcesPerCanvasCap(t *testing.T) {
	h := newWebhookHarness(t)
	for i := 0; i < maxWebhooksPerCanvas; i++ {
		h.createHook(t, fmt.Sprintf("https://example.com/hook-%d", i), fmt.Sprintf("hook %d", i))
	}
	if got := h.fake.hookCount(); got != maxWebhooksPerCanvas {
		t.Fatalf("seeded %d webhooks, want %d", got, maxWebhooksPerCanvas)
	}

	w := h.owner(t, "POST", webhookURL(""), map[string]any{"url": "https://example.com/one-too-many"})
	if w.Code != http.StatusConflict {
		t.Fatalf("create past the cap = %d, want 409: %s", w.Code, w.Body)
	}
	if msg, _ := decodeBody(t, w)["error"].(string); !strings.Contains(msg, "maximum") {
		t.Errorf("error = %q, want it to explain the cap", msg)
	}
	if got := h.fake.hookCount(); got != maxWebhooksPerCanvas {
		t.Fatalf("the rejected create still landed: count = %d", got)
	}

	// Deleting one makes room again — the cap is a limit, not a lifetime quota.
	var victim uuid.UUID
	for id := range h.fake.hooks {
		victim = id
		break
	}
	if dw := h.owner(t, "DELETE", webhookURL("/"+victim.String()), nil); dw.Code != http.StatusOK {
		t.Fatalf("delete = %d, want 200: %s", dw.Code, dw.Body)
	}
	if aw := h.owner(t, "POST", webhookURL(""), map[string]any{"url": "https://example.com/room-again"}); aw.Code != http.StatusCreated {
		t.Fatalf("create after delete = %d, want 201: %s", aw.Code, aw.Body)
	}
}

// ── Validation ───────────────────────────────────────────────────────────────

func TestCreateWebhookValidation(t *testing.T) {
	tests := []struct {
		name string
		body map[string]any
		want int
	}{
		{"missing url", map[string]any{"name": "x"}, http.StatusBadRequest},
		{"blank url", map[string]any{"url": "   "}, http.StatusBadRequest},
		{"relative url", map[string]any{"url": "/hooks/tandem"}, http.StatusBadRequest},
		{"non-http scheme", map[string]any{"url": "file:///etc/passwd"}, http.StatusBadRequest},
		{"no host", map[string]any{"url": "https://"}, http.StatusBadRequest},
		{"unknown event", map[string]any{
			"url": "https://example.com/h", "events": []string{"task.approved", "task.exploded"},
		}, http.StatusBadRequest},
		{"empty event list", map[string]any{
			"url": "https://example.com/h", "events": []string{},
		}, http.StatusBadRequest},
		{"name too long", map[string]any{
			"url": "https://example.com/h", "name": strings.Repeat("a", maxWebhookNameLen+1),
		}, http.StatusBadRequest},
		{"description too long", map[string]any{
			"url": "https://example.com/h", "description": strings.Repeat("a", maxWebhookDescriptionLen+1),
		}, http.StatusBadRequest},
		{"http is allowed (localhost receivers in dev)", map[string]any{
			"url": "http://example.com/h",
		}, http.StatusCreated},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newWebhookHarness(t)
			w := h.owner(t, "POST", webhookURL(""), tc.body)
			if w.Code != tc.want {
				t.Fatalf("create = %d, want %d: %s", w.Code, tc.want, w.Body)
			}
		})
	}
}

// An omitted event filter subscribes to everything — the sane default for
// someone wiring up a receiver for the first time — and it comes back sorted and
// deduped, matching what the emit-path containment predicate will look for.
func TestCreateWebhookDefaultsAndNormalizesEvents(t *testing.T) {
	h := newWebhookHarness(t)

	id, _ := h.createHook(t, "https://example.com/hook", "all events")
	stored := h.fake.storedHook(id)
	if len(stored.Events) != len(store.KnownWebhookEvents) {
		t.Fatalf("default events = %v, want all of %v", stored.Events, store.KnownWebhookEvents)
	}

	w := h.owner(t, "POST", webhookURL(""), map[string]any{
		"url":    "https://example.com/dupes",
		"events": []string{"task.completed", "task.approved", "task.completed"},
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", w.Code, w.Body)
	}
	id2, _ := uuid.Parse(fmt.Sprint(decodeBody(t, w)["id"]))
	got := h.fake.storedHook(id2).Events
	if len(got) != 2 || got[0] != "task.approved" || got[1] != "task.completed" {
		t.Fatalf("events = %v, want deduped + sorted [task.approved task.completed]", got)
	}
}

func TestUpdateWebhookValidation(t *testing.T) {
	h := newWebhookHarness(t)
	id, _ := h.createHook(t, "https://example.com/hook", "hook")
	path := webhookURL("/" + id.String())

	if w := h.owner(t, "PATCH", path, map[string]any{"url": "ftp://example.com"}); w.Code != http.StatusBadRequest {
		t.Errorf("patch with a bad url = %d, want 400: %s", w.Code, w.Body)
	}
	if w := h.owner(t, "PATCH", path, map[string]any{"events": []string{"task.exploded"}}); w.Code != http.StatusBadRequest {
		t.Errorf("patch with an unknown event = %d, want 400: %s", w.Code, w.Body)
	}
	if w := h.owner(t, "PATCH", path, map[string]any{"events": []string{}}); w.Code != http.StatusBadRequest {
		t.Errorf("patch with an empty event list = %d, want 400: %s", w.Code, w.Body)
	}
	// The toggle the list row exposes.
	if w := h.owner(t, "PATCH", path, map[string]any{"enabled": false}); w.Code != http.StatusOK {
		t.Fatalf("patch enabled=false = %d, want 200: %s", w.Code, w.Body)
	}
	if h.fake.storedHook(id).Enabled {
		t.Error("enabled=false did not stick")
	}
	if w := h.owner(t, "PATCH", webhookURL("/"+uuid.New().String()), map[string]any{"enabled": false}); w.Code != http.StatusNotFound {
		t.Errorf("patch unknown webhook = %d, want 404: %s", w.Code, w.Body)
	}
}

func TestDeleteUnknownWebhookIs404(t *testing.T) {
	h := newWebhookHarness(t)
	w := h.owner(t, "DELETE", webhookURL("/"+uuid.New().String()), nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("delete unknown = %d, want 404: %s", w.Code, w.Body)
	}
}

// ── Deliveries + dead-letter retry ───────────────────────────────────────────

func (h *webhookHarness) seedDelivery(webhookID uuid.UUID, status string, attempts int) *store.WebhookDelivery {
	code := 502
	d := &store.WebhookDelivery{
		ID: uuid.New(), WebhookID: webhookID, CanvasID: h.canvasID,
		EventID: uuid.New(), EventType: "task.completed",
		Payload: json.RawMessage(`{"task":{"id":"x"}}`),
		Status:  status, AttemptCount: attempts,
		ResponseStatus: &code, Error: "receiver said no",
		CreatedAt: time.Now().UTC(),
	}
	h.fake.deliveries[d.ID] = d
	return d
}

func TestListDeliveriesFiltersByStatus(t *testing.T) {
	h := newWebhookHarness(t)
	id, _ := h.createHook(t, "https://example.com/hook", "hook")
	dead := h.seedDelivery(id, "dead", 5)
	h.seedDelivery(id, "ok", 1)

	w := h.owner(t, "GET", webhookURL("/deliveries?status=dead"), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("deliveries = %d: %s", w.Code, w.Body)
	}
	var got struct {
		Deliveries []store.WebhookDelivery `json:"deliveries"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v — %s", err, w.Body)
	}
	if len(got.Deliveries) != 1 || got.Deliveries[0].ID != dead.ID {
		t.Fatalf("dead-letter list = %+v, want just the dead one", got.Deliveries)
	}
	// The columns the dead-letter row renders.
	if got.Deliveries[0].EventType == "" || got.Deliveries[0].AttemptCount == 0 || got.Deliveries[0].Error == "" {
		t.Errorf("dead letter is missing render data: %+v", got.Deliveries[0])
	}

	// No status = everything.
	all := h.owner(t, "GET", webhookURL("/deliveries"), nil)
	if err := json.Unmarshal(all.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Deliveries) != 2 {
		t.Fatalf("unfiltered list = %d rows, want 2", len(got.Deliveries))
	}
}

func TestListDeliveriesRejectsBadQuery(t *testing.T) {
	h := newWebhookHarness(t)
	for _, q := range []string{"?status=exploded", "?webhookId=not-a-uuid", "?limit=0", "?limit=abc"} {
		if w := h.owner(t, "GET", webhookURL("/deliveries"+q), nil); w.Code != http.StatusBadRequest {
			t.Errorf("deliveries%s = %d, want 400: %s", q, w.Code, w.Body)
		}
	}
}

// Retry re-queues in place: same delivery id (so a receiver that already applied
// it still dedupes), status back to pending, due now, fresh attempt budget, and
// the stale failure cleared.
func TestRetryDeadDeliveryRequeuesIt(t *testing.T) {
	h := newWebhookHarness(t)
	id, _ := h.createHook(t, "https://example.com/hook", "hook")
	dead := h.seedDelivery(id, "dead", 5)
	before := time.Now().UTC()

	w := h.owner(t, "POST", webhookURL("/deliveries/"+dead.ID.String()+"/retry"), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("retry = %d, want 200: %s", w.Code, w.Body)
	}
	var got struct {
		Delivery store.WebhookDelivery `json:"delivery"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v — %s", err, w.Body)
	}
	if got.Delivery.ID != dead.ID {
		t.Fatalf("retry minted a NEW delivery id (%s, was %s) — receivers lose their dedupe key",
			got.Delivery.ID, dead.ID)
	}
	if got.Delivery.Status != "pending" {
		t.Errorf("status = %q, want pending", got.Delivery.Status)
	}
	if got.Delivery.AttemptCount != 0 {
		t.Errorf("attemptCount = %d, want 0 — a retry with a spent budget dies on the first failure", got.Delivery.AttemptCount)
	}
	if got.Delivery.NextAttemptAt.Before(before.Add(-time.Second)) {
		t.Errorf("nextAttemptAt = %s, want ~now", got.Delivery.NextAttemptAt)
	}
	if got.Delivery.Error != "" || got.Delivery.ResponseStatus != nil {
		t.Errorf("the previous attempt's failure survived the re-queue: %+v", got.Delivery)
	}
	// And it has left the dead-letter list.
	lw := h.owner(t, "GET", webhookURL("/deliveries?status=dead"), nil)
	if strings.Contains(lw.Body.String(), dead.ID.String()) {
		t.Errorf("the retried delivery is still in the dead-letter list: %s", lw.Body)
	}
}

// Only failed/dead are retryable. Re-queueing a succeeded delivery would send a
// duplicate notification nobody asked for; re-queueing an in-flight one races
// the worker holding its lease.
func TestRetryNonRetryableDeliveryIs404(t *testing.T) {
	h := newWebhookHarness(t)
	id, _ := h.createHook(t, "https://example.com/hook", "hook")

	for _, status := range []string{"ok", "pending", "delivering"} {
		d := h.seedDelivery(id, status, 1)
		w := h.owner(t, "POST", webhookURL("/deliveries/"+d.ID.String()+"/retry"), nil)
		if w.Code != http.StatusNotFound {
			t.Errorf("retry of a %q delivery = %d, want 404: %s", status, w.Code, w.Body)
		}
		if h.fake.deliveries[d.ID].Status != status {
			t.Errorf("a %q delivery was mutated by a rejected retry", status)
		}
	}

	w := h.owner(t, "POST", webhookURL("/deliveries/"+uuid.New().String()+"/retry"), nil)
	if w.Code != http.StatusNotFound {
		t.Errorf("retry of an unknown delivery = %d, want 404: %s", w.Code, w.Body)
	}
	if w := h.owner(t, "POST", webhookURL("/deliveries/not-a-uuid/retry"), nil); w.Code != http.StatusBadRequest {
		t.Errorf("retry with a malformed id = %d, want 400: %s", w.Code, w.Body)
	}
}

// A delivery belonging to ANOTHER canvas must not be retryable from this one,
// even by a legitimate owner. The store scopes by canvas_id; this pins that the
// handler actually passes the canvas through.
func TestRetryIsCanvasScoped(t *testing.T) {
	h := newWebhookHarness(t)
	id, _ := h.createHook(t, "https://example.com/hook", "hook")
	foreign := h.seedDelivery(id, "dead", 5)
	foreign.CanvasID = uuid.New() // same row, different canvas

	w := h.owner(t, "POST", webhookURL("/deliveries/"+foreign.ID.String()+"/retry"), nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("cross-canvas retry = %d, want 404: %s", w.Code, w.Body)
	}
	if h.fake.deliveries[foreign.ID].Status != "dead" {
		t.Fatal("a delivery on another canvas was re-queued")
	}
}

// ── Routing ──────────────────────────────────────────────────────────────────

// /webhooks/deliveries is registered next to /webhooks/{id}. chi prefers static
// segments, but that is a property worth pinning: a regression here sends the
// delivery list into UpdateCanvasWebhook with id="deliveries" (a 400) or worse.
func TestWebhookDeliveriesRouteDoesNotShadowConfigRoutes(t *testing.T) {
	h := newWebhookHarness(t)
	id, _ := h.createHook(t, "https://example.com/hook", "hook")

	// The literal path resolves to the delivery list, not to a config read.
	w := h.owner(t, "GET", webhookURL("/deliveries"), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /webhooks/deliveries = %d, want 200: %s", w.Code, w.Body)
	}
	if _, ok := decodeBody(t, w)["deliveries"]; !ok {
		t.Fatalf("GET /webhooks/deliveries returned a non-delivery body: %s", w.Body)
	}
	// And the {id} route still works alongside it.
	if pw := h.owner(t, "PATCH", webhookURL("/"+id.String()), map[string]any{"enabled": false}); pw.Code != http.StatusOK {
		t.Fatalf("PATCH /webhooks/{id} = %d, want 200: %s", pw.Code, pw.Body)
	}
}

// Webhook config lives on /api/canvases/*, NOT /api/canvas/* — the latter is the
// canvas-JWT surface every MCP tool call goes through. This pins the separation
// at the routing layer: no webhook path may be registered under the JWT prefix.
func TestNoWebhookRouteUnderTheCanvasJWTPrefix(t *testing.T) {
	h := newWebhookHarness(t)
	err := chi.Walk(h.mux, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		lower := strings.ToLower(route)
		if strings.Contains(lower, "webhook") && strings.HasPrefix(route, "/api/canvas/") {
			t.Errorf("%s %s is a webhook route on the canvas-JWT prefix — an MCP agent could reach it", method, route)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}
