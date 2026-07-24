package api

import (
	"net/http"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// Batch-DELETE handlers.
//
// These mirror the batch-UPDATE pattern (canvas_batch_update.go): they remove
// MANY existing elements in ONE request and fire exactly ONE state broadcast
// at the very end (NOT per item) — same fix as the update/create batches for
// agents blowing the per-turn tool-call limit when they had to call
// canvas_X_delete once per element.
//
// Each request body is {ids:[...]} of the type's id, EXCEPT:
//   - sheet columns, which are addressed by (sheetId, columnId) — a column id
//     is local to its sheet — so the body is {items:[{sheetId, columnId}]},
//     mirroring UpdateSheetColumnsBatch.
//   - documents, which are addressed by ref (id OR name, matching the single
//     DELETE /documents/{ref} route), so the body is {refs:[...]}.
//
// Zero/empty ids are skipped, not errors (mirrors the batch-update skip of a
// missing id). A document ref that doesn't resolve IS an error (404) and
// aborts the batch — unlike a zero id, a non-empty-but-wrong ref is a real
// mistake worth surfacing, not a silent no-op.
//
// The store DeleteX methods return (rows-affected int, error); like the single
// handlers, the int is ignored — a well-formed but already-absent id is a
// no-op, not an error, matching single-handler semantics.
//
// Execution: the id-keyed deletes run concurrently via runBatch (each row is
// independent), with the trailing broadcast async (broadcastBatchDelete). Two
// types stay serial: sheet columns (a read-modify-write of the sheet's JSON
// array — concurrent removals would clobber) and documents (ref resolution needs
// the request goroutine to surface a 404). See each handler's note.

// broadcastBatchDelete fires the single trailing state broadcast and writes
// the list of deleted ids. Callers do all the per-item work first, then hand
// the deleted ids here. Async for the same reason as broadcastBatchUpdate: the
// deletes are durable, so the caller returns immediately and viewers converge a
// moment later off the request goroutine.
func (h *Handler) broadcastBatchDelete(w http.ResponseWriter, r *http.Request, deleted []string) {
	canvasID := CanvasIDFromCtx(r.Context())
	// One version bump per batch — the per-item deletes ran with the bump suppressed
	// (store.WithoutVersionBump). Skip when nothing was deleted, mirroring the old
	// serial loop. Synchronous so the async broadcast reflects the new version.
	if len(deleted) > 0 {
		if _, err := h.store.BumpCanvasVersion(r.Context(), canvasID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}

// POST /api/canvas/pins/batch-delete
func (h *Handler) DeletePinsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "ids: at least one id is required")
		return
	}
	ids := make([]uuid.UUID, 0, len(body.IDs))
	deleted := make([]string, 0, len(body.IDs))
	for _, id := range body.IDs {
		if id == uuid.Nil {
			continue
		}
		ids = append(ids, id)
		deleted = append(deleted, id.String())
	}
	if err := runBatch(len(ids), func(i int) error {
		_, err := h.store.DeletePin(store.WithoutVersionBump(r.Context()), canvasID, ids[i])
		return err
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.broadcastBatchDelete(w, r, deleted)
}

// POST /api/canvas/events/batch-delete
func (h *Handler) DeleteEventsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "ids: at least one id is required")
		return
	}
	ids := make([]uuid.UUID, 0, len(body.IDs))
	deleted := make([]string, 0, len(body.IDs))
	for _, id := range body.IDs {
		if id == uuid.Nil {
			continue
		}
		ids = append(ids, id)
		deleted = append(deleted, id.String())
	}
	if err := runBatch(len(ids), func(i int) error {
		_, err := h.store.DeleteEvent(store.WithoutVersionBump(r.Context()), canvasID, ids[i])
		return err
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.broadcastBatchDelete(w, r, deleted)
}

// POST /api/canvas/notes/batch-delete
func (h *Handler) DeleteNotesBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "ids: at least one id is required")
		return
	}
	ids := make([]uuid.UUID, 0, len(body.IDs))
	deleted := make([]string, 0, len(body.IDs))
	for _, id := range body.IDs {
		if id == uuid.Nil {
			continue
		}
		ids = append(ids, id)
		deleted = append(deleted, id.String())
	}
	if err := runBatch(len(ids), func(i int) error {
		_, err := h.store.DeleteNote(store.WithoutVersionBump(r.Context()), canvasID, ids[i])
		return err
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.broadcastBatchDelete(w, r, deleted)
}

// POST /api/canvas/roadmap-items/batch-delete
func (h *Handler) DeleteRoadmapItemsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "ids: at least one id is required")
		return
	}
	ids := make([]uuid.UUID, 0, len(body.IDs))
	deleted := make([]string, 0, len(body.IDs))
	for _, id := range body.IDs {
		if id == uuid.Nil {
			continue
		}
		ids = append(ids, id)
		deleted = append(deleted, id.String())
	}
	if err := runBatch(len(ids), func(i int) error {
		_, err := h.store.DeleteRoadmapItem(store.WithoutVersionBump(r.Context()), canvasID, ids[i])
		return err
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.broadcastBatchDelete(w, r, deleted)
}

// POST /api/canvas/charts/batch-delete
func (h *Handler) DeleteChartsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "ids: at least one id is required")
		return
	}
	ids := make([]uuid.UUID, 0, len(body.IDs))
	deleted := make([]string, 0, len(body.IDs))
	for _, id := range body.IDs {
		if id == uuid.Nil {
			continue
		}
		ids = append(ids, id)
		deleted = append(deleted, id.String())
	}
	if err := runBatch(len(ids), func(i int) error {
		_, err := h.store.DeleteChart(store.WithoutVersionBump(r.Context()), canvasID, ids[i])
		return err
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.broadcastBatchDelete(w, r, deleted)
}

// POST /api/canvas/sheets/batch-delete
func (h *Handler) DeleteSheetsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "ids: at least one id is required")
		return
	}
	ids := make([]uuid.UUID, 0, len(body.IDs))
	deleted := make([]string, 0, len(body.IDs))
	for _, id := range body.IDs {
		if id == uuid.Nil {
			continue
		}
		ids = append(ids, id)
		deleted = append(deleted, id.String())
	}
	if err := runBatch(len(ids), func(i int) error {
		_, err := h.store.DeleteSheet(store.WithoutVersionBump(r.Context()), canvasID, ids[i])
		return err
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.broadcastBatchDelete(w, r, deleted)
}

// POST /api/canvas/sheet-rows/batch-delete
func (h *Handler) DeleteSheetRowsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "ids: at least one id is required")
		return
	}
	ids := make([]uuid.UUID, 0, len(body.IDs))
	deleted := make([]string, 0, len(body.IDs))
	for _, id := range body.IDs {
		if id == uuid.Nil {
			continue
		}
		ids = append(ids, id)
		deleted = append(deleted, id.String())
	}
	if err := runBatch(len(ids), func(i int) error {
		_, err := h.store.DeleteSheetRow(store.WithoutVersionBump(r.Context()), canvasID, ids[i])
		return err
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.broadcastBatchDelete(w, r, deleted)
}

// POST /api/canvas/sheet-columns/batch-delete
//
// Columns are addressed by (sheetId, columnId) — a column id is a string
// local to its sheet, so unlike the other element types each item must carry
// its owning sheetId (mirrors UpdateSheetColumnsBatch). Can span multiple
// sheets in one call.
//
// Serial (not parallelized like the id-keyed deletes): a column lives inside its
// sheet's JSON array, so DeleteSheetColumn is a read-modify-write of that array;
// two columns of the same sheet removed concurrently would clobber each other.
func (h *Handler) DeleteSheetColumnsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	type columnItem struct {
		SheetID  uuid.UUID `json:"sheetId"`
		ColumnID string    `json:"columnId"`
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
	deleted := make([]string, 0, len(body.Items))
	for _, item := range body.Items {
		if item.SheetID == uuid.Nil || item.ColumnID == "" {
			continue
		}
		if _, err := h.store.DeleteSheetColumn(store.WithoutVersionBump(r.Context()), canvasID, item.SheetID, item.ColumnID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		deleted = append(deleted, item.ColumnID)
	}
	h.broadcastBatchDelete(w, r, deleted)
}

// POST /api/canvas/documents/batch-delete
//
// Documents are addressed by ref (id or name), matching the single
// DELETE /documents/{ref} route — resolved through the same
// resolveDocumentRef helper, so a name resolves exactly like it does
// everywhere else. An unresolvable ref is a real error (404), not a skip: a
// non-empty ref that fails to resolve is a mistake worth surfacing, unlike a
// blank/zero id in the other batches.
//
// Serial (not parallelized): each ref is resolved on the request goroutine so an
// unresolvable ref surfaces as 404 rather than a generic 500 from inside a
// worker. Document deletes are also comparatively rare, so the serial cost is fine.
func (h *Handler) DeleteDocumentsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Refs []string `json:"refs"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.Refs) == 0 {
		writeError(w, http.StatusBadRequest, "refs: at least one document ref is required")
		return
	}
	deleted := make([]string, 0, len(body.Refs))
	for _, ref := range body.Refs {
		if ref == "" {
			continue
		}
		doc, err := h.resolveDocumentRef(r.Context(), canvasID, ref, "")
		if err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		if _, err := h.store.DeleteDocument(store.WithoutVersionBump(r.Context()), canvasID, doc.ID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		deleted = append(deleted, doc.ID.String())
	}
	h.broadcastBatchDelete(w, r, deleted)
}

// POST /api/canvas/forms/batch-delete
func (h *Handler) DeleteFormsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "ids: at least one id is required")
		return
	}
	ids := make([]uuid.UUID, 0, len(body.IDs))
	deleted := make([]string, 0, len(body.IDs))
	for _, id := range body.IDs {
		if id == uuid.Nil {
			continue
		}
		ids = append(ids, id)
		deleted = append(deleted, id.String())
	}
	if err := runBatch(len(ids), func(i int) error {
		_, err := h.store.DeleteForm(store.WithoutVersionBump(r.Context()), canvasID, ids[i])
		return err
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.broadcastBatchDelete(w, r, deleted)
}

// POST /api/canvas/actions/batch-delete
//
// Also covers "tasks" — a task is just an action with type "task"; there's no
// separate tasks table/endpoint, so canvas_task_delete_batch on the gateway
// posts here too.
func (h *Handler) DeleteActionsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "ids: at least one id is required")
		return
	}
	ids := make([]uuid.UUID, 0, len(body.IDs))
	deleted := make([]string, 0, len(body.IDs))
	for _, id := range body.IDs {
		if id == uuid.Nil {
			continue
		}
		ids = append(ids, id)
		deleted = append(deleted, id.String())
	}
	if err := runBatch(len(ids), func(i int) error {
		_, err := h.store.DeleteAction(store.WithoutVersionBump(r.Context()), canvasID, ids[i])
		return err
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.broadcastBatchDelete(w, r, deleted)
}
