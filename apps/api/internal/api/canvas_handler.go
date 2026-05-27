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
	case "welcome", "map", "itinerary", "docs", "roadmap", "sheets":
		return true
	}
	return false
}

func isValidSheetColumnType(t string) bool {
	switch t {
	case "text", "number", "date", "checkbox":
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
		Title      string     `json:"title"`
		Start      time.Time  `json:"start"`
		End        *time.Time `json:"end"`
		PinID      *uuid.UUID `json:"pinId"`
		FromPinID  *uuid.UUID `json:"fromPinId"`
		ToPinID    *uuid.UUID `json:"toPinId"`
		TravelMode *string    `json:"travelMode"`
		CreatedBy  string     `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.CreatedBy == "" { body.CreatedBy = "agent" }
	ev := &store.Event{
		ID: uuid.New(), Kind: "event",
		Title: body.Title, Start: body.Start, End: body.End,
		PinID: body.PinID, FromPinID: body.FromPinID, ToPinID: body.ToPinID,
		TravelMode: body.TravelMode, CreatedBy: body.CreatedBy,
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

// POST /api/canvas/roadmap-items
func (h *Handler) CreateRoadmapItem(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		ParentID  *uuid.UUID `json:"parentId"`
		Title     string     `json:"title"`
		Body      string     `json:"body"`
		Status    string     `json:"status"`
		SortOrder int        `json:"sortOrder"`
		CreatedBy string     `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.CreatedBy == "" { body.CreatedBy = "agent" }
	if body.Status == "" { body.Status = "todo" }
	item := &store.RoadmapItem{
		ID: uuid.New(), Kind: "roadmap",
		ParentID: body.ParentID, Title: body.Title, Body: body.Body,
		Status: body.Status, SortOrder: body.SortOrder, CreatedBy: body.CreatedBy,
	}
	if _, err := h.store.CreateRoadmapItem(r.Context(), canvasID, item); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, item)
}

// PATCH /api/canvas/roadmap-items/{id}
func (h *Handler) UpdateRoadmapItem(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var patch store.RoadmapItemPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := h.store.UpdateRoadmapItem(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/roadmap-items/{id}
func (h *Handler) DeleteRoadmapItem(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	if _, err := h.store.DeleteRoadmapItem(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// ── Sheets ────────────────────────────────────────────────────────────────────

// POST /api/canvas/sheets
func (h *Handler) CreateSheet(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Name      string              `json:"name"`
		Columns   []store.SheetColumn `json:"columns"`
		SortOrder int                 `json:"sortOrder"`
		CreatedBy string              `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.CreatedBy == "" { body.CreatedBy = "agent" }
	if body.Name == "" { body.Name = "Untitled sheet" }
	cols := make([]store.SheetColumn, 0, len(body.Columns))
	for _, c := range body.Columns {
		if c.Type == "" { c.Type = "text" }
		if !isValidSheetColumnType(c.Type) {
			writeError(w, http.StatusBadRequest, "invalid column type: "+c.Type)
			return
		}
		if c.ID == "" { c.ID = uuid.New().String() }
		cols = append(cols, c)
	}
	sh := &store.Sheet{
		ID: uuid.New(), Kind: "sheet",
		Name: body.Name, Columns: cols, SortOrder: body.SortOrder,
		CreatedBy: body.CreatedBy,
	}
	if _, err := h.store.CreateSheet(r.Context(), canvasID, sh); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, sh)
}

// PATCH /api/canvas/sheets/{id}
func (h *Handler) UpdateSheet(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil { writeError(w, http.StatusBadRequest, "invalid id"); return }
	var patch store.SheetPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := h.store.UpdateSheet(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/sheets/{id}
func (h *Handler) DeleteSheet(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	if _, err := h.store.DeleteSheet(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/sheets/{id}/columns
func (h *Handler) AddSheetColumn(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	sheetID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil { writeError(w, http.StatusBadRequest, "invalid sheet id"); return }
	var body store.SheetColumn
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Type == "" { body.Type = "text" }
	if !isValidSheetColumnType(body.Type) {
		writeError(w, http.StatusBadRequest, "invalid column type")
		return
	}
	if body.ID == "" { body.ID = uuid.New().String() }
	if _, err := h.store.AddSheetColumn(r.Context(), canvasID, sheetID, body); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, body)
}

// PATCH /api/canvas/sheets/{id}/columns/{columnId}
func (h *Handler) UpdateSheetColumn(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	sheetID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil { writeError(w, http.StatusBadRequest, "invalid sheet id"); return }
	columnID := chi.URLParam(r, "columnId")
	var patch store.SheetColumnPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if patch.Type != nil && !isValidSheetColumnType(*patch.Type) {
		writeError(w, http.StatusBadRequest, "invalid column type")
		return
	}
	if _, err := h.store.UpdateSheetColumn(r.Context(), canvasID, sheetID, columnID, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/sheets/{id}/columns/{columnId}
func (h *Handler) DeleteSheetColumn(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	sheetID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil { writeError(w, http.StatusBadRequest, "invalid sheet id"); return }
	columnID := chi.URLParam(r, "columnId")
	if _, err := h.store.DeleteSheetColumn(r.Context(), canvasID, sheetID, columnID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/sheet-rows
func (h *Handler) CreateSheetRow(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		SheetID   uuid.UUID      `json:"sheetId"`
		Data      map[string]any `json:"data"`
		SortOrder int            `json:"sortOrder"`
		CreatedBy string         `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.CreatedBy == "" { body.CreatedBy = "agent" }
	if body.Data == nil { body.Data = map[string]any{} }
	row := &store.SheetRow{
		ID: uuid.New(), Kind: "sheetRow", SheetID: body.SheetID,
		Data: body.Data, SortOrder: body.SortOrder, CreatedBy: body.CreatedBy,
	}
	if _, err := h.store.CreateSheetRow(r.Context(), canvasID, row); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, row)
}

// PATCH /api/canvas/sheet-rows/{id}
func (h *Handler) UpdateSheetRow(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil { writeError(w, http.StatusBadRequest, "invalid id"); return }
	var patch store.SheetRowPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := h.store.UpdateSheetRow(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/sheet-rows/{id}
func (h *Handler) DeleteSheetRow(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	if _, err := h.store.DeleteSheetRow(r.Context(), canvasID, id); err != nil {
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
