package api

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// The context bundle — one read that hands an agent everything it needs on
// connect, rendered as AGENTS.md-shaped markdown.
//
// WHY MARKDOWN AND NOT JSON. The consumer is a model, and the thing it is best
// at reading is the format its own instruction files are written in: an H1 for
// what this is, H2 sections for the parts, prose in between. A JSON envelope of
// the same facts costs more tokens and has to be re-narrated by the client
// before the model can use it. The JSON envelope this rides in carries only the
// markdown plus counts, so callers that want to meter or cache have something
// cheap to look at without parsing prose.
//
// WHY A PURE FUNCTION. renderContextMarkdown takes already-fetched state and a
// pinned `now`, and returns a string — no store, no clock, no request. That
// makes the whole rendering surface (every section, every empty state, every
// freshness annotation) table-testable without a DB, and it makes the one thing
// freshness must not get wrong — a single instant for the whole bundle —
// structurally guaranteed rather than a convention the handler has to remember.
//
// FRESHNESS IS SHOWN, NEVER FILTERED. A stale note stays in the bundle with a
// visible "[stale — verified 21d ago]". Dropping it would silently delete
// context the author put there; annotating it lets the agent weigh it. That is
// the whole point of migration 0037 — rot made visible, not hidden.

// contextBundle is the fully-fetched input to the formatter. Everything here is
// plain loaded state: the handler does all I/O, the formatter does none.
type contextBundle struct {
	Canvas *store.Canvas
	// BriefingDoc is the document designated by canvases.briefing_doc_id, nil
	// when none is designated (or when the designation dangles).
	BriefingDoc   *store.Document
	BriefingNotes []*store.Note
	// ApprovedTasks are the type="task", state="approved" actions — the
	// ready-to-work queue. Rendered as a compact list, never full bodies.
	ApprovedTasks []*store.Action
	// EpicTitles maps epic action id → title, so a task's epic can be named
	// without a per-task lookup.
	EpicTitles map[uuid.UUID]string
	// Epics are the type="epic" actions in creation order — rendered as the
	// batch-level "what has this board achieved" section (TDM-93). The same rows
	// EpicTitles is built from, so this costs no extra read.
	Epics []*store.Action
	// Task and TaskLinks are populated only for a ?taskId= request: that one
	// task hydrated with its linked notes / roadmap items.
	Task      *store.Action
	TaskLinks []store.TaskLink
}

// contextTaskPayload is the slice of a task action's payload the bundle renders.
// Unknown fields are ignored — the payload is open by design.
type contextTaskPayload struct {
	Title     string      `json:"title"`
	Body      string      `json:"body"`
	EpicID    string      `json:"epicId"`
	Assignee  string      `json:"assignee"`
	LinkedIDs []uuid.UUID `json:"linkedIds"`
	// Links is completion EVIDENCE (TDM-45) — commit / PR / branch URLs left by
	// whoever worked this task before. Worth rendering because a task that comes
	// back round (re-queued, or a follow-up) reads better with the previous
	// attempt's artefacts named than without them.
	Links []string `json:"links"`
}

func decodeTaskPayload(raw json.RawMessage) contextTaskPayload {
	var p contextTaskPayload
	_ = json.Unmarshal(raw, &p)
	return p
}

// renderContextMarkdown renders the bundle. Pure: same input + same `now` →
// byte-identical output, which is what makes it worth diffing in tests.
func renderContextMarkdown(b contextBundle, now time.Time) string {
	var sb strings.Builder

	name := "Canvas"
	if b.Canvas != nil && strings.TrimSpace(b.Canvas.Name) != "" {
		name = strings.TrimSpace(b.Canvas.Name)
	}
	fmt.Fprintf(&sb, "# %s\n\n", name)
	fmt.Fprintf(&sb,
		"_Context bundle generated %s. Freshness is derived at read time from "+
			"(verified_at, stale_after_seconds); items with no annotation have never been verified._\n",
		now.UTC().Format(time.RFC3339))

	renderBriefingSection(&sb, b, now)
	renderEpicsSection(&sb, b)
	renderQueueSection(&sb, b)
	if b.Task != nil {
		renderTaskSection(&sb, b, now)
	}
	return sb.String()
}

// renderBriefingSection renders the designated briefing document's notes, in
// order — the "read me first" an agent gets on connect. The absent case is a
// real section with a real instruction, not a silent omission: an agent that
// gets no Briefing heading can't tell "this canvas has no briefing" from "the
// bundle forgot to include it".
func renderBriefingSection(sb *strings.Builder, b contextBundle, now time.Time) {
	sb.WriteString("\n## Briefing\n\n")
	if b.BriefingDoc == nil {
		sb.WriteString("No briefing document is designated for this canvas. " +
			"Designate one (canvases.briefing_doc_id) to give every agent the same read-me-first on connect.\n")
		return
	}
	fmt.Fprintf(sb, "Source: **%s**%s\n",
		orFallback(strings.TrimSpace(b.BriefingDoc.Name), "(untitled document)"),
		suffixFreshness(b.BriefingDoc.VerifiedAt, b.BriefingDoc.StaleAfterSeconds, now))

	notes := sortedNotes(b.BriefingNotes)
	if len(notes) == 0 {
		sb.WriteString("\nThe briefing document has no content yet.\n")
		return
	}
	for _, n := range notes {
		sb.WriteString("\n")
		// Note bodies are free prose with no label line of their own, so the
		// annotation goes on its own line BEFORE the body — a reader is warned
		// that what follows is stale before they read and believe it, not after.
		if ann := freshnessAnnotation(n.VerifiedAt, n.StaleAfterSeconds, now); ann != "" {
			sb.WriteString(ann + "\n\n")
		}
		sb.WriteString(strings.TrimRight(n.Body, "\n") + "\n")
	}
}

// renderEpicsSection renders the board's batches and what each one achieved
// (TDM-93). The SUMMARY is the point: an agent orienting on a canvas should learn
// "E5 shipped the metrics endpoint and the loadtest" from the briefing, instead
// of having to open six tickets to reconstruct it.
//
// Deliberately NOT the per-epic task rollup (counts, drained, done lines): that
// needs every task on the canvas, and the briefing's whole discipline is two
// waves of reads. The rollup has its own one-call endpoint —
// GET /api/canvas/epics, which is what the MCP's board_status reads.
//
// An epic with no summary is listed anyway, marked as such. Hiding it would let
// a reader mistake "nobody wrote it down" for "nothing happened", and the
// unwritten summary is exactly the thing worth prompting about.
func renderEpicsSection(sb *strings.Builder, b contextBundle) {
	epics := sortedEpics(b.Epics)
	if len(epics) == 0 {
		return
	}
	sb.WriteString("\n## Epics\n\n")
	fmt.Fprintf(sb, "%s on this board, oldest first. For task counts and the ticket-by-ticket "+
		"account, read the epic rollup (board_status).\n",
		plural(len(epics), "batch", "batches"))
	for _, e := range epics {
		p := decodeTaskPayload(e.Payload)
		fmt.Fprintf(sb, "\n**%s** (%s)\n",
			orFallback(strings.TrimSpace(p.Title), "(untitled epic)"), e.State)
		sum := readEpicSummary(e.Payload)
		if sum.Summary == "" {
			sb.WriteString("\n_No summary yet — what this batch achieved is unrecorded._\n")
			continue
		}
		fmt.Fprintf(sb, "\n%s\n", strings.TrimRight(sum.Summary, "\n"))
		if by := strings.TrimSpace(sum.SummaryBy); by != "" {
			fmt.Fprintf(sb, "\n_— %s_\n", by)
		}
	}
}

// renderQueueSection renders the approved queue as one line per task: ticket,
// title, epic. Deliberately NOT the bodies — this is the "what could I pick up"
// view, and a board with 40 approved tasks would otherwise dominate the bundle.
// The full body of ONE task arrives via ?taskId=.
func renderQueueSection(sb *strings.Builder, b contextBundle) {
	sb.WriteString("\n## Approved queue\n\n")
	tasks := sortedTasks(b.ApprovedTasks)
	if len(tasks) == 0 {
		sb.WriteString("No approved tasks — the ready-to-work queue is empty.\n")
		return
	}
	fmt.Fprintf(sb, "%s ready to work. Titles only — request one with ?taskId= for its body and linked context.\n\n",
		plural(len(tasks), "approved task", "approved tasks"))
	for _, t := range tasks {
		p := decodeTaskPayload(t.Payload)
		fmt.Fprintf(sb, "- %s%s%s\n",
			ticketPrefix(t),
			orFallback(strings.TrimSpace(p.Title), "(untitled task)"),
			epicSuffix(b.EpicTitles, p.EpicID))
	}
}

// renderTaskSection renders the one requested task hydrated: its own fields plus
// every linked note / roadmap item in full, each annotated with its freshness.
func renderTaskSection(sb *strings.Builder, b contextBundle, now time.Time) {
	t := b.Task
	p := decodeTaskPayload(t.Payload)

	heading := "Task"
	if id := t.TicketID(); id != "" {
		heading = "Task " + id
	}
	fmt.Fprintf(sb, "\n## %s\n\n", heading)

	fmt.Fprintf(sb, "**%s**\n\n", orFallback(strings.TrimSpace(p.Title), "(untitled task)"))
	meta := []string{"state: " + t.State}
	if epic := epicTitle(b.EpicTitles, p.EpicID); epic != "" {
		meta = append(meta, "epic: "+epic)
	}
	if a := strings.TrimSpace(p.Assignee); a != "" {
		meta = append(meta, "assignee: "+a)
	}
	if t.ClaimedBy != nil && strings.TrimSpace(*t.ClaimedBy) != "" {
		meta = append(meta, "claimed by: "+strings.TrimSpace(*t.ClaimedBy))
	}
	fmt.Fprintf(sb, "%s\n", strings.Join(meta, " · "))

	if body := strings.TrimSpace(p.Body); body != "" {
		fmt.Fprintf(sb, "\n%s\n", body)
	}

	// Evidence from earlier work on this task, if any. One line each — the URL
	// is the fact; anything more would be this renderer guessing.
	if links := trimmedLinks(p.Links); len(links) > 0 {
		sb.WriteString("\n### Evidence\n\n")
		for _, l := range links {
			fmt.Fprintf(sb, "- %s\n", l)
		}
	}

	sb.WriteString("\n### Linked context\n\n")
	if len(b.TaskLinks) == 0 {
		sb.WriteString("No linked notes or roadmap items.\n")
		return
	}
	for i, l := range b.TaskLinks {
		if i > 0 {
			sb.WriteString("\n")
		}
		label := l.Kind
		if strings.TrimSpace(l.Title) != "" {
			label = l.Kind + " — " + strings.TrimSpace(l.Title)
		}
		if strings.TrimSpace(l.Status) != "" {
			label += " (status: " + strings.TrimSpace(l.Status) + ")"
		}
		fmt.Fprintf(sb, "**%s**%s\n", label, suffixFreshness(l.VerifiedAt, l.StaleAfterSeconds, now))
		if body := strings.TrimRight(l.Body, "\n"); strings.TrimSpace(body) != "" {
			fmt.Fprintf(sb, "\n%s\n", body)
		}
	}
}

// ── Freshness rendering ───────────────────────────────────────────────────────

// freshnessAnnotation renders an item's derived freshness as a bracketed
// annotation, or "" when it is unknown (never verified). Unknown is left
// unmarked on purpose: annotating every unverified item with "[unknown]" would
// put noise on the overwhelming majority of rows and drown the handful that
// actually decayed. The bundle header states the convention once instead.
func freshnessAnnotation(verifiedAt *time.Time, staleAfterSeconds *int, now time.Time) string {
	f := store.DeriveFreshness(verifiedAt, staleAfterSeconds, now)
	if f == store.FreshnessUnknown {
		return ""
	}
	// Non-unknown implies verifiedAt != nil (see DeriveFreshness's first rule).
	return fmt.Sprintf("[%s — verified %s]", f, humanAge(now.Sub(*verifiedAt)))
}

// suffixFreshness is freshnessAnnotation as a trailing suffix on a label line —
// " [aging — verified 3d ago]" — or "" when unknown.
func suffixFreshness(verifiedAt *time.Time, staleAfterSeconds *int, now time.Time) string {
	if ann := freshnessAnnotation(verifiedAt, staleAfterSeconds, now); ann != "" {
		return " " + ann
	}
	return ""
}

// humanAge renders an elapsed duration at one significant unit — "21d ago"
// beats "504h13m2s ago" for a reader deciding whether to trust a line. A
// negative duration (clock skew, or a verification stamped in the future)
// reads as "just now", matching DeriveFreshness treating it as fresh.
func humanAge(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

// contextCounts is the numeric side of the bundle: enough for a caller to meter
// or alert without parsing the markdown. stale/aging count every annotated item
// the bundle rendered, so "this canvas is rotting" is one integer away.
func contextCounts(b contextBundle, now time.Time) map[string]int {
	counts := map[string]int{
		"briefingNotes": len(b.BriefingNotes),
		"approvedTasks": len(b.ApprovedTasks),
		"linkedItems":   len(b.TaskLinks),
		"stale":         0,
		"aging":         0,
	}
	tally := func(verifiedAt *time.Time, staleAfterSeconds *int) {
		switch store.DeriveFreshness(verifiedAt, staleAfterSeconds, now) {
		case store.FreshnessStale:
			counts["stale"]++
		case store.FreshnessAging:
			counts["aging"]++
		}
	}
	if b.BriefingDoc != nil {
		tally(b.BriefingDoc.VerifiedAt, b.BriefingDoc.StaleAfterSeconds)
	}
	for _, n := range b.BriefingNotes {
		tally(n.VerifiedAt, n.StaleAfterSeconds)
	}
	for _, l := range b.TaskLinks {
		tally(l.VerifiedAt, l.StaleAfterSeconds)
	}
	return counts
}

// ── Small helpers ─────────────────────────────────────────────────────────────

// sortedNotes copies and orders briefing notes by (sortOrder, id). Ordering
// lives here rather than being trusted from the caller so the formatter's output
// is deterministic for any input — the property the table tests rest on.
func sortedNotes(in []*store.Note) []*store.Note {
	out := make([]*store.Note, 0, len(in))
	for _, n := range in {
		if n != nil {
			out = append(out, n)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].SortOrder != out[j].SortOrder {
			return out[i].SortOrder < out[j].SortOrder
		}
		return out[i].ID.String() < out[j].ID.String()
	})
	return out
}

// sortedTasks copies and orders the queue by ticket number ascending — the order
// the tasks were created, which is the order a human reads the board in.
// Ticketless tasks (pre-migration-0034 rows) sort last, then by creation time.
func sortedTasks(in []*store.Action) []*store.Action {
	out := make([]*store.Action, 0, len(in))
	for _, a := range in {
		if a != nil {
			out = append(out, a)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		ti, tj := out[i].Ticket, out[j].Ticket
		switch {
		case ti != nil && tj != nil:
			return *ti < *tj
		case ti != nil:
			return true
		case tj != nil:
			return false
		default:
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
	})
	return out
}

// sortedEpics copies and orders epics oldest-first — the same order the board's
// epic timeline reads in, and (id as tiebreak) deterministic for the tests.
func sortedEpics(in []*store.Action) []*store.Action {
	out := make([]*store.Action, 0, len(in))
	for _, e := range in {
		if e != nil {
			out = append(out, e)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return out[i].ID.String() < out[j].ID.String()
	})
	return out
}

// ticketPrefix renders "**TDM-29** — " for a ticketed task, "" otherwise.
func ticketPrefix(a *store.Action) string {
	if id := a.TicketID(); id != "" {
		return "**" + id + "** — "
	}
	return ""
}

// epicTitle resolves a payload epicId against the loaded epics. A dangling or
// unparseable id resolves to "" (the epic was deleted, or the field is junk) —
// the task still renders, just without a batch name.
func epicTitle(titles map[uuid.UUID]string, epicID string) string {
	id, err := uuid.Parse(strings.TrimSpace(epicID))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(titles[id])
}

func epicSuffix(titles map[uuid.UUID]string, epicID string) string {
	if t := epicTitle(titles, epicID); t != "" {
		return " — epic: " + t
	}
	return ""
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// trimmedLinks drops blanks from a payload's links[] without reordering it.
func trimmedLinks(in []string) []string {
	out := make([]string, 0, len(in))
	for _, l := range in {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}
