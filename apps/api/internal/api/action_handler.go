package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/webhooks"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// ── Agents (v1 identity / provenance) ─────────────────────────────────────────

// POST /api/canvas/agents  — an agent identifies itself on connect. An
// orchestrator's subagents pass parentAgentId (the orchestrator's registered
// agent id) so the swarm view can group them structurally; absent → unparented,
// flat display, exactly as before. Re-registering a name is idempotent (TDM-8):
// the store upserts on (canvas_id, name), so the SAME agentId comes back with
// its fields refreshed — never a duplicate row.
func (h *Handler) RegisterAgent(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Name          string     `json:"name"`
		Role          string     `json:"role"`
		Model         *string    `json:"model"`
		ParentAgentID *uuid.UUID `json:"parentAgentId"`
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
	// A parent must be a registered agent on THIS canvas: the DB FK is not
	// canvas-scoped, so without this check a cross-canvas id would insert fine
	// and render as a silently-flat child; a nonexistent id would 500 on the FK.
	if body.ParentAgentID != nil {
		if _, err := h.store.GetAgent(r.Context(), canvasID, *body.ParentAgentID); err != nil {
			writeError(w, http.StatusBadRequest, "parentAgentId does not name a registered agent on this canvas")
			return
		}
	}
	// No pre-generated id: RegisterAgent is an upsert on (canvas_id, name) and
	// fills agent.ID with the SURVIVING row's id — the existing one on a
	// re-register, a DB-generated one on first insert — so the response below
	// always names the row that actually holds this identity.
	agent := &store.Agent{
		Kind: "agent",
		Name: body.Name, Role: body.Role, Model: body.Model,
		ParentAgentID: body.ParentAgentID,
	}
	if _, err := h.store.RegisterAgent(r.Context(), canvasID, agent); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	resp := map[string]any{"agentId": agent.ID.String()}
	if agent.ParentAgentID != nil {
		resp["parentAgentId"] = agent.ParentAgentID.String()
	}
	writeJSON(w, http.StatusCreated, resp)
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
		// Provenance (TDM-40): derived from the auth context by the Provenance
		// middleware, NOT from the body — note there is no authoredBy field on
		// the struct above, so a client that sends one is silently ignored.
		AuthoredBy:   AuthorFromCtx(r.Context()),
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
	// A task can be BORN approved — a human passing state:"approved", or the
	// 'auto'/'epic' approval policy stamping it above. Either way it just entered
	// the ready-to-work queue, so it is a task.approved like any other. Emitted
	// only after the insert committed (TDM-37).
	if action.State == "approved" {
		h.emitTaskEvent(canvasID, webhooks.EventTaskApproved, action)
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	broadcastProposeActivity(h.hub, canvasID, action) // TDM-46 live fleet feed
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
	// Provenance (TDM-40) is a property of the REQUEST, so it's derived once and
	// stamped on every action in the batch — a caller can't mix authorship by
	// varying the body, because no body field feeds it.
	author := AuthorFromCtx(r.Context())
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
			AuthoredBy:   author,
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
	// One task.approved per task born approved — same rule as ProposeAction, and
	// per-task even though the insert was one round trip (TDM-37).
	for _, a := range actions {
		if a.State == "approved" {
			h.emitTaskEvent(canvasID, webhooks.EventTaskApproved, a)
		}
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	broadcastProposeActivity(h.hub, canvasID, actions...) // TDM-46 live fleet feed
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
		writeError(w, http.StatusBadRequest, "invalid id: expected a task uuid or an existing ticket ref like TDM-21")
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
//
// `caller` is the claim identity behind the request, and this is where the claim
// fence applies to EVERY transition (TDM-98): the MCP/web completion PATCH, the
// CI status API's completed/failed, and the human board's Done button all funnel
// through here, so fencing here is what makes "you cannot finish a task you no
// longer hold" true on all of them at once rather than on whichever handler
// remembered to check. Approve/reject pass a zero claimant — a proposed task has
// no holder to fence against (see claim_fence.go's audit table).
func (h *Handler) transitionAction(w http.ResponseWriter, r *http.Request, to string, patch store.ActionStatePatch, caller claimant) (*store.Action, bool) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id: expected a task uuid or an existing ticket ref like TDM-21")
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
	// The claim fence, before anything is written: a caller that presents a claim
	// identity must still hold this task. Checked AFTER the idempotent no-op above
	// on purpose — a retry of a transition that already landed is answered like the
	// first response, and re-fencing it would turn a lost 200 into a scary 409 for
	// a caller that did nothing wrong.
	if !h.fenceTaskWriteOrFail(w, current, caller) {
		return nil, false
	}
	// The content gate's other door (TDM-41). ActionStatePatch can carry a
	// payload — legitimately, for the additive bookkeeping the status API writes
	// alongside a completion (evidence links) and for the navigate executor's
	// computed waypoints. But that makes `PATCH {state:"done", payload:{title:…}}`
	// a way to rewrite approved content in the same breath as ending the task,
	// which would walk straight past updateActionPayload's gate. Content changes
	// simply do not ride transitions: they belong on the payload-only path, where
	// they are audited and (on an approved/executing task) revert the approval.
	//
	// This check sits here rather than in the callers because transitionAction is
	// the single funnel every transition goes through — the MCP/web PATCH, the
	// status API's completed/failed, approve and reject alike.
	if len(patch.Payload) > 0 {
		if changed := store.ContentDiff(current.Payload, patch.Payload); len(changed) > 0 {
			writeJSON(w, http.StatusConflict, map[string]string{
				"error": "content_locked",
				"message": "a state change cannot also rewrite the task's " + strings.Join(changed, " and ") +
					" — edit content with a payload-only PATCH, which re-enters the approval gate",
			})
			return nil, false
		}
		// The claim record is server-owned, and this is the one payload door that
		// writes raw (see store.CarryClaimRecord): whatever the caller sent under
		// `claim`, the stored record is what gets stored again.
		patch.Payload = store.CarryClaimRecord(patch.Payload, current.Payload)
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
	// TDM-46 live fleet feed. ONE line covers approve / reject / complete on
	// every surface — the MCP PATCH and the CI status API both funnel through
	// here — and activityVerbFor returns "" (no-op) for anything else.
	broadcastActionActivity(h.hub, canvasID, activityVerbFor(to), &fresh)
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
	// No claimant: approve is the human gate on a PROPOSED task, which by
	// definition has no holder to fence against (see claim_fence.go).
	fresh, moved := h.transitionAction(w, r, "approved", store.ActionStatePatch{ApprovedBy: &approvedBy}, claimant{})
	// task.approved fires on the TRANSITION only (moved), never on the idempotent
	// already-approved retry — a client re-sending an approve must not hand the
	// fleet the same task twice. emitTaskEvent skips non-tasks, so approving an
	// EPIC emits nothing here; its tasks each get their own event from the
	// cascade below.
	if moved {
		h.emitTaskEvent(CanvasIDFromCtx(r.Context()), webhooks.EventTaskApproved, fresh)
	}
	// Cascade whenever the epic IS approved, not only on the first transition:
	// ApproveEpicTasks is an idempotent bulk UPDATE, so re-running it on an
	// approve retry repairs a previously-failed cascade instead of stranding the
	// batch behind the no-op idempotency path above.
	if fresh != nil && fresh.Type == "epic" && fresh.State == "approved" {
		// The response is already written; the cascade is follow-up work. Runs in
		// a detached goroutine (like broadcastStateAsync) so it neither delays the
		// return nor lands in the route-latency histogram, then pushes one more
		// state broadcast so viewers see the tasks flip.
		ctx := context.WithoutCancel(r.Context())
		canvasID := CanvasIDFromCtx(ctx)
		epicID := fresh.ID
		go func() {
			// The batch flow is a property of the 'epic' (and 'auto') policies.
			// Under 'strict' every agent task keeps its own gate — approving the
			// epic must not mass-approve its tasks. Unreadable policy fails
			// closed, like the birth-time cascade.
			canvas, err := h.store.GetCanvasByID(ctx, canvasID)
			if err != nil || canvas.ApprovalPolicy == "strict" {
				if err != nil {
					log.Printf("approve epic %s: reading approval policy (cascade skipped): %v", epicID, err)
				}
				return
			}
			tasks, err := h.store.ApproveEpicTasks(ctx, canvasID, epicID, "policy:epic")
			if err != nil {
				log.Printf("approve epic %s: batch-approving its tasks: %v", epicID, err)
				return
			}
			if len(tasks) > 0 {
				// The fan-out is per TASK, not per epic: each of these just
				// entered the queue and each is separately claimable.
				h.emitTaskApprovedEach(canvasID, tasks)
				broadcastStateAsync(ctx, h.store, h.hub, canvasID)
				broadcastActionActivity(h.hub, canvasID, activityApproved, tasks...) // TDM-46
			}
		}()
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
		// N approvals are N events. `rows` holds only the ids that ACTUALLY
		// flipped, so a stale panel retry (ids already approved → skipped) emits
		// nothing. Non-task rows (epics) are filtered inside emitTaskEvent.
		h.emitTaskApprovedEach(canvasID, rows)
		broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
		broadcastActionActivity(h.hub, canvasID, activityApproved, rows...) // TDM-46
	}
	writeJSON(w, http.StatusOK, map[string]any{"approved": approved, "skipped": skipped})

	// Post-approve epic cascade — the response is already written; this is
	// follow-up work. Runs in a detached goroutine so it neither delays the
	// handler return nor pollutes the route-latency histogram with work the
	// client never waited for.
	var epicIDs []uuid.UUID
	for _, a := range rows {
		if a.Type == "epic" {
			epicIDs = append(epicIDs, a.ID)
		}
	}
	// Cascade repair: a skipped id may be an epic that is ALREADY approved but
	// whose earlier cascade failed (tasks stranded proposed). Re-firing the
	// idempotent bulk approve here gives bulk-select the same repair semantics
	// as single-approve's retry path.
	for _, id := range skipped {
		if a, err := h.store.GetAction(r.Context(), canvasID, id); err == nil &&
			a.Type == "epic" && a.State == "approved" {
			epicIDs = append(epicIDs, a.ID)
		}
	}
	if len(epicIDs) == 0 {
		return
	}
	ctx := context.WithoutCancel(r.Context())
	go func() {
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
		for _, epicID := range epicIDs {
			tasks, err := h.store.ApproveEpicTasks(ctx, canvasID, epicID, "policy:epic")
			if err != nil {
				log.Printf("approve-batch epic %s: batch-approving its tasks: %v", epicID, err)
				continue
			}
			// Per-task events, emitted per epic as each cascade commits — a
			// later epic failing must not swallow the earlier ones' events.
			h.emitTaskApprovedEach(canvasID, tasks)
			broadcastActionActivity(h.hub, canvasID, activityApproved, tasks...) // TDM-46
			total += len(tasks)
		}
		// One extra broadcast for the whole cascade, only if any task flipped.
		if total > 0 {
			broadcastStateAsync(ctx, h.store, h.hub, canvasID)
		}
	}()
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
	// No claimant, same reason as approve: rejection is the other exit from the
	// human gate, and 'proposed' is never claimed.
	h.transitionAction(w, r, "rejected", store.ActionStatePatch{Error: reason}, claimant{})
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
		// Links is completion EVIDENCE (TDM-45): commit / PR / branch URLs the
		// board resolves against GitHub. Same field, same additive merge, and the
		// same caps as the inbound status API's links[] — one shape for evidence
		// whether the report arrives by MCP or by curl. Only read on a terminal
		// transition; see the merge below.
		Links []string `json:"links"`
		// ClaimGeneration is the fencing token this caller holds (TDM-98) — the
		// `claim.generation` a successful claim handed back. Optional: absent means
		// the holder-identity check alone, which is what every client before the
		// token got. Present and stale means refused, whatever AgentName says.
		ClaimGeneration int `json:"claimGeneration"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	caller := callerClaim(r, body.AgentName, body.ClaimGeneration)
	if body.State == "" && len(body.Payload) > 0 {
		h.updateActionPayload(w, r, body.Payload, caller)
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
	// buy exclusivity at start and nothing at finish), and neither can a task
	// whose lease has since been reclaimed — that check now lives in
	// transitionAction, which every completion on every surface goes through, so
	// there is no longer a per-handler copy of it here (TDM-98).
	if body.AgentName != "" {
		canvasID := CanvasIDFromCtx(r.Context())
		// Liveness heartbeat: completing (or failing) a task proves the agent is
		// alive — refresh its last_seen_at so the swarm view gets a short grace
		// window between tasks instead of flickering offline. Touch-or-create: a
		// session that worked a task without ever calling agent_register gets a
		// minimal executor row, so it still shows in presence. Best-effort and
		// DETACHED: presence must never add a round-trip to the complete path
		// (the exact latency the loadtest measures).
		touchCtx := context.WithoutCancel(r.Context())
		agentName := body.AgentName
		go func() {
			if err := h.store.TouchOrCreateAgent(touchCtx, canvasID, agentName); err != nil {
				log.Printf("complete: touching agent last_seen (%s): %v", agentName, err)
			}
		}()
	}
	patch := store.ActionStatePatch{Result: body.Result, Error: body.Error, Payload: body.Payload}
	// Evidence rides the SAME write as the transition — one round trip, and no
	// window where a task is done but the commit that finished it hasn't landed.
	// Merged ADDITIVELY through the status API's own merge (append, dedupe, cap),
	// because this PATCH otherwise REPLACES the payload wholesale and a caller
	// sending only links must not blank the task's title.
	if len(body.Links) > 0 {
		links, lerr := normalizeStatusLinks(body.Links)
		if lerr != nil {
			writeError(w, http.StatusBadRequest, lerr.Error())
			return
		}
		base, haveBase := body.Payload, len(body.Payload) > 0
		if !haveBase {
			// No payload in the body (the task_complete shape): read the stored one
			// so the merge appends rather than replaces. If the read fails, the
			// links are DROPPED rather than written onto an empty object — losing
			// evidence beats erasing a task's content.
			if id, perr := uuid.Parse(chi.URLParam(r, "id")); perr == nil {
				if current, gerr := h.store.GetAction(r.Context(), CanvasIDFromCtx(r.Context()), id); gerr == nil {
					base, haveBase = current.Payload, true
				} else {
					log.Printf("complete: links dropped, could not read task %s: %v", id, gerr)
				}
			}
		}
		if haveBase {
			merged, changed, merr := mergeTaskStatusPayload(base, "", "", links, time.Now().UTC())
			if merr != nil {
				writeError(w, http.StatusBadRequest, merr.Error())
				return
			}
			if changed {
				patch.Payload = merged
			}
		}
	}
	fresh, moved := h.transitionAction(w, r, body.State, patch, caller)
	// Terminal transition → task.completed, for 'done' AND 'failed' alike; the
	// payload's task.state says which, and task.error carries the failure reason.
	// (Rationale for folding 'failed' in here rather than staying silent: see the
	// package note in task_events.go.) `moved` is false on the idempotent
	// already-done retry, so a re-sent completion notifies once.
	if moved {
		h.emitTaskEvent(CanvasIDFromCtx(r.Context()), webhooks.EventTaskCompleted, fresh)
	}
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
		writeError(w, http.StatusBadRequest, "invalid id: expected a task uuid or an existing ticket ref like TDM-21")
		return
	}
	if agentName == "" {
		agentName = "agent"
	}
	action, err := h.claimTask(r.Context(), canvasID, id, agentName)
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
	// The response carries the fencing token this claim minted (TDM-98) — the
	// claimant must present it on every later write to the task.
	writeClaimed(w, action)
}

// claimTask is THE claim — the atomic store call plus the two side effects every
// claim owes the rest of the system, with no HTTP in it. Both surfaces that can
// start a task go through here: the MCP/web PATCH (claimAction, above) and the
// inbound status API a CI job curls (statusStarted, TDM-38). That's the point —
// a curl from GitHub Actions and an MCP task_start must leave the board, the
// presence view and the webhook stream in states nobody can tell apart.
//
// The caller maps the error onto a status code and broadcasts state; everything
// that must happen REGARDLESS of surface lives here.
func (h *Handler) claimTask(ctx context.Context, canvasID, id uuid.UUID, agentName string) (*store.Action, error) {
	return h.claimTaskAs(ctx, canvasID, id, agentName, true)
}

// claimTaskAs is claimTask with the presence side effect made explicit.
//
// `presence` is true for every AGENT surface: a claimant that never called
// agent_register still belongs in the roster, so the claim touch-or-creates its
// agents row. It is false for the human board controls (see MoveAction), and
// that distinction is the whole reason this parameter exists — a person marking
// their own todo as started is not a fleet member, and minting an agents row
// named "human" would put a fake executor in the swarm view, permanently
// "online", for as long as the canvas lives. The claim itself is identical:
// same atomic store call, same 409, same metrics, same activity ping.
func (h *Handler) claimTaskAs(ctx context.Context, canvasID, id uuid.UUID, agentName string, presence bool) (*store.Action, error) {
	action, outcome, err := h.store.ClaimAction(ctx, canvasID, id, agentName)
	if err != nil {
		// Contention metric (TDM-42). Counted HERE, at the one function both
		// claim surfaces funnel through, rather than in the store (which would
		// have to be handed a registry and is untestable behind the fake stores)
		// or in the two HTTP handlers (which would double-count nothing today and
		// silently miss the next surface that starts a task). A lost claim is the
		// signal that matters — rising claim_conflicts means the fleet is racing
		// for the same work. Only a rival holder counts: not-found and
		// illegal-state are caller bugs, not contention.
		var claimed *store.AlreadyClaimedError
		if errors.As(err, &claimed) {
			h.metrics.IncClaimConflict()
		}
		return nil, err
	}
	h.metrics.IncClaim()
	// Liveness heartbeat: a claim proves the agent is alive — refresh its
	// last_seen_at so the swarm view's staleness threshold stays honest.
	// Touch-or-create ("when an agent takes a task it should still be
	// connected"): a claimant that never called agent_register gets a minimal
	// executor row on this canvas, so any session that takes a task appears in
	// presence/swarm views labelled with its task (the web side already matches
	// claimedBy → agent name). This is also what puts a CI job on the board as a
	// named member. Best-effort and DETACHED: presence must never add a
	// round-trip to the claim path (the exact latency the loadtest measures).
	if presence {
		touchCtx := context.WithoutCancel(ctx)
		go func() {
			if err := h.store.TouchOrCreateAgent(touchCtx, canvasID, agentName); err != nil {
				log.Printf("claim %s: touching agent last_seen (%s): %v", id, agentName, err)
			}
		}()
	}
	// TDM-46 live fleet feed: a claim is the transition the presence UI most
	// needs pushed (who just picked up what), and it is the one the webhook
	// vocabulary deliberately stays silent on.
	broadcastActionActivity(h.hub, canvasID, activityClaimed, action)
	// Claim expiry is LAZY — there is no sweeper (see store.DefaultClaimTTL), so
	// the takeover inside ClaimAction is the one and only moment a lapsed claim
	// becomes observable. A non-empty ExpiredClaimBy means THIS claim expired
	// someone else's; an ordinary claim off the queue (and a self-reclaim) emits
	// nothing — approved → executing is not an event.
	if outcome.ExpiredClaimBy != "" {
		h.metrics.IncTTLExpiry()
		log.Printf("claim %s: expired claim held by %q, taken over by %q", id, outcome.ExpiredClaimBy, agentName)
		h.emitTaskEvent(canvasID, webhooks.EventTaskClaimExpired, action, withExpiredClaim(outcome))
		// The caller's full-state broadcast already reconciles the board, but it
		// says nothing about WHY the claimant changed. This is the lightweight
		// signal the Tasks panel can surface as activity ("a claim lapsed").
		// The actor is passed explicitly (TDM-46): `action` has ALREADY been
		// restamped to the new claimant, so the agent that went dark — the
		// subject of this event — is only knowable from the outcome.
		broadcastActionActivityAs(h.hub, canvasID, activityClaimExpired, action, outcome.ExpiredClaimBy)
	}
	return action, nil
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
//
// One line on top of rewindTask (task_move.go), which is the shared body of
// every backwards human move — so a release, a requeue and a reopen leave the
// board, the activity feed and the task's audit trail in the same shape. This
// endpoint stays as its own route because it is what the web app has always
// called and because "release" is a verb worth keeping in the URL space; POST
// …/move with {"to":"approved"} on an executing task does exactly the same thing.
func (h *Handler) ReleaseAction(w http.ResponseWriter, r *http.Request) {
	note, caller := moveBody(r)
	h.rewindTask(w, r, moveRelease, note, caller)
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
//
// Shares rewindTask with release and reopen — see ReleaseAction above.
func (h *Handler) RequeueAction(w http.ResponseWriter, r *http.Request) {
	note, caller := moveBody(r)
	h.rewindTask(w, r, moveRequeue, note, caller)
}

// DELETE /api/canvas/actions/{id}  — remove an action (e.g. delete a task from
// the queue). Terminal for any state — no state-machine guard.
//
// FENCED for a caller that asserts an agent identity (TDM-98): deleting a task
// another worker is mid-flight on is the most destructive write there is, and an
// agent tidying up must not do it to a peer. A human (or an anonymous viewer on a
// public canvas) asserts no claim identity and is deliberately NOT fenced — the
// board's delete is one of the escape hatches, like release and requeue.
//
// The extra read only happens when there is something to fence: an unidentified
// caller deletes in one round trip exactly as before.
func (h *Handler) DeleteAction(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id: expected a task uuid or an existing ticket ref like TDM-21")
		return
	}
	if caller := callerClaim(r, "", 0); caller.presented() {
		if current, gerr := h.store.GetAction(r.Context(), canvasID, id); gerr == nil {
			if !h.fenceTaskWriteOrFail(w, current, caller) {
				return
			}
		}
	}
	if _, err := h.store.DeleteAction(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// updateActionPayload is the payload-only PATCH path (task content edits) — and
// the surface of the content-mutation gate (TDM-41). The RULE lives in
// store.UpdateActionPayload (see store/content_gate.go); everything here is
// translation: canonicalize, call, map the outcome onto HTTP.
//
// The response deliberately TELLS the caller when its edit cost the approval
// (`reverted: true` plus what changed and the state it fell from). An agent
// that rewrites an approved task and gets a bare 200 would carry on believing
// the task is queued; being told it must be re-approved is the difference
// between a gate and a trap.
// FENCED as well as gated (TDM-98), and the two rules answer different questions:
// the content gate asks "does this edit cost the approval?", the fence asks "is
// this task yours to edit at all?". Rewriting the body of a task another worker
// is executing would otherwise be a way to change the work under it — and, since
// a content edit REVERTS an approved task to 'proposed' and clears the claim, a
// way for one agent to knock another off its task entirely.
func (h *Handler) updateActionPayload(w http.ResponseWriter, r *http.Request, payload json.RawMessage, caller claimant) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id: expected a task uuid or an existing ticket ref like TDM-21")
		return
	}
	current, err := h.store.GetAction(r.Context(), canvasID, id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if !h.fenceTaskWriteOrFail(w, current, caller) {
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
	// The actor is the SERVER's conclusion about who is calling (E4.1), never
	// anything the body said — an audit trail whose actor is self-reported is
	// decoration. nil (no Provenance middleware on the route) records "unknown".
	actor := ""
	if a := AuthorFromCtx(r.Context()); a != nil {
		actor = *a
	}
	outcome, err := h.store.UpdateActionPayload(r.Context(), canvasID, id, payload, actor)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrContentLocked):
			// 409, not 403: the edit isn't forbidden to this caller, it conflicts
			// with the task's state. A different task, or this one before it
			// finished, would have taken it.
			writeJSON(w, http.StatusConflict, map[string]string{
				"error":   "content_locked",
				"message": err.Error(),
				"state":   current.State,
			})
		case errors.Is(err, store.ErrIllegalActionState):
			writeJSON(w, http.StatusConflict, map[string]string{
				"error":   "state_changed",
				"message": err.Error(),
			})
		case errors.Is(err, store.ErrActionNotFound):
			writeError(w, http.StatusNotFound, "action not found")
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	if outcome.Reverted {
		// The board must not keep showing this task in Ready/Working while a
		// human hasn't re-approved it. The full-state broadcast below moves the
		// card; this lightweight signal says WHY, so the activity surfaces can
		// call it out rather than showing a card that silently teleported.
		broadcastActivity(h.hub, canvasID, "reverted")
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	fresh, err := h.store.GetAction(r.Context(), canvasID, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := map[string]any{"action": fresh}
	if outcome.Reverted {
		resp["reverted"] = true
		resp["changed"] = outcome.Changed
		resp["fromState"] = outcome.FromState
		resp["message"] = "editing an approved task's " + strings.Join(outcome.Changed, " and ") +
			" sends it back through the approval gate — it is now 'proposed' and its claim was released. " +
			"A human must approve it again before any agent works it."
	}
	writeJSON(w, http.StatusOK, resp)
}
