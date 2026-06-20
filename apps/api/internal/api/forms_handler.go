package api

import (
	"net/http"
	"time"

	"github.com/agentcanvas/api/internal/forms"
	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// canvasTimezone picks a representative timezone for the canvas (the first event
// that declares one), falling back to UTC. Used so computed:"today" lands a
// late-night submit on the right local day. There's no canvas-level tz field; an
// event's timezone is the best signal we store today.
func canvasTimezone(state *store.CanvasState) *time.Location {
	for _, e := range state.Events {
		if e.Timezone != nil && *e.Timezone != "" {
			if loc, err := time.LoadLocation(*e.Timezone); err == nil {
				return loc
			}
		}
	}
	return time.UTC
}

// POST /api/canvas/forms — define a form from an authoring Intent.
// Compiles against live state; stores iff ok. Returns the CompileResult (200 on
// ok with formId; 422 with errors otherwise).
func (h *Handler) DefineForm(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var intent forms.Intent
	if err := decode(r, &intent); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	_, state, _, err := h.store.GetCanvasState(r.Context(), canvasID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	res, fields, actions := forms.Compile(intent, state)
	if !res.OK {
		writeJSON(w, http.StatusUnprocessableEntity, res)
		return
	}
	f := &store.Form{
		ID: uuid.New(), Kind: "form",
		Name: intent.Name, Description: intent.Description,
		Fields: fields, Actions: actions,
		SortOrder: len(state.Forms), CreatedBy: "agent",
	}
	if _, err := h.store.CreateForm(r.Context(), canvasID, f); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	res.FormID = f.ID.String()
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, res)
}

// PATCH /api/canvas/forms/{id} — redefine a form from a full Intent (re-compiled).
func (h *Handler) UpdateForm(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var intent forms.Intent
	if err := decode(r, &intent); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	_, state, _, err := h.store.GetCanvasState(r.Context(), canvasID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	res, fields, actions := forms.Compile(intent, state)
	if !res.OK {
		writeJSON(w, http.StatusUnprocessableEntity, res)
		return
	}
	patch := store.FormPatch{
		Name: &intent.Name, Description: &intent.Description,
		Fields: &fields, Actions: &actions,
	}
	if _, err := h.store.UpdateForm(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	res.FormID = id.String()
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, res)
}

// DELETE /api/canvas/forms/{id}
func (h *Handler) DeleteForm(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if _, err := h.store.DeleteForm(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/forms/scaffold — draft an Intent from an existing sheet.
// Read-only: stores nothing.
func (h *Handler) ScaffoldForm(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Sheet string `json:"sheet"`
	}
	if err := decode(r, &body); err != nil || body.Sheet == "" {
		writeError(w, http.StatusBadRequest, "sheet is required")
		return
	}
	_, state, _, err := h.store.GetCanvasState(r.Context(), canvasID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	intent, compileRes, err := forms.Scaffold(state, body.Sheet)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"intent": intent, "compile": compileRes})
}

// POST /api/canvas/forms/{id}/submit — a human fills the form; we resolve + apply.
// Provenance: the effect is a USER change, so we broadcast "user" (no agent cursor;
// counts toward the recurrence signal).
func (h *Handler) SubmitForm(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var body struct {
		Values       map[string]any `json:"values"`
		SubmissionID string         `json:"submissionId"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	form, err := h.store.GetForm(r.Context(), canvasID, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "form not found")
		return
	}
	_, state, _, err := h.store.GetCanvasState(r.Context(), canvasID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().In(canvasTimezone(state))
	batch, err := forms.Resolve(form, body.Values, state, now)
	if err != nil {
		// A resolve failure is a bad submission (validation) — 422, not 500.
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	version, err := h.store.SubmitForm(r.Context(), canvasID, batch, body.SubmissionID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastStateBy(r.Context(), h.store, h.hub, canvasID, "user")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": version})
}
