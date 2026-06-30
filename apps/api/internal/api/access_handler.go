package api

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// requireCanvasOwner loads the canvas named by {code} and verifies the session
// user owns it. The sharing endpoints (visibility + member management) are
// owner-only. Writes the error response + returns ok=false on any failure.
func (h *Handler) requireCanvasOwner(w http.ResponseWriter, r *http.Request) (*store.Canvas, bool) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return nil, false
	}
	canvas, err := h.store.GetCanvasByCode(r.Context(), chi.URLParam(r, "code"))
	if err != nil {
		writeError(w, http.StatusNotFound, "canvas not found")
		return nil, false
	}
	if canvas.OwnerUserID == nil || *canvas.OwnerUserID != uid {
		writeError(w, http.StatusForbidden, "only the canvas owner can manage sharing")
		return nil, false
	}
	return canvas, true
}

// PATCH /api/canvases/{code}/visibility — body { visibility, publicRole }
func (h *Handler) SetCanvasVisibility(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireCanvasOwner(w, r)
	if !ok {
		return
	}
	var body struct {
		Visibility string `json:"visibility"`
		PublicRole string `json:"publicRole"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.Visibility != "public" && body.Visibility != "private" {
		writeError(w, http.StatusBadRequest, "visibility must be 'public' or 'private'")
		return
	}
	// publicRole only bites when public, but keep the stored value sane regardless.
	if body.PublicRole == "" {
		body.PublicRole = "write"
	}
	if body.PublicRole != "read" && body.PublicRole != "write" {
		writeError(w, http.StatusBadRequest, "publicRole must be 'read' or 'write'")
		return
	}
	if _, err := h.store.SetCanvasVisibility(r.Context(), canvas.ID, body.Visibility, body.PublicRole); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Push fresh state so connected boards pick up the new posture, then re-resolve
	// every connected viewer's access live — flipping to private kicks non-members
	// on the spot, and a read/write change updates their gate without a reconnect.
	broadcastState(r.Context(), h.store, h.hub, canvas.ID)
	reevaluateAccess(r.Context(), h.store, h.hub, canvas.ID)
	writeJSON(w, http.StatusOK, map[string]string{"visibility": body.Visibility, "publicRole": body.PublicRole})
}

// GET /api/canvases/{code}/access — owner-only member list.
func (h *Handler) ListCanvasAccess(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireCanvasOwner(w, r)
	if !ok {
		return
	}
	access, err := h.store.ListCanvasAccess(r.Context(), canvas.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, access)
}

// POST /api/canvases/{code}/access — body { email, role }; share by email.
func (h *Handler) AddCanvasAccess(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireCanvasOwner(w, r)
	if !ok {
		return
	}
	var body struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := decode(r, &body); err != nil || strings.TrimSpace(body.Email) == "" {
		writeError(w, http.StatusBadRequest, "email is required")
		return
	}
	if body.Role == "" {
		body.Role = "read"
	}
	if body.Role != "read" && body.Role != "write" {
		writeError(w, http.StatusBadRequest, "role must be 'read' or 'write'")
		return
	}
	user, err := h.store.GetUserByEmail(r.Context(), body.Email)
	if err != nil {
		if errors.Is(err, store.ErrUserNotFound) {
			writeError(w, http.StatusNotFound, "no Tandem account uses that email — ask them to sign in once first")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if canvas.OwnerUserID != nil && *canvas.OwnerUserID == user.ID {
		writeError(w, http.StatusBadRequest, "that account already owns this canvas")
		return
	}
	if err := h.store.UpsertCanvasAccess(r.Context(), canvas.ID, user.ID, body.Role); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Drop a notification in the grantee's inbox so the share surfaces on their
	// homepage. Best effort — the share already succeeded; a failed inbox write
	// must not fail the request. actorID is the owner who shared (the session user).
	owner := canvas.OwnerUserID
	note := store.NewNotification(user.ID, "canvas_shared", &canvas.ID, owner, body.Role)
	if err := h.store.CreateNotification(r.Context(), note); err != nil {
		log.Printf("share: failed to write notification for user %s on canvas %s: %v", user.ID, canvas.ID, err)
	}

	// If the grantee is already connected (e.g. watching a public-read canvas),
	// upgrade their live write-gate immediately instead of on the next reconnect.
	reevaluateAccess(r.Context(), h.store, h.hub, canvas.ID)

	writeJSON(w, http.StatusOK, store.CanvasAccess{
		UserID: user.ID, Email: user.Email, DisplayName: user.DisplayName,
		AvatarURL: user.AvatarURL, Role: body.Role,
	})
}

// DELETE /api/canvases/{code}/access/{userId} — unshare.
func (h *Handler) RemoveCanvasAccess(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireCanvasOwner(w, r)
	if !ok {
		return
	}
	userID, err := uuid.Parse(chi.URLParam(r, "userId"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if err := h.store.DeleteCanvasAccess(r.Context(), canvas.ID, userID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Revoke live: if the unshared user is connected, re-resolve their access now.
	// On a private canvas they drop to none and get kicked; on a public canvas
	// they fall back to the public role (so they stay, at that level).
	reevaluateAccess(r.Context(), h.store, h.hub, canvas.ID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}
