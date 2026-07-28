package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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

// canonicalizeEpicPayload validates an epic payload: title is required. An epic
// is a batch of related work ({title, body, linkedIds[]}); tasks reference it
// via their payload epicId. Unknown fields pass through untouched.
func canonicalizeEpicPayload(raw json.RawMessage) (json.RawMessage, error) {
	var p map[string]any
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("epic payload must be an object")
	}
	title, _ := p["title"].(string)
	if title == "" {
		return nil, fmt.Errorf("epic payload requires a non-empty title")
	}
	return json.Marshal(p)
}

// taskPolicyFields are the payload fields the approval-policy cascade reads.
type taskPolicyFields struct {
	EpicID           string `json:"epicId"`
	RequiresApproval bool   `json:"requiresApproval"`
}

// policyApproval decides whether an agent-proposed task is born approved under
// the canvas approval policy (migration 0033). Returns the approved_by
// provenance stamp ("policy:auto" / "policy:epic"), or "" when the task must
// land proposed. epicApproved reports whether an id names an APPROVED epic.
//   - requiresApproval:true in the payload always lands proposed (the agent
//     self-flags deviations), regardless of policy.
//   - 'strict': every agent task lands proposed.
//   - 'auto':   every agent task is born approved.
//   - 'epic' (default, incl. legacy empty): approved iff the task carries an
//     epicId naming an approved epic; no epic / proposed epic → proposed.
func policyApproval(policy string, payload json.RawMessage, epicApproved func(uuid.UUID) bool) string {
	var f taskPolicyFields
	_ = json.Unmarshal(payload, &f)
	if f.RequiresApproval {
		return ""
	}
	switch policy {
	case "strict":
		return ""
	case "auto":
		return "policy:auto"
	default: // 'epic' — also the fallback for legacy rows with no policy yet
		id, err := uuid.Parse(f.EpicID)
		if err != nil {
			return ""
		}
		if epicApproved(id) {
			return "policy:epic"
		}
		return ""
	}
}

// policyResolver applies policyApproval for a request, lazily loading the
// canvas policy and epic states at most once each (the batch path may resolve
// many tasks). Store failures fail CLOSED — the task lands proposed.
type policyResolver struct {
	h        *Handler
	ctx      context.Context
	canvasID uuid.UUID
	policy   *string
	epics    map[uuid.UUID]bool
}

func (pr *policyResolver) stamp(payload json.RawMessage) string {
	if pr.policy == nil {
		policy := ""
		if canvas, err := pr.h.store.GetCanvasByID(pr.ctx, pr.canvasID); err == nil {
			policy = canvas.ApprovalPolicy
		} else {
			policy = "strict" // can't read the policy → keep the human gate
		}
		pr.policy = &policy
	}
	return policyApproval(*pr.policy, payload, func(epicID uuid.UUID) bool {
		if pr.epics == nil {
			pr.epics = map[uuid.UUID]bool{}
		}
		approved, seen := pr.epics[epicID]
		if !seen {
			epic, err := pr.h.store.GetAction(pr.ctx, pr.canvasID, epicID)
			approved = err == nil && epic.Type == "epic" && epic.State == "approved"
			pr.epics[epicID] = approved
		}
		return approved
	})
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
	if body.Type == "epic" {
		canonical, err := canonicalizeEpicPayload(body.Payload)
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
	// Approval-policy cascade (server-side, never in the gateway): an
	// agent-proposed task may be born approved under the canvas policy.
	if action.Type == "task" && action.State == "proposed" {
		pr := &policyResolver{h: h, ctx: r.Context(), canvasID: canvasID}
		if stamp := pr.stamp(action.Payload); stamp != "" {
			action.State = "approved"
			action.ApprovedBy = &stamp
		}
	}
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
	// One resolver for the whole batch — the canvas policy and each epic's state
	// load at most once no matter how many tasks reference them.
	pr := &policyResolver{h: h, ctx: r.Context(), canvasID: canvasID}
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
		if item.Type == "epic" {
			canonical, err := canonicalizeEpicPayload(item.Payload)
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
		// Approval-policy cascade — same rule as ProposeAction. NOTE: an epic
		// proposed in this same batch is not yet approved, so its tasks land
		// proposed and flow when the human approves the epic.
		if action.Type == "task" && action.State == "proposed" {
			if stamp := pr.stamp(action.Payload); stamp != "" {
				action.State = "approved"
				action.ApprovedBy = &stamp
			}
		}
		actions = append(actions, action)
	}
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
			EpicID    string      `json:"epicId"`
		}
		_ = json.Unmarshal(action.Payload, &p)
		linked, err := h.store.GetLinkedEntities(r.Context(), canvasID, p.LinkedIDs)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		resp["linked"] = linked
		// Hydrate the epic (title + state) so a session sees the batch this task
		// belongs to without another read. Best effort — a dangling epicId is
		// simply omitted.
		if epicID, err := uuid.Parse(p.EpicID); err == nil {
			if epic, err := h.store.GetAction(r.Context(), canvasID, epicID); err == nil && epic.Type == "epic" {
				var ep struct {
					Title string `json:"title"`
				}
				_ = json.Unmarshal(epic.Payload, &ep)
				resp["epic"] = map[string]any{"id": epic.ID, "title": ep.Title, "state": epic.State}
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// transitionAction loads the action, checks the proposed→to move is legal,
// applies the patch, and writes the fresh action to the response. Shared by
// approve / reject / update_state so the state-machine guard lives in exactly
// one place. Returns the fresh action and whether the transition landed (false
// on error AND on the idempotent already-there no-op), so a caller can chain
// follow-up work — e.g. approving an epic cascades to its tasks.
func (h *Handler) transitionAction(w http.ResponseWriter, r *http.Request, to string, patch store.ActionStatePatch) (*store.Action, bool) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return nil, false
	}
	current, err := h.store.GetAction(r.Context(), canvasID, id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return nil, false
	}
	// Idempotency: a client whose request timed out while the server was still
	// finishing (see broadcastStateAsync) may retry a transition that already
	// landed. Re-requesting the state the action is already in is a no-op success,
	// not an "illegal transition: done → done" error — the retry should look like
	// the (missed) first response.
	if current.State == to {
		writeJSON(w, http.StatusOK, map[string]any{"action": current})
		return current, false
	}
	if !canTransition(current.State, to) {
		writeError(w, http.StatusBadRequest, "illegal transition: "+current.State+" → "+to)
		return nil, false
	}
	patch.State = to
	if _, err := h.store.UpdateActionState(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return nil, false
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
	return &fresh, true
}

// POST /api/canvas/actions/{id}/approve  — human gate: proposed → approved.
// Approving an EPIC also batch-approves its currently-proposed tasks (payload
// epicId = the epic's id) with the 'policy:epic' provenance stamp — the
// one-time gate that lets the whole batch flow.
func (h *Handler) ApproveAction(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ApprovedBy string `json:"approvedBy"`
	}
	_ = decode(r, &body)
	approvedBy := body.ApprovedBy
	if approvedBy == "" {
		approvedBy = "human"
	}
	fresh, ok := h.transitionAction(w, r, "approved", store.ActionStatePatch{ApprovedBy: &approvedBy})
	if ok && fresh.Type == "epic" {
		// The response is already written; the cascade is follow-up work. Detach
		// from the request context like broadcastStateAsync does, then push one
		// more state broadcast so viewers see the tasks flip.
		ctx := context.WithoutCancel(r.Context())
		canvasID := CanvasIDFromCtx(ctx)
		if _, err := h.store.ApproveEpicTasks(ctx, canvasID, fresh.ID, "policy:epic"); err != nil {
			log.Printf("approve epic %s: batch-approving its tasks: %v", fresh.ID, err)
			return
		}
		broadcastStateAsync(ctx, h.store, h.hub, canvasID)
	}
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
	if current.Type == "epic" {
		canonical, err := canonicalizeEpicPayload(payload)
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
