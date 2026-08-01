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

// PATCH /api/canvases/{code}/approval-policy — body { approvalPolicy }.
// Owner-only, like the other canvas settings. Sets how much human gating
// agent-proposed tasks get ('strict' | 'epic' | 'auto', migration 0033; 'peer',
// migration 0041); the cascade itself is enforced in the action create/approve
// handlers. Reading the policy needs no dedicated endpoint — it rides on the
// canvas meta (GET /api/canvases/{code} and every WS state push).
//
// 'peer' is the opt-in that lets a REVIEWER agent approve another agent's task
// (TDM-145). It is owner-only to set precisely because it is the one policy that
// moves an approval out of human hands, so the decision to allow that has to be
// a human's — and it is the ONLY way a canvas ever enters that mode. Nothing
// defaults to it and no migration moves an existing canvas onto it.
func (h *Handler) SetCanvasApprovalPolicy(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireCanvasOwner(w, r)
	if !ok {
		return
	}
	var body struct {
		ApprovalPolicy string `json:"approvalPolicy"`
		// RequireCrossModelReview (TDM-155, migration 0042) rides along on the same
		// owner-only PATCH rather than claiming a route of its own: it is a modifier
		// on 'peer', meaningless without it, and an owner setting the review posture
		// is setting one thing. A POINTER so omitting it means "leave as-is" — every
		// existing caller (the web ShareDialog sends only approvalPolicy) keeps its
		// exact behaviour, which is what default-OFF has to mean in practice.
		RequireCrossModelReview *bool `json:"requireCrossModelReview"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	switch body.ApprovalPolicy {
	case "strict", "epic", "auto", policyPeer:
	default:
		writeError(w, http.StatusBadRequest, "approvalPolicy must be 'strict', 'epic', 'auto', or 'peer'")
		return
	}
	if _, err := h.store.SetCanvasApprovalPolicy(r.Context(), canvas.ID, body.ApprovalPolicy); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	crossModel := canvas.RequireCrossModelReview
	if body.RequireCrossModelReview != nil && *body.RequireCrossModelReview != crossModel {
		if _, err := h.store.SetCanvasCrossModelReview(r.Context(), canvas.ID, *body.RequireCrossModelReview); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		crossModel = *body.RequireCrossModelReview
	}
	// Push fresh state so connected boards pick up the new policy live.
	broadcastState(r.Context(), h.store, h.hub, canvas.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"approvalPolicy": body.ApprovalPolicy, "requireCrossModelReview": crossModel})
}

// maxCanvasNameLen caps a canvas name. Names are short human labels rendered in
// the header and dashboard cards; 120 chars is plenty and keeps a pasted essay
// out of the title slot.
const maxCanvasNameLen = 120

// PATCH /api/canvases/{code}/name — body { name }. Owner-only rename.
func (h *Handler) SetCanvasName(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireCanvasOwner(w, r)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if len(name) > maxCanvasNameLen {
		writeError(w, http.StatusBadRequest, "name is too long (max 120 characters)")
		return
	}
	if _, err := h.store.SetCanvasName(r.Context(), canvas.ID, name); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Push fresh state so every connected board picks up the new name live.
	broadcastState(r.Context(), h.store, h.hub, canvas.ID)
	writeJSON(w, http.StatusOK, map[string]string{"name": name})
}

// DELETE /api/canvases/{code} — owner-only permanent delete. requireCanvasOwner
// rejects an unowned (anonymous) canvas or a non-owner, so this is only ever
// reachable for a canvas the signed-in account owns. DB cascades drop all content,
// shares, and notifications; we boot any live viewers so open boards don't error
// on a now-missing canvas.
func (h *Handler) DeleteCanvas(w http.ResponseWriter, r *http.Request) {
	canvas, ok := h.requireCanvasOwner(w, r)
	if !ok {
		return
	}
	if err := h.store.DeleteCanvas(r.Context(), canvas.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	disconnectAll(h.hub, canvas.ID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
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
