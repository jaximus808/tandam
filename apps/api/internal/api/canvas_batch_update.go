package api

import (
	"net/http"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// Batch-UPDATE handlers.
//
// These mirror the CreateXBatch pattern (canvas_handler.go): they patch MANY
// existing elements in ONE request and fire exactly ONE state broadcast at the
// very end (NOT per item). The single-broadcast-per-batch is the whole point —
// it's the fix for agents blowing the per-turn tool-call limit when they had to
// call canvas_event_update once per element (see the applyBatch note at
// ws_handler.go and the create-batch note at canvas_handler.go:684).
//
// Each request body is {items:[{id, <partial fields>}]}. Each item embeds the
// existing per-type Patch struct (so the partial fields decode with the exact
// same json tags and semantics as the single PATCH handlers) plus the target
// id. Items with a missing/zero id are skipped; the response returns the ids
// that were applied.
//
// The int returned by store.UpdateX is the bumped canvas version, not a
// rows-affected count (same as the single handlers, which ignore it), so
// "updated" here means "patched without error", matching single-handler
// semantics where a well-formed but absent id is a no-op, not an error.

// broadcastBatchUpdate fires the single trailing state broadcast and writes the
// list of applied ids. Callers do all the per-item work first, then hand the
// applied ids here.
func (h *Handler) broadcastBatchUpdate(w http.ResponseWriter, r *http.Request, updated []string) {
	canvasID := CanvasIDFromCtx(r.Context())
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]any{"updated": updated})
}

// POST /api/canvas/pins/batch-update
func (h *Handler) UpdatePinsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	type pinItem struct {
		ID uuid.UUID `json:"id"`
		store.PinPatch
	}
	var body struct {
		Items []pinItem `json:"items"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusBadRequest, "items: at least one entry is required")
		return
	}
	updated := make([]string, 0, len(body.Items))
	for _, item := range body.Items {
		if item.ID == uuid.Nil {
			continue
		}
		// Validate any coordinate the patch touches, mirroring UpdatePin: lat/lng
		// are independently optional, so default the absent one to an in-range
		// value so a single-field update isn't blocked by the missing one.
		if item.Lat != nil || item.Lng != nil {
			lat, lng := 0.0, 0.0
			if item.Lat != nil {
				lat = *item.Lat
			}
			if item.Lng != nil {
				lng = *item.Lng
			}
			if msg := validateLatLng(lat, lng); msg != "" {
				writeError(w, http.StatusBadRequest, msg)
				return
			}
		}
		if _, err := h.store.UpdatePin(r.Context(), canvasID, item.ID, item.PinPatch); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		updated = append(updated, item.ID.String())
	}
	h.broadcastBatchUpdate(w, r, updated)
}

// POST /api/canvas/events/batch-update
func (h *Handler) UpdateEventsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	type eventItem struct {
		ID uuid.UUID `json:"id"`
		store.EventPatch
	}
	var body struct {
		Items []eventItem `json:"items"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusBadRequest, "items: at least one entry is required")
		return
	}
	updated := make([]string, 0, len(body.Items))
	for _, item := range body.Items {
		if item.ID == uuid.Nil {
			continue
		}
		if _, err := h.store.UpdateEvent(r.Context(), canvasID, item.ID, item.EventPatch); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		updated = append(updated, item.ID.String())
	}
	h.broadcastBatchUpdate(w, r, updated)
}

// POST /api/canvas/notes/batch-update
func (h *Handler) UpdateNotesBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	type noteItem struct {
		ID uuid.UUID `json:"id"`
		store.NotePatch
	}
	var body struct {
		Items []noteItem `json:"items"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusBadRequest, "items: at least one entry is required")
		return
	}
	updated := make([]string, 0, len(body.Items))
	for _, item := range body.Items {
		if item.ID == uuid.Nil {
			continue
		}
		if _, err := h.store.UpdateNote(r.Context(), canvasID, item.ID, item.NotePatch); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		updated = append(updated, item.ID.String())
	}
	h.broadcastBatchUpdate(w, r, updated)
}

// POST /api/canvas/roadmap-items/batch-update
func (h *Handler) UpdateRoadmapItemsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	type roadmapItem struct {
		ID uuid.UUID `json:"id"`
		store.RoadmapItemPatch
	}
	var body struct {
		Items []roadmapItem `json:"items"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusBadRequest, "items: at least one entry is required")
		return
	}
	updated := make([]string, 0, len(body.Items))
	for _, item := range body.Items {
		if item.ID == uuid.Nil {
			continue
		}
		if _, err := h.store.UpdateRoadmapItem(r.Context(), canvasID, item.ID, item.RoadmapItemPatch); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		updated = append(updated, item.ID.String())
	}
	h.broadcastBatchUpdate(w, r, updated)
}

// POST /api/canvas/charts/batch-update
func (h *Handler) UpdateChartsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	type chartItem struct {
		ID uuid.UUID `json:"id"`
		store.ChartPatch
	}
	var body struct {
		Items []chartItem `json:"items"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusBadRequest, "items: at least one entry is required")
		return
	}
	updated := make([]string, 0, len(body.Items))
	for _, item := range body.Items {
		if item.ID == uuid.Nil {
			continue
		}
		if item.ChartType != nil && !isValidChartType(*item.ChartType) {
			writeError(w, http.StatusBadRequest, "invalid chart type: "+*item.ChartType)
			return
		}
		if _, err := h.store.UpdateChart(r.Context(), canvasID, item.ID, item.ChartPatch); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		updated = append(updated, item.ID.String())
	}
	h.broadcastBatchUpdate(w, r, updated)
}

// POST /api/canvas/sheet-rows/batch-update
func (h *Handler) UpdateSheetRowsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	type rowItem struct {
		ID uuid.UUID `json:"id"`
		store.SheetRowPatch
	}
	var body struct {
		Items []rowItem `json:"items"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusBadRequest, "items: at least one entry is required")
		return
	}
	updated := make([]string, 0, len(body.Items))
	for _, item := range body.Items {
		if item.ID == uuid.Nil {
			continue
		}
		if _, err := h.store.UpdateSheetRow(r.Context(), canvasID, item.ID, item.SheetRowPatch); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		updated = append(updated, item.ID.String())
	}
	h.broadcastBatchUpdate(w, r, updated)
}

// POST /api/canvas/sheet-columns/batch-update
//
// Columns are addressed by (sheetId, columnId) — a column id is a string local
// to its sheet, so unlike the other element types each item must carry its
// owning sheetId. This can span multiple sheets in one call.
func (h *Handler) UpdateSheetColumnsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	type columnItem struct {
		SheetID  uuid.UUID `json:"sheetId"`
		ColumnID string    `json:"columnId"`
		store.SheetColumnPatch
	}
	var body struct {
		Items []columnItem `json:"items"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusBadRequest, "items: at least one entry is required")
		return
	}
	updated := make([]string, 0, len(body.Items))
	for _, item := range body.Items {
		if item.SheetID == uuid.Nil || item.ColumnID == "" {
			continue
		}
		if item.Type != nil && !isValidSheetColumnType(*item.Type) {
			writeError(w, http.StatusBadRequest, "invalid column type")
			return
		}
		if _, err := h.store.UpdateSheetColumn(r.Context(), canvasID, item.SheetID, item.ColumnID, item.SheetColumnPatch); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		updated = append(updated, item.ColumnID)
	}
	h.broadcastBatchUpdate(w, r, updated)
}
