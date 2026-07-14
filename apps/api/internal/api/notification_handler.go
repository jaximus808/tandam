package api

import (
	"net/http"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// GET /api/me/shared — canvases other owners have shared with the signed-in user
// (the recipient side of sharing). Each carries the granted role in yourRole.
func (h *Handler) SharedWithMe(w http.ResponseWriter, r *http.Request) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	canvases, err := h.store.ListCanvasesSharedWithUser(r.Context(), uid)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, canvases)
}

// GET /api/me/notifications — the signed-in user's inbox (newest first) plus the
// unread count for the homepage badge.
func (h *Handler) ListNotifications(w http.ResponseWriter, r *http.Request) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	notes, err := h.store.ListNotifications(r.Context(), uid, 50)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	unread := 0
	for _, n := range notes {
		if !n.Read {
			unread++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"notifications": notes,
		"unread":        unread,
	})
}

// POST /api/me/notifications/read — mark the whole inbox read (clears the badge).
func (h *Handler) MarkNotificationsRead(w http.ResponseWriter, r *http.Request) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	if err := h.store.MarkNotificationsRead(r.Context(), uid); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// canvasForPrefs resolves the {code} canvas and confirms the signed-in user can
// see it (any non-"none" role — owner, member, or a public canvas). Notification
// prefs are personal, so unlike the sharing endpoints this is not owner-gated:
// anyone with access sets their own. Writes the error + returns ok=false on fail.
func (h *Handler) canvasForPrefs(w http.ResponseWriter, r *http.Request) (uuid.UUID, *store.Canvas, bool) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return uuid.Nil, nil, false
	}
	canvas, err := h.store.GetCanvasByCode(r.Context(), chi.URLParam(r, "code"))
	if err != nil {
		writeError(w, http.StatusNotFound, "canvas not found")
		return uuid.Nil, nil, false
	}
	role, err := h.store.ResolveCanvasRole(r.Context(), canvas, &uid)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return uuid.Nil, nil, false
	}
	if role == "none" {
		writeError(w, http.StatusForbidden, "no access to this canvas")
		return uuid.Nil, nil, false
	}
	return uid, canvas, true
}

// GET /api/canvases/{code}/notification-prefs — the signed-in user's per-canvas
// preferences (defaults if they've never set them).
func (h *Handler) GetNotificationPrefs(w http.ResponseWriter, r *http.Request) {
	uid, canvas, ok := h.canvasForPrefs(w, r)
	if !ok {
		return
	}
	prefs, err := h.store.GetNotificationPrefs(r.Context(), uid, canvas.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, prefs)
}

// PATCH /api/canvases/{code}/notification-prefs — replace the signed-in user's
// per-canvas preferences with the posted blob. The full object is expected;
// unknown category keys are dropped and missing modes default to on.
func (h *Handler) SetNotificationPrefs(w http.ResponseWriter, r *http.Request) {
	uid, canvas, ok := h.canvasForPrefs(w, r)
	if !ok {
		return
	}
	var prefs store.NotificationPrefs
	if err := decode(r, &prefs); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	prefs.Normalize()
	if err := h.store.UpsertNotificationPrefs(r.Context(), uid, canvas.ID, &prefs); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, &prefs)
}
