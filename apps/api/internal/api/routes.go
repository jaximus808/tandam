package api

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/maps"
	"github.com/agentcanvas/api/internal/metrics"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/webhooks"
	"github.com/agentcanvas/api/internal/ws"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
)

// NewRouter builds the whole HTTP surface. emitter is the outbound-webhook
// emitter (TDM-37) and is OPTIONAL — pass nil when webhooks are disabled and
// every task-lifecycle emit becomes a no-op. It is threaded as a nilable
// *webhooks.Emitter rather than the TaskEventEmitter interface precisely so a nil
// here stays a nil: a typed-nil pointer boxed into an interface would be
// non-nil and panic on first emit.
func NewRouter(s store.Store, hub *ws.Hub, authSvc *auth.Service, googleVerifier *auth.GoogleVerifier, cookieSecure bool, mapsReg *maps.Registry, webDistPath string, imageDir string, publicBaseURL string, metricsEnabled bool, emitter *webhooks.Emitter) http.Handler {
	r := chi.NewRouter()

	metricsReg := metrics.NewRegistry()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(metricsReg.Middleware) // per-route latency, keyed by chi RoutePattern
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: false,
	}))

	var hOpts []HandlerOption
	if emitter != nil {
		hOpts = append(hOpts, WithTaskEvents(emitter))
	}
	h := NewHandler(s, hub, mapsReg, hOpts...)
	wsH := NewWSHandler(s, hub, authSvc, mapsReg)
	mapsH := NewMapsHandler(mapsReg)
	authH := NewAuthHandler(s, authSvc, googleVerifier, cookieSecure)
	oauthH := NewOAuthHandler(s, publicBaseURL)

	// ── Public ─────────────────────────────────────────────────────────────────
	// OptionalUser: a logged-in create (cookie) or PAT-bearing agent gets owned;
	// a truly anonymous create doesn't.
	r.With(OptionalUser(authSvc, s)).Post("/api/canvases", h.CreateCanvas)
	r.Get("/api/canvases/{code}", h.GetCanvasByCode)
	// OptionalUser so a browser cookie OR an agent's personal access token lets the
	// resolver grant the user's real role; a caller with neither is anonymous
	// (public canvases only).
	r.With(OptionalUser(authSvc, s)).Post("/api/mcp/auth", mcpAuthHandlerFunc(h, authSvc))
	r.Get("/ws", wsH.ServeWS)
	r.Get("/api/maps", mapsH.List)
	r.Get("/api/maps/{id}", mapsH.Get)
	r.Get("/api/stats", h.Stats)
	if metricsEnabled {
		// Latency aggregates only (no canvas data) — open by design.
		r.Get("/api/metrics", metricsReg.Handler)
	}

	// ── OAuth 2.1 authorization server (hosted MCP connector) ────────────────────
	// Discovery metadata (RFC 8414 / 9728). Registered with a trailing wildcard
	// too because some clients append the resource path to the well-known URL.
	r.Get("/.well-known/oauth-protected-resource", oauthH.ProtectedResourceMetadata)
	r.Get("/.well-known/oauth-protected-resource/*", oauthH.ProtectedResourceMetadata)
	r.Get("/.well-known/oauth-authorization-server", oauthH.AuthorizationServerMetadata)
	r.Get("/.well-known/oauth-authorization-server/*", oauthH.AuthorizationServerMetadata)
	// Dynamic client registration + token exchange (public; PKCE). The consent
	// PAGE at GET /oauth/authorize is intentionally NOT a route here — it falls
	// through to the SPA, which drives the two /api/oauth/authorize calls below.
	r.Post("/oauth/register", oauthH.Register)
	r.Post("/oauth/token", oauthH.Token)

	// ── Auth (human login; cookie-based session) ─────────────────────────────────
	r.Post("/api/auth/google", authH.GoogleLogin)
	r.Get("/api/auth/me", authH.Me)
	r.Post("/api/auth/logout", authH.Logout)

	// ── Account-scoped (user session required) ───────────────────────────────────
	r.Group(func(r chi.Router) {
		r.Use(RequireUser(authSvc))
		// Account preferences (e.g. default canvas visibility). RequireUser puts
		// the user id in context for UpdateMe.
		r.Patch("/api/auth/me", authH.UpdateMe)
		// Permanent account deletion (danger zone on /me). Owner's canvases go
		// with the account; the handler clears the session cookie.
		r.Delete("/api/auth/me", authH.DeleteMe)
		r.Get("/api/me/canvases", h.MeCanvases)
		// Recipient-side of sharing: canvases shared with me + the inbox that
		// tells me a share happened.
		r.Get("/api/me/shared", h.SharedWithMe)
		r.Get("/api/me/notifications", h.ListNotifications)
		r.Post("/api/me/notifications/read", h.MarkNotificationsRead)

		// Personal access tokens — user-scoped MCP credentials (mint / list /
		// revoke). The plaintext is returned only from POST, once.
		r.Get("/api/me/tokens", h.ListTokens)
		r.Post("/api/me/tokens", h.CreateToken)
		r.Delete("/api/me/tokens/{id}", h.RevokeToken)

		// OAuth consent backend — the SPA consent page (served at /oauth/authorize)
		// validates the request via GET and mints the authorization code via POST,
		// both as the signed-in user.
		r.Get("/api/oauth/authorize", oauthH.GetAuthorizationInfo)
		r.Post("/api/oauth/authorize", oauthH.Approve)

		// Connected apps — list + revoke the user's OAuth authorizations.
		r.Get("/api/me/connections", oauthH.ListConnections)
		r.Delete("/api/me/connections/{clientId}", oauthH.RevokeConnection)
		r.Post("/api/canvases/{code}/copy", h.CopyCanvas)
		r.Post("/api/canvases/{code}/claim", h.ClaimCanvas)

		// Sharing (owner-only; the handler enforces ownership). Visibility +
		// per-account access for the Google-Docs model.
		r.Patch("/api/canvases/{code}/visibility", h.SetCanvasVisibility)
		r.Patch("/api/canvases/{code}/name", h.SetCanvasName)
		// Approval policy for agent-proposed tasks (strict | epic | auto).
		r.Patch("/api/canvases/{code}/approval-policy", h.SetCanvasApprovalPolicy)
		// Owner-only permanent delete (requireCanvasOwner gates it).
		r.Delete("/api/canvases/{code}", h.DeleteCanvas)
		r.Get("/api/canvases/{code}/access", h.ListCanvasAccess)
		r.Post("/api/canvases/{code}/access", h.AddCanvasAccess)
		r.Delete("/api/canvases/{code}/access/{userId}", h.RemoveCanvasAccess)

		// Outbound webhooks (TDM-39) — owner-only canvas config, HUMAN-ONLY BY
		// CONSTRUCTION. These sit in this group, and not under /api/canvas/*,
		// for one reason: RequireUser accepts a session COOKIE and nothing else,
		// so none of the credentials an agent can hold — canvas JWT, PAT, OAuth
		// access token — reaches them. A webhook config names an endpoint and
		// mints a signing secret, so an agent that could create one could point
		// the board at a server it controls; migration 0038 forbids the MCP
		// surface and this is where that is enforced. See webhook_handler.go for
		// the full argument, including the honest limits.
		//
		// The static "deliveries" segment is registered alongside {id}; chi
		// prefers static segments, and TestWebhookDeliveriesRouteDoesNotShadow
		// pins it so a future route edit can't silently reroute one to the other.
		r.Get("/api/canvases/{code}/webhooks", h.ListCanvasWebhooks)
		r.Post("/api/canvases/{code}/webhooks", h.CreateCanvasWebhook)
		r.Get("/api/canvases/{code}/webhooks/deliveries", h.ListCanvasWebhookDeliveries)
		r.Post("/api/canvases/{code}/webhooks/deliveries/{id}/retry", h.RetryCanvasWebhookDelivery)
		r.Patch("/api/canvases/{code}/webhooks/{id}", h.UpdateCanvasWebhook)
		r.Delete("/api/canvases/{code}/webhooks/{id}", h.DeleteCanvasWebhook)
		r.Post("/api/canvases/{code}/webhooks/{id}/rotate", h.RotateCanvasWebhookSecret)
	})

	// Sheet export — public by canvas code (matches WS auth model).
	r.Get("/api/canvas/sheets/{id}/export", h.ExportSheet)

	// Itinerary export — public by canvas code. Doubles as a calendar
	// subscription URL (Google / Apple / Outlook poll it to stay in sync).
	r.Get("/api/canvas/{code}/itinerary.ics", h.ExportItineraryICS)

	// ── Inbound status API (TDM-38) ────────────────────────────────────────────
	// A fleet member with no MCP client — a CI job, a Modal function, a cron
	// script — reports task status with one curl. Canvas is addressed by CODE
	// here (not by the token's embedded id) because the URL is the thing a human
	// pastes into a workflow file; RequireCanvasByCode makes the two agree.
	// RequireWrite applies as it does to every other mutation: a read-only
	// credential can watch the board, not move it.
	r.Group(func(r chi.Router) {
		r.Use(RequireCanvasByCode(authSvc, s))
		r.Use(RequireLiveGrant(s))
		r.Use(RequireWrite)
		r.Post("/api/canvas/{code}/tasks/{id}/status", h.ReportTaskStatus)
	})

	// Image upload is intentionally disabled for v1 — needs a real storage
	// story (durable disk + backups) before we offer it. The read path below
	// stays so any imageRefs left from dev still render instead of 404'ing
	// in a confusing way.
	r.Get("/canvas-images/*", func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(imageDir, chi.URLParam(r, "*"))
		// prevent path traversal
		if !strings.HasPrefix(filepath.Clean(path), filepath.Clean(imageDir)) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		http.ServeFile(w, r, path)
	})

	// ── Protected (JWT required) ───────────────────────────────────────────────
	// RequireJWT validates the canvas token (which now carries a resolved role).
	// Reads are allowed for any role; mutations sit behind RequireWrite so a
	// read-only token (public-read canvas, or a member shared at 'read') can look
	// but not touch — the HTTP mirror of the WS write gate.
	r.Group(func(r chi.Router) {
		r.Use(RequireJWT(authSvc))
		// Kill tokens whose OAuth connection was revoked mid-session (before the
		// 24h JWT TTL). No-op for anonymous/PAT tokens, which carry no binding.
		r.Use(RequireLiveGrant(s))

		// Reads — any valid role.
		r.Get("/api/canvas/state", h.GetState)
		// One-call connect bundle: briefing + approved queue (+ ?taskId= for one
		// hydrated task) as AGENTS.md-shaped markdown. See context_handler.go.
		r.Get("/api/canvas/context", h.GetContext)
		r.Get("/api/canvas/pending-edits", h.ListPendingEdits)
		r.Post("/api/canvas/forms/scaffold", h.ScaffoldForm) // computes a spec; no mutation
		r.Get("/api/canvas/actions", h.ListActions)
		r.Get("/api/canvas/actions/{id}", h.ReadAction)
		r.Get("/api/canvas/roadmap-items", h.ListRoadmapItems)
		r.Get("/api/canvas/documents", h.ListDocuments)

		// Writes — require write role.
		r.Group(func(r chi.Router) {
			r.Use(RequireWrite)

			r.Post("/api/canvas/mode", h.SetMode)

			// Briefing designation (migration 0037). Import creates/reuses a notes
			// doc, writes the file into it, and designates it in one call; the PUT
			// is the bare designation for "set as briefing" on an existing doc.
			// Both mutate the canvas, so both sit behind RequireWrite.
			r.Post("/api/canvas/briefing/import", h.ImportBriefing)
			r.Put("/api/canvas/briefing", h.SetBriefing)

			r.Post("/api/canvas/documents", h.CreateDocument)
			r.Post("/api/canvas/documents/batch", h.CreateDocumentsBatch)
			r.Patch("/api/canvas/documents/{ref}", h.UpdateDocument)
			r.Delete("/api/canvas/documents/{ref}", h.DeleteDocument)
			r.Post("/api/canvas/documents/batch-delete", h.DeleteDocumentsBatch)
			r.Post("/api/canvas/mode/enable", h.EnableMode)
			r.Post("/api/canvas/map", h.SetMap)
			r.Post("/api/canvas/template", h.ApplyTemplate)

			r.Post("/api/canvas/pins", h.CreatePin)
			r.Post("/api/canvas/pins/batch", h.CreatePinsBatch)
			r.Post("/api/canvas/pins/batch-update", h.UpdatePinsBatch)
			r.Post("/api/canvas/pins/batch-delete", h.DeletePinsBatch)
			r.Patch("/api/canvas/pins/{id}", h.UpdatePin)
			r.Delete("/api/canvas/pins/{id}", h.DeletePin)

			r.Post("/api/canvas/events", h.CreateEvent)
			r.Post("/api/canvas/events/batch", h.CreateEventsBatch)
			r.Post("/api/canvas/events/batch-update", h.UpdateEventsBatch)
			r.Post("/api/canvas/events/batch-delete", h.DeleteEventsBatch)
			r.Patch("/api/canvas/events/{id}", h.UpdateEvent)
			r.Delete("/api/canvas/events/{id}", h.DeleteEvent)

			// Combined pins + events in one write; events reference brand-new
			// pins by client-supplied clientId (breaks the pin-ID dependency trap).
			r.Post("/api/canvas/map/batch", h.CreateMapBatch)

			r.Post("/api/canvas/notes", h.CreateNote)
			r.Post("/api/canvas/notes/batch", h.CreateNotesBatch)
			r.Post("/api/canvas/notes/batch-update", h.UpdateNotesBatch)
			r.Post("/api/canvas/notes/batch-delete", h.DeleteNotesBatch)
			r.Patch("/api/canvas/notes/{id}", h.UpdateNote)
			r.Delete("/api/canvas/notes/{id}", h.DeleteNote)

			r.Post("/api/canvas/roadmap-items", h.CreateRoadmapItem)
			r.Post("/api/canvas/roadmap-items/batch", h.CreateRoadmapItemsBatch)
			r.Post("/api/canvas/roadmap-items/batch-update", h.UpdateRoadmapItemsBatch)
			r.Post("/api/canvas/roadmap-items/batch-delete", h.DeleteRoadmapItemsBatch)
			r.Patch("/api/canvas/roadmap-items/{id}", h.UpdateRoadmapItem)
			r.Delete("/api/canvas/roadmap-items/{id}", h.DeleteRoadmapItem)

			r.Post("/api/canvas/sheets", h.CreateSheet)
			r.Post("/api/canvas/sheets/batch-delete", h.DeleteSheetsBatch)
			r.Patch("/api/canvas/sheets/{id}", h.UpdateSheet)
			r.Delete("/api/canvas/sheets/{id}", h.DeleteSheet)
			r.Post("/api/canvas/sheets/{id}/columns", h.AddSheetColumn)
			r.Post("/api/canvas/sheets/{id}/columns/batch", h.CreateSheetColumnsBatch)
			r.Post("/api/canvas/sheet-columns/batch-update", h.UpdateSheetColumnsBatch)
			r.Post("/api/canvas/sheet-columns/batch-delete", h.DeleteSheetColumnsBatch)
			r.Patch("/api/canvas/sheets/{id}/columns/{columnId}", h.UpdateSheetColumn)
			r.Delete("/api/canvas/sheets/{id}/columns/{columnId}", h.DeleteSheetColumn)
			r.Post("/api/canvas/sheets/{id}/rows/batch", h.CreateSheetRowsBatch)
			r.Post("/api/canvas/sheet-rows", h.CreateSheetRow)
			r.Post("/api/canvas/sheet-rows/batch-update", h.UpdateSheetRowsBatch)
			r.Post("/api/canvas/sheet-rows/batch-delete", h.DeleteSheetRowsBatch)
			r.Patch("/api/canvas/sheet-rows/{id}", h.UpdateSheetRow)
			r.Delete("/api/canvas/sheet-rows/{id}", h.DeleteSheetRow)

			r.Post("/api/canvas/charts", h.CreateChart)
			r.Post("/api/canvas/charts/batch", h.CreateChartsBatch)
			r.Post("/api/canvas/charts/batch-update", h.UpdateChartsBatch)
			r.Post("/api/canvas/charts/batch-delete", h.DeleteChartsBatch)
			r.Patch("/api/canvas/charts/{id}", h.UpdateChart)
			r.Delete("/api/canvas/charts/{id}", h.DeleteChart)

			// Forms (direct-input layer). submit is the human write path.
			r.Post("/api/canvas/forms", h.DefineForm)
			r.Patch("/api/canvas/forms/{id}", h.UpdateForm)
			r.Delete("/api/canvas/forms/{id}", h.DeleteForm)
			r.Post("/api/canvas/forms/batch-delete", h.DeleteFormsBatch)
			r.Post("/api/canvas/forms/{id}/submit", h.SubmitForm)

			// Agents + actions (v1 execution primitive) — proposing mutates.
			r.Post("/api/canvas/agents", h.RegisterAgent)
			r.Post("/api/canvas/actions", h.ProposeAction)
			r.Post("/api/canvas/actions/batch", h.ProposeActionsBatch)
			r.Post("/api/canvas/actions/batch-delete", h.DeleteActionsBatch)
			r.Post("/api/canvas/actions/approve-batch", h.ApproveActionsBatch)
			r.Post("/api/canvas/actions/{id}/approve", h.ApproveAction)
			r.Post("/api/canvas/actions/{id}/reject", h.RejectAction)
			// Stuck-claim release (executing → approved). Human-only by surface:
			// not exposed through the MCP gateway — see Handler.ReleaseAction.
			r.Post("/api/canvas/actions/{id}/release", h.ReleaseAction)
			// Failed-task requeue (failed → approved, error cleared). Human-only
			// by surface: not exposed through the MCP gateway — agents must not
			// requeue their own failures. See Handler.RequeueAction.
			r.Post("/api/canvas/actions/{id}/requeue", h.RequeueAction)
			r.Patch("/api/canvas/actions/{id}", h.UpdateActionState)
			r.Delete("/api/canvas/actions/{id}", h.DeleteAction)

			r.Post("/api/canvas/pending-edits", h.CreatePendingEdit)
			r.Delete("/api/canvas/pending-edits/{id}", h.DeletePendingEdit)
		})
	})

	// ── SPA (web app) ──────────────────────────────────────────────────────────
	if _, err := os.Stat(webDistPath); err == nil {
		r.Handle("/*", spaHandler(webDistPath))
	}

	return r
}

// spaHandler serves static files and falls back to index.html for SPA routing.
//
// The web app is a single static index.html whose <head> hard-codes a canonical
// of https://tandemcanvas.com/ and never rewrites it client-side. That's fine for
// the landing page, but crawlable routes that are also listed in the sitemap (e.g.
// /mcp) would otherwise serve that same canonical and get folded into "/" by Google
// — so the extra pages never get indexed. For those routes we serve a variant of
// index.html with a self-referencing canonical + a route-specific <title>, so each
// indexable URL returns 200 at its own canonical. Everything else falls through to
// the default index.html and the SPA renders the right view from the path.
func spaHandler(distPath string) http.Handler {
	indexPath := filepath.Join(distPath, "index.html")
	base, _ := os.ReadFile(indexPath)
	variants := buildRouteVariants(base)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(distPath, r.URL.Path)
		if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
			http.ServeFile(w, r, path)
			return
		}
		if html, ok := variants[strings.TrimRight(r.URL.Path, "/")]; ok {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(html)
			return
		}
		http.ServeFile(w, r, indexPath)
	})
}

// titleRe and descRe match the home page's <title> and meta description in
// index.html. They're matched by *shape*, not by literal copy: an earlier version
// of this file string-matched the exact home title, so every time the marketing
// copy changed the per-route titles silently stopped applying and /mcp and /about
// went back to being served as duplicates of the landing page.
var (
	titleRe = regexp.MustCompile(`(?s)<title>.*?</title>`)
	descRe  = regexp.MustCompile(`(?s)<meta\s+name="description"\s+content="[^"]*"\s*/?>`)
)

// buildRouteVariants precomputes per-route index.html variants with a
// self-referencing canonical and route-specific title/description, keyed by
// request path (no trailing slash). Returns nil if index.html couldn't be read,
// in which case spaHandler just serves the default for every route.
//
// Titles lead with what the page is in category terms rather than brand voice —
// these are the only two non-landing URLs Google can index, and "Tandem" alone
// only matches people who already know the name.
func buildRouteVariants(base []byte) map[string][]byte {
	if len(base) == 0 {
		return nil
	}
	const origin = "https://tandemcanvas.com"
	rewrite := func(path, title, desc string) []byte {
		html := string(base)
		// Point the canonical + og:url at this route instead of the apex.
		html = strings.ReplaceAll(html,
			`<link rel="canonical" href="`+origin+`/" />`,
			`<link rel="canonical" href="`+origin+path+`" />`)
		html = strings.ReplaceAll(html,
			`<meta property="og:url" content="`+origin+`/" />`,
			`<meta property="og:url" content="`+origin+path+`" />`)
		// Give the route its own title + description so it can rank on its own
		// terms instead of competing with the landing page for the same words.
		// Matched by shape (see titleRe/descRe) rather than by the exact home
		// copy, so marketing edits can't silently turn this into a no-op.
		html = titleRe.ReplaceAllLiteralString(html, "<title>"+title+"</title>")
		html = descRe.ReplaceAllLiteralString(html,
			`<meta name="description" content="`+desc+`" />`)
		return []byte(html)
	}
	return map[string][]byte{
		"/mcp": rewrite("/mcp",
			"Connect any MCP client to a shared canvas — Tandem MCP server",
			"Point Claude, Claude Code, Cursor, or any MCP-aware agent at a Tandem canvas. Setup for the hosted connector and the @jaximus/tandem-mcp stdio server, plus the full canvas tool surface."),
		"/about": rewrite("/about",
			"About Tandem — why a shared canvas for AI agents",
			"Who built Tandem, and why a chat log is the wrong place for work an AI agent did on your behalf."),
	}
}
