package api

import (
	"net/http"

	"github.com/agentcanvas/api/internal/maps"
	"github.com/go-chi/chi/v5"
)

type MapsHandler struct {
	reg *maps.Registry
}

func NewMapsHandler(r *maps.Registry) *MapsHandler {
	return &MapsHandler{reg: r}
}

// GET /api/maps
func (h *MapsHandler) List(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"maps": h.reg.List()})
}

// GET /api/maps/{id}
func (h *MapsHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	def, ok := h.reg.Get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "map not found")
		return
	}
	writeJSON(w, http.StatusOK, def)
}
