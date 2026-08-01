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

// THE COMPACT DEFAULT (TDM-183). This endpoint composes the batch account for a
// board that now has 31 epics and 221 finished tickets, and it used to render one
// line per finished ticket every time anybody asked where the project stands.
// Almost all of that is ARCHIVE: a batch that drained weeks ago answers "what is
// left?" with a number, and nobody reads its per-ticket lines. So the DEFAULT is
// now the live half — counts, the activity window, and the summary saying what
// the batch achieved — and `?full=1` returns today's shape, byte for byte, for
// the readers that do want the lines (the web board, and whoever is writing an
// epic summary).
//
// WHAT THE DIET NEVER TOUCHES. Counts, drained/summaryNeeded, and the returned[]
// account. A batch with OPEN work or with tickets that came BACK keeps its line
// items in both shapes — that is the half a reader acts on — and only its result
// excerpts get shorter. Compaction trims LINES, never the truth about how much
// work there was.

// epicResultExcerpt caps a done task's result line in RUNES. This is a rollup:
// one line per ticket, enough to recognize the work. The full result is on the
// task, one task_get away.
const epicResultExcerpt = 240

// epicResultExcerptCompact is the same cap on the compact default. Shorter
// because the compact read's job is recognition, not reading: the whole result
// is one task_get away and the whole excerpt is one `?full=1` away.
const epicResultExcerptCompact = 160

// maxEpicDoneLines caps how many done-ticket lines one epic contributes. A
// 60-task epic would otherwise dominate the response the rollup exists to keep
// cheap; the count in `tasks` still tells the whole truth.
const maxEpicDoneLines = 40

// maxEpicReturnedLines caps the returned[] lines one epic contributes, for the
// same reason as maxEpicDoneLines. Lower, because these carry prose: a batch
// where twenty tickets came back is a batch whose problem is the plan, and the
// twenty-first reason adds nothing the first twenty did not already say.
const maxEpicReturnedLines = 20

// reviewReasonExcerpt caps a reason in RUNES on this LIST read. The single-task
// read (task_get) hands the reason back whole and this one points at it; see
// excerptReason in review_feedback.go for why the two differ.
const reviewReasonExcerpt = 400

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

// epicReturnedLine is one ticket in this batch that came BACK — rejected at the
// gate, or bounced for rework after it was finished — with the reason attached
// (TDM-161).
//
// WHY IT BELONGS IN THE BATCH READ. An orchestrator that proposed eleven tickets
// and polls to learn what was approved otherwise sees only that the count
// dropped: seven approved, and no account of the four that went away. The reason
// is the correction, and it is worth more to the plan than to the ticket — "no,
// messaging is a separate service" applies to the neighbours as much as to the
// ticket it was typed on. Reading it per batch is what lets an orchestrator
// amend the rest of the plan before it gets worked.
type epicReturnedLine struct {
	ID       uuid.UUID `json:"id"`
	TicketID string    `json:"ticketId,omitempty"`
	Title    string    `json:"title"`
	State    string    `json:"state"`
	// Outcome / Reason / By / At, flattened out of reviewFeedback so a line here
	// reads like the done[] lines beside it rather than nesting one object deep.
	Outcome string `json:"outcome"`
	Reason  string `json:"reason,omitempty"`
	By      string `json:"by,omitempty"`
	At      string `json:"at,omitempty"`
	// ReasonTruncated says the reason was cut for this list; task_get on the
	// ticket has the whole thing.
	ReasonTruncated bool `json:"reasonTruncated,omitempty"`
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
	// Returned is the other half of that account (TDM-161): the tickets that came
	// back, with WHY. Oldest first, like Done. Empty on a batch nobody has
	// corrected — which is most of them.
	Returned []epicReturnedLine `json:"returned"`
	// Review is feedback on the EPIC ITSELF — a human rejecting the whole batch.
	// Same shape a task carries, because "the batch was cut, here is why" is the
	// same news as "the ticket was cut, here is why".
	Review *reviewFeedback `json:"review,omitempty"`
	// Drained: approved, has tasks, and every one of them is terminal — the epic
	// is over whether or not anyone has said what it achieved.
	Drained bool `json:"drained"`
	// SummaryNeeded is the affordance that makes the write path get used: a
	// drained epic with no summary is a batch whose story is about to be lost.
	SummaryNeeded bool `json:"summaryNeeded"`
	// Truncated counts done lines omitted by maxEpicDoneLines.
	Truncated int `json:"truncated,omitempty"`
	// ReturnedTruncated counts returned lines omitted by maxEpicReturnedLines.
	ReturnedTruncated int `json:"returnedTruncated,omitempty"`
	// DoneOmitted counts the finished-ticket lines the COMPACT default left out
	// on a batch with nothing open and nothing returned — the archive this read
	// stopped shipping. It is the difference between "this batch produced
	// nothing" and "this batch's account is one `?full=1` away", so it is the one
	// field that must never be silently absent. Never set on ?full=1.
	DoneOmitted int `json:"doneOmitted,omitempty"`
}

// epicRollupBody is the endpoint's response.
type epicRollupBody struct {
	Epics []epicRollup `json:"epics"`
	// Unepiced is every task with no epicId (or one that dangles) — the work
	// that belongs to no batch, which no epic row would otherwise account for.
	Unepiced epicTaskRollup `json:"unepiced"`
	// UnepicedReturned is the returned[] list for those same batchless tickets
	// (TDM-161). Without it a ticket proposed on its own with task_propose could
	// be rejected and its reason would be reachable only by knowing to task_get a
	// ticket you were never told about — the dead end this whole feedback channel
	// exists to close.
	UnepicedReturned []epicReturnedLine `json:"unepicedReturned"`
	// Compact marks the cheap default (TDM-183): drained batches answered with
	// counts instead of their per-ticket lines. Absent on `?full=1`, which is
	// what makes that shape byte-identical to what this endpoint always returned.
	Compact bool   `json:"compact,omitempty"`
	Hint    string `json:"_hint"`
}

// The two hints. fullRollupHint is the string this endpoint has always
// returned — it is part of what `?full=1` keeps byte-identical, so edit it only
// alongside the callers that read the full shape.
const fullRollupHint = "One read for every batch on this board: its summary (what it achieved), task counts " +
	"by state, and one line per finished ticket. An epic with summaryNeeded:true has drained " +
	"with nobody saying what it delivered — write it in one call. `returned` is the other " +
	"half of the account: the tickets that came BACK — rejected at the gate, or bounced for " +
	"rework — each with the reason. Read those against the tickets still standing: a " +
	"rejection is a correction to the PLAN, not just to the ticket it was typed on. Reasons " +
	"are excerpted here; task_get on the ticket has the whole thing."

const compactRollupHint = "One read for every batch on this board: its summary (what it achieved) and task counts " +
	"by state. Batches that have DRAINED answer with counts alone — `doneOmitted` says how " +
	"many finished-ticket lines were left out, and `?full=1` returns them plus every excerpt " +
	"in full. Batches with OPEN or RETURNED work keep their line items, because that is the " +
	"half you act on. An epic with summaryNeeded:true has drained with nobody saying what it " +
	"delivered — write it in one call. `returned` is the tickets that came BACK — rejected at " +
	"the gate, or bounced for rework — each with the reason; read those against the tickets " +
	"still standing, because a rejection is a correction to the PLAN, not just to the ticket " +
	"it was typed on. Results and reasons are excerpted here; task_get on the ticket has the " +
	"whole thing."

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
//
// This wrapper is the FULL shape — what `?full=1` answers and what this endpoint
// has always returned. The default response is the compact one; see
// buildEpicRollupsView.
func buildEpicRollups(epics, tasks []*store.Action) epicRollupBody {
	return buildEpicRollupsView(epics, tasks, true)
}

// buildEpicRollupsView is buildEpicRollups with the shape switch: full=true is
// today's response, full=false the compact default (TDM-183).
func buildEpicRollupsView(epics, tasks []*store.Action, full bool) epicRollupBody {
	byEpic := map[uuid.UUID][]*store.Action{}
	known := make(map[uuid.UUID]bool, len(epics))
	for _, e := range epics {
		if e != nil {
			known[e.ID] = true
		}
	}
	unepiced := epicTaskRollup{ByState: map[string]int{}}
	unepicedReturned := []epicReturnedLine{}
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
			if fb := deriveReviewFeedback(t); fb != nil && len(unepicedReturned) < maxEpicReturnedLines {
				unepicedReturned = append(unepicedReturned, returnedLine(t, fb))
			}
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
		out = append(out, rollupOne(e, byEpic[e.ID], full))
	}
	body := epicRollupBody{
		Epics:            out,
		Unepiced:         unepiced,
		UnepicedReturned: unepicedReturned,
		Hint:             fullRollupHint,
	}
	if !full {
		body.Compact = true
		body.Hint = compactRollupHint
	}
	return body
}

func rollupOne(e *store.Action, tasks []*store.Action, full bool) epicRollup {
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
		Returned:  []epicReturnedLine{},
		// The epic's own feedback, when a human rejected the whole batch.
		Review: deriveReviewFeedback(e),
	}

	excerpt := epicResultExcerpt
	if !full {
		excerpt = epicResultExcerptCompact
	}

	ordered := sortedTasks(tasks)
	allTerminal := true
	// doneCount is every finished (done|failed) ticket, counted whether or not it
	// got a line — so the compact shape can say how many lines it left out even
	// when maxEpicDoneLines already dropped some.
	doneCount := 0
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
		// The other account (TDM-161): the tickets that came back, and why. A
		// rejected ticket appears HERE rather than in done[] — nobody worked it —
		// and a ticket bounced for rework appears here while the bounce is
		// outstanding, even though it is 'approved' and counted as such above.
		// The two lists answer different questions and a ticket may legitimately
		// be in the counts and here at once.
		if fb := deriveReviewFeedback(t); fb != nil {
			if len(r.Returned) >= maxEpicReturnedLines {
				r.ReturnedTruncated++
			} else {
				r.Returned = append(r.Returned, returnedLine(t, fb))
			}
		}
		// The account of the work: what finished, and what it produced. `failed`
		// belongs here too — "we tried and it broke" is part of what a batch
		// achieved, and hiding it would make the rollup flattering rather than
		// honest. Rejected tasks are not: nobody worked them.
		if t.State != "done" && t.State != "failed" {
			continue
		}
		doneCount++
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
			Result:   firstLineExcerpt(t.Result, excerpt),
		})
	}

	r.Drained = e.State == "approved" && r.Tasks.Total > 0 && allTerminal
	r.SummaryNeeded = r.Drained && r.Summary == ""
	if !full {
		compactRollup(&r, allTerminal, doneCount)
	}
	return r
}

// compactRollup puts one epic on the diet (TDM-183).
//
// The stamps go in every case: summaryBy/summaryAt are provenance on a LIST
// read, and the summary itself is what the reader came for. The per-ticket lines
// go only when the batch has nothing OPEN and nothing RETURNED — the two
// conditions that make its line items actionable rather than archival. Note the
// test is "nothing open", not the `drained` flag: an epic still `proposed` whose
// every task is terminal is archive too, and `drained` deliberately says no.
//
// doneOmitted is what keeps this honest — a compacted batch says how many lines
// it is not showing, so an empty done[] never reads as "this batch shipped
// nothing".
func compactRollup(r *epicRollup, allTerminal bool, doneCount int) {
	r.SummaryBy = ""
	r.SummaryAt = ""
	if !allTerminal || len(r.Returned) > 0 {
		return
	}
	r.Done = []epicDoneLine{}
	r.Truncated = 0
	r.DoneOmitted = doneCount
}

// returnedLine renders one came-back ticket for a list read, with its reason
// excerpted. Shared by the per-epic list and the unepiced one so a ticket's line
// does not depend on whether it happens to sit in a batch.
func returnedLine(t *store.Action, fb *reviewFeedback) epicReturnedLine {
	var p epicRollupTaskPayload
	_ = json.Unmarshal(t.Payload, &p)
	reason, cut := excerptReason(fb.Reason, reviewReasonExcerpt)
	return epicReturnedLine{
		ID:              t.ID,
		TicketID:        t.TicketID(),
		Title:           strings.TrimSpace(p.Title),
		State:           t.State,
		Outcome:         fb.Outcome,
		Reason:          reason,
		By:              fb.By,
		At:              fb.At,
		ReasonTruncated: cut,
	}
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
//
// Two shapes (TDM-183):
//   - (default)  → compact: drained batches answer with counts, not line items.
//   - ?full=1    → today's shape, unchanged, for the board and summary writers.
func (h *Handler) ListEpics(w http.ResponseWriter, r *http.Request) {
	full := rollupFullRequested(r.URL.Query().Get("full"))
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

	writeJSON(w, http.StatusOK, buildEpicRollupsView(epics, tasks, full))
}

// rollupFullRequested reads ?full. The documented spelling is `?full=1`, but
// `true` and `yes` mean the same thing here: a caller who guessed the other
// spelling and got the compact shape back would conclude the ticket lines were
// GONE, not that the flag was misspelled — a silent wrong answer, which is worse
// than being liberal about three synonyms. Anything else (absent, 0, false) is
// the default.
func rollupFullRequested(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes":
		return true
	}
	return false
}
