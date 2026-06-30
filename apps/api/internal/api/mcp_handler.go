package api

import (
	"context"
	"net/http"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// POST /api/mcp/auth
// Body: { "code": "ABCD1234" }
// Returns: { "token": "...", "canvasId": "...", "canvasName": "..." }
func (h *Handler) MCPAuth(w http.ResponseWriter, r *http.Request, authSvc *auth.Service) {
	var body struct {
		Code string `json:"code"`
	}
	if err := decode(r, &body); err != nil || body.Code == "" {
		writeError(w, http.StatusBadRequest, "code is required")
		return
	}

	// OptionalUser populates the session user (if the caller is a logged-in
	// browser); an agent/MCP caller has none → anonymous, public canvases only.
	var uid *uuid.UUID
	if id, ok := UserIDFromCtx(r.Context()); ok {
		uid = &id
	}

	canvas, token, role, ok := h.issueTokenForCode(w, r.Context(), body.Code, authSvc, uid)
	if !ok {
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"token":      token,
		"canvasId":   canvas.ID,
		"canvasName": canvas.Name,
		"canvasCode": canvas.Code,
		"role":       role,
		"_note":      "Attach as 'Authorization: Bearer <token>' on all subsequent API calls. Canvas ID is embedded in the token — never pass it explicitly. role 'read' means write tools will be rejected.",
	})
}

// issueTokenForCode resolves a canvas code, resolves the caller's role for it,
// and issues a canvas token carrying that role. The role is baked into the JWT
// so RequireWrite can enforce it on mutating routes. Returns 403 when the caller
// has no access (private canvas, not a member). On failure it writes the error
// response and returns ok=false.
func (h *Handler) issueTokenForCode(w http.ResponseWriter, ctx context.Context, code string, authSvc *auth.Service, userID *uuid.UUID) (*store.Canvas, string, string, bool) {
	canvas, err := h.store.GetCanvasByCode(ctx, code)
	if err != nil {
		writeError(w, http.StatusNotFound, "canvas not found — check your canvas code")
		return nil, "", "", false
	}
	role, err := h.store.ResolveCanvasRole(ctx, canvas, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not resolve canvas access")
		return nil, "", "", false
	}
	if role == "none" {
		writeError(w, http.StatusForbidden, "this canvas is private — sign in with an account it's shared with")
		return nil, "", "", false
	}
	token, err := authSvc.Issue(canvas.ID, role)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to issue token")
		return nil, "", "", false
	}
	return canvas, token, role, true
}

// mcpAuthHandlerFunc returns an http.HandlerFunc that closes over authSvc.
func mcpAuthHandlerFunc(h *Handler, authSvc *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h.MCPAuth(w, r, authSvc)
	}
}
