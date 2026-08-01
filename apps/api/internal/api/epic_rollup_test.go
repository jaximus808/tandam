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

// ── The compact default (TDM-183) ─────────────────────────────────────────────

// A result line as completions on this board actually read — what was done,
// where, and the commit — long enough that the excerpt cap is what decides its
// length in either shape.
const rollupFixtureResult = "Added the compact rollup shape in apps/api/internal/api/epic_rollup.go and threaded " +
	"the ?full=1 switch through ListEpics, with a table test covering both shapes against a " +
	"live-shaped fixture; go build ./... and go test ./... both pass clean.\n" +
	"Left for Jaxon: nothing — API-only, no migration."

const rollupFixtureSummary = "The batch landed the read-path diet end to end: the API serves counts by default, " +
	"the gateway asks for the ticket lines only when it needs them, and the board read " +
	"stopped shipping the archive on every single call."

// liveShapedRollupBoard is a fixture shaped like the canvas this endpoint
// actually serves: 31 epics and 221 finished tickets, nearly all of it ARCHIVE —
// batches that drained months of sessions ago — plus the live minority whose
// line items a reader still acts on.
//
// The finished work sits where it really sits: in the 28 drained batches. A live
// batch is a YOUNG one (this ticket's own epic was three tasks, none finished,
// when it was dispatched), so the three live ones here hold two done tickets
// each and their open work. Indexes 28, 29 and 30 are the live ones: open work,
// a ticket that came BACK, and one still executing.
func liveShapedRollupBoard() (epics, tasks []*store.Action) { return rollupBoard(221) }

// rollupBoard is that fixture with the size of the ARCHIVE as a knob, so a test
// can ask what happens as finished tickets pile up.
func rollupBoard(doneTotal int) (epics, tasks []*store.Action) {
	const epicCount = 31
	const liveFrom = 28 // 28, 29, 30
	ticket := 0
	ids := make([]uuid.UUID, epicCount)

	for i := 0; i < epicCount; i++ {
		ids[i] = uuid.New()
		extra := map[string]any{}
		// Most drained batches have had their summary written; some have not, which
		// is what summaryNeeded exists to nag about.
		if i%3 != 0 {
			extra["summary"] = rollupFixtureSummary
			extra["summaryBy"] = "agent:opus-exec-tdm183"
			extra["summaryAt"] = "2026-07-30T09:00:00Z"
		}
		epics = append(epics, epicAction(ids[i], "E · Board reads on a token diet — board_status stops shipping the archive",
			"approved", epicNow.Add(time.Duration(i)*time.Hour), extra))
	}
	done := func(e uuid.UUID) {
		ticket++
		tasks = append(tasks, rollupTask(ticket, "API: compact epic rollup by default, ?full=1 keeps today's shape",
			e.String(), "done", rollupFixtureResult, epicNow, epicNow.Add(time.Hour)))
	}
	// Two finished tickets in each live batch, the remaining 215 in the archive —
	// no batch anywhere near maxEpicDoneLines.
	for i := liveFrom; i < epicCount; i++ {
		done(ids[i])
		done(ids[i])
	}
	for i := 0; ticket < doneTotal; i++ {
		done(ids[i%liveFrom])
	}
	// The live minority: open work, a returned ticket, and one in flight.
	for i := 0; i < 3; i++ {
		ticket++
		tasks = append(tasks, rollupTask(ticket, "Gateway: ask for the lines only when it needs them",
			ids[28].String(), "approved", "", epicNow, epicNow))
	}
	ticket++
	cut := "board_status is not the place for this — it belongs on the epic read"
	rejected := rollupTask(ticket, "Cache the rollup in memory", ids[29].String(), "rejected", "", epicNow, epicNow)
	rejected.Error = &cut
	tasks = append(tasks, rejected)
	ticket++
	tasks = append(tasks, rollupTask(ticket, "Web: read the compact shape", ids[30].String(), "executing", "", epicNow, epicNow))
	return epics, tasks
}

// The whole point of the ticket: the DEFAULT read is dramatically cheaper on a
// board shaped like the live one, and `?full=1` is byte-identical to what this
// endpoint returned before the diet.
//
// WHY THE BAR IS 5x AND NOT THE TICKET'S "ORDER OF MAGNITUDE". The archive is
// gone — ~90KB of the ~108KB full response is the 215 finished-ticket lines
// nobody reads, and every one of them is dropped. What is left cannot be
// squeezed to a tenth, because it is what the ticket says to KEEP: 31 epic
// envelopes (id, title, state, counts, activity window) are ~10.7KB on their
// own, before a single summary. Ten-to-one would mean dropping the summaries —
// the one thing the compact read exists to deliver. So the byte bar is 5x and
// the property that actually matters is pinned separately, below: the compact
// response is O(epics), not O(tickets), so it stops growing as the board fills.
func TestEpicRollupCompactDefaultIsMuchCheaper(t *testing.T) {
	epics, tasks := liveShapedRollupBoard()

	fullBody := buildEpicRollupsView(epics, tasks, true)
	compactBody := buildEpicRollupsView(epics, tasks, false)
	fullJSON, err := json.Marshal(fullBody)
	if err != nil {
		t.Fatalf("marshal full: %v", err)
	}
	compactJSON, err := json.Marshal(compactBody)
	if err != nil {
		t.Fatalf("marshal compact: %v", err)
	}

	// ?full=1 is byte-for-byte the shape the old builder produced. buildEpicRollups
	// IS that shape by definition, so this pins the wrapper to the flag: if a
	// future edit makes full mode diverge, the callers that asked for "today's
	// response" find out here.
	legacyJSON, _ := json.Marshal(buildEpicRollups(epics, tasks))
	if string(legacyJSON) != string(fullJSON) {
		t.Error("?full=1 must be byte-identical to the shape this endpoint always returned")
	}
	// And it must not have grown the compact shape's fields.
	for _, leaked := range []string{`"compact"`, `"doneOmitted"`} {
		if strings.Contains(string(fullJSON), leaked) {
			t.Errorf("%s leaked into the full shape", leaked)
		}
	}

	ratio := float64(len(fullJSON)) / float64(len(compactJSON))
	t.Logf("full %d bytes, compact %d bytes (%.1fx)", len(fullJSON), len(compactJSON), ratio)
	if ratio < 5 {
		t.Errorf("compact default is only %.1fx cheaper (%d → %d bytes); the diet has regressed",
			ratio, len(fullJSON), len(compactJSON))
	}
	if !compactBody.Compact {
		t.Error("the compact response must say so, so a reader can tell which shape it got")
	}
	if compactBody.Hint == fullBody.Hint {
		t.Error("the compact hint must point at ?full=1; it is the only way back to the lines")
	}
}

// The property the byte count is a proxy for: the compact read costs what the
// BOARD costs (its batches), not what its HISTORY costs (its tickets). Triple
// the archive and the full response triples with it while the compact one does
// not move — which is the whole reason this endpoint stops getting more
// expensive every week the project runs.
func TestEpicRollupCompactDefaultDoesNotGrowWithTheArchive(t *testing.T) {
	size := func(doneTotal int, full bool) int {
		epics, tasks := rollupBoard(doneTotal)
		b, err := json.Marshal(buildEpicRollupsView(epics, tasks, full))
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		return len(b)
	}
	compactSmall, compactBig := size(221, false), size(663, false)
	fullSmall, fullBig := size(221, true), size(663, true)
	t.Logf("221→663 tickets: compact %d→%d, full %d→%d", compactSmall, compactBig, fullSmall, fullBig)

	// Only the doneOmitted counts get wider (7→8 and 8→9 digits' worth), so the
	// compact response may creep by a byte or two per epic — never by tickets.
	if grew := compactBig - compactSmall; grew > compactSmall/50 {
		t.Errorf("compact response grew %d bytes when the archive tripled; it should be O(epics)", grew)
	}
	if fullBig < 2*fullSmall {
		t.Errorf("full response should grow with the archive: %d → %d", fullSmall, fullBig)
	}
}

// What the compact shape keeps, drops, and admits to dropping — epic by epic.
func TestEpicRollupCompactShapePerEpic(t *testing.T) {
	epics, tasks := liveShapedRollupBoard()
	compact := buildEpicRollupsView(epics, tasks, false).Epics
	full := buildEpicRollups(epics, tasks).Epics
	if len(compact) != len(full) || len(compact) != 31 {
		t.Fatalf("want 31 epics in both shapes, got %d and %d", len(compact), len(full))
	}

	// An ARCHIVE batch: counts, window and summary stay; the lines go, and
	// doneOmitted says how many, so an empty done[] never reads as "shipped
	// nothing".
	arch, archFull := compact[1], full[1]
	if len(arch.Done) != 0 {
		t.Errorf("a drained batch should not ship its ticket lines: %+v", arch.Done)
	}
	if arch.DoneOmitted != len(archFull.Done) || arch.DoneOmitted == 0 {
		t.Errorf("doneOmitted should count the omitted lines: got %d, want %d", arch.DoneOmitted, len(archFull.Done))
	}
	if arch.Tasks.Total != archFull.Tasks.Total || arch.Tasks.ByState["done"] != archFull.Tasks.ByState["done"] {
		t.Errorf("the diet must trim LINES, never the counts: %+v vs %+v", arch.Tasks, archFull.Tasks)
	}
	if arch.Summary != rollupFixtureSummary {
		t.Errorf("the summary is what the compact read is FOR: %q", arch.Summary)
	}
	if arch.SummaryBy != "" || arch.SummaryAt != "" {
		t.Errorf("the summary stamps are provenance, not content — ?full=1 has them: %+v", arch)
	}
	if arch.FirstActivity == nil || arch.LastActivity == nil {
		t.Errorf("the activity window stays: %+v", arch)
	}
	if !arch.Drained || arch.SummaryNeeded {
		t.Errorf("drained/summaryNeeded are the live signals and never change: %+v", arch)
	}
	if compact[0].SummaryNeeded != full[0].SummaryNeeded || !compact[0].SummaryNeeded {
		t.Errorf("a drained batch with no summary still asks for one: %+v", compact[0])
	}

	// An OPEN batch keeps its line items — that is the half a reader acts on —
	// with the results excerpted shorter.
	open := compact[28]
	if len(open.Done) == 0 || open.DoneOmitted != 0 {
		t.Errorf("a batch with open work keeps its lines: %d lines, %d omitted", len(open.Done), open.DoneOmitted)
	}
	if r := []rune(open.Done[0].Result); len(r) != epicResultExcerptCompact+1 || r[len(r)-1] != '…' {
		t.Errorf("compact results cap at %d runes: got %d", epicResultExcerptCompact, len(r))
	}
	if r := []rune(full[28].Done[0].Result); len(r) != epicResultExcerpt+1 {
		t.Errorf("?full=1 keeps the %d-rune excerpt: got %d", epicResultExcerpt, len(r))
	}

	// A RETURNED batch keeps its lines too, reason and all: a rejection is a
	// correction to the plan, and it is worth more to the neighbouring tickets
	// than to the archive it sits in.
	ret := compact[29]
	if len(ret.Returned) != 1 || ret.Returned[0].Reason == "" {
		t.Fatalf("the came-back ticket and its reason survive the diet: %+v", ret.Returned)
	}
	if len(ret.Done) == 0 || ret.DoneOmitted != 0 {
		t.Errorf("a batch with returned work keeps its lines: %d lines, %d omitted", len(ret.Done), ret.DoneOmitted)
	}
}

// The compaction test is "nothing open", not the `drained` flag: a batch still
// `proposed` whose every task is terminal is archive too, and `drained` says no
// on purpose (it means approved-and-finished).
func TestEpicRollupCompactsUnapprovedFinishedBatch(t *testing.T) {
	id := uuid.New()
	got := buildEpicRollupsView(
		[]*store.Action{epicAction(id, "E14 · Proposed but finished", "proposed", epicNow, nil)},
		[]*store.Action{rollupTask(1, "t", id.String(), "done", "r", epicNow, epicNow)},
		false,
	).Epics[0]
	if got.Drained {
		t.Fatalf("a proposed epic is not drained: %+v", got)
	}
	if len(got.Done) != 0 || got.DoneOmitted != 1 {
		t.Fatalf("nothing open means archive: want 0 lines and doneOmitted 1, got %d and %d",
			len(got.Done), got.DoneOmitted)
	}
}

// A compacted batch reports the lines maxEpicDoneLines had ALREADY dropped, not
// just the ones it rendered — doneOmitted is the count of what you are not being
// shown, from every cause.
func TestEpicRollupCompactDoneOmittedCountsPastTheCap(t *testing.T) {
	id := uuid.New()
	epics := []*store.Action{epicAction(id, "E15 · Huge drained batch", "approved", epicNow, nil)}
	var tasks []*store.Action
	for i := 1; i <= maxEpicDoneLines+7; i++ {
		tasks = append(tasks, rollupTask(i, "t", id.String(), "done", "r", epicNow, epicNow))
	}
	got := buildEpicRollupsView(epics, tasks, false).Epics[0]
	if got.DoneOmitted != maxEpicDoneLines+7 || got.Truncated != 0 {
		t.Fatalf("want doneOmitted %d and no separate truncated count, got %d and %d",
			maxEpicDoneLines+7, got.DoneOmitted, got.Truncated)
	}
}

// ?full spellings. Getting the compact shape back because you wrote `true`
// instead of `1` reads as "the lines are gone", not "the flag was misspelled".
func TestRollupFullRequested(t *testing.T) {
	for _, raw := range []string{"1", "true", "TRUE", " yes ", "Yes"} {
		if !rollupFullRequested(raw) {
			t.Errorf("%q should ask for the full shape", raw)
		}
	}
	for _, raw := range []string{"", "0", "false", "no", "full", "2"} {
		if rollupFullRequested(raw) {
			t.Errorf("%q should get the compact default", raw)
		}
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
