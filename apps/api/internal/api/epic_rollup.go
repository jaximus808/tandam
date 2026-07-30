package api

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// The epic rollup (TDM-93) — "what did this batch achieve?" in ONE read.
//
// WHY AN ENDPOINT AND NOT N READS. board_status used to answer the epic question
// by listing epics and counting tasks client-side, which gave counts but no
// account of the work: the ticket-by-ticket results only existed on the tasks
// themselves, so an agent (or a human) asking what E5 delivered had to read six
// tasks. This composes the whole answer server-side from two list queries, in
// parallel: the epics, and the tasks. Nothing here is per-item.
//
// DERIVED, NEVER STORED. Counts, the activity window, the drained flag and the
// done-ticket lines are all computed at read time from rows that already exist —
// there is no rollup table to keep in sync and no migration. The one PERSISTED
// half is the epic's own `summary` (epic_summary.go), because prose about intent
// is the one thing a machine cannot derive from task states.

// epicResultExcerpt caps a done task's result line in RUNES. This is a rollup:
// one line per ticket, enough to recognize the work. The full result is on the
// task, one task_get away.
const epicResultExcerpt = 240

// maxEpicDoneLines caps how many done-ticket lines one epic contributes. A
// 60-task epic would otherwise dominate the response the rollup exists to keep
// cheap; the count in `tasks` still tells the whole truth.
const maxEpicDoneLines = 40

// epicTerminalStates mirrors the web's TERMINAL_STATES (lib/epicLifecycle.ts) —
// a task in one of these never moves again on its own, and an approved epic whose
// every task is terminal has DRAINED. The two definitions must agree or the board
// and the MCP will disagree about whether a batch is finished.
var epicTerminalStates = map[string]bool{"done": true, "failed": true, "rejected": true}

// epicTaskRollup is the count half: the total and the per-state breakdown, the
// same shape the MCP's board_status already speaks.
type epicTaskRollup struct {
	Total   int            `json:"total"`
	ByState map[string]int `json:"byState"`
}

// epicDoneLine is one finished ticket, as a reader meets it: what it was and
// what it produced. `result` is the first line of the task's result, excerpted.
type epicDoneLine struct {
	ID       uuid.UUID `json:"id"`
	TicketID string    `json:"ticketId,omitempty"`
	Title    string    `json:"title"`
	State    string    `json:"state"`
	Result   string    `json:"result,omitempty"`
}

// epicRollup is one epic, answerable without opening a single ticket.
type epicRollup struct {
	ID    uuid.UUID `json:"id"`
	Title string    `json:"title"`
	State string    `json:"state"`
	// Summary is the persisted human/agent account of what the batch achieved,
	// with its server-stamped provenance. Absent until somebody writes one.
	Summary   string         `json:"summary,omitempty"`
	SummaryBy string         `json:"summaryBy,omitempty"`
	SummaryAt string         `json:"summaryAt,omitempty"`
	Tasks     epicTaskRollup `json:"tasks"`
	// FirstActivity / LastActivity bound the batch in time: the earliest task
	// creation and the latest task update. Absent for an epic with no tasks.
	FirstActivity *time.Time `json:"firstActivity,omitempty"`
	LastActivity  *time.Time `json:"lastActivity,omitempty"`
	// Done is the ticket-level account, oldest ticket first.
	Done []epicDoneLine `json:"done"`
	// Drained: approved, has tasks, and every one of them is terminal — the epic
	// is over whether or not anyone has said what it achieved.
	Drained bool `json:"drained"`
	// SummaryNeeded is the affordance that makes the write path get used: a
	// drained epic with no summary is a batch whose story is about to be lost.
	SummaryNeeded bool `json:"summaryNeeded"`
	// Truncated counts done lines omitted by maxEpicDoneLines.
	Truncated int `json:"truncated,omitempty"`
}

// epicRollupBody is the endpoint's response.
type epicRollupBody struct {
	Epics []epicRollup `json:"epics"`
	// Unepiced is every task with no epicId (or one that dangles) — the work
	// that belongs to no batch, which no epic row would otherwise account for.
	Unepiced epicTaskRollup `json:"unepiced"`
	Hint     string         `json:"_hint"`
}

// epicRollupTaskPayload is the slice of a task payload the rollup reads.
type epicRollupTaskPayload struct {
	Title  string `json:"title"`
	EpicID string `json:"epicId"`
}

// buildEpicRollups is the whole computation, PURE: epics + tasks in, rollups
// out. No store, no clock, no request — which is what makes every branch here
// (dangling epicId, ticketless task, drained-with-no-summary, the done cap)
// table-testable without a database.
//
// Epics come back in creation order — the order the board's epic timeline reads
// in, oldest first.
func buildEpicRollups(epics, tasks []*store.Action) epicRollupBody {
	byEpic := map[uuid.UUID][]*store.Action{}
	known := make(map[uuid.UUID]bool, len(epics))
	for _, e := range epics {
		if e != nil {
			known[e.ID] = true
		}
	}
	unepiced := epicTaskRollup{ByState: map[string]int{}}
	for _, t := range tasks {
		if t == nil {
			continue
		}
		var p epicRollupTaskPayload
		_ = json.Unmarshal(t.Payload, &p)
		id, err := uuid.Parse(strings.TrimSpace(p.EpicID))
		// A dangling epicId (the epic was deleted) counts as unepiced rather
		// than vanishing — the task is real and somebody has to account for it.
		if err != nil || !known[id] {
			unepiced.Total++
			unepiced.ByState[t.State]++
			continue
		}
		byEpic[id] = append(byEpic[id], t)
	}

	ordered := make([]*store.Action, 0, len(epics))
	for _, e := range epics {
		if e != nil {
			ordered = append(ordered, e)
		}
	}
	sort.SliceStable(ordered, func(i, j int) bool {
		if !ordered[i].CreatedAt.Equal(ordered[j].CreatedAt) {
			return ordered[i].CreatedAt.Before(ordered[j].CreatedAt)
		}
		return ordered[i].ID.String() < ordered[j].ID.String()
	})

	out := make([]epicRollup, 0, len(ordered))
	for _, e := range ordered {
		out = append(out, rollupOne(e, byEpic[e.ID]))
	}
	return epicRollupBody{
		Epics:    out,
		Unepiced: unepiced,
		Hint: "One read for every batch on this board: its summary (what it achieved), task counts " +
			"by state, and one line per finished ticket. An epic with summaryNeeded:true has drained " +
			"with nobody saying what it delivered — write it in one call.",
	}
}

func rollupOne(e *store.Action, tasks []*store.Action) epicRollup {
	var ep struct {
		Title string `json:"title"`
	}
	_ = json.Unmarshal(e.Payload, &ep)
	sum := readEpicSummary(e.Payload)

	r := epicRollup{
		ID:        e.ID,
		Title:     strings.TrimSpace(ep.Title),
		State:     e.State,
		Summary:   sum.Summary,
		SummaryBy: sum.SummaryBy,
		SummaryAt: sum.SummaryAt,
		Tasks:     epicTaskRollup{ByState: map[string]int{}},
		Done:      []epicDoneLine{},
	}

	ordered := sortedTasks(tasks)
	allTerminal := true
	for _, t := range ordered {
		r.Tasks.Total++
		r.Tasks.ByState[t.State]++
		if !epicTerminalStates[t.State] {
			allTerminal = false
		}
		if r.FirstActivity == nil || t.CreatedAt.Before(*r.FirstActivity) {
			at := t.CreatedAt
			r.FirstActivity = &at
		}
		if r.LastActivity == nil || t.UpdatedAt.After(*r.LastActivity) {
			at := t.UpdatedAt
			r.LastActivity = &at
		}
		// The account of the work: what finished, and what it produced. `failed`
		// belongs here too — "we tried and it broke" is part of what a batch
		// achieved, and hiding it would make the rollup flattering rather than
		// honest. Rejected tasks are not: nobody worked them.
		if t.State != "done" && t.State != "failed" {
			continue
		}
		if len(r.Done) >= maxEpicDoneLines {
			r.Truncated++
			continue
		}
		var p epicRollupTaskPayload
		_ = json.Unmarshal(t.Payload, &p)
		r.Done = append(r.Done, epicDoneLine{
			ID:       t.ID,
			TicketID: t.TicketID(),
			Title:    strings.TrimSpace(p.Title),
			State:    t.State,
			Result:   firstLineExcerpt(t.Result, epicResultExcerpt),
		})
	}

	r.Drained = e.State == "approved" && r.Tasks.Total > 0 && allTerminal
	r.SummaryNeeded = r.Drained && r.Summary == ""
	return r
}

// firstLineExcerpt renders a task result as ONE line, capped by rune. Results
// are often multi-paragraph (files touched, commit, what's left for the human);
// the rollup wants the headline, and the task itself keeps the rest.
func firstLineExcerpt(s *string, max int) string {
	if s == nil {
		return ""
	}
	line := strings.TrimSpace(*s)
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = strings.TrimSpace(line[:i])
	}
	if r := []rune(line); len(r) > max {
		return strings.TrimSpace(string(r[:max])) + "…"
	}
	return line
}

// GET /api/canvas/epics   (canvas JWT required; any role)
//
// The batch-level read: every epic with its summary and its derived rollup, so a
// board-shaped question costs one round trip instead of one per ticket. Two list
// queries in parallel — see buildEpicRollups for the (pure) composition.
//
// Counts every type="task" action, human todos included: an epic's rollup is the
// truth about the epic, not about one assignee. board_status's own task census
// stays agent-only, and the two answer different questions on purpose.
func (h *Handler) ListEpics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	canvasID := CanvasIDFromCtx(ctx)

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

	// Same pulse as the other agent read paths — a rollup read is a session
	// looking at the board, and viewers should see that.
	broadcastActivity(h.hub, canvasID, "read")

	writeJSON(w, http.StatusOK, buildEpicRollups(epics, tasks))
}
