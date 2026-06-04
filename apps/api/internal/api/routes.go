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
	r.Post("/api/canvases", h.CreateCanvas)
	r.Get("/api/canvases/{code}", h.GetCanvasByCode)
	r.Post("/api/mcp/auth", mcpAuthHandlerFunc(h, authSvc))
	r.Get("/ws", wsH.ServeWS)
	r.Get("/api/maps", mapsH.List)
	r.Get("/api/maps/{id}", mapsH.Get)

	// ── Auth (human login; cookie-based session) ─────────────────────────────────
	r.Post("/api/auth/google", authH.GoogleLogin)
	r.Get("/api/auth/me", authH.Me)
	r.Post("/api/auth/logout", authH.Logout)

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
	r.Group(func(r chi.Router) {
		r.Use(RequireJWT(authSvc))

		r.Get("/api/canvas/state", h.GetState)
		r.Post("/api/canvas/mode", h.SetMode)
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

		// Agents + actions (v1 execution primitive)
		r.Post("/api/canvas/agents", h.RegisterAgent)
		r.Post("/api/canvas/actions", h.ProposeAction)
		r.Get("/api/canvas/actions", h.ListActions)
		r.Get("/api/canvas/actions/{id}", h.ReadAction)
		r.Post("/api/canvas/actions/{id}/approve", h.ApproveAction)
		r.Post("/api/canvas/actions/{id}/reject", h.RejectAction)
		r.Patch("/api/canvas/actions/{id}", h.UpdateActionState)

		r.Post("/api/canvas/pending-edits", h.CreatePendingEdit)
		r.Delete("/api/canvas/pending-edits/{id}", h.DeletePendingEdit)
	})

	// ── SPA (web app) ──────────────────────────────────────────────────────────
	if _, err := os.Stat(webDistPath); err == nil {
		r.Handle("/*", spaHandler(webDistPath))
	}

	return r
}

// spaHandler serves static files and falls back to index.html for SPA routing.
func spaHandler(distPath string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(distPath, r.URL.Path)
		if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
			http.ServeFile(w, r, path)
			return
		}
		http.ServeFile(w, r, filepath.Join(distPath, "index.html"))
	})
}
