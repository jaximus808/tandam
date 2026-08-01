package api

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// Review feedback (TDM-161). deriveReviewFeedback is pure, so the whole rule —
// which events count as "came back", which ones have gone stale, and where the
// reason is read from — is provable without a database.

var reviewNow = time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)

// reviewTask builds a task row with an optional audit log and error column.
func reviewTask(state string, errText string, audit ...store.ContentAudit) *store.Action {
	p := map[string]any{"title": "Wire the rework channel"}
	if len(audit) > 0 {
		p["audit"] = audit
	}
	raw, _ := json.Marshal(p)
	a := &store.Action{ID: uuid.New(), Kind: "action", Type: "task", State: state,
		Payload: raw, CreatedAt: reviewNow, UpdatedAt: reviewNow}
	if errText != "" {
		e := errText
		a.Error = &e
	}
	return a
}

func reworkEntry(actor, note, at string) store.ContentAudit {
	return store.NewStateAudit(actor, "done", "approved", note, mustTime(at))
}

func mustTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestDeriveReviewFeedback(t *testing.T) {
	// The reason a reviewer writes is long enough that the 80-rune audit summary
	// excerpt would cut it — which is exactly the case Note exists for, and the
	// one this channel must not repeat.
	longReason := "The rework handler never checks the claim fence, so a worker whose lease " +
		"was superseded can still bounce the task. Cover that case in the API tests before " +
		"this goes back through review."

	cases := []struct {
		name    string
		action  *store.Action
		want    *reviewFeedback
		wantNil bool
	}{
		{
			// The human gate's no, with its reason. `by` is a fact here, not a
			// guess: the reject endpoint admits nobody the server cannot see as a
			// signed-in human.
			name:   "a rejection carries its reason",
			action: reviewTask("rejected", "messaging is a separate service — do not touch it"),
			want: &reviewFeedback{
				Outcome: reviewRejected,
				Reason:  "messaging is a separate service — do not touch it",
				By:      AuthorHuman,
				At:      reviewNow.Format(time.RFC3339),
				State:   "rejected",
			},
		},
		{
			// Silence is reported as silence. Hiding a reasonless rejection would
			// leave the author with no signal at all that its ticket was cut.
			name:   "a rejection with no reason still reports",
			action: reviewTask("rejected", ""),
			want: &reviewFeedback{Outcome: reviewRejected, By: AuthorHuman,
				At: reviewNow.Format(time.RFC3339), State: "rejected"},
		},
		{
			// The reviewer's bounce (TDM-154), read from the audit note VERBATIM.
			name: "a rework bounce carries the reviewer's whole instruction",
			action: reviewTask("approved", "",
				reworkEntry("agent:codex-reviewer", longReason, "2026-08-01T11:00:00Z")),
			want: &reviewFeedback{
				Outcome: reviewRework,
				Reason:  longReason,
				By:      "agent:codex-reviewer",
				At:      "2026-08-01T11:00:00Z",
				State:   "approved",
			},
		},
		{
			// A human reopening finished work writes the SAME audit pair. It reads
			// through the same channel on purpose — to the author it is the same
			// news — and `by` is what tells the two apart.
			name: "a human reopen reads as the same event",
			action: reviewTask("approved", "",
				reworkEntry(AuthorHuman, "the migration is missing", "2026-08-01T11:30:00Z")),
			want: &reviewFeedback{Outcome: reviewRework, Reason: "the migration is missing",
				By: AuthorHuman, At: "2026-08-01T11:30:00Z", State: "approved"},
		},
		{
			// Claimed and being redone: still outstanding, because the worker
			// holding it is the one who needs the instruction.
			name: "a bounce is still outstanding while the task is executing",
			action: reviewTask("executing", "",
				reworkEntry("agent:reviewer", "add the test", "2026-08-01T11:00:00Z")),
			want: &reviewFeedback{Outcome: reviewRework, Reason: "add the test",
				By: "agent:reviewer", At: "2026-08-01T11:00:00Z", State: "executing"},
		},
		{
			// Answered. The bounce moved it to 'approved'; for it to be 'done' now
			// it must have been re-claimed and re-completed since. Re-quoting a
			// satisfied instruction would be worse than saying nothing.
			name: "a bounce that has since been redone is not reported",
			action: reviewTask("done", "",
				reworkEntry("agent:reviewer", "add the test", "2026-08-01T11:00:00Z")),
			wantNil: true,
		},
		{
			// Two bounces: the live one is the last.
			name: "the most recent bounce wins",
			action: reviewTask("approved", "",
				reworkEntry("agent:a", "first pass", "2026-08-01T09:00:00Z"),
				reworkEntry("agent:b", "second pass", "2026-08-01T11:00:00Z")),
			want: &reviewFeedback{Outcome: reviewRework, Reason: "second pass",
				By: "agent:b", At: "2026-08-01T11:00:00Z", State: "approved"},
		},
		{
			// TDM-160's reject-with-undo. Read off CURRENT state, so a withdrawn
			// rejection leaves no ghost — even though the error column still holds
			// the old text.
			name:    "an undone rejection stops being feedback",
			action:  reviewTask("proposed", "cut this"),
			wantNil: true,
		},
		{
			// Ordinary work in flight has nothing to say.
			name:    "a plain approved task has no feedback",
			action:  reviewTask("approved", ""),
			wantNil: true,
		},
		{
			// Other state moves in the log are not bounces.
			name: "an unrelated state move is not a bounce",
			action: reviewTask("approved", "",
				store.NewStateAudit(AuthorHuman, "executing", "approved", "released it", reviewNow)),
			wantNil: true,
		},
		{name: "nil action", action: nil, wantNil: true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := deriveReviewFeedback(c.action)
			if c.wantNil {
				if got != nil {
					t.Fatalf("want no feedback, got %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("want %+v, got nil", c.want)
			}
			if *got != *c.want {
				t.Fatalf("want %+v\ngot  %+v", *c.want, *got)
			}
		})
	}
}

// A rejection that came through the board's move path records WHO in the audit
// log; that beats the endpoint-derived default, which is the fallback.
func TestReviewFeedbackPrefersRecordedActor(t *testing.T) {
	a := reviewTask("rejected", "not a thing",
		store.NewStateAudit("anonymous", "proposed", "rejected", "not a thing",
			mustTime("2026-08-01T10:00:00Z")))
	got := deriveReviewFeedback(a)
	if got == nil {
		t.Fatal("want feedback")
	}
	if got.By != "anonymous" || got.At != "2026-08-01T10:00:00Z" {
		t.Fatalf("want the recorded actor and time, got by=%q at=%q", got.By, got.At)
	}
}

// An epic rejected as a whole answers the same way a ticket does — the batch
// read is where an orchestrator learns its plan was cut.
func TestDeriveReviewFeedbackOnAnEpic(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{"title": "E9 · Messaging"})
	reason := "we are not touching messaging this quarter"
	e := &store.Action{ID: uuid.New(), Kind: "action", Type: "epic", State: "rejected",
		Payload: raw, Error: &reason, CreatedAt: reviewNow, UpdatedAt: reviewNow}
	got := deriveReviewFeedback(e)
	if got == nil || got.Outcome != reviewRejected || got.Reason != reason {
		t.Fatalf("want the epic's own rejection reason, got %+v", got)
	}
}

// Rows written before TDM-154 have no verbatim note, only the excerpted summary
// line. Falling back to it is better than reporting a bounce with no reason.
func TestReviewFeedbackFallsBackToSummary(t *testing.T) {
	a := reviewTask("approved", "", store.ContentAudit{
		At: "2026-08-01T11:00:00Z", Actor: "agent:old", Change: []string{store.StateChange},
		FromState: "done", ToState: "approved", Summary: `state: "done" → "approved" — fix the tests`,
	})
	got := deriveReviewFeedback(a)
	if got == nil || !strings.Contains(got.Reason, "fix the tests") {
		t.Fatalf("want the summary line as a fallback reason, got %+v", got)
	}
}

// The list read excerpts; the single-task read never does.
func TestExcerptReason(t *testing.T) {
	short, cut := excerptReason("  keep it whole  ", 400)
	if short != "keep it whole" || cut {
		t.Fatalf("short reasons pass through untouched, got %q cut=%v", short, cut)
	}
	long := strings.Repeat("é", 500)
	got, cut := excerptReason(long, 400)
	if !cut || len([]rune(got)) != 401 {
		t.Fatalf("want 400 runes plus the ellipsis, got %d runes cut=%v", len([]rune(got)), cut)
	}
}

// The epic rollup carries the came-back tickets with their reasons — the
// batch-level read an orchestrator polls while waiting on its approvals.
func TestEpicRollupReportsReturnedTickets(t *testing.T) {
	epicID := uuid.New()
	created := reviewNow

	rejected := rollupTask(1, "Rewrite the messaging queue", epicID.String(), "rejected", "", created, created)
	cut := "messaging is a separate service — do not touch it"
	rejected.Error = &cut

	bounced := rollupTask(2, "Add the fence test", epicID.String(), "approved", "", created, created)
	payload, _ := json.Marshal(map[string]any{
		"title": "Add the fence test", "epicId": epicID.String(),
		"audit": []store.ContentAudit{
			reworkEntry("agent:codex-reviewer", "no test covers a superseded lease", "2026-08-01T11:00:00Z"),
		},
	})
	bounced.Payload = payload

	fine := rollupTask(3, "Ship it", epicID.String(), "done", "shipped", created, created)

	body := buildEpicRollups(
		[]*store.Action{epicAction(epicID, "E21 · Slop in", "approved", created, nil)},
		[]*store.Action{rejected, bounced, fine},
	)
	if len(body.Epics) != 1 {
		t.Fatalf("want one epic, got %d", len(body.Epics))
	}
	got := body.Epics[0].Returned
	if len(got) != 2 {
		t.Fatalf("want the rejected and the bounced ticket, got %d: %+v", len(got), got)
	}
	if got[0].Outcome != reviewRejected || got[0].Reason != cut || got[0].TicketID != "TDM-1" {
		t.Fatalf("rejected line is wrong: %+v", got[0])
	}
	if got[1].Outcome != reviewRework || got[1].By != "agent:codex-reviewer" {
		t.Fatalf("rework line is wrong: %+v", got[1])
	}
	// The bounced ticket is 'approved', so it is also in the counts — the two
	// lists answer different questions and a ticket can be in both.
	if body.Epics[0].Tasks.ByState["approved"] != 1 {
		t.Fatalf("a bounced ticket stays in the approved count: %+v", body.Epics[0].Tasks)
	}
	// The finished one contributes to done[], not here.
	if len(body.Epics[0].Done) != 1 || body.Epics[0].Done[0].TicketID != "TDM-3" {
		t.Fatalf("want only the finished ticket in done[], got %+v", body.Epics[0].Done)
	}
}

// A ticket proposed on its own (no epic) is still reachable from the batch read
// — otherwise its reason would need a ticket ref nobody was ever handed.
func TestEpicRollupReportsUnepicedReturned(t *testing.T) {
	loose := rollupTask(7, "Delete the old gateway", "", "rejected", "", reviewNow, reviewNow)
	reason := "that gateway is still serving 2.3.x sessions"
	loose.Error = &reason

	body := buildEpicRollups(nil, []*store.Action{loose})
	if len(body.UnepicedReturned) != 1 {
		t.Fatalf("want the loose rejected ticket, got %+v", body.UnepicedReturned)
	}
	if body.UnepicedReturned[0].Reason != reason || body.UnepicedReturned[0].TicketID != "TDM-7" {
		t.Fatalf("wrong line: %+v", body.UnepicedReturned[0])
	}
}

// The context bundle renders the same channel as prose, with the reason whole.
func TestContextBundleRendersReviewFeedback(t *testing.T) {
	reason := "the rework handler never checks the claim fence — cover that in the API tests"
	task := reviewTask("approved", "", reworkEntry("agent:codex-reviewer", reason, "2026-08-01T11:00:00Z"))
	md := renderContextMarkdown(contextBundle{
		Canvas: &store.Canvas{Name: "Tandem planning"},
		Task:   task,
	}, reviewNow)

	if !strings.Contains(md, "### Sent back for rework") {
		t.Fatalf("want a rework section, got:\n%s", md)
	}
	if !strings.Contains(md, reason) {
		t.Fatalf("want the reason VERBATIM, got:\n%s", md)
	}
	if !strings.Contains(md, "agent:codex-reviewer") {
		t.Fatalf("want the reviewer named, got:\n%s", md)
	}

	rejectedMD := renderContextMarkdown(contextBundle{
		Canvas: &store.Canvas{Name: "Tandem planning"},
		Task:   reviewTask("rejected", "messaging is a separate service"),
	}, reviewNow)
	if !strings.Contains(rejectedMD, "### Rejected") ||
		!strings.Contains(rejectedMD, "messaging is a separate service") {
		t.Fatalf("want a rejection section with its reason, got:\n%s", rejectedMD)
	}
}
