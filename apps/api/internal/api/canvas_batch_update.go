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
// that were actually applied.
//
// "Applied" means ROWS-AFFECTED, not "patched without error" (TDM-138). Each
// store.UpdateX now returns the true rows-affected, so an id that is absent or
// belongs to another canvas — a silent 0-row no-op — is NOT echoed back as
// updated. See runBatchAffected / finishBatch in batch_common.go, which also
// converge the canvas even when a batch partially fails.
//
// Execution: each handler validates its items synchronously (400s stay on the
// request goroutine), then runs the per-item store calls concurrently via
// runBatch — every element is its own DB row keyed by id, so the writes are
// independent. The one exception is sheet columns, which live inside their
// sheet's JSON array and so stay serial (see UpdateSheetColumnsBatch). The
// trailing broadcast is async (broadcastBatchUpdate), so the caller unblocks as
// soon as the writes are durable.

// broadcastBatchUpdate fires the single trailing state broadcast and writes the
// list of applied ids. Callers do all the per-item work first, then hand the
// applied ids here. The broadcast is async: the writes are already durable, so
// the caller (an agent over the MCP path) unblocks immediately instead of waiting
// on a full-canvas read + marshal + WS fan-out that only exists to converge
// viewers — the same reasoning as broadcastStateAsync elsewhere.
func (h *Handler) broadcastBatchUpdate(w http.ResponseWriter, r *http.Request, updated []string) {
	// Thin wrapper over finishBatch (no batch error) for the serial handlers that
	// build their applied list directly (sheet columns). The parallel handlers call
	// finishBatch themselves so they can surface a partial-batch error.
	h.finishBatch(w, r, updated, nil, "updated")
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
	if tooManyBatchItems(w, len(body.Items)) {
		return
	}
	// Validate synchronously and collect the valid items; the store calls then run
	// concurrently via runBatch. Validation stays on the request goroutine so a
	// 400 is decided before any write, exactly as the old serial loop did.
	items := make([]pinItem, 0, len(body.Items))
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
		items = append(items, item)
	}
	applied, batchErr := runBatchAffected(len(items), func(i int) (int, error) {
		return h.store.UpdatePin(store.WithoutVersionBump(r.Context()), canvasID, items[i].ID, items[i].PinPatch)
	})
	h.finishBatch(w, r, appliedIDs(applied, func(i int) string { return items[i].ID.String() }), batchErr, "updated")
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
	if tooManyBatchItems(w, len(body.Items)) {
		return
	}
	items := make([]eventItem, 0, len(body.Items))
	for _, item := range body.Items {
		if item.ID == uuid.Nil {
			continue
		}
		items = append(items, item)
	}
	applied, batchErr := runBatchAffected(len(items), func(i int) (int, error) {
		return h.store.UpdateEvent(store.WithoutVersionBump(r.Context()), canvasID, items[i].ID, items[i].EventPatch)
	})
	h.finishBatch(w, r, appliedIDs(applied, func(i int) string { return items[i].ID.String() }), batchErr, "updated")
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
	if tooManyBatchItems(w, len(body.Items)) {
		return
	}
	items := make([]noteItem, 0, len(body.Items))
	for _, item := range body.Items {
		if item.ID == uuid.Nil {
			continue
		}
		items = append(items, item)
	}
	applied, batchErr := runBatchAffected(len(items), func(i int) (int, error) {
		return h.store.UpdateNote(store.WithoutVersionBump(r.Context()), canvasID, items[i].ID, items[i].NotePatch)
	})
	h.finishBatch(w, r, appliedIDs(applied, func(i int) string { return items[i].ID.String() }), batchErr, "updated")
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
	if tooManyBatchItems(w, len(body.Items)) {
		return
	}
	items := make([]roadmapItem, 0, len(body.Items))
	for _, item := range body.Items {
		if item.ID == uuid.Nil {
			continue
		}
		items = append(items, item)
	}
	applied, batchErr := runBatchAffected(len(items), func(i int) (int, error) {
		return h.store.UpdateRoadmapItem(store.WithoutVersionBump(r.Context()), canvasID, items[i].ID, items[i].RoadmapItemPatch)
	})
	h.finishBatch(w, r, appliedIDs(applied, func(i int) string { return items[i].ID.String() }), batchErr, "updated")
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
	if tooManyBatchItems(w, len(body.Items)) {
		return
	}
	items := make([]chartItem, 0, len(body.Items))
	for _, item := range body.Items {
		if item.ID == uuid.Nil {
			continue
		}
		if item.ChartType != nil && !isValidChartType(*item.ChartType) {
			writeError(w, http.StatusBadRequest, "invalid chart type: "+*item.ChartType)
			return
		}
		items = append(items, item)
	}
	applied, batchErr := runBatchAffected(len(items), func(i int) (int, error) {
		return h.store.UpdateChart(store.WithoutVersionBump(r.Context()), canvasID, items[i].ID, items[i].ChartPatch)
	})
	h.finishBatch(w, r, appliedIDs(applied, func(i int) string { return items[i].ID.String() }), batchErr, "updated")
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
	if tooManyBatchItems(w, len(body.Items)) {
		return
	}
	items := make([]rowItem, 0, len(body.Items))
	for _, item := range body.Items {
		if item.ID == uuid.Nil {
			continue
		}
		items = append(items, item)
	}
	applied, batchErr := runBatchAffected(len(items), func(i int) (int, error) {
		return h.store.UpdateSheetRow(store.WithoutVersionBump(r.Context()), canvasID, items[i].ID, items[i].SheetRowPatch)
	})
	h.finishBatch(w, r, appliedIDs(applied, func(i int) string { return items[i].ID.String() }), batchErr, "updated")
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
	if tooManyBatchItems(w, len(body.Items)) {
		return
	}
	// NOT parallelized (unlike the other batch-updates): a column lives inside its
	// sheet's `columns` JSON array, so UpdateSheetColumn is a read-modify-write of
	// that whole array. Two columns of the SAME sheet updated concurrently would
	// each start from the same snapshot and the second write would clobber the
	// first (lost update). Column batches are small, so a serial loop is fine here.
	updated := make([]string, 0, len(body.Items))
	for _, item := range body.Items {
		if item.SheetID == uuid.Nil || item.ColumnID == "" {
			continue
		}
		if item.Type != nil && !isValidSheetColumnType(*item.Type) {
			writeError(w, http.StatusBadRequest, "invalid column type")
			return
		}
		if _, err := h.store.UpdateSheetColumn(store.WithoutVersionBump(r.Context()), canvasID, item.SheetID, item.ColumnID, item.SheetColumnPatch); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		updated = append(updated, item.ColumnID)
	}
	h.broadcastBatchUpdate(w, r, updated)
}
