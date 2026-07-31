package api

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/ws"
	"github.com/google/uuid"
)

// Fleet presence + activity (TDM-46) — the two reads that let a UI answer "who
// is working on what, right now" and "what just happened", without pulling the
// whole canvas.
//
//	GET /api/canvas/agents     the roster: every identity on the board, each
//	                           paired with the task(s) it currently holds.
//	GET /api/canvas/activity   the feed: the last N fleet facts, newest first.
//
// Both are canvas-JWT reads (any role), like GET /api/canvas/state.
//
// THE ACTIVITY FEED IS DERIVED, NOT LOGGED. There is no events table and no
// migration behind it: every fact it reports is read back off the `actions`
// rows' own state timestamps (created_at, claimed_at, updated_at) plus the
// provenance columns (proposed_by, approved_by, claimed_by, result, error).
// That buys a feed with zero write cost and zero schema change — and it is
// lossy in exactly the ways deriveActivity documents. The precise stream is the
// WS `activity` message this file also emits: a client that stays connected
// sees every transition as it happens; the derived feed is the backfill it
// renders on load.

// ── (a) Roster: GET /api/canvas/agents ───────────────────────────────────────

// rosterMsg is the whole response.
type rosterMsg struct {
	Type        string         `json:"type"` // "agents.roster"
	GeneratedAt time.Time      `json:"generatedAt"`
	Counts      rosterCounts   `json:"counts"`
	Agents      []*rosterAgent `json:"agents"`
	Hint        string         `json:"_hint"`
}

type rosterCounts struct {
	Agents       int `json:"agents"`
	Registered   int `json:"registered"`
	Unregistered int `json:"unregistered"`
	Working      int `json:"working"` // holding at least one executing claim
	// Waiting is agents parked on the long poll and holding no claim (TDM-151) —
	// present and blocked, which is neither working nor idle.
	Waiting int `json:"waiting"`
	Idle    int `json:"idle"`
	Claims  int `json:"claims"` // executing actions with a claimant
	// WaitingUnattributed is parked waits that asserted no identity, so they
	// belong to no row above. Counted rather than dropped: they are real agents,
	// and a board that silently ignored them would under-report presence.
	WaitingUnattributed int `json:"waitingUnattributed"`
}

// rosterAgent is one fleet member. Everything below `Registered` is nil/empty
// for an unregistered claimant — a name that appears on an executing action but
// has no `agents` row (the "fable-orchestrator" case, or a CI job whose
// touch-or-create hasn't landed). It is listed anyway, because a roster that
// hides whoever is actually holding your tasks is worse than useless.
type rosterAgent struct {
	ID            string `json:"id,omitempty"`
	Name          string `json:"name"`
	Role          string `json:"role,omitempty"`
	Model         string `json:"model,omitempty"`
	ParentAgentID string `json:"parentAgentId,omitempty"`
	// Status is the stored presence flag for a registered agent
	// ("online"/"offline"); "unknown" for an unregistered claimant, which has no
	// presence row to read — its only liveness signal is LastActivityAt.
	Status     string `json:"status"`
	Registered bool   `json:"registered"`
	// RegisteredAt / LastSeen come straight off the agents row.
	RegisteredAt *time.Time `json:"registeredAt,omitempty"`
	LastSeen     *time.Time `json:"lastSeen,omitempty"`
	// LastActivityAt is the newest moment we can prove this identity was doing
	// something: max(registered_at, last_seen_at, its claims' claimed_at). The
	// claim AND complete paths both touch last_seen_at (see claimTask /
	// UpdateActionState), so completions are already folded into it — no extra
	// read, and no new write, to compute this.
	LastActivityAt *time.Time   `json:"lastActivityAt,omitempty"`
	Tasks          []rosterTask `json:"tasks"`
	// Waiting is set ONLY while this identity is genuinely parked on the queue
	// long poll right now (TDM-151). Absent is the default and the safe answer:
	// nothing infers waiting, so a board with no live waiter shows none.
	Waiting *rosterWait `json:"waiting,omitempty"`
}

// rosterWait is "this agent is blocked on approval, since when, and for what".
//
// It is LIVE PRESENCE, not stored state: it comes from the in-process long-poll
// registry (queue_wait.go), never from a table. Everything follows from that —
// it cannot survive the connection (a waiter that hung up is out of the registry
// before this is computed), it cannot survive a restart (the registry starts
// empty, and so did every connection), and it cannot be asserted by a client
// that isn't actually holding a wait open.
type rosterWait struct {
	// Since is the start of this agent's continuous wait, held stable across the
	// re-polls a long wait is made of — so "waiting 6m" means six minutes, not
	// "since the last 25-second window".
	Since time.Time `json:"since"`
	// EpicID is set when the agent narrowed its wait to one batch (the shape an
	// orchestrator uses after epic_propose: "wake me when MY tasks are approved").
	EpicID string `json:"epicId,omitempty"`
	// Scope names that in one word for a UI: "queue" (anything approved) or
	// "epic".
	Scope string `json:"scope"`
}

// rosterTask is the in-flight work an agent holds — a compact projection, not
// the stored payload (which can carry a whole task body plus linkedIds).
type rosterTask struct {
	ID       uuid.UUID `json:"id"`
	TicketID string    `json:"ticketId,omitempty"`
	Title    string    `json:"title,omitempty"`
	Type     string    `json:"type"`
	State    string    `json:"state"`
	EpicID   string    `json:"epicId,omitempty"`
	// ClaimedBy is the holder — the SAME string the roster grouped this task
	// under. Carried on the task so the fleet view can derive the lease with the
	// same lib/lease.ts deriveLease the board uses (it reads action.claimedBy).
	ClaimedBy string `json:"claimedBy,omitempty"`
	// ClaimedAt is the LEASE stamp: set on claim and pushed forward by every
	// heartbeat (TouchActionClaim / statusProgress). It is what the lease health
	// (live / slipping / stale) is measured against — NOT a start time.
	ClaimedAt *time.Time `json:"claimedAt,omitempty"`
	// FirstClaimedAt is the STABLE start of the current lease generation, taken
	// from the claim record (payload.claim.at), which heartbeats do NOT move — so
	// the fleet view can honestly say "working for X" instead of the frozen,
	// heartbeat-reset ClaimedAt the old UI mistakenly showed (TDM-112).
	FirstClaimedAt *time.Time `json:"firstClaimedAt,omitempty"`
	// Progress is the mid-flight heartbeat log, compacted to what the client lease
	// needs (when each report landed). deriveLease uses the newest to tell "still
	// filing reports but the lease isn't moving" (a non-exclusive holder) apart
	// from a truly silent one.
	Progress []rosterProgress `json:"progress,omitempty"`
}

// rosterProgress is one heartbeat, compacted for the fleet view — the instant it
// landed (what the lease reads) plus a short note for the tooltip.
type rosterProgress struct {
	At   time.Time `json:"at"`
	Note string    `json:"note,omitempty"`
}

// rosterProgressOf parses a task payload's progress[] into the compact fleet
// shape, dropping entries with an unparseable timestamp (the lease only cares
// about when a report landed). nil when there are none, so the key is omitted.
func rosterProgressOf(payload json.RawMessage) []rosterProgress {
	var p struct {
		Progress []struct {
			At   string `json:"at"`
			Note string `json:"note"`
		} `json:"progress"`
	}
	if json.Unmarshal(payload, &p) != nil {
		return nil
	}
	out := make([]rosterProgress, 0, len(p.Progress))
	for _, e := range p.Progress {
		ts, err := time.Parse(time.RFC3339, e.At)
		if err != nil {
			continue
		}
		out = append(out, rosterProgress{At: ts.UTC(), Note: e.Note})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// actionPayloadFields are the only payload keys these reads look at.
type actionPayloadFields struct {
	Title  string `json:"title"`
	EpicID string `json:"epicId"`
}

func payloadFields(a *store.Action) actionPayloadFields {
	var f actionPayloadFields
	_ = json.Unmarshal(a.Payload, &f)
	return f
}

// GET /api/canvas/agents  (canvas JWT required; any role)
//
// TWO store round trips, run as ONE wave (the context_handler.go pattern):
// ListAgents and ListActions(state='executing') are independent, so runBatch
// fires them concurrently and the handler joins them in memory. No per-agent
// query — the whole roster costs the same two trips whether the fleet is 2
// agents or 40.
func (h *Handler) ListAgentRoster(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	canvasID := CanvasIDFromCtx(ctx)
	now := time.Now().UTC()

	var agents []*store.Agent
	var executing []*store.Action
	fetches := []func() error{
		func() error {
			list, err := h.store.ListAgents(ctx, canvasID)
			agents = list
			return err
		},
		func() error {
			// No type filter: claims are an action-level mechanism, so an
			// executing non-task action counts as work in flight too.
			list, err := h.store.ListActions(ctx, canvasID, "executing", "", "")
			executing = list
			return err
		},
	}
	if err := runBatch(len(fetches), func(i int) error { return fetches[i]() }); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Who is parked on the queue right now (TDM-151). A process-local read, not a
	// third round trip: waiting is a live connection, so it is known here and
	// nowhere else, and it is read AFTER the store fetches so the answer is as
	// late as possible.
	waiting, anonWaits := h.waiters.waitingOn(canvasID, now)

	writeJSON(w, http.StatusOK, buildRoster(agents, executing, waiting, anonWaits, now))
}

// buildRoster is the join, kept out of the handler so it is directly testable.
//
// MATCHING. actions.claimed_by is a free-text identity: the registered agent
// NAME (what the gateway sends) or, occasionally, an agent id. So a claim is
// attributed by name first, then by id string. A claimant matching neither
// becomes its own registered:false entry — including the generic "agent"
// sentinel the web surface uses when it completes a task with no identity, which
// is a real (if anonymous) holder and is reported as such rather than dropped.
//
// WAITING (TDM-151) is joined by the SAME two-step, from the live long-poll
// registry rather than from any row: `waiting` maps an asserted identity to the
// wait it is parked on, and `anonWaits` counts the parked waits that named
// nobody. The rule the ticket turns on: an entry appears here only while a
// connection is genuinely held open, so a waiter that hung up or a process that
// restarted reports nothing — better to show nothing than to imply an agent is
// waiting when it is gone.
func buildRoster(
	agents []*store.Agent,
	executing []*store.Action,
	waiting map[string]waitingWatch,
	anonWaits int,
	now time.Time,
) rosterMsg {
	out := make([]*rosterAgent, 0, len(agents))
	byName := make(map[string]*rosterAgent, len(agents))
	byID := make(map[string]*rosterAgent, len(agents))
	for _, a := range agents {
		e := &rosterAgent{
			ID: a.ID.String(), Name: a.Name, Role: a.Role,
			Status: a.Status, Registered: true, Tasks: []rosterTask{},
		}
		if a.Model != nil {
			e.Model = *a.Model
		}
		if a.ParentAgentID != nil {
			e.ParentAgentID = a.ParentAgentID.String()
		}
		if !a.CreatedAt.IsZero() {
			t := a.CreatedAt.UTC()
			e.RegisteredAt = &t
			e.LastActivityAt = &t
		}
		if !a.LastSeenAt.IsZero() {
			t := a.LastSeenAt.UTC()
			e.LastSeen = &t
			e.LastActivityAt = laterOf(e.LastActivityAt, &t)
		}
		out = append(out, e)
		byName[a.Name] = e
		byID[e.ID] = e
	}

	claims := 0
	for _, act := range executing {
		if act.ClaimedBy == nil || *act.ClaimedBy == "" {
			continue // executing but unclaimed — nobody to attribute it to
		}
		claims++
		name := *act.ClaimedBy
		entry := byName[name]
		if entry == nil {
			entry = byID[name]
		}
		if entry == nil {
			entry = &rosterAgent{
				Name: name, Status: "unknown", Registered: false,
				Tasks: []rosterTask{},
			}
			out = append(out, entry)
			byName[name] = entry
		}
		f := payloadFields(act)
		t := rosterTask{
			ID: act.ID, Title: f.Title, Type: act.Type,
			State: act.State, EpicID: f.EpicID, ClaimedBy: name,
			Progress: rosterProgressOf(act.Payload),
		}
		if act.Ticket != nil {
			t.TicketID = store.TicketID(*act.Ticket)
		}
		if act.ClaimedAt != nil {
			at := act.ClaimedAt.UTC()
			t.ClaimedAt = &at
			entry.LastActivityAt = laterOf(entry.LastActivityAt, &at)
		}
		// The claim record's `at` is the current lease generation's start, which
		// heartbeats never move — the honest "working for X" anchor (TDM-112).
		if rec := store.ReadClaimRecord(act.Payload); rec.At != "" {
			if ts, err := time.Parse(time.RFC3339, rec.At); err == nil {
				u := ts.UTC()
				t.FirstClaimedAt = &u
			}
		}
		entry.Tasks = append(entry.Tasks, t)
	}

	// Waiting, attributed the same way a claim is: by name, then by id string. An
	// identity that is waiting but has no agents row gets an entry of its own —
	// the same call the claim join makes above, for the same reason. It is holding
	// a connection open on this canvas right now; hiding it would leave the human
	// with the exact silence this is meant to break.
	for name, watch := range waiting {
		entry := byName[name]
		if entry == nil {
			entry = byID[name]
		}
		if entry == nil {
			entry = &rosterAgent{
				Name: name, Status: "unknown", Registered: false, Tasks: []rosterTask{},
			}
			out = append(out, entry)
			byName[name] = entry
		}
		scope := "queue"
		if watch.EpicID != "" {
			scope = "epic"
		}
		entry.Waiting = &rosterWait{Since: watch.Since.UTC(), EpicID: watch.EpicID, Scope: scope}
		// A held-open wait is proof of life at least as recent as its start, so it
		// counts as activity — otherwise an orchestrator that has waited an hour
		// without claiming anything ages into "dormant" while it is demonstrably
		// there. Deliberately `since` and not `now`: what is provable is when the
		// wait began.
		at := watch.Since.UTC()
		entry.LastActivityAt = laterOf(entry.LastActivityAt, &at)
	}

	counts := rosterCounts{Agents: len(out), Claims: claims, WaitingUnattributed: anonWaits}
	for _, e := range out {
		if e.Registered {
			counts.Registered++
		} else {
			counts.Unregistered++
		}
		switch {
		case len(e.Tasks) > 0:
			counts.Working++
		case e.Waiting != nil:
			// Blocked on the human, not idle — the distinction the whole feature
			// exists to draw. (An agent holding a claim reads as working even if it
			// is also waiting: what it holds is the more urgent fact.)
			counts.Waiting++
		default:
			counts.Idle++
		}
		// Newest claim first inside an agent that holds several.
		sort.SliceStable(e.Tasks, func(i, j int) bool {
			return afterTime(e.Tasks[i].ClaimedAt, e.Tasks[j].ClaimedAt)
		})
	}

	// Working agents first (that's the question the roster answers), then the ones
	// parked on the queue (present, blocked, and the human's move), then most
	// recently active, then name for a stable order across refreshes.
	sort.SliceStable(out, func(i, j int) bool {
		ai, aj := out[i], out[j]
		if (len(ai.Tasks) > 0) != (len(aj.Tasks) > 0) {
			return len(ai.Tasks) > 0
		}
		if (ai.Waiting != nil) != (aj.Waiting != nil) {
			return ai.Waiting != nil
		}
		if !sameTime(ai.LastActivityAt, aj.LastActivityAt) {
			return afterTime(ai.LastActivityAt, aj.LastActivityAt)
		}
		return ai.Name < aj.Name
	})

	return rosterMsg{
		Type: "agents.roster", GeneratedAt: now, Counts: counts, Agents: out,
		Hint: "registered:false = a claimant with no agents row (never called " +
			"agent_register), listed so the roster matches who actually holds work. " +
			"lastActivityAt = max(registeredAt, lastSeen, claimedAt) — the claim and " +
			"complete paths both refresh lastSeen, so completions are folded in. " +
			"waiting = this agent is holding the queue long poll open RIGHT NOW " +
			"(live connection, in-process, never stored): absent means nobody is " +
			"waiting, and a waiter that disconnected or a server that restarted " +
			"reports nothing rather than a ghost.",
	}
}

func laterOf(a, b *time.Time) *time.Time {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	if b.After(*a) {
		return b
	}
	return a
}

// afterTime orders nullable timestamps newest-first, nils last.
func afterTime(a, b *time.Time) bool {
	if a == nil {
		return false
	}
	if b == nil {
		return true
	}
	return a.After(*b)
}

func sameTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}

// ── (b) Activity: GET /api/canvas/activity ───────────────────────────────────

const (
	defaultActivityLimit = 50
	maxActivityLimit     = 200
)

// Fleet activity verbs. One vocabulary for BOTH surfaces — the derived feed and
// the live WS message use the same strings, so a client can append a socket
// message straight onto the list it loaded over REST.
const (
	activityProposed     = "proposed"
	activityApproved     = "approved"
	activityRejected     = "rejected"
	activityClaimed      = "claimed"
	activityCompleted    = "completed" // terminal: state says done | failed
	activityReleased     = "released"
	activityRequeued     = "requeued"
	activityClaimExpired = "claim_expired"
	// activityContended: two fleet members went for the same task and one was
	// refused — a claim lost at the door, or a write the claim fence turned away
	// (TDM-100). The ACTOR is the loser; the task's own row names who holds it.
	//
	// Live-only, like claim_expired and for the same reason: deriveActivity reads
	// history off the action row's own columns, and a collision leaves no trace
	// there — the loser changed nothing. The durable record is the task's
	// payload.contention[] trail, which every state push already carries.
	activityContended = "contended"
	// activityReworked: a REVIEWER sent finished work back (done → approved with
	// a reason, TDM-154). Distinct from `requeued`, which is a human rescuing a
	// FAILED task: this one is a judgement on work that reported success, and it
	// is the fact a watcher most wants to see land live. The ACTOR is the
	// reviewer (server-derived), not the worker whose task moved.
	//
	// Live-only, like claim_expired and contended: deriveActivity reads history
	// off the row's own columns and a bounce leaves no column behind (the rewind
	// clears the claim and the result). The durable record is the task's
	// payload.audit[] entry, which carries the reviewer, the states and the
	// verbatim reason — and every state push already carries the payload.
	activityReworked = "reworked"
)

// activityEvent is ONE fleet fact, and it is deliberately the SAME struct on
// both wires:
//
//	REST  GET /api/canvas/activity → {"events": [ activityEvent, … ]}
//	WS    a single activityEvent, pushed on every action transition
//
// so the UI has one renderer and one type. `type` is always "activity", which
// is also what the pre-existing lightweight presence pulse
// (broadcast.go's activityMsg — {"type":"activity","action":"read"}) sends;
// tell them apart by `actionId`, which only the action-lifecycle form carries.
type activityEvent struct {
	Type   string `json:"type"`   // always "activity"
	Action string `json:"action"` // one of the verbs above
	// Actor is who did it: proposedBy / approvedBy / claimedBy depending on the
	// verb. "human" or "agent" when the surface carried no identity.
	Actor      string    `json:"actor,omitempty"`
	At         time.Time `json:"at"`
	ActionID   uuid.UUID `json:"actionId"`
	ActionType string    `json:"actionType"` // "task" | "epic" | "navigate" | …
	TicketID   string    `json:"ticketId,omitempty"`
	Title      string    `json:"title,omitempty"`
	EpicID     string    `json:"epicId,omitempty"`
	// State is the action's state AT this fact — "executing" on a claim, the
	// terminal state on a completion — not necessarily its state now.
	State string `json:"state,omitempty"`
	// Result / Error are the completion summary and the failure reason.
	Result string `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type activityMsgList struct {
	Type        string          `json:"type"` // "activity.feed"
	GeneratedAt time.Time       `json:"generatedAt"`
	Limit       int             `json:"limit"`
	Truncated   bool            `json:"truncated"`
	Events      []activityEvent `json:"events"`
	Hint        string          `json:"_hint"`
}

// GET /api/canvas/activity?limit=50  (canvas JWT required; any role)
//
// ONE store round trip (ListActions with no filter), derived in memory.
func (h *Handler) ListActivity(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	canvasID := CanvasIDFromCtx(ctx)

	limit := defaultActivityLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = min(n, maxActivityLimit)
	}

	actions, err := h.store.ListActions(ctx, canvasID, "", "", "")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	events := deriveActivity(actions)
	truncated := len(events) > limit
	if truncated {
		events = events[:limit]
	}
	writeJSON(w, http.StatusOK, activityMsgList{
		Type: "activity.feed", GeneratedAt: time.Now().UTC(),
		Limit: limit, Truncated: truncated, Events: events,
		Hint: "Derived from action state timestamps — no event log. It CANNOT show: " +
			"claim expiries/takeovers (the row is restamped to the new holder), " +
			"releases and requeues (the claim is cleared), approvals of actions that " +
			"have since moved on (no approved_at column), superseded claims, or " +
			"anything about a deleted action. Subscribe to the WS 'activity' message " +
			"for the exact live stream.",
	})
}

// deriveActivity reads the fleet's history back off the action rows themselves,
// newest fact first. There is no events table; this is the whole feature.
//
// WHAT IT CAN SHOW, and the column each fact is read from:
//
//	proposed   always            created_at   + proposed_by
//	approved   state='approved'  updated_at   + approved_by
//	rejected   state='rejected'  updated_at   + approved_by (or "human")
//	claimed    claimed_at != nil claimed_at   + claimed_by
//	completed  state done|failed updated_at   + claimed_by, result / error
//
// WHAT IT CANNOT SHOW, and why — read this before trusting the feed as history:
//
//   - CLAIM EXPIRIES / TAKEOVERS. ClaimAction restamps claimed_by/claimed_at in
//     place, so the agent that went dark is gone from the row. The expiry is
//     observable only live (the WS claim_expired message, and the
//     task.claim_expired webhook) — which is why those exist.
//   - RELEASES AND REQUEUES. Both clear claimed_by/claimed_at, so the claim they
//     undid vanishes from the feed too: a released task reads as never claimed.
//   - WHEN an approval happened, once the action has moved past 'approved'.
//     There is no approved_at column, and updated_at has been overwritten by the
//     claim/completion. We know THAT it was approved and BY whom (approved_by
//     survives) but not when, so no approved fact is emitted for it — the claim
//     that followed carries the story instead.
//   - PAYLOAD EDITS, and any transition on a DELETED action (row gone).
//   - MORE THAN ONE FACT PER STATE. updated_at holds only the LAST write, so a
//     done task shows its completion, not its approval an hour earlier.
//
// The honest summary: this is a reliable "what is the board's history" view for
// the happy path (propose → approve → claim → complete) and silent about
// everything that got undone. Sub-transition fidelity comes from the WS stream.
func deriveActivity(actions []*store.Action) []activityEvent {
	events := make([]activityEvent, 0, len(actions)*2)
	for _, a := range actions {
		if a == nil {
			continue
		}
		f := payloadFields(a)
		base := activityEvent{
			Type: "activity", ActionID: a.ID, ActionType: a.Type,
			Title: f.Title, EpicID: f.EpicID,
		}
		if a.Ticket != nil {
			base.TicketID = store.TicketID(*a.Ticket)
		}

		ev := base
		ev.Action, ev.At, ev.State = activityProposed, a.CreatedAt.UTC(), "proposed"
		ev.Actor = a.ProposedBy
		events = append(events, ev)

		// Approval time is knowable only while the action still sits in
		// 'approved' — see the CANNOT list above.
		if a.State == "approved" && a.ApprovedBy != nil {
			ev := base
			ev.Action, ev.At, ev.State = activityApproved, a.UpdatedAt.UTC(), "approved"
			ev.Actor = *a.ApprovedBy
			events = append(events, ev)
		}
		if a.State == "rejected" {
			ev := base
			ev.Action, ev.At, ev.State = activityRejected, a.UpdatedAt.UTC(), "rejected"
			ev.Actor = "human"
			if a.ApprovedBy != nil && *a.ApprovedBy != "" {
				ev.Actor = *a.ApprovedBy
			}
			if a.Error != nil {
				ev.Error = *a.Error
			}
			events = append(events, ev)
		}
		// claimed_at survives into done/failed, so a completed task still shows
		// who picked it up and when.
		if a.ClaimedAt != nil {
			ev := base
			ev.Action, ev.At, ev.State = activityClaimed, a.ClaimedAt.UTC(), "executing"
			ev.Actor = "agent"
			if a.ClaimedBy != nil && *a.ClaimedBy != "" {
				ev.Actor = *a.ClaimedBy
			}
			events = append(events, ev)
		}
		if a.State == "done" || a.State == "failed" {
			ev := base
			ev.Action, ev.At, ev.State = activityCompleted, a.UpdatedAt.UTC(), a.State
			ev.Actor = "agent"
			if a.ClaimedBy != nil && *a.ClaimedBy != "" {
				ev.Actor = *a.ClaimedBy
			}
			if a.Result != nil {
				ev.Result = *a.Result
			}
			if a.Error != nil {
				ev.Error = *a.Error
			}
			events = append(events, ev)
		}
	}

	// Newest first. Ties (same second, or a completion whose updated_at equals
	// its claimed_at) fall back to lifecycle order reversed, so a task's own
	// facts never read out of sequence; action id breaks the last tie so two
	// requests against unchanged data return identical bytes.
	sort.SliceStable(events, func(i, j int) bool {
		ei, ej := events[i], events[j]
		if !ei.At.Equal(ej.At) {
			return ei.At.After(ej.At)
		}
		if ei.ActionID == ej.ActionID {
			return lifecycleRank(ei.Action) > lifecycleRank(ej.Action)
		}
		return ei.ActionID.String() < ej.ActionID.String()
	})
	return events
}

// lifecycleRank orders the verbs along the state machine, for tie-breaking only.
func lifecycleRank(verb string) int {
	switch verb {
	case activityProposed:
		return 0
	case activityApproved:
		return 1
	case activityRejected, activityRequeued, activityReleased, activityReworked:
		return 2
	case activityClaimed, activityClaimExpired:
		return 3
	case activityCompleted:
		return 4
	}
	return 5
}

// ── Live: the WS activity message ────────────────────────────────────────────

// broadcastActionActivity pushes one activityEvent per action to a canvas's
// viewers so a feed can update without refetching. Called (additively) from
// every action transition; the full-state broadcast still follows — this just
// says WHAT moved and WHO moved it.
//
// Variadic and empty-verb-tolerant so every call site is ONE line, whether it
// holds a single action, a batch, or a state whose verb may not be fleet-
// visible (activityVerbFor returns "" and this becomes a no-op). Batches emit
// one message per action, never a "batch" message: the feed is a list of task
// facts, and a client would only have to fan it out itself.
func broadcastActionActivity(hub *ws.Hub, canvasID uuid.UUID, verb string, actions ...*store.Action) {
	for _, a := range actions {
		broadcastActionActivityAs(hub, canvasID, verb, a, actorFor(verb, a))
	}
}

// broadcastProposeActivity pings newly created actions: "proposed", plus
// "approved" for any that was BORN approved (a human passing state:"approved",
// or the canvas approval policy stamping it). Without the second ping a task
// could enter the ready-to-work queue having never passed through an approve
// call, and a feed listening for `approved` would never hear about it — the
// same asymmetry ProposeAction already handles for the task.approved webhook.
func broadcastProposeActivity(hub *ws.Hub, canvasID uuid.UUID, actions ...*store.Action) {
	broadcastActionActivity(hub, canvasID, activityProposed, actions...)
	for _, a := range actions {
		if a != nil && a.State == "approved" {
			broadcastActionActivity(hub, canvasID, activityApproved, a)
		}
	}
}

// broadcastActionActivityAs is the explicit-actor form, for the one case the
// row can't answer: claim_expired, where the action has ALREADY been restamped
// to the new claimant and the agent that went dark is only known to the caller.
func broadcastActionActivityAs(hub *ws.Hub, canvasID uuid.UUID, verb string, a *store.Action, actor string) {
	// Nil hub = no WS surface (handler tests); nil action or empty verb =
	// nothing to say (a transition the fleet vocabulary doesn't name).
	if hub == nil || a == nil || verb == "" {
		return
	}
	f := payloadFields(a)
	ev := activityEvent{
		Type: "activity", Action: verb, Actor: actor, At: time.Now().UTC(),
		ActionID: a.ID, ActionType: a.Type, Title: f.Title, EpicID: f.EpicID,
		State: a.State,
	}
	if a.Ticket != nil {
		ev.TicketID = store.TicketID(*a.Ticket)
	}
	if verb == activityCompleted {
		if a.Result != nil {
			ev.Result = *a.Result
		}
		if a.Error != nil {
			ev.Error = *a.Error
		}
	}
	data, err := json.Marshal(ev)
	if err != nil {
		log.Printf("broadcastActionActivity marshal: %v", err)
		return
	}
	hub.Broadcast(canvasID, data)
}

func actorFor(verb string, a *store.Action) string {
	if a == nil {
		return ""
	}
	switch verb {
	case activityProposed:
		return a.ProposedBy
	case activityApproved, activityRejected:
		if a.ApprovedBy != nil && *a.ApprovedBy != "" {
			return *a.ApprovedBy
		}
		return "human"
	case activityClaimed, activityCompleted, activityClaimExpired:
		if a.ClaimedBy != nil && *a.ClaimedBy != "" {
			return *a.ClaimedBy
		}
		return "agent"
	case activityReleased, activityRequeued:
		return "human"
	}
	return ""
}

// activityVerbFor maps a target STATE onto the fleet verb, so transitionAction —
// the one seam every approve / reject / complete goes through, from the MCP
// PATCH and the CI status API alike — can ping with a single line. Returns ""
// for states that aren't a fleet-visible transition.
func activityVerbFor(state string) string {
	switch state {
	case "approved":
		return activityApproved
	case "rejected":
		return activityRejected
	case "done", "failed":
		return activityCompleted
	}
	return ""
}
