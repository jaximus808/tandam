package api

import (
	"context"
	"encoding/json"
	"errors"
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
	// Canonicalize epicId: the epic cascade (ApproveEpicTasks) and the gateway's
	// epicId filter match on the STORED text, so a non-canonical UUID spelling
	// (uppercase, braces) would make the task invisible to both. Parse and
	// re-store the canonical form; reject garbage outright.
	if raw, present := p["epicId"]; present {
		s, _ := raw.(string)
		if s == "" {
			delete(p, "epicId")
		} else {
			id, err := uuid.Parse(s)
			if err != nil {
				return nil, fmt.Errorf("epicId must be a valid epic action id")
			}
			p["epicId"] = id.String()
		}
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
	fresh, _ := h.transitionAction(w, r, "approved", store.ActionStatePatch{ApprovedBy: &approvedBy})
	// Cascade whenever the epic IS approved, not only on the first transition:
	// ApproveEpicTasks is an idempotent bulk UPDATE, so re-running it on an
	// approve retry repairs a previously-failed cascade instead of stranding the
	// batch behind the no-op idempotency path above.
	if fresh != nil && fresh.Type == "epic" && fresh.State == "approved" {
		// The response is already written; the cascade is follow-up work. Detach
		// from the request context like broadcastStateAsync does, then push one
		// more state broadcast so viewers see the tasks flip.
		ctx := context.WithoutCancel(r.Context())
		canvasID := CanvasIDFromCtx(ctx)
		// The batch flow is a property of the 'epic' (and 'auto') policies. Under
		// 'strict' every agent task keeps its own gate — approving the epic must
		// not mass-approve its tasks. Unreadable policy fails closed, like the
		// birth-time cascade.
		canvas, err := h.store.GetCanvasByID(ctx, canvasID)
		if err != nil || canvas.ApprovalPolicy == "strict" {
			if err != nil {
				log.Printf("approve epic %s: reading approval policy (cascade skipped): %v", fresh.ID, err)
			}
			return
		}
		n, err := h.store.ApproveEpicTasks(ctx, canvasID, fresh.ID, "policy:epic")
		if err != nil {
			log.Printf("approve epic %s: batch-approving its tasks: %v", fresh.ID, err)
			return
		}
		if n > 0 {
			broadcastStateAsync(ctx, h.store, h.hub, canvasID)
		}
	}
}

// POST /api/canvas/actions/approve-batch  — bulk human gate: flip every listed
// action still in 'proposed' to approved in ONE conditional UPDATE + ONE
// version bump + ONE broadcast (never N serial round trips — the batch-latency
// lesson). Ids that don't match (missing, or no longer proposed) come back in
// `skipped` instead of failing the batch, so a stale panel retry is harmless.
// Any EPIC that became approved here gets the same post-approve cascade as the
// single-approve path: under the 'epic'/'auto' policies its proposed tasks are
// batch-approved (ApproveEpicTasks, which itself skips requiresApproval:true);
// under 'strict' every task keeps its own gate.
func (h *Handler) ApproveActionsBatch(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		IDs        []uuid.UUID `json:"ids"`
		ApprovedBy string      `json:"approvedBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "ids: at least one action id is required")
		return
	}
	if body.ApprovedBy == "" {
		body.ApprovedBy = "human"
	}
	rows, err := h.store.ApproveActionsBatch(r.Context(), canvasID, body.IDs, body.ApprovedBy)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	approvedSet := make(map[uuid.UUID]bool, len(rows))
	approved := make([]uuid.UUID, 0, len(rows))
	for _, a := range rows {
		approvedSet[a.ID] = true
		approved = append(approved, a.ID)
	}
	// skipped = requested ids that didn't flip (not found or not proposed),
	// deduped so a repeated id doesn't report twice.
	skipped := make([]uuid.UUID, 0)
	seen := make(map[uuid.UUID]bool, len(body.IDs))
	for _, id := range body.IDs {
		if !approvedSet[id] && !seen[id] {
			seen[id] = true
			skipped = append(skipped, id)
		}
	}
	if len(approved) > 0 {
		broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"approved": approved, "skipped": skipped})

	// Post-approve epic cascade — the response is already written; this is
	// follow-up work, detached from the request context like ApproveAction's.
	var epics []*store.Action
	for _, a := range rows {
		if a.Type == "epic" {
			epics = append(epics, a)
		}
	}
	if len(epics) == 0 {
		return
	}
	ctx := context.WithoutCancel(r.Context())
	// Policy check mirrors ApproveAction: under 'strict' approving an epic is
	// bookkeeping — its tasks keep their individual gates. Unreadable policy
	// fails closed (cascade skipped).
	canvas, err := h.store.GetCanvasByID(ctx, canvasID)
	if err != nil || canvas.ApprovalPolicy == "strict" {
		if err != nil {
			log.Printf("approve-batch: reading approval policy (epic cascade skipped): %v", err)
		}
		return
	}
	total := 0
	for _, epic := range epics {
		n, err := h.store.ApproveEpicTasks(ctx, canvasID, epic.ID, "policy:epic")
		if err != nil {
			log.Printf("approve-batch epic %s: batch-approving its tasks: %v", epic.ID, err)
			continue
		}
		total += n
	}
	// One extra broadcast for the whole cascade, only if any task flipped.
	if total > 0 {
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
	// Terminal transitions respect the claim: a task another NAMED agent holds
	// cannot be completed out from under it (the atomic claim would otherwise
	// buy exclusivity at start and nothing at finish). The generic "agent"
	// holder is exempt, mirroring ClaimAction's idempotency rule; a caller
	// sending no identity (the web surface) is not blocked.
	if body.AgentName != "" {
		canvasID := CanvasIDFromCtx(r.Context())
		if id, perr := uuid.Parse(chi.URLParam(r, "id")); perr == nil {
			if current, gerr := h.store.GetAction(r.Context(), canvasID, id); gerr == nil &&
				current.State == "executing" && current.ClaimedBy != nil {
				holder := *current.ClaimedBy
				if holder != "" && holder != "agent" && holder != body.AgentName {
					writeJSON(w, http.StatusConflict, map[string]string{
						"error":     "claimed_by_other",
						"claimedBy": holder,
					})
					return
				}
			}
		}
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

// POST /api/canvas/actions/{id}/requeue — send a FAILED task back to the
// queue: failed → approved, clearing claimed_by/claimed_at AND error, so an
// agent session can pick it up fresh. The failed → approved transition exists
// ONLY here — it is deliberately absent from validActionStates, so the generic
// PATCH path can never make it: an agent must not requeue its own (or a
// peer's) failure; a human decides a failed task deserves another shot.
//
// HUMAN-ONLY BY SURFACE, exactly like ReleaseAction above: the canvas JWT
// cannot distinguish human from agent, so the gate is that no MCP gateway tool
// maps to this endpoint — only the web task surfaces call it. Re-queueing a
// task that is already back in 'approved' is an idempotent success.
func (h *Handler) RequeueAction(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	action, _, err := h.store.RequeueAction(r.Context(), canvasID, id)
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
