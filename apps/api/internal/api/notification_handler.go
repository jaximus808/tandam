package api

import (
	"net/http"
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
