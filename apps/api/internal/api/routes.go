package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/maps"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/ws"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
)

func NewRouter(s store.Store, hub *ws.Hub, authSvc *auth.Service, googleVerifier *auth.GoogleVerifier, cookieSecure bool, mapsReg *maps.Registry, webDistPath string, imageDir string) http.Handler {
	r := chi.NewRouter()

	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: false,
	}))

	h := NewHandler(s, hub, mapsReg)
	wsH := NewWSHandler(s, hub, authSvc, mapsReg)
	mapsH := NewMapsHandler(mapsReg)
	authH := NewAuthHandler(s, authSvc, googleVerifier, cookieSecure)

	// ── Public ─────────────────────────────────────────────────────────────────
	// OptionalUser: a logged-in create gets owned; anonymous/MCP creates don't.
	r.With(OptionalUser(authSvc)).Post("/api/canvases", h.CreateCanvas)
	r.Get("/api/canvases/{code}", h.GetCanvasByCode)
	// OptionalUser so a logged-in browser's cookie lets the resolver grant the
	// real role; an agent/MCP caller has no cookie → anonymous (public canvases).
	r.With(OptionalUser(authSvc)).Post("/api/mcp/auth", mcpAuthHandlerFunc(h, authSvc))
	r.Get("/ws", wsH.ServeWS)
	r.Get("/api/maps", mapsH.List)
	r.Get("/api/maps/{id}", mapsH.Get)
	r.Get("/api/stats", h.Stats)

	// ── Auth (human login; cookie-based session) ─────────────────────────────────
	r.Post("/api/auth/google", authH.GoogleLogin)
	r.Get("/api/auth/me", authH.Me)
	r.Post("/api/auth/logout", authH.Logout)

	// ── Account-scoped (user session required) ───────────────────────────────────
	r.Group(func(r chi.Router) {
		r.Use(RequireUser(authSvc))
		r.Get("/api/me/canvases", h.MeCanvases)
		// Recipient-side of sharing: canvases shared with me + the inbox that
		// tells me a share happened.
		r.Get("/api/me/shared", h.SharedWithMe)
		r.Get("/api/me/notifications", h.ListNotifications)
		r.Post("/api/me/notifications/read", h.MarkNotificationsRead)
		r.Post("/api/canvases/{code}/copy", h.CopyCanvas)
		r.Post("/api/canvases/{code}/claim", h.ClaimCanvas)

		// Sharing (owner-only; the handler enforces ownership). Visibility +
		// per-account access for the Google-Docs model.
		r.Patch("/api/canvases/{code}/visibility", h.SetCanvasVisibility)
		r.Patch("/api/canvases/{code}/name", h.SetCanvasName)
		r.Get("/api/canvases/{code}/access", h.ListCanvasAccess)
		r.Post("/api/canvases/{code}/access", h.AddCanvasAccess)
		r.Delete("/api/canvases/{code}/access/{userId}", h.RemoveCanvasAccess)
	})

	// Sheet export — public by canvas code (matches WS auth model).
	r.Get("/api/canvas/sheets/{id}/export", h.ExportSheet)

	// Itinerary export — public by canvas code. Doubles as a calendar
	// subscription URL (Google / Apple / Outlook poll it to stay in sync).
	r.Get("/api/canvas/{code}/itinerary.ics", h.ExportItineraryICS)

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

		// Reads — any valid role.
		r.Get("/api/canvas/state", h.GetState)
		r.Post("/api/canvas/forms/scaffold", h.ScaffoldForm) // computes a spec; no mutation
		r.Get("/api/canvas/actions", h.ListActions)
		r.Get("/api/canvas/actions/{id}", h.ReadAction)
		r.Get("/api/canvas/roadmap-items", h.ListRoadmapItems)
		r.Get("/api/canvas/documents", h.ListDocuments)

		// Writes — require write role.
		r.Group(func(r chi.Router) {
			r.Use(RequireWrite)

			r.Post("/api/canvas/mode", h.SetMode)

			r.Post("/api/canvas/documents", h.CreateDocument)
			r.Patch("/api/canvas/documents/{ref}", h.UpdateDocument)
			r.Delete("/api/canvas/documents/{ref}", h.DeleteDocument)
			r.Post("/api/canvas/mode/enable", h.EnableMode)
			r.Post("/api/canvas/map", h.SetMap)
			r.Post("/api/canvas/template", h.ApplyTemplate)

			r.Post("/api/canvas/pins", h.CreatePin)
			r.Patch("/api/canvas/pins/{id}", h.UpdatePin)
			r.Delete("/api/canvas/pins/{id}", h.DeletePin)

			r.Post("/api/canvas/events", h.CreateEvent)
			r.Patch("/api/canvas/events/{id}", h.UpdateEvent)
			r.Delete("/api/canvas/events/{id}", h.DeleteEvent)

			r.Post("/api/canvas/notes", h.CreateNote)
			r.Patch("/api/canvas/notes/{id}", h.UpdateNote)
			r.Delete("/api/canvas/notes/{id}", h.DeleteNote)

			r.Post("/api/canvas/roadmap-items", h.CreateRoadmapItem)
			r.Patch("/api/canvas/roadmap-items/{id}", h.UpdateRoadmapItem)
			r.Delete("/api/canvas/roadmap-items/{id}", h.DeleteRoadmapItem)

			r.Post("/api/canvas/sheets", h.CreateSheet)
			r.Patch("/api/canvas/sheets/{id}", h.UpdateSheet)
			r.Delete("/api/canvas/sheets/{id}", h.DeleteSheet)
			r.Post("/api/canvas/sheets/{id}/columns", h.AddSheetColumn)
			r.Patch("/api/canvas/sheets/{id}/columns/{columnId}", h.UpdateSheetColumn)
			r.Delete("/api/canvas/sheets/{id}/columns/{columnId}", h.DeleteSheetColumn)
			r.Post("/api/canvas/sheet-rows", h.CreateSheetRow)
			r.Patch("/api/canvas/sheet-rows/{id}", h.UpdateSheetRow)
			r.Delete("/api/canvas/sheet-rows/{id}", h.DeleteSheetRow)

			r.Post("/api/canvas/charts", h.CreateChart)
			r.Patch("/api/canvas/charts/{id}", h.UpdateChart)
			r.Delete("/api/canvas/charts/{id}", h.DeleteChart)

			// Forms (direct-input layer). submit is the human write path.
			r.Post("/api/canvas/forms", h.DefineForm)
			r.Patch("/api/canvas/forms/{id}", h.UpdateForm)
			r.Delete("/api/canvas/forms/{id}", h.DeleteForm)
			r.Post("/api/canvas/forms/{id}/submit", h.SubmitForm)

			// Agents + actions (v1 execution primitive) — proposing mutates.
			r.Post("/api/canvas/agents", h.RegisterAgent)
			r.Post("/api/canvas/actions", h.ProposeAction)
			r.Post("/api/canvas/actions/{id}/approve", h.ApproveAction)
			r.Post("/api/canvas/actions/{id}/reject", h.RejectAction)
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

// buildRouteVariants precomputes per-route index.html variants with a
// self-referencing canonical and a route-specific title, keyed by request path
// (no trailing slash). Returns nil if index.html couldn't be read, in which case
// spaHandler just serves the default for every route.
func buildRouteVariants(base []byte) map[string][]byte {
	if len(base) == 0 {
		return nil
	}
	const origin = "https://tandemcanvas.com"
	rewrite := func(path, title string) []byte {
		html := string(base)
		// Point the canonical + og:url at this route instead of the apex.
		html = strings.ReplaceAll(html,
			`<link rel="canonical" href="`+origin+`/" />`,
			`<link rel="canonical" href="`+origin+path+`" />`)
		html = strings.ReplaceAll(html,
			`<meta property="og:url" content="`+origin+`/" />`,
			`<meta property="og:url" content="`+origin+path+`" />`)
		// Give the route its own title (also used as og/twitter title).
		const homeTitle = "Tandem Canvas — one canvas for your team and your AI agents"
		html = strings.ReplaceAll(html, homeTitle, title)
		return []byte(html)
	}
	return map[string][]byte{
		"/mcp": rewrite("/mcp",
			"Connect your AI agent — Tandem Canvas MCP"),
		"/about": rewrite("/about",
			"About — the person behind Tandem Canvas"),
	}
}
