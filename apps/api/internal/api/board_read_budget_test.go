package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// THE SIZE REGRESSION GUARD (TDM-185) — the board read can never grow with
// history again.
//
// TDM-183 put GET /api/canvas/epics on a diet (compact by default, `?full=1` for
// the readers that want the ticket lines) and TDM-184 taught the gateway's
// board_status to ask for the cheap shape. Both are easy to lose by accident:
// one `full := true`, one route that forgets the query flag, one new field on
// every done line, and the read is quietly back to costing what the project's
// whole HISTORY costs. This file is the tripwire.
//
// WHAT IT ADDS over epic_rollup_test.go, which already covers the compaction
// rules thoroughly:
//
//  1. it goes through the HANDLER, not the pure builder. Every existing size
//     test calls buildEpicRollupsView(epics, tasks, false) — it hands the
//     compact shape in as an argument, so it keeps passing even if ListEpics
//     stops asking for it. The one line that decides what a real client gets
//     (`full := rollupFullRequested(...)`) had no test on it at all.
//  2. it pins an ABSOLUTE byte ceiling, not a ratio. TestEpicRollupCompact-
//     DefaultIsMuchCheaper pins compact-vs-full at 5x and the archive-growth
//     test pins a relative delta; a change that inflated BOTH shapes equally
//     (a fat new field on every epic row) satisfies both and still doubles what
//     every board read costs.
//
// WHY THE CEILING IS PER-EPIC AND NOT A FLAT TOTAL. The residual after the diet
// is dominated by irreducible identity rows — one envelope per batch (id, title,
// state, counts, activity window, summary), which is precisely what the compact
// read exists to deliver. So the total legitimately drifts up as Jaxon creates
// new epics, and a flat total would fail on a good week. The honest invariant is
// the one that must hold forever: each batch costs a bounded amount, and that
// amount does not move when tickets pile up underneath it.
const maxBoardReadBytesPerEpic = 1800

// The synthetic canvas: 30 batches, 250 finished tickets, all of it drained —
// the archive-heavy shape this endpoint actually serves and the worst case for
// the diet, since every one of those 250 lines is a line the compact read must
// decline to ship.
const (
	boardBudgetEpics = 30
	boardBudgetDone  = 250
)

// boardBudgetFixture builds that canvas, with the two knobs a size test needs:
// how many batches, and how deep the archive under them.
func boardBudgetFixture(epicCount, doneTotal int) (epics, tasks []*store.Action) {
	ids := make([]uuid.UUID, epicCount)
	for i := 0; i < epicCount; i++ {
		ids[i] = uuid.New()
		extra := map[string]any{}
		// Most drained batches have had their summary written — and the summary is
		// the one thing the compact read carries in full, so a fixture without them
		// would flatter the budget.
		if i%3 != 0 {
			extra["summary"] = rollupFixtureSummary
			extra["summaryBy"] = "agent:opus-exec-tdm184"
			extra["summaryAt"] = "2026-07-31T09:00:00Z"
		}
		epics = append(epics, epicAction(ids[i],
			"E · Board reads on a token diet — board_status stops shipping the archive",
			"approved", epicNow.Add(time.Duration(i)*time.Hour), extra))
	}
	for i := 0; i < doneTotal; i++ {
		tasks = append(tasks, rollupTask(i+1,
			"API: compact epic rollup by default, ?full=1 keeps today's shape",
			ids[i%epicCount].String(), "done", rollupFixtureResult, epicNow, epicNow.Add(time.Hour)))
	}
	return epics, tasks
}

// boardBudgetStore is the two list reads ListEpics makes, and nothing else.
// runBatch issues them in parallel, so the call counter is guarded.
type boardBudgetStore struct {
	store.Store
	mu    sync.Mutex
	calls int
	epics []*store.Action
	tasks []*store.Action
}

func (s *boardBudgetStore) ListActions(_ context.Context, _ uuid.UUID, _, typeFilter, _ string) ([]*store.Action, error) {
	s.mu.Lock()
	s.calls++
	s.mu.Unlock()
	if typeFilter == "epic" {
		return s.epics, nil
	}
	return s.tasks, nil
}

// boardRead runs the real endpoint and returns the bytes a client receives —
// the number this whole file is about.
func boardRead(t *testing.T, epics, tasks []*store.Action, query string) []byte {
	t.Helper()
	st := &boardBudgetStore{epics: epics, tasks: tasks}
	w := httptest.NewRecorder()
	NewHandler(st, nil, nil).ListEpics(w, canvasRequest(t, "GET", "/api/canvas/epics"+query, nil, uuid.New(), ""))
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/canvas/epics%s = %d; body %s", query, w.Code, w.Body)
	}
	// Two list queries, in parallel, for the whole board. If this ever becomes
	// per-item the response size stops being the interesting number.
	if st.calls != 2 {
		t.Fatalf("the rollup should cost 2 list reads, got %d", st.calls)
	}
	return []byte(strings.TrimSpace(w.Body.String()))
}

// The tripwire itself. If this fails, the board read got expensive: something
// put per-ticket weight back into the default shape, or the default stopped
// being the compact one.
func TestBoardReadStaysUnderItsByteBudget(t *testing.T) {
	epics, tasks := boardBudgetFixture(boardBudgetEpics, boardBudgetDone)
	got := boardRead(t, epics, tasks, "")

	var body epicRollupBody
	if err := json.Unmarshal(got, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !body.Compact {
		t.Fatal("the DEFAULT read must be the compact shape — check `full :=` in ListEpics")
	}
	if len(body.Epics) != boardBudgetEpics {
		t.Fatalf("want %d epics, got %d", boardBudgetEpics, len(body.Epics))
	}

	budget := maxBoardReadBytesPerEpic * boardBudgetEpics
	perEpic := len(got) / boardBudgetEpics
	t.Logf("%d epics / %d finished tickets: %d bytes (%d B/epic); budget %d (%d B/epic)",
		boardBudgetEpics, boardBudgetDone, len(got), perEpic, budget, maxBoardReadBytesPerEpic)
	if len(got) > budget {
		t.Errorf("the board read is %d bytes (%d B/epic) — over its %d-byte budget (%d B/epic).\n"+
			"Something put per-ticket weight back into the DEFAULT shape. Check, in order:\n"+
			"  · ListEpics still defaults to compact (`full := rollupFullRequested(...)`)\n"+
			"  · compactRollup still clears Done on a batch with nothing open or returned\n"+
			"  · no new field was added to every epic row or every done line\n"+
			"If the growth is legitimate, raise maxBoardReadBytesPerEpic DELIBERATELY and say why.",
			len(got), perEpic, budget, maxBoardReadBytesPerEpic)
	}

	// And the budget has to be able to fail. The same fixture in the full shape
	// must blow it — otherwise the assertion above passes for the wrong reason
	// and would keep passing through a straight revert of the diet.
	full := boardRead(t, epics, tasks, "?full=1")
	t.Logf("?full=1 on the same board: %d bytes (%d B/epic)", len(full), len(full)/boardBudgetEpics)
	if len(full) <= budget {
		t.Errorf("the budget no longer discriminates: the pre-diet FULL shape fits inside it "+
			"(%d ≤ %d bytes), so this test would not notice the diet being reverted. Tighten "+
			"maxBoardReadBytesPerEpic — compact is %d B/epic, full is %d B/epic.",
			len(full), budget, perEpic, len(full)/boardBudgetEpics)
	}
}

// The property the byte ceiling is a proxy for, at the layer a client talks to:
// the default read costs what the BOARD costs, not what its HISTORY costs. Ten
// times the archive, same response.
func TestBoardReadDoesNotGrowWithTheArchive(t *testing.T) {
	size := func(doneTotal int) int {
		epics, tasks := boardBudgetFixture(boardBudgetEpics, doneTotal)
		return len(boardRead(t, epics, tasks, ""))
	}
	small, huge := size(boardBudgetDone), size(boardBudgetDone*10)
	t.Logf("%d→%d finished tickets over %d epics: %d→%d bytes",
		boardBudgetDone, boardBudgetDone*10, boardBudgetEpics, small, huge)

	// Only the tallies get wider — doneOmitted, tasks.total and its byState entry
	// each gain a digit as an epic's archive goes from ~8 tickets to ~83. That is
	// a handful of bytes per epic; anything more means lines came back.
	if grew := huge - small; grew > 8*boardBudgetEpics {
		t.Errorf("the board read grew %d bytes (%d → %d) when the archive grew 10x; it must be "+
			"O(epics), not O(tickets). A per-ticket line item has come back into the default shape.",
			grew, small, huge)
	}
}

// The other half of "bounded": a batch costs the same whether the board holds
// ten of them or a hundred and twenty. This is the invariant that survives the
// board getting bigger, which a flat total never could.
func TestBoardReadCostPerEpicStaysBounded(t *testing.T) {
	for _, epicCount := range []int{10, 30, 120} {
		epics, tasks := boardBudgetFixture(epicCount, boardBudgetDone)
		got := boardRead(t, epics, tasks, "")
		perEpic := len(got) / epicCount
		t.Logf("%d epics: %d bytes (%d B/epic)", epicCount, len(got), perEpic)
		if perEpic > maxBoardReadBytesPerEpic {
			t.Errorf("at %d epics the board read costs %d B/epic (%d bytes total), over the "+
				"%d B/epic ceiling — a batch's row must stay bounded no matter how many batches there are",
				epicCount, perEpic, len(got), maxBoardReadBytesPerEpic)
		}
	}
}

// The route-level reversion detector, separate from the size question: which
// shape a real client GETS. Nothing else tests this — the compaction tests all
// pass the shape in as an argument to the pure builder.
func TestListEpicsDefaultsToCompactAndFullOptsBackIn(t *testing.T) {
	epics, tasks := boardBudgetFixture(3, 9) // 3 finished tickets per batch
	read := func(query string) epicRollupBody {
		t.Helper()
		var body epicRollupBody
		if err := json.Unmarshal(boardRead(t, epics, tasks, query), &body); err != nil {
			t.Fatalf("unmarshal %q: %v", query, err)
		}
		if len(body.Epics) != 3 {
			t.Fatalf("want 3 epics from %q, got %d", query, len(body.Epics))
		}
		return body
	}

	def := read("")
	if !def.Compact {
		t.Error("the default response must announce the compact shape, so a reader knows which one it got")
	}
	if len(def.Epics[0].Done) != 0 || def.Epics[0].DoneOmitted != 3 {
		t.Errorf("a drained batch should answer with counts and say what it withheld: %d lines, doneOmitted %d",
			len(def.Epics[0].Done), def.Epics[0].DoneOmitted)
	}

	// ?full=1 is the way back to the lines, and the board and the summary writers
	// depend on it. A guard that only pinned "small" could be satisfied by
	// deleting the escape hatch.
	full := read("?full=1")
	if full.Compact {
		t.Error("?full=1 must not come back marked compact")
	}
	if len(full.Epics[0].Done) != 3 || full.Epics[0].DoneOmitted != 0 {
		t.Errorf("?full=1 must return the ticket lines: %d lines, doneOmitted %d",
			len(full.Epics[0].Done), full.Epics[0].DoneOmitted)
	}
}
