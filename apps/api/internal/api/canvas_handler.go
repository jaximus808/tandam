package api

import (
	"net/http"
	"time"

	"github.com/agentcanvas/api/internal/maps"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/ws"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type Handler struct {
	store store.Store
	hub   *ws.Hub
	maps  *maps.Registry
}

func NewHandler(s store.Store, hub *ws.Hub, mapsReg *maps.Registry) *Handler {
	return &Handler{store: s, hub: hub, maps: mapsReg}
}

// POST /api/canvases
func (h *Handler) CreateCanvas(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := decode(r, &body); err != nil || body.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	canvas, err := h.store.CreateCanvas(r.Context(), body.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, canvas)
}

// GET /api/canvases/{code}
func (h *Handler) GetCanvasByCode(w http.ResponseWriter, r *http.Request) {
	code := chi.URLParam(r, "code")
	canvas, err := h.store.GetCanvasByCode(r.Context(), code)
	if err != nil {
		writeError(w, http.StatusNotFound, "canvas not found")
		return
	}
	writeJSON(w, http.StatusOK, canvas)
}

// GET /api/canvas/state  (JWT required)
func (h *Handler) GetState(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	canvas, state, edits, err := h.store.GetCanvasState(r.Context(), canvasID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, stateMsg{
		Type:         "state",
		Canvas:       canvas,
		State:        state,
		PendingEdits: edits,
	})
}

// POST /api/canvas/mode  (JWT required)
func (h *Handler) SetMode(w http.ResponseWriter, r *http.Request) {
	var body struct{ Mode string `json:"mode"` }
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !isValidMode(body.Mode) {
		writeError(w, http.StatusBadRequest, "invalid mode")
		return
	}
	canvasID := CanvasIDFromCtx(r.Context())
	if _, err := h.store.SetMode(r.Context(), canvasID, body.Mode); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/map  (JWT required)
func (h *Handler) SetMap(w http.ResponseWriter, r *http.Request) {
	var body struct{ MapID string `json:"mapId"` }
	if err := decode(r, &body); err != nil || body.MapID == "" {
		writeError(w, http.StatusBadRequest, "mapId is required")
		return
	}
	if h.maps == nil || !h.maps.Has(body.MapID) {
		writeError(w, http.StatusBadRequest, "unknown mapId")
		return
	}
	canvasID := CanvasIDFromCtx(r.Context())
	if _, err := h.store.SetMapID(r.Context(), canvasID, body.MapID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/template  (JWT required)
func (h *Handler) ApplyTemplate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TemplateID string  `json:"templateId"`
		Mode       string  `json:"mode"`
		MapID      *string `json:"mapId,omitempty"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !isValidMode(body.Mode) {
		writeError(w, http.StatusBadRequest, "invalid mode")
		return
	}
	if body.MapID != nil && (h.maps == nil || !h.maps.Has(*body.MapID)) {
		writeError(w, http.StatusBadRequest, "unknown mapId")
		return
	}
	canvasID := CanvasIDFromCtx(r.Context())
	if _, err := h.store.ApplyTemplate(r.Context(), canvasID, body.Mode, body.MapID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

func isValidMode(mode string) bool {
	switch mode {
	case "welcome", "map", "itinerary", "docs":
		return true
	}
	return false
}

// POST /api/canvas/pins
func (h *Handler) CreatePin(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var pin store.Pin
	if err := decode(r, &pin); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	pin.ID = uuid.New()
	pin.Kind = "pin"
	if pin.CreatedBy == "" { pin.CreatedBy = "agent" }
	if _, err := h.store.CreatePin(r.Context(), canvasID, &pin); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, pin)
}

// PATCH /api/canvas/pins/{id}
func (h *Handler) UpdatePin(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var patch store.PinPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := h.store.UpdatePin(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/pins/{id}
func (h *Handler) DeletePin(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if _, err := h.store.DeletePin(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/events
func (h *Handler) CreateEvent(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Title  string     `json:"title"`
		Start  time.Time  `json:"start"`
		End    *time.Time `json:"end"`
		PinID  *uuid.UUID `json:"pinId"`
		CreatedBy string  `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.CreatedBy == "" { body.CreatedBy = "agent" }
	ev := &store.Event{
		ID: uuid.New(), Kind: "event",
		Title: body.Title, Start: body.Start, End: body.End,
		PinID: body.PinID, CreatedBy: body.CreatedBy,
	}
	if _, err := h.store.CreateEvent(r.Context(), canvasID, ev); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, ev)
}

// PATCH /api/canvas/events/{id}
func (h *Handler) UpdateEvent(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var patch store.EventPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := h.store.UpdateEvent(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/events/{id}
func (h *Handler) DeleteEvent(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	if _, err := h.store.DeleteEvent(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/notes
func (h *Handler) CreateNote(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Body       string     `json:"body"`
		ImageRefs  []string   `json:"imageRefs"`
		ParentID   *uuid.UUID `json:"parentId"`
		ParentKind *string    `json:"parentKind"`
		CreatedBy  string     `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.CreatedBy == "" { body.CreatedBy = "agent" }
	n := &store.Note{
		ID: uuid.New(), Kind: "note",
		Body: body.Body, ImageRefs: body.ImageRefs,
		ParentID: body.ParentID, ParentKind: body.ParentKind,
		CreatedBy: body.CreatedBy,
	}
	if _, err := h.store.CreateNote(r.Context(), canvasID, n); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, n)
}

// PATCH /api/canvas/notes/{id}
func (h *Handler) UpdateNote(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	var patch store.NotePatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := h.store.UpdateNote(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/notes/{id}
func (h *Handler) DeleteNote(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	if _, err := h.store.DeleteNote(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/pending-edits
func (h *Handler) CreatePendingEdit(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		EntityID    uuid.UUID `json:"entityId"`
		Instruction string    `json:"instruction"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	edit, err := h.store.CreatePendingEdit(r.Context(), canvasID, body.EntityID, body.Instruction)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, edit)
}

// DELETE /api/canvas/pending-edits/{id}
func (h *Handler) DeletePendingEdit(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	if err := h.store.DeletePendingEdit(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}
