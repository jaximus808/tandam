package api

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// TDM-165 — the pre-work intervention rate.
//
// What is under test is the CLASSIFICATION, not the arithmetic: which tasks land
// in the denominator, what counts as an amendment, and — the one everybody gets
// wrong — what an undone rejection does to the number. Those rules are the
// metric; if they drift, the figure keeps rendering and quietly means something
// else.

func gateTask(state string, created time.Time, payload map[string]any, approvedBy string) *store.Action {
	raw, _ := json.Marshal(payload)
	a := &store.Action{
		ID:        uuid.New(),
		Kind:      "action",
		Type:      "task",
		State:     state,
		Payload:   raw,
		CreatedAt: created,
		UpdatedAt: created,
	}
	if approvedBy != "" {
		a.ApprovedBy = &approvedBy
	}
	return a
}

// contentEdit is one title/body audit entry as the content gate writes it.
func contentEdit(from, to string) map[string]any {
	return map[string]any{
		"at": "2026-07-01T00:00:00Z", "actor": "human",
		"change": []string{"title"}, "fromState": from, "toState": to,
	}
}

// stateMove is one state audit entry as NewStateAudit writes it.
func stateMove(from, to string) map[string]any {
	return map[string]any{
		"at": "2026-07-01T00:00:00Z", "actor": "human",
		"change": []string{store.StateChange}, "fromState": from, "toState": to,
	}
}

func TestGateTallyCountsRejectedAndAmendedOnce(t *testing.T) {
	now := time.Now().UTC()
	tasks := []*store.Action{
		// Plain approved-and-shipped work: denominator only.
		gateTask("done", now, map[string]any{"title": "shipped"}, "policy:epic"),
		gateTask("done", now, map[string]any{"title": "shipped too"}, "policy:epic"),
		// Rejected: numerator.
		gateTask("rejected", now, map[string]any{"title": "thrown out"}, ""),
		// Amended while proposed, then approved: numerator.
		gateTask("approved", now, map[string]any{
			"title": "rewritten", "audit": []any{contentEdit("proposed", "proposed")},
		}, "policy:epic"),
		// BOTH rejected and amended — must count ONCE, or the rate exceeds what
		// actually happened.
		gateTask("rejected", now, map[string]any{
			"title": "rewritten then binned", "audit": []any{contentEdit("proposed", "proposed")},
		}, ""),
	}

	got := buildGateMetrics(nil, tasks, now, 30)
	a := got.AllTime
	if a.Decided != 5 {
		t.Fatalf("decided = %d, want 5", a.Decided)
	}
	if a.Rejected != 2 {
		t.Errorf("rejected = %d, want 2", a.Rejected)
	}
	if a.Amended != 2 {
		t.Errorf("amended = %d, want 2", a.Amended)
	}
	if a.Intervened != 3 {
		t.Errorf("intervened = %d, want 3 (the union, not 2+2)", a.Intervened)
	}
	if a.RatePct != 60 {
		t.Errorf("ratePct = %v, want 60", a.RatePct)
	}
	if !a.HasRate {
		t.Error("hasRate should be true with a non-empty population")
	}
}

// The TDM-160 requirement: a rejection that was undone must not inflate the
// count. The mechanism is that we read CURRENT state, so the undo — which moves
// the task back to 'proposed' — removes it from the numerator with no
// reconciliation pass.
func TestGateTallyUndoneRejectionDoesNotCount(t *testing.T) {
	now := time.Now().UTC()
	// Rejected, then undone: state is 'proposed' again and the audit log carries
	// the withdrawal.
	undone := gateTask("proposed", now, map[string]any{
		"title": "rejected by mistake", "audit": []any{stateMove("rejected", "proposed")},
	}, "")
	// Rejected, undone, then approved and shipped. Its history still holds the
	// rejection; the rejection is not what happened in the end.
	revived := gateTask("done", now, map[string]any{
		"title": "reconsidered", "audit": []any{stateMove("rejected", "proposed")},
	}, "policy:epic")

	got := buildGateMetrics(nil, []*store.Action{undone, revived}, now, 30)
	a := got.AllTime
	if a.Rejected != 0 {
		t.Fatalf("rejected = %d, want 0 — an undone rejection must not count", a.Rejected)
	}
	if a.Intervened != 0 {
		t.Errorf("intervened = %d, want 0", a.Intervened)
	}
	if a.RejectionsUndone != 2 {
		t.Errorf("rejectionsUndone = %d, want 2 — withdrawals are reported, not hidden", a.RejectionsUndone)
	}
	// The undone one is back in the gate and undecided; the revived one was ruled on.
	if a.Pending != 1 || a.Decided != 1 {
		t.Errorf("pending/decided = %d/%d, want 1/1", a.Pending, a.Decided)
	}
}

// Only edits that arrived BEFORE an agent claimed the task count. An edit made
// while executing is a rescue, not a prevention, and the metric's entire claim
// is about tokens not yet spent.
func TestGateTallyAmendmentWindow(t *testing.T) {
	now := time.Now().UTC()
	cases := []struct {
		name string
		from string
		want int
	}{
		{"edited in the gate", "proposed", 1},
		{"edited after approval, before any claim", "approved", 1},
		{"edited mid-flight", "executing", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			task := gateTask("done", now, map[string]any{
				"title": tc.name, "audit": []any{contentEdit(tc.from, "proposed")},
			}, "policy:epic")
			got := buildGateMetrics(nil, []*store.Action{task}, now, 30)
			if got.AllTime.Amended != tc.want {
				t.Fatalf("amended = %d, want %d", got.AllTime.Amended, tc.want)
			}
		})
	}
}

// A state move is not a content edit, however many of them a task accumulates.
func TestGateTallyStateMovesAreNotAmendments(t *testing.T) {
	now := time.Now().UTC()
	task := gateTask("done", now, map[string]any{
		"title": "busy card",
		"audit": []any{stateMove("approved", "executing"), stateMove("executing", "done")},
	}, "policy:epic")
	got := buildGateMetrics(nil, []*store.Action{task}, now, 30)
	if got.AllTime.Amended != 0 {
		t.Fatalf("amended = %d, want 0 — moving a card is not rewriting it", got.AllTime.Amended)
	}
}

// A done → approved bounce is post-work. Counting it would let rework
// masquerade as prevention, which is the opposite of what this measures.
func TestGateTallyPostWorkBounceIsOutsideTheRate(t *testing.T) {
	now := time.Now().UTC()
	task := gateTask("approved", now, map[string]any{
		"title": "sent back", "audit": []any{stateMove("done", "approved")},
	}, "policy:epic")
	got := buildGateMetrics(nil, []*store.Action{task}, now, 30)
	a := got.AllTime
	if a.PostWorkBounces != 1 {
		t.Fatalf("postWorkBounces = %d, want 1", a.PostWorkBounces)
	}
	if a.Intervened != 0 || a.RatePct != 0 {
		t.Errorf("a rework bounce leaked into the rate: intervened=%d ratePct=%v", a.Intervened, a.RatePct)
	}
}

// A canvas on 'auto' has no gate. Its tasks must leave the population entirely
// rather than counting as "not intervened" — otherwise switching the gate off
// makes the rate collapse, which would read as a quality signal.
func TestGateTallyExcludesAutoApprovedTasks(t *testing.T) {
	now := time.Now().UTC()
	tasks := []*store.Action{
		gateTask("done", now, map[string]any{"title": "ungated"}, "policy:auto"),
		gateTask("done", now, map[string]any{"title": "ungated too"}, "policy:auto"),
		gateTask("rejected", now, map[string]any{"title": "gated + binned"}, ""),
	}
	got := buildGateMetrics(nil, tasks, now, 30)
	a := got.AllTime
	if a.UngatedAuto != 2 {
		t.Fatalf("ungatedAuto = %d, want 2", a.UngatedAuto)
	}
	if a.Decided != 1 || a.RatePct != 100 {
		t.Errorf("auto tasks diluted the rate: decided=%d ratePct=%v, want 1 and 100", a.Decided, a.RatePct)
	}
}

// An empty population has no rate — not a confident 0%.
func TestGateTallyEmptyPopulationHasNoRate(t *testing.T) {
	now := time.Now().UTC()
	got := buildGateMetrics(nil, []*store.Action{
		gateTask("proposed", now, map[string]any{"title": "still in the gate"}, ""),
	}, now, 30)
	if got.AllTime.HasRate {
		t.Fatal("hasRate should be false when nothing has been decided")
	}
	if got.AllTime.Pending != 1 {
		t.Errorf("pending = %d, want 1", got.AllTime.Pending)
	}
}

// The rolling window is keyed on when the task was PROPOSED, so a task cannot
// drift between windows every time somebody touches it.
func TestGateTallyRollingWindowUsesCreationDate(t *testing.T) {
	now := time.Now().UTC()
	old := gateTask("rejected", now.AddDate(0, 0, -90), map[string]any{"title": "ancient"}, "")
	old.UpdatedAt = now // touched today; still outside a 30-day window
	recent := gateTask("done", now.AddDate(0, 0, -2), map[string]any{"title": "fresh"}, "policy:epic")

	got := buildGateMetrics(nil, []*store.Action{old, recent}, now, 30)
	if got.AllTime.Decided != 2 || got.AllTime.Rejected != 1 {
		t.Fatalf("all-time = %d decided / %d rejected, want 2/1", got.AllTime.Decided, got.AllTime.Rejected)
	}
	if got.Window.Decided != 1 || got.Window.Rejected != 0 {
		t.Errorf("window = %d decided / %d rejected, want 1/0", got.Window.Decided, got.Window.Rejected)
	}
	if got.WindowDays != 30 {
		t.Errorf("windowDays = %d, want 30", got.WindowDays)
	}
}

// Per-epic attribution, and the dangling-epicId rule the epic rollup already
// sets: a task whose epic was deleted is unepiced, never dropped.
func TestGateMetricsPerEpicAndUnepiced(t *testing.T) {
	now := time.Now().UTC()
	epicID := uuid.New()
	epic := &store.Action{
		ID: epicID, Kind: "action", Type: "epic", State: "approved",
		Payload:   json.RawMessage(`{"title":"E21"}`),
		CreatedAt: now.AddDate(0, 0, -5),
	}
	tasks := []*store.Action{
		gateTask("rejected", now, map[string]any{"title": "in the epic", "epicId": epicID.String()}, ""),
		gateTask("done", now, map[string]any{"title": "in the epic too", "epicId": epicID.String()}, "policy:epic"),
		gateTask("done", now, map[string]any{"title": "no epic"}, "policy:epic"),
		gateTask("done", now, map[string]any{"title": "dangling", "epicId": uuid.NewString()}, "policy:epic"),
	}

	got := buildGateMetrics([]*store.Action{epic}, tasks, now, 30)
	if len(got.Epics) != 1 {
		t.Fatalf("epics = %d, want 1", len(got.Epics))
	}
	e := got.Epics[0]
	if e.ID != epicID || e.Title != "E21" {
		t.Errorf("epic identity wrong: %v %q", e.ID, e.Title)
	}
	if e.Tally.Decided != 2 || e.Tally.Rejected != 1 || e.Tally.RatePct != 50 {
		t.Errorf("epic tally = %+v, want 2 decided / 1 rejected / 50%%", e.Tally)
	}
	if got.Unepiced.Decided != 2 {
		t.Errorf("unepiced decided = %d, want 2 (no epic + dangling epic)", got.Unepiced.Decided)
	}
}

// The definition and the caveat are part of the RESPONSE, not a UI string, so
// no surface can render the number without the words that qualify it.
func TestGateMetricsShipsItsOwnDefinitionAndCaveat(t *testing.T) {
	got := buildGateMetrics(nil, nil, time.Now().UTC(), 30)
	if len(got.Definition) == 0 {
		t.Fatal("the response must carry the metric's definition")
	}
	if got.Caveat == "" {
		t.Fatal("the response must carry the anti-target caveat")
	}
}
