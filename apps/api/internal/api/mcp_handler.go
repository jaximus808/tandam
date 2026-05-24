package api

import (
	"context"
	"net/http"

	"github.com/agentcanvas/api/internal/auth"
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

	canvas, err := h.store.GetCanvasByCode(r.Context(), body.Code)
	if err != nil {
		writeError(w, http.StatusNotFound, "canvas not found — check your canvas code")
		return
	}

	token, err := authSvc.Issue(canvas.ID, "editor")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to issue token")
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

// mcpAuthHandlerFunc returns an http.HandlerFunc that closes over authSvc.
func mcpAuthHandlerFunc(h *Handler, authSvc *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h.MCPAuth(w, r, authSvc)
	}
}

// ensure context import used
var _ = context.Background
