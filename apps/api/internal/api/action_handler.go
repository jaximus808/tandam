package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

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
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
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

// canonicalizeTaskPayload validates a task payload and fills defaults: title is
// required, assignee defaults to "agent" (a task is for an agent unless a human
// explicitly assigns it to themselves). Unknown fields pass through untouched.
func canonicalizeTaskPayload(raw json.RawMessage) (json.RawMessage, error) {
	var p map[string]any
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("task payload must be an object")
	}
	title, _ := p["title"].(string)
	if title == "" {
		return nil, fmt.Errorf("task payload requires a non-empty title")
	}
	switch p["assignee"] {
	case "agent", "human":
	case nil, "":
		p["assignee"] = "agent"
	default:
		return nil, fmt.Errorf("assignee must be 'agent' or 'human'")
	}
	return json.Marshal(p)
}

// POST /api/canvas/actions  — planner proposes an action. Humans may pass
// state "approved" to skip the gate (the gate exists for agent-proposed work).
func (h *Handler) ProposeAction(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Type         string          `json:"type"`
		State        string          `json:"state"`
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
	switch body.State {
	case "":
		body.State = "proposed"
	case "proposed", "approved":
	default:
		writeError(w, http.StatusBadRequest, "state must be 'proposed' or 'approved'")
		return
	}
	if body.Type == "task" {
		canonical, err := canonicalizeTaskPayload(body.Payload)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		body.Payload = canonical
	}
	action := &store.Action{
		ID: uuid.New(), Kind: "action",
		Type: body.Type, State: body.State,
		Payload:    body.Payload,
		ProposedBy: body.ProposedBy,
		LinkedPinIDs: body.LinkedPinIDs,
	}
	if body.State == "approved" {
		action.ApprovedBy = &body.ProposedBy
	}
	// Tasks get a per-canvas sequential ticket ("TDM-<n>", see ticket.go).
	h.assignTicketsBestEffort(r.Context(), canvasID, action)
	if _, err := h.store.CreateAction(r.Context(), canvasID, action); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, action)
}

// POST /api/canvas/actions/batch  — propose many actions (e.g. a whole task
// plan) in one shot via a single bulk INSERT + ONE state broadcast. Each
// action gets the same defaulting/validation as ProposeAction (type defaults
// to "navigate", proposedBy defaults to "agent", state defaults to
// "proposed", task payloads are canonicalized). Actions have no `document`
// target (unlike pins/events), so there's no doc-cache resolution here.
func (h *Handler) ProposeActionsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	type actionItem struct {
		Type         string          `json:"type"`
		State        string          `json:"state"`
		Payload      json.RawMessage `json:"payload"`
		ProposedBy   string          `json:"proposedBy"`
		LinkedPinIDs []uuid.UUID     `json:"linkedPinIds"`
	}
	var body struct {
		Actions []actionItem `json:"actions"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.Actions) == 0 {
		writeError(w, http.StatusBadRequest, "actions: at least one action is required")
		return
	}
	actions := make([]*store.Action, 0, len(body.Actions))
	for i := range body.Actions {
		item := body.Actions[i]
		if item.Type == "" {
			item.Type = "navigate"
		}
		if item.ProposedBy == "" {
			item.ProposedBy = "agent"
		}
		switch item.State {
		case "":
			item.State = "proposed"
		case "proposed", "approved":
		default:
			writeError(w, http.StatusBadRequest, "state must be 'proposed' or 'approved'")
			return
		}
		if item.Type == "task" {
			canonical, err := canonicalizeTaskPayload(item.Payload)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			item.Payload = canonical
		}
		action := &store.Action{
			ID: uuid.New(), Kind: "action",
			Type: item.Type, State: item.State,
			Payload:      item.Payload,
			ProposedBy:   item.ProposedBy,
			LinkedPinIDs: item.LinkedPinIDs,
		}
		if item.State == "approved" {
			action.ApprovedBy = &item.ProposedBy
		}
		actions = append(actions, action)
	}
	// Tasks in the batch get consecutive tickets from ONE reservation call.
	h.assignTicketsBestEffort(r.Context(), canvasID, actions...)
	if _, err := h.store.CreateActions(r.Context(), canvasID, actions); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, map[string]any{"actions": actions})
}

// GET /api/canvas/actions?state=&type=&assignee=  — list actions, optionally
// filtered. assignee filters on payload.assignee ("agent" matches tasks that
// predate the field).
func (h *Handler) ListActions(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	stateFilter := r.URL.Query().Get("state")
	typeFilter := r.URL.Query().Get("type")
	assigneeFilter := r.URL.Query().Get("assignee")
	actions, err := h.store.ListActions(r.Context(), canvasID, stateFilter, typeFilter, assigneeFilter)
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
	resp := map[string]any{"action": action}
	// Tasks get their linked roadmap items / notes hydrated so one read hands
	// an agent session the task plus its context — no full state pull needed.
	if action.Type == "task" {
		var p struct {
			LinkedIDs []uuid.UUID `json:"linkedIds"`
		}
		_ = json.Unmarshal(action.Payload, &p)
		linked, err := h.store.GetLinkedEntities(r.Context(), canvasID, p.LinkedIDs)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		resp["linked"] = linked
	}
	writeJSON(w, http.StatusOK, resp)
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
	// Idempotency: a client whose request timed out while the server was still
	// finishing (see broadcastStateAsync) may retry a transition that already
	// landed. Re-requesting the state the action is already in is a no-op success,
	// not an "illegal transition: done → done" error — the retry should look like
	// the (missed) first response.
	if current.State == to {
		writeJSON(w, http.StatusOK, map[string]any{"action": current})
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
	// The transition is persisted — respond now and fan the new state out to WS
	// viewers asynchronously so a slow full-canvas broadcast can't stall (and time
	// out) the caller. Reflect the patch onto the loaded action to answer without a
	// second round-trip.
	fresh := *current
	fresh.State = to
	if patch.Result != nil {
		fresh.Result = patch.Result
	}
	if patch.Error != nil {
		fresh.Error = patch.Error
	}
	if patch.ApprovedBy != nil {
		fresh.ApprovedBy = patch.ApprovedBy
	}
	if len(patch.Payload) > 0 {
		fresh.Payload = patch.Payload
	}
	fresh.UpdatedAt = time.Now().UTC()
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]any{"action": &fresh})
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

// PATCH /api/canvas/actions/{id}  — two modes:
//   - with `state`: executor transition (approved → executing → done|failed)
//   - payload only (no state): content edit — rewrite a task's title/body/links
//     without touching the state machine.
func (h *Handler) UpdateActionState(w http.ResponseWriter, r *http.Request) {
	var body struct {
		State   string          `json:"state"`
		Result  *string         `json:"result"`
		Error   *string         `json:"error"`
		Payload json.RawMessage `json:"payload"`
		// AgentName is the claimant identity for state='executing' (task_start).
		// Canvas JWTs carry no per-agent identity, so the gateway passes the
		// registered agent name/id here; empty falls back to the generic "agent".
		AgentName string `json:"agentName"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.State == "" && len(body.Payload) > 0 {
		h.updateActionPayload(w, r, body.Payload)
		return
	}
	switch body.State {
	case "executing":
		// Task-start is a CLAIM, not a plain transition: approved → executing is
		// decided atomically in the DB so concurrent starts get exactly one winner.
		h.claimAction(w, r, body.AgentName)
		return
	case "done", "failed":
		// allowed via update_state; approve/reject have their own endpoints
	default:
		writeError(w, http.StatusBadRequest, "state must be 'executing', 'done', or 'failed'")
		return
	}
	h.transitionAction(w, r, body.State, store.ActionStatePatch{
		Result: body.Result, Error: body.Error, Payload: body.Payload,
	})
}

// claimAction is the task-start path: approved → executing decided by a single
// conditional UPDATE in the store (WHERE state='approved'), replacing the old
// read-check-write flow where two concurrent task_starts could both win. The
// loser gets a structured 409 carrying who holds the claim, so it can move on
// to the next task instead of duplicating work.
func (h *Handler) claimAction(w http.ResponseWriter, r *http.Request, agentName string) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if agentName == "" {
		agentName = "agent"
	}
	action, _, err := h.store.ClaimAction(r.Context(), canvasID, id, agentName)
	if err != nil {
		var claimed *store.AlreadyClaimedError
		switch {
		case errors.As(err, &claimed):
			writeJSON(w, http.StatusConflict, map[string]string{
				"error":     "already_claimed",
				"claimedBy": claimed.ClaimedBy,
			})
		case errors.Is(err, store.ErrActionNotFound):
			writeError(w, http.StatusNotFound, "action not found")
		case errors.Is(err, store.ErrIllegalActionState):
			writeError(w, http.StatusBadRequest, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]any{"action": action})
}

// POST /api/canvas/actions/{id}/release — stuck-claim escape hatch: an
// executing task whose agent session died goes back to approved with its
// claim cleared, so the queue can hand it out again.
//
// HUMAN-ONLY BY SURFACE, not by token: a canvas JWT is identical for a browser
// and an MCP/agent caller (both come from /api/mcp/auth), and anonymous web
// users on public canvases carry no session cookie — so the token genuinely
// cannot distinguish human from agent here. The gate is that this endpoint is
// deliberately NOT exposed through the MCP gateway (no tool maps to it — an
// agent that lost a claim must ask a human, never un-claim a peer itself);
// only the web Tasks panel's Release button calls it. If canvas tokens ever
// grow an origin claim (browser vs gateway), enforce it here instead.
func (h *Handler) ReleaseAction(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	action, _, err := h.store.ReleaseAction(r.Context(), canvasID, id)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrActionNotFound):
			writeError(w, http.StatusNotFound, "action not found")
		case errors.Is(err, store.ErrIllegalActionState):
			writeError(w, http.StatusBadRequest, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]any{"action": action})
}

// DELETE /api/canvas/actions/{id}  — remove an action (e.g. delete a task from
// the queue). Terminal for any state — no state-machine guard.
func (h *Handler) DeleteAction(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if _, err := h.store.DeleteAction(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// updateActionPayload is the payload-only PATCH path (task content edits).
func (h *Handler) updateActionPayload(w http.ResponseWriter, r *http.Request, payload json.RawMessage) {
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
	if current.Type == "task" {
		canonical, err := canonicalizeTaskPayload(payload)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		payload = canonical
	}
	if _, err := h.store.UpdateActionPayload(r.Context(), canvasID, id, payload); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	fresh, err := h.store.GetAction(r.Context(), canvasID, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"action": fresh})
}
