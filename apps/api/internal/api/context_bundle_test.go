package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/ws"
	"github.com/google/uuid"
)

// ctxNow is the pinned instant every context-bundle test renders against, so
// "21d ago" in an expectation means exactly that and never drifts with the
// wall clock.
var ctxNow = time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)

func ago(d time.Duration) *time.Time { t := ctxNow.Add(-d); return &t }

// agoReal is ago against the wall clock — for the HANDLER tests, which can't
// pin `now` (the handler stamps it itself) and so must build fixtures relative
// to the real instant the request will be served at.
func agoReal(d time.Duration) *time.Time { t := time.Now().UTC().Add(-d); return &t }

func secs(n int) *int { return &n }

// Shelf life used across the fixtures: 10 days, so the aging band opens at 5d
// (AgingThreshold = 0.5) and expiry lands at 10d.
const tenDays = 10 * 24 * 60 * 60

func ctxCanvas(name string) *store.Canvas {
	return &store.Canvas{ID: uuid.New(), Code: "TESTCODE", Name: name}
}

func ctxNote(body string, sortOrder int, verifiedAt *time.Time, stale *int) *store.Note {
	return &store.Note{ID: uuid.New(), Kind: "note", Body: body, SortOrder: sortOrder,
		VerifiedAt: verifiedAt, StaleAfterSeconds: stale}
}

func ctxTask(ticket int, title, epicID string) *store.Action {
	payload, _ := json.Marshal(map[string]any{"title": title, "epicId": epicID, "assignee": "agent"})
	n := ticket
	return &store.Action{ID: uuid.New(), Kind: "action", Type: "task", State: "approved",
		Payload: payload, Ticket: &n, CreatedAt: ctxNow}
}

// ── Freshness annotation: one case per derived status ─────────────────────────

func TestFreshnessAnnotation(t *testing.T) {
	cases := []struct {
		name       string
		verifiedAt *time.Time
		stale      *int
		want       string
	}{
		// Never verified — deliberately unannotated (see freshnessAnnotation).
		{"unknown: never verified", nil, nil, ""},
		{"unknown: shelf life but no verification", nil, secs(tenDays), ""},
		// Verified with no declared shelf life never ages.
		{"fresh: verified, no shelf life", ago(400 * 24 * time.Hour), nil, "[fresh — verified 400d ago]"},
		{"fresh: well inside the window", ago(time.Hour), secs(tenDays), "[fresh — verified 1h ago]"},
		{"aging: past half the window", ago(6 * 24 * time.Hour), secs(tenDays), "[aging — verified 6d ago]"},
		{"aging: exactly at the threshold", ago(5 * 24 * time.Hour), secs(tenDays), "[aging — verified 5d ago]"},
		{"stale: past the window", ago(21 * 24 * time.Hour), secs(tenDays), "[stale — verified 21d ago]"},
		{"stale: exactly at expiry", ago(10 * 24 * time.Hour), secs(tenDays), "[stale — verified 10d ago]"},
		// Sub-unit ages read at one significant unit.
		{"fresh: minutes", ago(90 * time.Second), secs(tenDays), "[fresh — verified 1m ago]"},
		{"fresh: seconds", ago(2 * time.Second), secs(tenDays), "[fresh — verified just now]"},
		// Clock skew: a verification stamped in the future is fresh, not negative.
		{"fresh: future verification", ago(-time.Hour), secs(tenDays), "[fresh — verified just now]"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := freshnessAnnotation(c.verifiedAt, c.stale, ctxNow); got != c.want {
				t.Fatalf("freshnessAnnotation = %q, want %q", got, c.want)
			}
		})
	}
}

// ── The markdown bundle ───────────────────────────────────────────────────────

func TestRenderContextMarkdown(t *testing.T) {
	epicID := uuid.New()
	briefingDoc := &store.Document{ID: uuid.New(), Kind: "document", Type: "notes", Name: "Project brief",
		VerifiedAt: ago(6 * 24 * time.Hour), StaleAfterSeconds: secs(tenDays)}

	linkedNoteID, linkedItemID := uuid.New(), uuid.New()
	taskPayload, _ := json.Marshal(map[string]any{
		"title": "E1.3 context_get endpoint", "body": "Build the one-call connect bundle.",
		"epicId": epicID.String(), "assignee": "agent",
		"linkedIds": []string{linkedNoteID.String(), linkedItemID.String()},
	})
	ticket := 29
	hydrated := &store.Action{ID: uuid.New(), Kind: "action", Type: "task", State: "approved",
		Payload: taskPayload, Ticket: &ticket, CreatedAt: ctxNow}

	cases := []struct {
		name        string
		bundle      contextBundle
		wantContain []string
		wantAbsent  []string
	}{
		{
			name: "briefing present: doc name, notes in order, freshness on each",
			bundle: contextBundle{
				Canvas:      ctxCanvas("tandem planning"),
				BriefingDoc: briefingDoc,
				BriefingNotes: []*store.Note{
					// Deliberately out of order — the formatter sorts.
					ctxNote("Deploy = push to main.", 1, ago(2*time.Hour), secs(tenDays)),
					ctxNote("Tandem is a shared planning canvas.", 0, ago(21*24*time.Hour), secs(tenDays)),
					ctxNote("Nobody has ever vouched for this line.", 2, nil, nil),
				},
			},
			wantContain: []string{
				"# tandem planning\n",
				"## Briefing\n",
				"Source: **Project brief** [aging — verified 6d ago]",
				"[stale — verified 21d ago]\n\nTandem is a shared planning canvas.",
				"[fresh — verified 2h ago]\n\nDeploy = push to main.",
				// Rot is annotated, never dropped.
				"Nobody has ever vouched for this line.",
			},
			wantAbsent: []string{"No briefing document is designated"},
		},
		{
			name: "briefing absent: a real section saying so, not a silent omission",
			bundle: contextBundle{
				Canvas:        ctxCanvas("tandem planning"),
				ApprovedTasks: []*store.Action{ctxTask(1, "Do the thing", "")},
			},
			wantContain: []string{
				"## Briefing\n",
				"No briefing document is designated for this canvas.",
			},
			wantAbsent: []string{"Source: **"},
		},
		{
			name: "briefing designated but empty",
			bundle: contextBundle{
				Canvas:      ctxCanvas("tandem planning"),
				BriefingDoc: &store.Document{ID: uuid.New(), Name: "Project brief"},
			},
			wantContain: []string{
				"Source: **Project brief**\n",
				"The briefing document has no content yet.",
			},
		},
		{
			name: "approved queue: ticket, title, epic — titles only, never bodies",
			bundle: contextBundle{
				Canvas:     ctxCanvas("tandem planning"),
				EpicTitles: map[uuid.UUID]string{epicID: "E1 Context spine"},
				ApprovedTasks: []*store.Action{
					// Out of ticket order on the way in.
					ctxTask(31, "Freshness UI", ""),
					ctxTask(29, "context_get endpoint", epicID.String()),
				},
			},
			wantContain: []string{
				"## Approved queue\n",
				"2 approved tasks ready to work.",
				"- **TDM-29** — context_get endpoint — epic: E1 Context spine\n" +
					"- **TDM-31** — Freshness UI\n",
			},
		},
		{
			name: "empty queue",
			bundle: contextBundle{
				Canvas:      ctxCanvas("tandem planning"),
				BriefingDoc: briefingDoc,
			},
			wantContain: []string{"No approved tasks — the ready-to-work queue is empty."},
			wantAbsent:  []string{"ready to work."},
		},
		{
			name: "taskId bundle: task hydrated with linked notes and roadmap items",
			bundle: contextBundle{
				Canvas:     ctxCanvas("tandem planning"),
				EpicTitles: map[uuid.UUID]string{epicID: "E1 Context spine"},
				Task:       hydrated,
				TaskLinks: []store.TaskLink{
					{ID: linkedItemID, Kind: "roadmap", Title: "Context spine", Status: "in_progress",
						Body: "Give an agent one call on connect.",
						// A stale roadmap item stays IN the bundle, flagged.
						VerifiedAt: ago(30 * 24 * time.Hour), StaleAfterSeconds: secs(tenDays)},
					{ID: linkedNoteID, Kind: "note", Body: "Prefer few store round-trips.",
						VerifiedAt: ago(time.Hour), StaleAfterSeconds: secs(tenDays)},
				},
			},
			wantContain: []string{
				"## Task TDM-29\n",
				"**E1.3 context_get endpoint**",
				"state: approved · epic: E1 Context spine · assignee: agent",
				"Build the one-call connect bundle.",
				"### Linked context\n",
				"**roadmap — Context spine (status: in_progress)** [stale — verified 30d ago]",
				"Give an agent one call on connect.",
				"**note** [fresh — verified 1h ago]",
				"Prefer few store round-trips.",
			},
		},
		{
			name: "no taskId: no Task section at all",
			bundle: contextBundle{
				Canvas:        ctxCanvas("tandem planning"),
				ApprovedTasks: []*store.Action{ctxTask(1, "Do the thing", "")},
			},
			wantAbsent: []string{"## Task", "### Linked context"},
		},
		{
			name: "taskId with no links says so rather than omitting the section",
			bundle: contextBundle{
				Canvas: ctxCanvas("tandem planning"),
				Task:   ctxTask(7, "Standalone task", ""),
			},
			wantContain: []string{"## Task TDM-7\n", "No linked notes or roadmap items."},
		},
		{
			name:   "degenerate: nothing loaded at all still renders every section",
			bundle: contextBundle{},
			wantContain: []string{
				"# Canvas\n", "## Briefing\n", "## Approved queue\n",
			},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := renderContextMarkdown(c.bundle, ctxNow)
			for _, want := range c.wantContain {
				if !strings.Contains(got, want) {
					t.Fatalf("markdown missing %q\n---\n%s", want, got)
				}
			}
			for _, absent := range c.wantAbsent {
				if strings.Contains(got, absent) {
					t.Fatalf("markdown should not contain %q\n---\n%s", absent, got)
				}
			}
			// AGENTS.md shape: exactly one H1, and it names the canvas.
			if h1 := strings.Count(got, "\n# ") + boolToInt(strings.HasPrefix(got, "# ")); h1 != 1 {
				t.Fatalf("expected exactly one H1, got %d\n---\n%s", h1, got)
			}
			// The generation instant is pinned into the bundle.
			if !strings.Contains(got, ctxNow.Format(time.RFC3339)) {
				t.Fatalf("markdown must state its generation instant\n---\n%s", got)
			}
		})
	}
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func TestContextCounts(t *testing.T) {
	b := contextBundle{
		Canvas:      ctxCanvas("tandem planning"),
		BriefingDoc: &store.Document{ID: uuid.New(), Name: "Brief", VerifiedAt: ago(6 * 24 * time.Hour), StaleAfterSeconds: secs(tenDays)},
		BriefingNotes: []*store.Note{
			ctxNote("stale one", 0, ago(21*24*time.Hour), secs(tenDays)),
			ctxNote("fresh one", 1, ago(time.Hour), secs(tenDays)),
			ctxNote("never verified", 2, nil, nil),
		},
		ApprovedTasks: []*store.Action{ctxTask(1, "a", ""), ctxTask(2, "b", "")},
		TaskLinks: []store.TaskLink{
			{ID: uuid.New(), Kind: "note", Body: "x", VerifiedAt: ago(30 * 24 * time.Hour), StaleAfterSeconds: secs(tenDays)},
		},
	}
	got := contextCounts(b, ctxNow)
	want := map[string]int{"briefingNotes": 3, "approvedTasks": 2, "linkedItems": 1, "stale": 2, "aging": 1}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("counts[%q] = %d, want %d (full: %+v)", k, got[k], v, got)
		}
	}
}

// sortedTasks must be total and deterministic even for pre-ticket rows, since
// the queue's order is the one thing a returning agent scans by.
func TestSortedTasksPutsTicketlessLast(t *testing.T) {
	older := &store.Action{ID: uuid.New(), Type: "task", CreatedAt: ctxNow.Add(-2 * time.Hour)}
	newer := &store.Action{ID: uuid.New(), Type: "task", CreatedAt: ctxNow.Add(-time.Hour)}
	got := sortedTasks([]*store.Action{newer, ctxTask(9, "nine", ""), older, ctxTask(2, "two", "")})
	if len(got) != 4 {
		t.Fatalf("lost a task: %d", len(got))
	}
	if *got[0].Ticket != 2 || *got[1].Ticket != 9 {
		t.Fatalf("ticketed tasks must lead in ticket order, got %v", got)
	}
	if got[2].ID != older.ID || got[3].ID != newer.ID {
		t.Fatalf("ticketless tasks must trail in creation order")
	}
}

// ── Handler ───────────────────────────────────────────────────────────────────

// contextFakeStore stubs only the reads GetContext performs; every other Store
// method panics through the embedded nil interface, which is exactly the signal
// we want if the handler ever starts making an unplanned round trip.
type contextFakeStore struct {
	store.Store
	canvas *store.Canvas
	doc    *store.Document
	notes  []*store.Note
	tasks  []*store.Action
	epics  []*store.Action
	action *store.Action
	links  []store.TaskLink

	docErr    error
	actionErr error
	calls     chan string // every store method call, for round-trip accounting
}

func (f *contextFakeStore) note(name string) {
	select {
	case f.calls <- name:
	default:
	}
}

func (f *contextFakeStore) GetCanvasByID(context.Context, uuid.UUID) (*store.Canvas, error) {
	f.note("GetCanvasByID")
	return f.canvas, nil
}

func (f *contextFakeStore) GetDocument(_ context.Context, _, _ uuid.UUID) (*store.Document, error) {
	f.note("GetDocument")
	if f.docErr != nil {
		return nil, f.docErr
	}
	return f.doc, nil
}

func (f *contextFakeStore) ListNotesByDocument(_ context.Context, _, _ uuid.UUID) ([]*store.Note, error) {
	f.note("ListNotesByDocument")
	return f.notes, nil
}

func (f *contextFakeStore) ListActions(_ context.Context, _ uuid.UUID, stateFilter, typeFilter, _ string) ([]*store.Action, error) {
	f.note("ListActions:" + typeFilter + ":" + stateFilter)
	if typeFilter == "epic" {
		return f.epics, nil
	}
	return f.tasks, nil
}

func (f *contextFakeStore) GetAction(context.Context, uuid.UUID, uuid.UUID) (*store.Action, error) {
	f.note("GetAction")
	if f.actionErr != nil {
		return nil, f.actionErr
	}
	return f.action, nil
}

func (f *contextFakeStore) GetLinkedEntities(context.Context, uuid.UUID, []uuid.UUID) ([]store.TaskLink, error) {
	f.note("GetLinkedEntities")
	return f.links, nil
}

func getContext(t *testing.T, fake *contextFakeStore, query string) (int, contextMsg) {
	t.Helper()
	fake.calls = make(chan string, 32)
	h := NewHandler(fake, ws.NewHub(), nil)
	r := httptest.NewRequest("GET", "/api/canvas/context"+query, nil)
	r = r.WithContext(context.WithValue(r.Context(), claimsKey,
		&auth.Claims{CanvasID: fake.canvas.ID, Role: "read"}))
	w := httptest.NewRecorder()
	h.GetContext(w, r)

	var msg contextMsg
	_ = json.Unmarshal(w.Body.Bytes(), &msg)
	return w.Code, msg
}

func (f *contextFakeStore) callNames() []string {
	close(f.calls)
	var out []string
	for c := range f.calls {
		out = append(out, c)
	}
	return out
}

func newContextFake() *contextFakeStore {
	epicID := uuid.New()
	epicPayload, _ := json.Marshal(map[string]any{"title": "E1 Context spine"})
	return &contextFakeStore{
		canvas: ctxCanvas("tandem planning"),
		doc:    &store.Document{ID: uuid.New(), Name: "Project brief"},
		notes:  []*store.Note{ctxNote("Read me first.", 0, agoReal(21*24*time.Hour), secs(tenDays))},
		tasks:  []*store.Action{ctxTask(29, "context_get endpoint", epicID.String())},
		epics: []*store.Action{{ID: epicID, Kind: "action", Type: "epic", State: "approved",
			Payload: epicPayload}},
	}
}

func TestGetContext_BundleAndCounts(t *testing.T) {
	fake := newContextFake()
	docID := fake.doc.ID
	fake.canvas.BriefingDocID = &docID

	code, msg := getContext(t, fake, "")
	if code != 200 {
		t.Fatalf("status = %d", code)
	}
	if msg.Type != "context" {
		t.Fatalf("type = %q", msg.Type)
	}
	for _, want := range []string{
		"# tandem planning", "## Briefing", "Source: **Project brief**",
		"[stale — verified 21d ago]", "Read me first.",
		"## Approved queue", "**TDM-29** — context_get endpoint — epic: E1 Context spine",
	} {
		if !strings.Contains(msg.Markdown, want) {
			t.Fatalf("markdown missing %q\n---\n%s", want, msg.Markdown)
		}
	}
	if msg.Counts["approvedTasks"] != 1 || msg.Counts["briefingNotes"] != 1 || msg.Counts["stale"] != 1 {
		t.Fatalf("counts = %+v", msg.Counts)
	}
	if msg.GeneratedAt.IsZero() {
		t.Fatalf("generatedAt must be set")
	}
	// No ?taskId= → no task read, no link read: the cheap path stays cheap.
	for _, c := range fake.callNames() {
		if c == "GetAction" || c == "GetLinkedEntities" {
			t.Fatalf("unexpected store call %q on the no-taskId path", c)
		}
	}
}

// No briefing designated → no document/notes reads at all, and the section says so.
func TestGetContext_NoBriefing(t *testing.T) {
	fake := newContextFake()
	code, msg := getContext(t, fake, "")
	if code != 200 {
		t.Fatalf("status = %d", code)
	}
	if !strings.Contains(msg.Markdown, "No briefing document is designated") {
		t.Fatalf("expected the no-briefing section\n---\n%s", msg.Markdown)
	}
	for _, c := range fake.callNames() {
		if c == "GetDocument" || c == "ListNotesByDocument" {
			t.Fatalf("unexpected briefing read %q when none is designated", c)
		}
	}
}

// A briefing_doc_id pointing at a deleted document degrades to "no briefing"
// rather than 500-ing the whole connect read.
func TestGetContext_DanglingBriefingDegrades(t *testing.T) {
	fake := newContextFake()
	docID := uuid.New()
	fake.canvas.BriefingDocID = &docID
	fake.docErr = context.DeadlineExceeded

	code, msg := getContext(t, fake, "")
	if code != 200 {
		t.Fatalf("status = %d, want 200", code)
	}
	if !strings.Contains(msg.Markdown, "No briefing document is designated") {
		t.Fatalf("expected graceful degradation\n---\n%s", msg.Markdown)
	}
}

func TestGetContext_TaskBundle(t *testing.T) {
	fake := newContextFake()
	linkID := uuid.New()
	payload, _ := json.Marshal(map[string]any{
		"title": "context_get endpoint", "body": "Build the bundle.",
		"linkedIds": []string{linkID.String()},
	})
	ticket := 29
	fake.action = &store.Action{ID: uuid.New(), Type: "task", State: "approved",
		Payload: payload, Ticket: &ticket}
	fake.links = []store.TaskLink{{ID: linkID, Kind: "note", Body: "Linked context body.",
		VerifiedAt: agoReal(30 * 24 * time.Hour), StaleAfterSeconds: secs(tenDays)}}

	code, msg := getContext(t, fake, "?taskId="+uuid.New().String())
	if code != 200 {
		t.Fatalf("status = %d", code)
	}
	for _, want := range []string{
		"## Task TDM-29", "Build the bundle.", "### Linked context",
		"**note** [stale — verified 30d ago]", "Linked context body.",
	} {
		if !strings.Contains(msg.Markdown, want) {
			t.Fatalf("markdown missing %q\n---\n%s", want, msg.Markdown)
		}
	}
	if msg.Counts["linkedItems"] != 1 || msg.Counts["stale"] != 1 {
		t.Fatalf("counts = %+v", msg.Counts)
	}
}

func TestGetContext_BadAndMissingTaskId(t *testing.T) {
	fake := newContextFake()
	if code, _ := getContext(t, fake, "?taskId=not-a-uuid"); code != 400 {
		t.Fatalf("malformed taskId → %d, want 400", code)
	}

	fake = newContextFake()
	fake.actionErr = store.ErrActionNotFound
	if code, _ := getContext(t, fake, "?taskId="+uuid.New().String()); code != 404 {
		t.Fatalf("unknown taskId → %d, want 404", code)
	}
}

// The bundle must not cost one query per queued task: epic titles come from a
// single epics list regardless of how many approved tasks reference them.
func TestGetContext_NoPerTaskQueries(t *testing.T) {
	fake := newContextFake()
	epicID := fake.epics[0].ID
	fake.tasks = nil
	for i := 1; i <= 25; i++ {
		fake.tasks = append(fake.tasks, ctxTask(i, "task", epicID.String()))
	}
	code, msg := getContext(t, fake, "")
	if code != 200 {
		t.Fatalf("status = %d", code)
	}
	if !strings.Contains(msg.Markdown, "25 approved tasks ready to work.") {
		t.Fatalf("expected the whole queue\n---\n%s", msg.Markdown)
	}
	if n := strings.Count(msg.Markdown, "epic: E1 Context spine"); n != 25 {
		t.Fatalf("every task should name its epic, got %d", n)
	}
	// Three reads total for 25 tasks: the canvas, the queue, the epics.
	if calls := fake.callNames(); len(calls) != 3 {
		t.Fatalf("expected 3 store calls, got %d: %v", len(calls), calls)
	}
}
