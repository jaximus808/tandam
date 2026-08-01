package api

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/store"
)

// Review feedback (TDM-161) — the reason a piece of work came back, on the read
// paths the agent that proposed it actually calls.
//
// THE PROBLEM. Saying no is the most informative thing a human does at the gate,
// and until now it was a dead end. A rejection reason was stored (RejectAction
// writes it to actions.error) and a reviewer's rework reason was stored
// (payload.audit[].note, TDM-154) — and neither was ever handed back to the
// agent that wrote the ticket. So the correction that would have fixed the next
// five tickets went nowhere, and the same slop got proposed again. Triage that
// repeats is triage the human eventually stops doing.
//
// ONE CHANNEL, TWO ORIGINS. A human rejecting a proposal and a reviewer agent
// bouncing finished work are the same event to the AUTHOR — "this came back, and
// here is why" — so they read as one shape (reviewFeedback) with `outcome`
// naming which happened and `by` naming who. An author agent has ONE place to
// look, not two, and does not have to know that one of them lives in a column
// and the other in an audit log.
//
// DERIVED, NEVER STORED. Everything here is computed at read time off rows that
// already exist — no column, no migration, and no second copy of the truth to
// drift. It is deliberately the same discipline gate_metrics.go (TDM-165) uses
// on the same audit log, and it reuses that file's reading of it rather than
// growing a parallel one.
//
// WHERE IT SURFACES, AND WHERE IT DELIBERATELY DOES NOT:
//
//	task_get (GET /api/canvas/actions/{id})   the specific ticket → `review`
//	the epic read (GET /api/canvas/epics)     the batch → `returned[]` per epic
//	context_get with ?taskId=                 the same task, in the markdown
//	queue_next (GET …/actions?state=approved) NOTHING. See below.
//
// queue_next is the ready-work call. It answers "what should I start?", and an
// agent reading it is about to work, not about to re-plan. Folding "and by the
// way, three of your tickets were cut" into it would make the one call every
// session depends on into a notifications feed — and the reason a worker
// actually needs (a bounce on the task it is about to pick up) reaches it one
// call later on task_get, which the handoff already tells it to make. So the
// queue projection is untouched here on purpose.

// reviewOutcome values. Two, because there are two ways work comes back.
const (
	// reviewRejected: a human rejected the proposal. Terminal — nobody will work
	// it, and re-proposing the same ticket lands the same way.
	reviewRejected = "rejected"
	// reviewRework: finished work was sent back to the queue — a reviewer agent's
	// bounce (TDM-154) or a human's reopen. Not terminal: the ticket is live again
	// and the reason is the instruction for the second attempt.
	reviewRework = "rework"
)

// reviewOutstandingStates are the states in which a rework bounce is still
// something to act on.
//
// The bounce lands a task in 'approved'. For it to have reached 'done' or
// 'failed' since, it must have been re-claimed and re-completed — the bounce has
// been answered, and re-quoting a stale instruction at a worker would be worse
// than saying nothing. 'proposed' stays in: a bounced task whose content was
// then edited reverts there (content_gate.go), and the reason still applies to
// whoever picks it up.
var reviewOutstandingStates = map[string]bool{
	"proposed":  true,
	"approved":  true,
	"executing": true,
}

// reviewFeedback is one "your work came back" event, whatever produced it.
type reviewFeedback struct {
	// Outcome is reviewRejected or reviewRework — what happened, in the author's
	// terms rather than the state machine's.
	Outcome string `json:"outcome"`
	// Reason is the decider's own words, VERBATIM and unexcerpted on a single-task
	// read. The reason IS the correction; truncating it would hand back a hint
	// where an instruction was written (the TDM-154 lesson about the 80-rune audit
	// summary). Empty when whoever said no did not say why — which is worth
	// surfacing as an empty reason rather than hiding, so the author can ask.
	Reason string `json:"reason,omitempty"`
	// By is server-derived provenance, same vocabulary as authoredBy: "human",
	// "agent:<identity>", "anonymous". Never a guess — see reviewActorForRejection.
	By string `json:"by,omitempty"`
	// At is when it happened, RFC3339.
	At string `json:"at,omitempty"`
	// State is where the task sits NOW, so a reader can tell "cut for good" from
	// "back in the queue waiting for you" without knowing the state machine.
	State string `json:"state"`
	// ReasonTruncated marks a reason cut down for a LIST read (the epic rollup).
	// Never set on a single-task read, which always carries the whole thing.
	ReasonTruncated bool `json:"reasonTruncated,omitempty"`
}

// deriveReviewFeedback reduces one action to its outstanding review feedback, or
// nil when there is none. PURE — no store, no clock, no request — so every
// branch is table-testable, and so the same function can answer for a single
// task read, an epic rollup and the context bundle without three readings of the
// audit log that could disagree.
//
// Order matters: a CURRENT rejection outranks any older bounce, because it is
// both newer and stronger. Reading current state (rather than replaying the
// audit log) is also what makes an undone rejection — TDM-160's reject-with-undo
// — disappear from here with no reconciliation pass, exactly as it does from the
// gate metrics.
func deriveReviewFeedback(a *store.Action) *reviewFeedback {
	if a == nil {
		return nil
	}
	if a.State == "rejected" {
		reason := ""
		if a.Error != nil {
			reason = strings.TrimSpace(*a.Error)
		}
		by, at := reviewActorForRejection(a)
		return &reviewFeedback{
			Outcome: reviewRejected,
			Reason:  reason,
			By:      by,
			At:      at,
			State:   a.State,
		}
	}
	if !reviewOutstandingStates[a.State] {
		return nil
	}
	e := lastReworkAudit(a)
	if e == nil {
		return nil
	}
	return &reviewFeedback{
		Outcome: reviewRework,
		// Note, never Summary: Summary excerpts the reason at 80 runes, which is
		// right for a glance and wrong when the note IS the instruction. Rows
		// written before TDM-154 have no Note; they fall back to the summary line,
		// which is all that was ever recorded for them.
		Reason: strings.TrimSpace(orString(e.Note, e.Summary)),
		By:     strings.TrimSpace(e.Actor),
		At:     e.At,
		State:  a.State,
	}
}

// lastReworkAudit finds the most recent entry in an action's audit log that
// took finished work back OFF the done pile — the pair every way of sending it
// back writes: a reviewer agent's rework and a human's reopen, both done →
// approved (TDM-154, E10 task_move.go), and the owner's re-open to the gate,
// done → proposed (TDM-190, task_owner_move.go).
//
// They are deliberately not told apart here. To the author they are the same
// event — "what I finished came back, and here is why" — and the feedback's
// `By` already says who and its `State` already says where it landed, which is
// the only part that changes what happens next (back in the queue vs. back at
// the gate). Splitting them into separate outcomes would make an author agent
// branch on a distinction it can already read.
//
// KNOWN FLOOR, inherited from the log: payload.audit[] keeps only its
// store.MaxContentAudit most recent entries, so a task with a very busy edit
// history can age its bounce out. The reason then reads as absent rather than
// wrong.
func lastReworkAudit(a *store.Action) *store.ContentAudit {
	log := readActionAudit(a.Payload)
	var found *store.ContentAudit
	for i := range log {
		if log[i].FromState != "done" {
			continue
		}
		if log[i].ToState == "approved" || log[i].ToState == "proposed" {
			found = &log[i]
		}
	}
	return found
}

// readActionAudit pulls the server-owned audit log off a payload. Anything
// unparsable reads as no history — the same forgiving rule storedAudit applies
// on the write side, because a corrupt log must degrade a read, never fail it.
func readActionAudit(raw json.RawMessage) []store.ContentAudit {
	var p struct {
		Audit []store.ContentAudit `json:"audit"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil
	}
	return p.Audit
}

// reviewActorForRejection answers who rejected and when.
//
// The rejection itself records neither: RejectAction stores only the reason (in
// actions.error), and the transition writes no audit entry. Two honest sources,
// in order:
//
//  1. An audit entry landing in 'rejected' — written when the rejection came
//     through the board's move path — which carries the SERVER-derived actor.
//  2. Otherwise "human", which is a FACT rather than a guess: the reject
//     endpoint refuses anyone the server cannot see as a signed-in human
//     (TDM-129), and the 'peer' policy deliberately does not relax it. There is
//     no door a rejection can arrive by that is not a human's.
//
// The timestamp falls back to updated_at, which for a rejected task is the
// rejection (nothing moves after it except an undo, which removes it from here
// entirely).
func reviewActorForRejection(a *store.Action) (string, string) {
	for _, e := range readActionAudit(a.Payload) {
		if e.ToState == "rejected" {
			if actor := strings.TrimSpace(e.Actor); actor != "" && actor != "unknown" {
				return actor, e.At
			}
		}
	}
	return AuthorHuman, a.UpdatedAt.UTC().Format(time.RFC3339)
}

// excerptReason cuts a reason down for a LIST read, by RUNE, marking the cut.
// Returns the text and whether it was cut.
//
// Only list reads call this. A reason is an instruction, and the single-task
// read hands it back whole — but an epic rollup can carry twenty of them beside
// everything else it already answers, and a batch read that quotes twenty full
// rework reasons stops being the cheap "where does this batch stand" call it
// exists to be. The full text is always one task_get away, and the rollup says so.
func excerptReason(s string, max int) (string, bool) {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= max {
		return s, false
	}
	return strings.TrimSpace(string(r[:max])) + "…", true
}

// orString returns the first non-blank of the two.
func orString(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}
