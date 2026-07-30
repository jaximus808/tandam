package api

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// Epic summaries + rollup (TDM-93). Everything under test here is pure — the
// provenance stamp and the rollup composition — so the rules are provable
// without a database, which is the point of keeping them out of the handlers.

var epicNow = time.Date(2026, 7, 30, 9, 0, 0, 0, time.UTC)

func epicAction(id uuid.UUID, title, state string, created time.Time, extra map[string]any) *store.Action {
	p := map[string]any{"title": title}
	for k, v := range extra {
		p[k] = v
	}
	raw, _ := json.Marshal(p)
	return &store.Action{ID: id, Kind: "action", Type: "epic", State: state,
		Payload: raw, CreatedAt: created, UpdatedAt: created}
}

func rollupTask(ticket int, title, epicID, state, result string, created, updated time.Time) *store.Action {
	raw, _ := json.Marshal(map[string]any{"title": title, "epicId": epicID, "assignee": "agent"})
	a := &store.Action{ID: uuid.New(), Kind: "action", Type: "task", State: state,
		Payload: raw, CreatedAt: created, UpdatedAt: updated}
	if ticket > 0 {
		n := ticket
		a.Ticket = &n
	}
	if result != "" {
		r := result
		a.Result = &r
	}
	return a
}

// ── The provenance stamp ──────────────────────────────────────────────────────

func TestStampEpicSummary(t *testing.T) {
	stored, _ := json.Marshal(map[string]any{
		"title":     "E5 · Observability",
		"summary":   "Shipped the metrics endpoint.",
		"summaryBy": "agent:opus-a",
		"summaryAt": "2026-07-01T00:00:00Z",
	})

	cases := []struct {
		name     string
		stored   json.RawMessage
		incoming map[string]any
		actor    string
		want     epicSummaryFields
	}{
		{
			// A first summary is attributed to the caller, at the server's clock.
			name:     "new summary is stamped",
			incoming: map[string]any{"title": "E5", "summary": "  Shipped it.  "},
			actor:    "agent:opus-tdm93",
			want: epicSummaryFields{Summary: "Shipped it.", SummaryBy: "agent:opus-tdm93",
				SummaryAt: epicNow.Format(time.RFC3339)},
		},
		{
			// The forgery case: a caller naming a human as the author, or
			// backdating the write, is stripped of both.
			name: "caller-supplied stamp is discarded",
			incoming: map[string]any{"title": "E5", "summary": "Shipped it.",
				"summaryBy": "human", "summaryAt": "2020-01-01T00:00:00Z"},
			actor: "agent:opus-tdm93",
			want: epicSummaryFields{Summary: "Shipped it.", SummaryBy: "agent:opus-tdm93",
				SummaryAt: epicNow.Format(time.RFC3339)},
		},
		{
			// The idempotence rule: the web editor round-trips the whole payload
			// on a title edit, and that must not make an old summary look fresh.
			name:     "unchanged summary keeps its original stamp",
			stored:   stored,
			incoming: map[string]any{"title": "E5 · Observability & perf", "summary": "Shipped the metrics endpoint."},
			actor:    "human",
			want: epicSummaryFields{Summary: "Shipped the metrics endpoint.",
				SummaryBy: "agent:opus-a", SummaryAt: "2026-07-01T00:00:00Z"},
		},
		{
			name:     "edited summary is restamped to the new author",
			stored:   stored,
			incoming: map[string]any{"title": "E5", "summary": "Shipped the metrics endpoint AND the loadtest."},
			actor:    "human",
			want: epicSummaryFields{Summary: "Shipped the metrics endpoint AND the loadtest.",
				SummaryBy: "human", SummaryAt: epicNow.Format(time.RFC3339)},
		},
		{
			// Clearing the summary clears the attribution with it — a stamp on
			// nothing is a lie about a summary that no longer exists.
			name:     "blank summary drops the field and its stamp",
			stored:   stored,
			incoming: map[string]any{"title": "E5", "summary": "   "},
			actor:    "human",
			want:     epicSummaryFields{},
		},
		{
			// No summary key at all: same outcome, and no empty field invented.
			name:     "absent summary leaves nothing behind",
			stored:   stored,
			incoming: map[string]any{"title": "E5"},
			actor:    "human",
			want:     epicSummaryFields{},
		},
		{
			// Provenance wasn't derived (a route without the middleware). Record
			// nothing rather than guessing "human".
			name:     "no actor records no author",
			incoming: map[string]any{"title": "E5", "summary": "Shipped it."},
			actor:    "",
			want: epicSummaryFields{Summary: "Shipped it.",
				SummaryAt: epicNow.Format(time.RFC3339)},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw, _ := json.Marshal(c.incoming)
			canonical, err := canonicalizeEpicPayload(raw)
			if err != nil {
				t.Fatalf("canonicalize: %v", err)
			}
			got := readEpicSummary(stampEpicSummary(c.stored, canonical, c.actor, epicNow))
			if got != c.want {
				t.Errorf("summary trio\n got %+v\nwant %+v", got, c.want)
			}
		})
	}
}

func TestNormalizeEpicSummaryCaps(t *testing.T) {
	long := strings.Repeat("é", MaxEpicSummary+500)
	p := map[string]any{"title": "E", "summary": long}
	got := normalizeEpicSummary(p)
	if r := []rune(got); len(r) != MaxEpicSummary+1 || r[len(r)-1] != '…' {
		t.Fatalf("expected %d runes plus an ellipsis, got %d runes ending %q",
			MaxEpicSummary, len(r), string(r[len(r)-1]))
	}
	// A non-string summary is not a summary; it must not survive as one.
	p2 := map[string]any{"title": "E", "summary": 42}
	if got := normalizeEpicSummary(p2); got != "" {
		t.Errorf("non-string summary: got %q, want dropped", got)
	}
	if _, present := p2["summary"]; present {
		t.Error("non-string summary was left on the payload")
	}
}

// ── The rollup ────────────────────────────────────────────────────────────────

func TestBuildEpicRollups(t *testing.T) {
	e1 := uuid.New()
	e2 := uuid.New()
	older := epicNow.Add(-48 * time.Hour)
	newer := epicNow.Add(-2 * time.Hour)

	epics := []*store.Action{
		// Listed second, created LAST — the rollup orders by creation.
		epicAction(e2, "E11 · Later batch", "proposed", newer, nil),
		epicAction(e1, "E10 · Drained batch", "approved", older, map[string]any{
			"summary": "Published the pivot.", "summaryBy": "agent:opus-a",
		}),
	}
	gone := uuid.New().String() // an epic that was deleted out from under its task
	tasks := []*store.Action{
		rollupTask(91, "Ship the landing copy", e1.String(), "done",
			"Rewrote the hero.\nAlso fixed the nav.", older, older.Add(time.Hour)),
		rollupTask(92, "Reconcile the surfaces", e1.String(), "failed",
			"Blocked on the design token rename", older, older.Add(2*time.Hour)),
		rollupTask(93, "Abandoned idea", e1.String(), "rejected", "", older, older),
		rollupTask(94, "Not started", e2.String(), "approved", "", newer, newer),
		rollupTask(95, "Orphan", gone, "approved", "", newer, newer),
		rollupTask(0, "No epic at all", "", "proposed", "", newer, newer),
	}

	body := buildEpicRollups(epics, tasks)
	if len(body.Epics) != 2 {
		t.Fatalf("want 2 epics, got %d", len(body.Epics))
	}
	if body.Epics[0].ID != e1 || body.Epics[1].ID != e2 {
		t.Fatalf("epics are not in creation order: %v then %v", body.Epics[0].ID, body.Epics[1].ID)
	}

	drained := body.Epics[0]
	if drained.Summary != "Published the pivot." || drained.SummaryBy != "agent:opus-a" {
		t.Errorf("summary not carried: %+v", drained)
	}
	if drained.Tasks.Total != 3 {
		t.Errorf("task total: got %d, want 3", drained.Tasks.Total)
	}
	for state, want := range map[string]int{"done": 1, "failed": 1, "rejected": 1} {
		if got := drained.Tasks.ByState[state]; got != want {
			t.Errorf("byState[%s]: got %d, want %d", state, got, want)
		}
	}
	if !drained.Drained {
		t.Error("an approved epic whose every task is terminal should read as drained")
	}
	if drained.SummaryNeeded {
		t.Error("a drained epic WITH a summary does not need one")
	}
	// done + failed are the account of the work; rejected is not (nobody worked it).
	if len(drained.Done) != 2 {
		t.Fatalf("want 2 done lines (done + failed), got %d: %+v", len(drained.Done), drained.Done)
	}
	if drained.Done[0].TicketID != "TDM-91" || drained.Done[0].Result != "Rewrote the hero." {
		t.Errorf("done line should carry the ticket and the FIRST result line: %+v", drained.Done[0])
	}
	if drained.Done[1].State != "failed" {
		t.Errorf("second done line should be the failed ticket: %+v", drained.Done[1])
	}
	if drained.FirstActivity == nil || !drained.FirstActivity.Equal(older) {
		t.Errorf("firstActivity: got %v, want %v", drained.FirstActivity, older)
	}
	if drained.LastActivity == nil || !drained.LastActivity.Equal(older.Add(2*time.Hour)) {
		t.Errorf("lastActivity: got %v, want the newest task update", drained.LastActivity)
	}

	open := body.Epics[1]
	if open.Drained || open.SummaryNeeded {
		t.Errorf("a proposed epic with an open task is neither drained nor owed a summary: %+v", open)
	}
	if len(open.Done) != 0 {
		t.Errorf("done should be an empty list, not null: %+v", open.Done)
	}

	// The dangling epicId and the epicless task both land in unepiced.
	if body.Unepiced.Total != 2 {
		t.Errorf("unepiced total: got %d, want 2 (a dangling epicId plus a task with none)", body.Unepiced.Total)
	}
}

func TestBuildEpicRollupsFlagsMissingSummary(t *testing.T) {
	id := uuid.New()
	epics := []*store.Action{epicAction(id, "E9 · Silent batch", "approved", epicNow, nil)}
	tasks := []*store.Action{rollupTask(1, "Did the thing", id.String(), "done", "Done.", epicNow, epicNow)}

	got := buildEpicRollups(epics, tasks).Epics[0]
	if !got.Drained || !got.SummaryNeeded {
		t.Fatalf("a drained epic with no summary must ask for one: %+v", got)
	}
}

func TestBuildEpicRollupsCapsDoneLines(t *testing.T) {
	id := uuid.New()
	epics := []*store.Action{epicAction(id, "E12 · Huge batch", "approved", epicNow, nil)}
	var tasks []*store.Action
	for i := 1; i <= maxEpicDoneLines+7; i++ {
		tasks = append(tasks, rollupTask(i, "t", id.String(), "done", "r", epicNow, epicNow))
	}
	got := buildEpicRollups(epics, tasks).Epics[0]
	if len(got.Done) != maxEpicDoneLines || got.Truncated != 7 {
		t.Fatalf("want %d lines + 7 truncated, got %d + %d", maxEpicDoneLines, len(got.Done), got.Truncated)
	}
	if got.Tasks.Total != maxEpicDoneLines+7 {
		t.Error("the cap must trim the LINES, never the counts")
	}
}

// ── The briefing's Epics section ───────────────────────────────────────────────

func TestRenderEpicsSection(t *testing.T) {
	older := epicNow.Add(-48 * time.Hour)
	b := contextBundle{
		Canvas: ctxCanvas("Board"),
		Epics: []*store.Action{
			epicAction(uuid.New(), "E11 · Unwritten", "approved", epicNow, nil),
			epicAction(uuid.New(), "E10 · Published", "approved", older, map[string]any{
				"summary": "Published the pivot and reconciled the surfaces.",
				// A caller-forged stamp never reaches storage, so the renderer
				// reads whatever the server stamped.
				"summaryBy": "agent:opus-a",
			}),
		},
	}
	got := renderContextMarkdown(b, epicNow)

	for _, want := range []string{
		"## Epics",
		"2 batches on this board",
		// Creation order, oldest first — same as the board's epic timeline.
		"**E10 · Published** (approved)",
		"Published the pivot and reconciled the surfaces.",
		"_— agent:opus-a_",
		// The unwritten one is LISTED, not hidden: "nobody wrote it down" must
		// not read as "nothing happened".
		"**E11 · Unwritten** (approved)",
		"_No summary yet",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("briefing is missing %q\n---\n%s", want, got)
		}
	}
	if strings.Index(got, "E10 · Published") > strings.Index(got, "E11 · Unwritten") {
		t.Error("epics should render oldest-first")
	}

	// A board with no epics gets no section at all — an empty heading would be
	// noise in every briefing on every canvas that doesn't use epics.
	if bare := renderContextMarkdown(contextBundle{Canvas: ctxCanvas("Board")}, epicNow); strings.Contains(bare, "## Epics") {
		t.Error("a canvas with no epics should not render an Epics heading")
	}
}

// An epic with no tasks is not finished — it is awaiting them. Same rule the
// web's epicLifecycle uses, and worth pinning: reading it the other way would
// mark every freshly approved epic as drained and owed a summary.
func TestBuildEpicRollupsEmptyEpicIsNotDrained(t *testing.T) {
	id := uuid.New()
	got := buildEpicRollups([]*store.Action{epicAction(id, "E13", "approved", epicNow, nil)}, nil).Epics[0]
	if got.Drained || got.SummaryNeeded {
		t.Fatalf("an approved epic with zero tasks is awaiting work, not drained: %+v", got)
	}
	if got.Tasks.Total != 0 || got.Tasks.ByState == nil {
		t.Errorf("byState should be an empty map, not null: %+v", got.Tasks)
	}
}
