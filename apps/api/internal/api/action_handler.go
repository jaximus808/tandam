package api

import (
	"encoding/json"
	"net/http"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// ── Agents (v1 identity / provenance) ─────────────────────────────────────────

// POST /api/canvas/agents  — an agent identifies itself on connect.
func (h *Handler) RegisterAgent(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Name  string  `json:"name"`
		Role  string  `json:"role"`
		Model *string `json:"model"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Role != "planner" && body.Role != "executor" {
		writeError(w, http.StatusBadRequest, "role must be 'planner' or 'executor'")
		return
	}
	if body.Name == "" {
		body.Name = body.Role
	}
	agent := &store.Agent{
		ID: uuid.New(), Kind: "agent",
		Name: body.Name, Role: body.Role, Model: body.Model,
	}
	if _, err := h.store.RegisterAgent(r.Context(), canvasID, agent); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, map[string]string{"agentId": agent.ID.String()})
}

// ── Actions (v1 execution primitive) ──────────────────────────────────────────

// validActionStates is the legal state machine, enforced before every write so
// an out-of-order client can't drive an action into a bad state.
//   proposed  → approved | rejected
//   approved  → executing
//   executing → done | failed
var validActionStates = map[string]map[string]bool{
	"proposed":  {"approved": true, "rejected": true},
	"approved":  {"executing": true},
	"executing": {"done": true, "failed": true},
}

func canTransition(from, to string) bool {
	return validActionStates[from] != nil && validActionStates[from][to]
}

// POST /api/canvas/actions  — planner proposes an action.
func (h *Handler) ProposeAction(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Type         string          `json:"type"`
		Payload      json.RawMessage `json:"payload"`
		ProposedBy   string          `json:"proposedBy"`
		LinkedPinIDs []uuid.UUID     `json:"linkedPinIds"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Type == "" {
		body.Type = "navigate"
	}
	if body.ProposedBy == "" {
		body.ProposedBy = "agent"
	}
	action := &store.Action{
		ID: uuid.New(), Kind: "action",
		Type: body.Type, State: "proposed",
		Payload:    body.Payload,
		ProposedBy: body.ProposedBy,
		LinkedPinIDs: body.LinkedPinIDs,
	}
	if _, err := h.store.CreateAction(r.Context(), canvasID, action); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, action)
}

// GET /api/canvas/actions?state=  — list actions, optionally filtered by state.
func (h *Handler) ListActions(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	stateFilter := r.URL.Query().Get("state")
	actions, err := h.store.ListActions(r.Context(), canvasID, stateFilter)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"actions": actions})
}

// GET /api/canvas/actions/{id}  — read one action (executor polls this).
func (h *Handler) ReadAction(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	action, err := h.store.GetAction(r.Context(), canvasID, id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"action": action})
}

// transitionAction loads the action, checks the proposed→to move is legal,
// applies the patch, and returns the fresh action. Shared by approve / reject /
// update_state so the state-machine guard lives in exactly one place.
func (h *Handler) transitionAction(w http.ResponseWriter, r *http.Request, to string, patch store.ActionStatePatch) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	current, err := h.store.GetAction(r.Context(), canvasID, id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if !canTransition(current.State, to) {
		writeError(w, http.StatusBadRequest, "illegal transition: "+current.State+" → "+to)
		return
	}
	patch.State = to
	if _, err := h.store.UpdateActionState(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	fresh, err := h.store.GetAction(r.Context(), canvasID, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"action": fresh})
}

// POST /api/canvas/actions/{id}/approve  — human gate: proposed → approved.
func (h *Handler) ApproveAction(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ApprovedBy string `json:"approvedBy"`
	}
	_ = decode(r, &body)
	approvedBy := body.ApprovedBy
	if approvedBy == "" {
		approvedBy = "human"
	}
	h.transitionAction(w, r, "approved", store.ActionStatePatch{ApprovedBy: &approvedBy})
}

// POST /api/canvas/actions/{id}/reject  — human gate: proposed → rejected.
func (h *Handler) RejectAction(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Reason string `json:"reason"`
	}
	_ = decode(r, &body)
	var reason *string
	if body.Reason != "" {
		reason = &body.Reason
	}
	h.transitionAction(w, r, "rejected", store.ActionStatePatch{Error: reason})
}

// PATCH /api/canvas/actions/{id}  — executor: approved → executing → done|failed.
func (h *Handler) UpdateActionState(w http.ResponseWriter, r *http.Request) {
	var body struct {
		State   string          `json:"state"`
		Result  *string         `json:"result"`
		Error   *string         `json:"error"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	switch body.State {
	case "executing", "done", "failed":
		// allowed via update_state; approve/reject have their own endpoints
	default:
		writeError(w, http.StatusBadRequest, "state must be 'executing', 'done', or 'failed'")
		return
	}
	h.transitionAction(w, r, body.State, store.ActionStatePatch{
		Result: body.Result, Error: body.Error, Payload: body.Payload,
	})
}
