package api

import (
	"context"
	"net/http"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
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

	canvas, token, ok := h.issueTokenForCode(w, r.Context(), body.Code, authSvc, "editor")
	if !ok {
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"token":      token,
		"canvasId":   canvas.ID,
		"canvasName": canvas.Name,
		"canvasCode": canvas.Code,
		"_note":      "Attach as 'Authorization: Bearer <token>' on all subsequent API calls. Canvas ID is embedded in the token — never pass it explicitly.",
	})
}

// issueTokenForCode resolves a canvas code and issues an auth token for it.
// On failure it writes the error response and returns ok=false.
func (h *Handler) issueTokenForCode(w http.ResponseWriter, ctx context.Context, code string, authSvc *auth.Service, role string) (*store.Canvas, string, bool) {
	canvas, err := h.store.GetCanvasByCode(ctx, code)
	if err != nil {
		writeError(w, http.StatusNotFound, "canvas not found — check your canvas code")
		return nil, "", false
	}
	token, err := authSvc.Issue(canvas.ID, role)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to issue token")
		return nil, "", false
	}
	return canvas, token, true
}

// mcpAuthHandlerFunc returns an http.HandlerFunc that closes over authSvc.
func mcpAuthHandlerFunc(h *Handler, authSvc *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h.MCPAuth(w, r, authSvc)
	}
}
