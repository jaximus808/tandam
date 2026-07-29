package api

import (
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

// Inbound status API (TDM-38) — how a fleet member with NO MCP client reports on
// a task. A GitHub Actions job, a Modal function, a cron script: anything that
// can run `curl` is a first-class member of the fleet, and the board updates
// live (the same WS broadcast + the same task.* webhooks the MCP path fires).
//
// This is a THIN SKIN over the existing transitions, deliberately: `started`
// goes through the same atomic claimTask the MCP task_start uses, and
// completed/failed go through the same transitionAction + task.completed emit as
// the MCP task_complete. A CI curl and an MCP tool call must be
// indistinguishable downstream — anything else and "CI is a fleet member" is a
// slogan rather than a fact.

const (
	// externalAgentDefault is the claim identity a caller that names no agent
	// gets. NOT the generic "agent": that string is the store's sentinel for "an
	// anonymous holder, no exclusivity" (see ClaimAction), and a CI job wants a
	// real claim. It also gives the board something honest to render.
	externalAgentDefault = "external"

	maxStatusAgentLen  = 120
	maxStatusSummary   = 8192
	maxStatusLinks     = 20
	maxStatusLinkLen   = 2048
	maxProgressEntries = 50
)

// taskStatusBody is the wire contract. `state` is the fleet-member vocabulary
// (started/progress/completed/failed), NOT the internal action states — a CI
// author should not have to know that "completed" is stored as 'done'.
type taskStatusBody struct {
	State   string   `json:"state"`
	Agent   string   `json:"agent"`
	Summary string   `json:"summary"`
	Error   string   `json:"error"`
	Links   []string `json:"links"`
}

// writeTaskStatusError writes this endpoint's machine-readable error shape:
//
//	{"error": "<code>", "message": "<what to do about it>", …extra}
//
// A curl in a CI script has no model behind it to interpret prose, so every
// error carries a stable code to branch on AND a message that says what the
// next call should be. `extra` carries the fact that makes it actionable
// (claimedBy, the current state).
func writeTaskStatusError(w http.ResponseWriter, status int, code, message string, extra map[string]string) {
	out := map[string]string{"error": code, "message": message}
	for k, v := range extra {
		out[k] = v
	}
	writeJSON(w, status, out)
}

// ReportTaskStatus handles POST /api/canvas/{code}/tasks/{id}/status — one call
// per status change from a fleet member that has no MCP client.
//
// AUTH. The bearer must be scoped to the canvas named by {code} (see
// RequireCanvasByCode). Two credentials work, pick by how long the caller lives:
//
//	# 1. Long-lived: a personal access token, straight into CI secrets. ONE curl.
//	curl -sS -X POST \
//	  https://tandemcanvas.com/api/canvas/TEGLQFXR/tasks/$TASK_ID/status \
//	  -H "Authorization: Bearer $TANDEM_PAT" \
//	  -H 'Content-Type: application/json' \
//	  -d '{"state":"started","agent":"ci-github"}'
//
//	# 2. Short-lived: exchange the canvas code for a 24h canvas token first.
//	#    No secret needed on a public canvas — but it expires, so mint it per run.
//	TOKEN=$(curl -sS -X POST https://tandemcanvas.com/api/mcp/auth \
//	  -H 'Content-Type: application/json' -d '{"code":"TEGLQFXR"}' | jq -r .token)
//
// WHERE $TASK_ID COMES FROM. Normally the task.approved webhook (TDM-36/37)
// that triggered the job — its body carries task.id, which is the whole "no
// polling" story: Tandem pushes the task out, the job pushes status back. A job
// that isn't webhook-triggered can list the queue instead:
// GET /api/canvas/actions?type=task&state=approved with the same bearer.
//
// A full CI run then reads:
//
//	POST …/status {"state":"started","agent":"ci-github"}
//	POST …/status {"state":"progress","agent":"ci-github","summary":"tests green"}
//	POST …/status {"state":"completed","agent":"ci-github","summary":"deployed",
//	               "links":["https://github.com/o/r/commit/abc123"]}
//
// TRANSITIONS (state → what happens, and what a retry does):
//
//	started    atomic claim (approved → executing). Re-sending it as the SAME
//	           agent is a 200 no-op, so a retried CI step never 409s itself; a
//	           DIFFERENT agent gets 409 already_claimed naming the holder.
//	progress   appends to payload.progress[]; no state change, no webhook.
//	           Requires 'executing' and the caller's own claim.
//	completed  executing → done, summary → result. Fires task.completed.
//	failed     executing → failed, error (or summary) → error. Also fires
//	           task.completed — terminal is terminal (see task_events.go).
//
// progress/completed/failed all require the task to be executing and claimed by
// this agent: 409 not_executing / 409 claimed_by_other, each carrying the fact
// (state, claimedBy) the caller needs to decide what to do. Re-sending a
// terminal state a task already reached is a 200 no-op, like every other
// transition on this API.
//
// links[] is completion evidence — commit URLs, PR URLs, a CI run page. It
// lands in payload.links[] ADDITIVELY: appended to whatever is there, deduped,
// capped, and every other payload key left untouched. The board renders it
// (TDM-39); nothing here depends on that.
func (h *Handler) ReportTaskStatus(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeTaskStatusError(w, http.StatusBadRequest, "invalid_id",
			"the {id} in the path must be a task id (uuid) — GET /api/canvas/actions?type=task lists them", nil)
		return
	}
	var body taskStatusBody
	if err := decode(r, &body); err != nil {
		writeTaskStatusError(w, http.StatusBadRequest, "invalid_body",
			"body must be JSON: {\"state\":\"started|progress|completed|failed\", \"agent\":\"…\", \"summary\":\"…\", \"links\":[…]}", nil)
		return
	}
	agent, links, err := body.normalize()
	if err != nil {
		writeTaskStatusError(w, http.StatusBadRequest, "invalid_body", err.Error(), nil)
		return
	}

	switch body.State {
	case "started":
		h.statusStarted(w, r, canvasID, id, agent, body.Summary, links)
	case "progress":
		h.statusProgress(w, r, canvasID, id, agent, body.Summary, links)
	case "completed":
		h.statusTerminal(w, r, canvasID, id, agent, "done", body.Summary, links)
	case "failed":
		reason := body.Error
		if reason == "" {
			reason = body.Summary
		}
		h.statusTerminal(w, r, canvasID, id, agent, "failed", reason, links)
	default:
		writeTaskStatusError(w, http.StatusBadRequest, "invalid_state",
			"state must be one of: started, progress, completed, failed", nil)
	}
}

// normalize validates the body and fills defaults, returning the claim identity
// and the cleaned links. Caps exist because this payload is stored on the task
// forever and re-read by every board load — an unbounded links[] from a looping
// CI job would bloat every state broadcast on the canvas.
func (b *taskStatusBody) normalize() (string, []string, error) {
	agent := strings.TrimSpace(b.Agent)
	if agent == "" {
		agent = externalAgentDefault
	}
	if len(agent) > maxStatusAgentLen {
		return "", nil, fmt.Errorf("agent must be at most %d characters", maxStatusAgentLen)
	}
	if len(b.Summary) > maxStatusSummary || len(b.Error) > maxStatusSummary {
		return "", nil, fmt.Errorf("summary/error must be at most %d characters", maxStatusSummary)
	}
	if len(b.Links) > maxStatusLinks {
		return "", nil, fmt.Errorf("at most %d links per report", maxStatusLinks)
	}
	links := make([]string, 0, len(b.Links))
	for _, l := range b.Links {
		l = strings.TrimSpace(l)
		if l == "" {
			return "", nil, fmt.Errorf("links must be non-empty strings (commit / PR / run URLs)")
		}
		if len(l) > maxStatusLinkLen {
			return "", nil, fmt.Errorf("each link must be at most %d characters", maxStatusLinkLen)
		}
		links = append(links, l)
	}
	return agent, links, nil
}

// statusStarted claims the task through the SAME atomic path as the MCP
// task_start (claimTask), so the winner, the 409, the liveness heartbeat and the
// task.claim_expired event are all identical to an agent claiming it.
func (h *Handler) statusStarted(w http.ResponseWriter, r *http.Request, canvasID, id uuid.UUID, agent, note string, links []string) {
	action, err := h.claimTask(r.Context(), canvasID, id, agent)
	if err != nil {
		var claimed *store.AlreadyClaimedError
		switch {
		case errors.As(err, &claimed):
			// Idempotent-started for the SAME agent never reaches here — the store
			// hands a named claimant its own claim back (see ClaimAction). This is
			// a genuine rival, so name them: the caller should stop, not retry.
			writeTaskStatusError(w, http.StatusConflict, "already_claimed",
				"another fleet member is already working this task — do not duplicate the work",
				map[string]string{"claimedBy": claimed.ClaimedBy})
		case errors.Is(err, store.ErrActionNotFound):
			writeTaskStatusError(w, http.StatusNotFound, "task_not_found",
				"no task with that id on this canvas", nil)
		case errors.Is(err, store.ErrIllegalActionState):
			writeTaskStatusError(w, http.StatusConflict, "illegal_state",
				"only an approved task can be started: "+err.Error(), nil)
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	// A start that came with evidence (a CI run URL, a first note) records it —
	// otherwise the claim is the whole report and there is nothing to write.
	// A failure here does NOT fail the request: the claim already committed, and
	// answering 500 would send CI round the retry loop for a start that actually
	// won. Log it and hand back the (successful) claim.
	if note != "" || len(links) > 0 {
		if !h.applyStatusPayload(r, canvasID, id, action, agent, note, links) {
			log.Printf("task status %s: claim landed but recording the start note/links failed", id)
		}
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]any{"action": action})
}

// statusProgress appends a progress entry (and any links) to the task payload.
// It is deliberately NOT a state transition and fires no webhook: the task
// hasn't moved, and a receiver subscribed to task.* must not be woken by a
// heartbeat. Live viewers still see it — the state broadcast carries the payload.
func (h *Handler) statusProgress(w http.ResponseWriter, r *http.Request, canvasID, id uuid.UUID, agent, note string, links []string) {
	if note == "" && len(links) == 0 {
		writeTaskStatusError(w, http.StatusBadRequest, "nothing_to_report",
			"a progress report needs a summary, links, or both", nil)
		return
	}
	current, ok := h.loadClaimedTask(w, r, canvasID, id, agent)
	if !ok {
		return
	}
	if !h.applyStatusPayload(r, canvasID, id, current, agent, note, links) {
		writeError(w, http.StatusInternalServerError, "could not record progress")
		return
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]any{"action": current})
}

// statusTerminal drives completed/failed through transitionAction — the same
// function the MCP/web PATCH uses — and fires task.completed exactly where
// UpdateActionState does. `to` is the stored state ('done' | 'failed'); the
// caller's vocabulary was translated one level up.
func (h *Handler) statusTerminal(w http.ResponseWriter, r *http.Request, canvasID, id uuid.UUID, agent, to, summary string, links []string) {
	current, err := h.store.GetAction(r.Context(), canvasID, id)
	if err != nil {
		writeTaskStatusError(w, http.StatusNotFound, "task_not_found",
			"no task with that id on this canvas", nil)
		return
	}
	// Idempotent CI retry: the task is already where this call wants it. Answer
	// like the (missed) first response rather than 409'ing on not-executing —
	// same rule transitionAction applies to every other transition.
	if current.State == to {
		writeJSON(w, http.StatusOK, map[string]any{"action": current})
		return
	}
	if !h.guardClaimedTask(w, current, agent) {
		return
	}
	patch := store.ActionStatePatch{}
	if summary != "" {
		s := summary
		if to == "done" {
			patch.Result = &s
		} else {
			patch.Error = &s
		}
	}
	// Links ride the SAME write as the transition (ActionStatePatch carries a
	// payload) — one round trip, and no window where a task is done but its
	// evidence hasn't landed yet.
	if len(links) > 0 {
		merged, changed, err := mergeTaskStatusPayload(current.Payload, agent, "", links, time.Now().UTC())
		if err != nil {
			writeTaskStatusError(w, http.StatusBadRequest, "invalid_payload", err.Error(), nil)
			return
		}
		if changed {
			patch.Payload = merged
		}
	}
	fresh, moved := h.transitionAction(w, r, to, patch)
	if moved {
		h.emitTaskEvent(canvasID, webhooks.EventTaskCompleted, fresh)
	}
}

// loadClaimedTask reads the task and enforces "executing, and mine" — the two
// preconditions every non-start report has. Writes the error and returns
// ok=false on any failure.
func (h *Handler) loadClaimedTask(w http.ResponseWriter, r *http.Request, canvasID, id uuid.UUID, agent string) (*store.Action, bool) {
	current, err := h.store.GetAction(r.Context(), canvasID, id)
	if err != nil {
		writeTaskStatusError(w, http.StatusNotFound, "task_not_found",
			"no task with that id on this canvas", nil)
		return nil, false
	}
	if !h.guardClaimedTask(w, current, agent) {
		return nil, false
	}
	return current, true
}

// guardClaimedTask enforces that a task is executing and held by this agent.
//
// The claim rule mirrors UpdateActionState's: a holder of "" or the generic
// "agent" is not an exclusive identity and doesn't block anyone (that's the
// anonymous web/MCP path), but a NAMED holder does. Since this endpoint always
// resolves an agent name (defaulting to "external"), a CI job can never finish
// another named member's work.
func (h *Handler) guardClaimedTask(w http.ResponseWriter, current *store.Action, agent string) bool {
	if current.Type != "task" {
		writeTaskStatusError(w, http.StatusBadRequest, "not_a_task",
			"that id names a "+current.Type+", not a task", nil)
		return false
	}
	if current.State != "executing" {
		writeTaskStatusError(w, http.StatusConflict, "not_executing",
			"claim the task first: POST this endpoint with {\"state\":\"started\"}",
			map[string]string{"state": current.State})
		return false
	}
	if holder := rivalClaimHolder(current, agent); holder != "" {
		writeTaskStatusError(w, http.StatusConflict, "claimed_by_other",
			"this task is claimed by another fleet member — it is not yours to report on",
			map[string]string{"claimedBy": holder})
		return false
	}
	return true
}

// rivalClaimHolder names the agent holding an exclusive claim that is NOT
// `agent`, or "" when the caller may proceed.
func rivalClaimHolder(a *store.Action, agent string) string {
	if a.ClaimedBy == nil {
		return ""
	}
	holder := *a.ClaimedBy
	if holder == "" || holder == "agent" || holder == agent {
		return ""
	}
	return holder
}

// applyStatusPayload merges the report into the task payload and persists it,
// reflecting the result onto `action` so the response shows what was stored.
// Returns false only on a store failure; "nothing to merge" is a success.
func (h *Handler) applyStatusPayload(r *http.Request, canvasID, id uuid.UUID, action *store.Action, agent, note string, links []string) bool {
	merged, changed, err := mergeTaskStatusPayload(action.Payload, agent, note, links, time.Now().UTC())
	if err != nil || !changed {
		return err == nil
	}
	if _, err := h.store.UpdateActionPayload(r.Context(), canvasID, id, merged); err != nil {
		return false
	}
	action.Payload = merged
	return true
}

// mergeTaskStatusPayload folds one status report into a task's stored payload.
//
// ADDITIVE BY CONSTRUCTION: the payload is the task's content (title, body,
// linkedIds, epicId …) and this endpoint is a reporter, not an editor. Unknown
// keys are round-tripped untouched; links are appended to whatever is already
// there and deduped; progress is an append-only log capped at the most recent
// maxProgressEntries so a chatty CI loop can't grow the row without bound.
//
// Returns changed=false when there was nothing to add, so the caller can skip
// the write entirely.
func mergeTaskStatusPayload(raw json.RawMessage, agent, note string, links []string, at time.Time) (json.RawMessage, bool, error) {
	p := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, false, fmt.Errorf("task payload is not a JSON object")
		}
	}
	changed := false

	if len(links) > 0 {
		merged := stringSlice(p["links"])
		seen := make(map[string]bool, len(merged))
		for _, l := range merged {
			seen[l] = true
		}
		for _, l := range links {
			if !seen[l] {
				seen[l] = true
				merged = append(merged, l)
			}
		}
		if len(merged) > maxStatusLinks {
			merged = merged[len(merged)-maxStatusLinks:]
		}
		p["links"] = merged
		changed = true
	}

	if note != "" {
		hist, _ := p["progress"].([]any)
		hist = append(hist, map[string]any{
			"at":    at.Format(time.RFC3339),
			"agent": agent,
			"note":  note,
		})
		if len(hist) > maxProgressEntries {
			hist = hist[len(hist)-maxProgressEntries:]
		}
		p["progress"] = hist
		changed = true
	}

	if !changed {
		return raw, false, nil
	}
	out, err := json.Marshal(p)
	if err != nil {
		return nil, false, err
	}
	return out, true, nil
}

// stringSlice coerces a round-tripped JSON value to []string, dropping anything
// that isn't a string. A payload whose `links` was something else entirely gets
// replaced rather than erroring — this endpoint must not fail a completion
// report over a malformed field it didn't write.
func stringSlice(v any) []string {
	items, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, it := range items {
		if s, ok := it.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}
