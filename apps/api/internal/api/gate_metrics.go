package api

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// The pre-work intervention rate (TDM-165) — the number that says whether the
// approval gate is load-bearing or decorative.
//
// WHY THIS EXISTS. The thesis behind the board (see the "Why an approval gate
// makes agent code cheaper and better" note) is falsifiable, and it rests on one
// quantity: the share of proposed work a human throws out or rewrites BEFORE an
// agent spends 70k tokens building it. Above roughly 10% the board pays for its
// own coordination overhead; below it, the honest claim narrows to auditability.
//
// Until now that number could only be obtained by hand-counting rows, which
// means nobody watched it — including us. Worse, the two readings of a low
// number ("the plans are genuinely good" and "nobody is reading the plans") are
// indistinguishable from the outside, and telling them apart is the entire point
// of measuring.
//
// DERIVED, NEVER STORED — NO MIGRATION. Everything here is computed at read time
// from rows that already exist, exactly like the epic rollup:
//
//   - a rejection is a task whose CURRENT state is 'rejected';
//   - an amendment is an entry in the task's server-owned payload.audit[] log
//     (store/content_gate.go), which already records every title/body edit with
//     the state the edit arrived in.
//
// Migration 0040's metrics_snapshots is deliberately NOT the home for this. That
// table is process-wide operational telemetry and its header states the rule in
// as many words: no canvas_id, not "nullable", not "for later". This metric is
// per-canvas and per-epic by definition, so it belongs to the canvas's own rows,
// not to the ops series.
//
// NOT A TARGET. Everything in this file is shaped to report an observation, not
// to push a number up. There is no goal, no streak, no score. A surface that
// rewards rejecting produces rejection theater, which is strictly worse than
// rubber-stamping: it destroys good work AND fakes the metric. The caveat text
// below ships WITH the numbers, in the same response, so no consumer can render
// the figure without the sentence that qualifies it.

// gateWindowDaysDefault is the rolling window when none is asked for. A month is
// long enough that a slow week doesn't swing the figure and short enough that it
// still reflects how the board is being used NOW, which is the question the
// all-time number cannot answer.
const gateWindowDaysDefault = 30

// gateWindowDaysMax caps ?days. Two years is past any real canvas's history, so
// the cap never truncates data — it exists only to keep an absurd value from
// becoming a nonsense timestamp.
const gateWindowDaysMax = 730

// maxGateEpics caps the per-epic breakdown. The canvas totals always tell the
// whole truth; this list is for locating WHICH batch the interventions landed
// in, and a hundred rows is far past the point a person reads one.
const maxGateEpics = 100

// gatePreWorkStates are the states an edit can arrive in and still count as
// happening BEFORE the work.
//
// 'proposed' is the obvious one — the task is sitting in the gate. 'approved' is
// included on purpose and it is the one judgement call in this file: an approved
// task has passed the gate but NOT been claimed, so no agent has loaded context
// and no code exists. Editing it is precisely the intervention this metric is
// named for — the content gate even reverts it to 'proposed' and makes it
// re-earn its approval (store/content_gate.go). Excluding it would undercount
// the cheapest, most valuable saves.
//
// 'executing' is deliberately absent. An edit there changes the instructions
// under an agent that is already burning tokens; that is a rescue, not a
// prevention, and folding it in would let mid-flight churn inflate a number
// whose whole meaning is "we caught it before we paid".
var gatePreWorkStates = map[string]bool{"proposed": true, "approved": true}

// gateTally is one population's counts and the rate derived from them.
//
// Every count is published alongside the rate so a reader can recompute it and
// check this code, rather than trusting a single float.
type gateTally struct {
	// Decided is the DENOMINATOR: tasks the gate has actually ruled on — every
	// task that has left 'proposed' (approved, worked, finished, failed) plus
	// every task currently 'rejected'.
	//
	// A task still sitting in 'proposed' is excluded from BOTH sides, because
	// nobody has decided anything about it yet; counting it as "not intervened"
	// would let a backlog of unread proposals quietly drive the rate toward
	// zero. Those are reported as Pending instead.
	Decided int `json:"decided"`
	// Pending is the undecided remainder — proposed, still in the gate.
	Pending int `json:"pending"`

	// Rejected counts tasks whose CURRENT state is 'rejected'.
	//
	// Current state, not audit history, and that is the whole handling of the
	// one-tap undo (TDM-160): undoing a rejection moves the task back to
	// 'proposed', so it stops being counted here the moment it is undone. There
	// is no window during which a withdrawn rejection inflates the figure, and
	// no reconciliation pass to get wrong. RejectionsUndone below reports the
	// withdrawals separately so they are visible rather than merely absent.
	Rejected int `json:"rejected"`
	// Amended counts tasks with at least one title/body edit recorded in
	// payload.audit[] while the task was in a gatePreWorkStates state. Per TASK,
	// not per edit: rewriting one ticket five times is one intervention on one
	// piece of work, and counting edits would reward fiddling.
	Amended int `json:"amended"`
	// Intervened is the UNION — tasks that were rejected or amended or both.
	// This is the numerator; Rejected + Amended would double-count a task that
	// was rewritten and then thrown out anyway.
	Intervened int `json:"intervened"`
	// RatePct is Intervened / Decided as a percentage, one decimal. Zero when
	// Decided is zero (no opinion, rather than a fabricated 0%: see HasRate).
	RatePct float64 `json:"ratePct"`
	// HasRate is false when Decided is 0. A rate over an empty population is not
	// 0% — it is unknown, and a UI must be able to tell those apart instead of
	// drawing a confident zero on a board nobody has used yet.
	HasRate bool `json:"hasRate"`

	// ── Disclosed, and deliberately OUTSIDE the rate ──────────────────────────

	// UngatedAuto counts tasks born approved under approval_policy 'auto'
	// (approved_by = "policy:auto"). They never faced a gate at all, so they are
	// excluded from Decided entirely — leaving them in would let a canvas turn
	// the gate off and watch its own intervention rate collapse, which reads as
	// a quality signal and is the opposite of one.
	UngatedAuto int `json:"ungatedAuto"`
	// RejectionsUndone counts rejected → proposed moves in the audit log — the
	// undo strip being used, or a human reconsidering something triaged away.
	// Reported because a rejection that gets withdrawn is a real event that the
	// Rejected count (correctly) hides.
	RejectionsUndone int `json:"rejectionsUndone"`
	// PostWorkBounces counts done → approved moves: a human reopening a task
	// that wasn't really finished, or a reviewer agent sending finished work back
	// for rework (TDM-154).
	//
	// EXCLUDED FROM THE RATE, on purpose. This metric measures work stopped
	// BEFORE it was built; a bounce happens after the tokens are already spent,
	// so it is a different (and much more expensive) event. It is reported here
	// because it is the natural companion question and because the thesis
	// predicts bounces should trace back to vague done-conditions — but adding it
	// to the numerator would let post-hoc rework masquerade as prevention.
	//
	// HONEST LIMIT: a human reopen and an agent rework bounce write the same
	// done → approved audit entry, so this count cannot separate them.
	PostWorkBounces int `json:"postWorkBounces"`
}

// gateEpicTally is one batch's numbers, so an unusually high or low rate can be
// located rather than just observed.
type gateEpicTally struct {
	ID      uuid.UUID `json:"id"`
	Title   string    `json:"title"`
	State   string    `json:"state"`
	Tally   gateTally `json:"tally"`
	Created time.Time `json:"createdAt"`
}

// gateMetricsBody is the endpoint's response. The definition and the caveat ride
// WITH the numbers rather than living in a UI string, so every surface that
// renders the figure renders the same words about what it means.
type gateMetricsBody struct {
	Type        string `json:"type"`
	GeneratedAt string `json:"generatedAt"`
	// WindowDays is the rolling window Window covers, by task creation date.
	WindowDays int `json:"windowDays"`
	// AllTime is every task on the canvas; Window is those proposed inside the
	// rolling window. Both, because "have we ever read the plans" and "are we
	// reading them lately" are different questions and only the pair distinguishes
	// a board that used to have a gate from one that still does.
	AllTime gateTally `json:"allTime"`
	Window  gateTally `json:"window"`
	// Epics is the all-time per-batch breakdown, oldest batch first. Unepiced
	// carries the tasks belonging to no batch, which no epic row would account
	// for.
	Epics     []gateEpicTally `json:"epics"`
	Unepiced  gateTally       `json:"unepiced"`
	Truncated int             `json:"truncated,omitempty"`

	// Definition is what the numbers mean, in words. A metric whose definition is
	// implicit gets misread, and this one has two edges people will guess wrong
	// (what counts as "materially amended", and what happens to an undone
	// rejection).
	Definition []string `json:"definition"`
	// Caveat is the anti-gamification statement, shipped as data for the same
	// reason: it must not be possible to render the number without it.
	Caveat string `json:"caveat"`
	Hint   string `json:"_hint"`
}

// gateDefinition is the metric, stated so a reader can argue with it.
var gateDefinition = []string{
	"Denominator: tasks the gate has ruled on — every task that left 'proposed', plus every task currently 'rejected'. Tasks still proposed are undecided and counted in neither half.",
	"Rejected: the task's current state is 'rejected'. An undone rejection is back in 'proposed', so it stops counting the moment it is undone — withdrawals show up under 'rejections undone' instead.",
	"Materially amended: at least one title or body edit recorded in the task's audit log while it was 'proposed' or 'approved' — i.e. before any agent claimed it. Counted once per task, however many times it was edited.",
	"Rate: rejected-or-amended tasks divided by decided tasks. A task that was both is counted once.",
	"Excluded: tasks born approved under the 'auto' policy (they never faced a gate), edits made while a task was 'executing' (the tokens were already being spent), and done → approved bounces (rework happens after the work, not before it).",
	"Known floor: a task's audit log keeps only its 20 most recent entries, so a heavily-edited ticket can lose its earliest amendments. The amended count can undercount; it never overcounts.",
}

// gateCaveat is the sentence that has to travel with the number.
const gateCaveat = "This is a diagnostic, not a target. The thesis behind the board puts the break-even near 10% — above it the gate is saving more than it costs, below it the honest claim is auditability rather than savings. But a low rate has two readings that look identical from here: the plans are genuinely good, or nobody is reading them. Only you know which. Do not try to move this number: rejecting work to raise it destroys good tickets and fakes the measurement at the same time."

// gateTaskPayload is the slice of a task payload this metric reads.
type gateTaskPayload struct {
	Title  string               `json:"title"`
	EpicID string               `json:"epicId"`
	Audit  []store.ContentAudit `json:"audit"`
}

// gateTaskFacts is one task reduced to the four things the tally needs. Split
// out from the accumulation so the classification rules — which are the
// substance of this metric — are testable on their own.
type gateTaskFacts struct {
	Decided     bool
	UngatedAuto bool
	Rejected    bool
	Amended     bool
	Undone      int
	Bounces     int
}

// classifyGateTask reduces one task row to its facts. Pure.
func classifyGateTask(t *store.Action) gateTaskFacts {
	var f gateTaskFacts
	if t == nil {
		return f
	}
	// Born approved under 'auto' and never gated. Checked first: such a task is
	// out of the population entirely, so nothing else about it matters.
	if t.ApprovedBy != nil && strings.TrimSpace(*t.ApprovedBy) == "policy:auto" {
		f.UngatedAuto = true
		return f
	}

	f.Rejected = t.State == "rejected"
	// Decided = the gate has ruled. Anything not still sitting in 'proposed'
	// has been ruled on, and 'rejected' is itself a ruling.
	f.Decided = t.State != "proposed"

	var p gateTaskPayload
	_ = json.Unmarshal(t.Payload, &p)
	for _, e := range p.Audit {
		switch {
		case auditIsContentChange(e):
			// The state the edit ARRIVED in is what decides whether it was
			// pre-work — not the state it ended in, which for an edit that
			// tripped the content gate is always 'proposed'.
			if gatePreWorkStates[e.FromState] {
				f.Amended = true
			}
		case e.FromState == "rejected" && e.ToState == "proposed":
			f.Undone++
		case e.FromState == "done" && e.ToState == "approved":
			f.Bounces++
		}
	}
	return f
}

// auditIsContentChange reports whether an audit entry records a title/body edit
// rather than a state move. Anything in Change that isn't store.StateChange is
// a content field by construction (store.contentFields is the only other source
// of values there), so this stays correct if a third content field is ever
// added.
func auditIsContentChange(e store.ContentAudit) bool {
	for _, c := range e.Change {
		if c != store.StateChange {
			return true
		}
	}
	return false
}

// add folds one task's facts into a tally.
func (g *gateTally) add(f gateTaskFacts) {
	// Undo and bounce counts are recorded even for an ungated task: they are
	// observations about what happened here, not inputs to the rate.
	g.RejectionsUndone += f.Undone
	g.PostWorkBounces += f.Bounces
	if f.UngatedAuto {
		g.UngatedAuto++
		return
	}
	if !f.Decided {
		g.Pending++
		// A pending task's amendment is real but has no denominator to sit in
		// yet; it will be counted when the gate rules on it.
		return
	}
	g.Decided++
	if f.Rejected {
		g.Rejected++
	}
	if f.Amended {
		g.Amended++
	}
	if f.Rejected || f.Amended {
		g.Intervened++
	}
}

// finish derives the rate. Separate from add so the division happens exactly
// once, after every task has landed.
func (g *gateTally) finish() {
	if g.Decided <= 0 {
		g.HasRate = false
		g.RatePct = 0
		return
	}
	g.HasRate = true
	g.RatePct = math.Round(float64(g.Intervened)/float64(g.Decided)*1000) / 10
}

// buildGateMetrics is the whole computation, PURE: epics + tasks + a clock in,
// the response out. No store, no request — so every rule above (the undo, the
// auto exclusion, the pre-work window, the union numerator) is table-testable
// without a database.
func buildGateMetrics(epics, tasks []*store.Action, now time.Time, windowDays int) gateMetricsBody {
	since := now.Add(-time.Duration(windowDays) * 24 * time.Hour)

	known := make(map[uuid.UUID]*store.Action, len(epics))
	for _, e := range epics {
		if e != nil {
			known[e.ID] = e
		}
	}

	var all, window, unepiced gateTally
	byEpic := map[uuid.UUID]*gateTally{}

	for _, t := range tasks {
		if t == nil {
			continue
		}
		f := classifyGateTask(t)
		all.add(f)
		// The rolling window is keyed on when the task was PROPOSED (created),
		// not when it was decided: the population is "work put in front of the
		// gate during this period", and keying on the decision would move a task
		// between windows every time somebody touched it.
		if !t.CreatedAt.Before(since) {
			window.add(f)
		}

		var p gateTaskPayload
		_ = json.Unmarshal(t.Payload, &p)
		id, err := uuid.Parse(strings.TrimSpace(p.EpicID))
		// A dangling epicId (the epic was deleted) counts as unepiced rather than
		// vanishing — same call the epic rollup makes, and for the same reason:
		// the task is real and something has to account for it.
		if err != nil || known[id] == nil {
			unepiced.add(f)
			continue
		}
		if byEpic[id] == nil {
			byEpic[id] = &gateTally{}
		}
		byEpic[id].add(f)
	}

	all.finish()
	window.finish()
	unepiced.finish()

	// Oldest batch first — the order the board's epic timeline reads in.
	ordered := make([]*store.Action, 0, len(epics))
	for _, e := range epics {
		if e != nil && byEpic[e.ID] != nil {
			ordered = append(ordered, e)
		}
	}
	sort.SliceStable(ordered, func(i, j int) bool {
		if !ordered[i].CreatedAt.Equal(ordered[j].CreatedAt) {
			return ordered[i].CreatedAt.Before(ordered[j].CreatedAt)
		}
		return ordered[i].ID.String() < ordered[j].ID.String()
	})

	out := make([]gateEpicTally, 0, len(ordered))
	truncated := 0
	for _, e := range ordered {
		if len(out) >= maxGateEpics {
			truncated++
			continue
		}
		var ep struct {
			Title string `json:"title"`
		}
		_ = json.Unmarshal(e.Payload, &ep)
		tally := *byEpic[e.ID]
		tally.finish()
		out = append(out, gateEpicTally{
			ID:      e.ID,
			Title:   strings.TrimSpace(ep.Title),
			State:   e.State,
			Tally:   tally,
			Created: e.CreatedAt,
		})
	}

	return gateMetricsBody{
		Type:        "gate.metrics",
		GeneratedAt: now.UTC().Format(time.RFC3339),
		WindowDays:  windowDays,
		AllTime:     all,
		Window:      window,
		Epics:       out,
		Unepiced:    unepiced,
		Truncated:   truncated,
		Definition:  gateDefinition,
		Caveat:      gateCaveat,
		Hint: "The share of proposed work that was rejected or rewritten BEFORE an agent built it — " +
			"the one number that separates 'the plans are good' from 'nobody is reading the plans'. " +
			"Read it with `caveat`: it is a diagnostic, never a target.",
	}
}

// GET /api/canvas/gate   (canvas JWT required; any role)
//
//	?days=30   rolling window, by task creation date
//
// Same two-list, one-round-trip shape as the epic rollup, and the same read-time
// derivation — see the file header for why there is no table behind this.
func (h *Handler) GateMetrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	canvasID := CanvasIDFromCtx(ctx)

	days := gateWindowDaysDefault
	if raw := strings.TrimSpace(r.URL.Query().Get("days")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			writeError(w, http.StatusBadRequest, "days must be a positive whole number")
			return
		}
		if n > gateWindowDaysMax {
			n = gateWindowDaysMax
		}
		days = n
	}

	var epics, tasks []*store.Action
	fetches := []func() error{
		func() error {
			list, err := h.store.ListActions(ctx, canvasID, "", "epic", "")
			if err != nil {
				return err
			}
			epics = list
			return nil
		},
		func() error {
			list, err := h.store.ListActions(ctx, canvasID, "", "task", "")
			if err != nil {
				return err
			}
			tasks = list
			return nil
		},
	}
	if err := runBatch(len(fetches), func(i int) error { return fetches[i]() }); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, buildGateMetrics(epics, tasks, time.Now().UTC(), days))
}
