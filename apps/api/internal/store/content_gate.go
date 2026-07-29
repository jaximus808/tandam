package store

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Content-mutation gate (TDM-41, E4.2).
//
// THE PROBLEM. The approval gate is the product: a human reads a task and says
// yes to THAT task. If an agent can get a benign task approved and then rewrite
// its title/body, the human approved one thing and the fleet executes another —
// the gate is theater. Approval has to bind to CONTENT, not to a row id.
//
// WHAT "CONTENT" IS. Exactly two payload fields: `title` and `body`. They are
// the approval-relevant ones — what a human reads before saying yes. Everything
// else in the payload is bookkeeping a running task legitimately accretes:
// `progress[]` (the TDM-38 CI heartbeat), `links[]` (completion evidence),
// `assignee`, `linkedIds`, `epicId`, `requiresApproval`. Those must NEVER cost a
// task its approval — a CI job posting "tests green" on an executing task that
// then bounced back to 'proposed' would make the status API useless.
//
// THE RULE (state × change-type → outcome), enforced in UpdateActionPayload:
//
//	state      content edit (title/body)                non-content edit
//	─────────  ───────────────────────────────────────  ────────────────
//	proposed   allowed, audited                          allowed, silent
//	rejected   allowed, audited                          allowed, silent
//	approved   REVERTS to proposed, claim + approved_by  allowed, silent
//	           cleared, audited (reverted:true)
//	executing  REVERTS to proposed, claim + approved_by  allowed, silent
//	           cleared, audited (reverted:true)
//	done       REFUSED (ErrContentLocked)                allowed, silent
//	failed     REFUSED (ErrContentLocked)                allowed, silent
//
// WHY 'executing' REVERTS TOO, and why the editor's identity is irrelevant.
// A claimed task whose body changes mid-flight is the attack in its purest
// form — the work is already moving and the instructions change under it. The
// hard line is: ANY content change to an approved-or-executing action reverts
// it and releases the claim, no matter who made it. An agent refining its own
// claimed task is caught by the same rule, and that is the intended cost: it
// re-enters the queue and a human re-reads it. "The editor was also the
// claimant" is not a safe exemption, because the claimant is a self-asserted
// string (see api/provenance.go) — an attacker would simply claim first.
//
// WHY done/failed REFUSE rather than revert. A terminal task is history. There
// is nothing left to re-approve, and silently rewriting what a completed task
// said would corrupt the record the audit trail exists to protect.
//
// THE AUDIT TRAIL is `payload.audit[]` — same shape of idea as `progress[]`,
// so it rides along in every existing read (REST, WS state broadcast) with no
// migration and no new table. It is SERVER-OWNED: carryContentAudit always
// takes the prior entries from the STORED payload and discards whatever the
// caller put under `audit`, so an agent can neither forge an entry nor erase
// the one recording its own edit. Capped at the most recent MaxContentAudit.

// MaxContentAudit bounds payload.audit[]. The payload is re-read by every board
// load and every WS state broadcast, so an unbounded log would tax the whole
// canvas. Twenty is far more edit history than any single task accumulates
// legitimately, and the entries that matter most (the recent ones) are the ones
// kept.
const MaxContentAudit = 20

// auditExcerpt is how much of a value a summary quotes. Long enough to see WHAT
// changed at a glance, short enough that a 5000-word body can't smuggle itself
// into the audit log twenty times over.
const auditExcerpt = 80

// ContentAudit is one entry in an action payload's server-owned audit[] log.
//
// Deliberately compact: this is a change RECORD, not a version-control system.
// It answers "who touched the approved content, when, which field, and roughly
// what did it become" — enough for a human to decide whether the re-approval is
// routine or alarming. Anyone needing the full before/after has the state
// broadcast history and the row's updated_at.
type ContentAudit struct {
	At    string `json:"at"`
	Actor string `json:"actor"`
	// Change lists the content fields that moved: "title", "body", or both, in
	// that fixed order (deterministic, so tests and diffs don't flap).
	Change []string `json:"change"`
	// FromState is the state the action was in when the edit arrived, and
	// ToState the state it ended in. They differ exactly when Reverted is true.
	FromState string `json:"fromState"`
	ToState   string `json:"toState"`
	// Reverted marks the entries that cost an approval — the ones the UI's
	// "edited after approval" notice keys on.
	Reverted bool `json:"reverted"`
	// Summary is a compact old→new hint per changed field, e.g.
	// `title: "Fix the login bug" → "Fix the login bug and rm -rf /"`.
	Summary string `json:"summary"`
}

// contentFields IS the definition of content, in the order Change reports them.
// Adding a field here widens the gate; that is the intended, single place to do
// it — and it should stay tiny. Every field added is a field a legitimate
// bookkeeping write can trip over.
var contentFields = []string{"title", "body"}

// ContentDiff reports which content fields differ between a stored payload and
// an incoming one, in contentFields order. Empty means "nothing approval-
// relevant moved" — the caller may write freely.
//
// A payload that isn't a JSON object contributes empty strings, so replacing an
// object payload with a scalar reads as a content change (safe direction);
// task/epic payloads are already rejected upstream by canonicalize*Payload.
// A payload that OMITS title is likewise a change from a payload that had one:
// this write path REPLACES the payload, so omission is deletion.
func ContentDiff(stored, incoming json.RawMessage) []string {
	before, after := contentValues(stored), contentValues(incoming)
	var changed []string
	for _, f := range contentFields {
		if before[f] != after[f] {
			changed = append(changed, f)
		}
	}
	return changed
}

// contentValues pulls the content fields out of a payload as plain strings. A
// non-string value under a content key (a number, an object) reads as "" —
// which is a change if it used to hold text, again the safe direction.
func contentValues(raw json.RawMessage) map[string]string {
	out := make(map[string]string, len(contentFields))
	for _, f := range contentFields {
		out[f] = ""
	}
	var p map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return out
	}
	for _, f := range contentFields {
		if s, ok := p[f].(string); ok {
			out[f] = s
		}
	}
	return out
}

// NewContentAudit builds the entry for one content edit. `changed` comes from
// ContentDiff; `to` is the state the action will land in (equal to `from`
// unless this edit reverts an approval).
func NewContentAudit(actor string, changed []string, stored, incoming json.RawMessage, from, to string, at time.Time) ContentAudit {
	if strings.TrimSpace(actor) == "" {
		// Provenance wasn't derived for this request (a route without the
		// middleware). "unknown" is the honest answer; guessing "human" would be
		// exactly the lie the provenance work exists to prevent.
		actor = "unknown"
	}
	return ContentAudit{
		At:        at.UTC().Format(time.RFC3339),
		Actor:     actor,
		Change:    append([]string(nil), changed...),
		FromState: from,
		ToState:   to,
		Reverted:  from != to,
		Summary:   contentSummary(changed, stored, incoming),
	}
}

// contentSummary renders the compact old→new hint. One clause per changed
// field, both sides excerpted.
func contentSummary(changed []string, stored, incoming json.RawMessage) string {
	before, after := contentValues(stored), contentValues(incoming)
	parts := make([]string, 0, len(changed))
	for _, f := range changed {
		parts = append(parts, fmt.Sprintf("%s: %q → %q", f, excerpt(before[f]), excerpt(after[f])))
	}
	return strings.Join(parts, "; ")
}

// excerpt truncates by RUNE so a multibyte value can't blow the budget, and
// marks the cut so nobody reads a truncated title as the whole title.
func excerpt(s string) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= auditExcerpt {
		return s
	}
	return string(r[:auditExcerpt]) + "…"
}

// carryContentAudit produces the payload to actually store: the incoming
// payload, with `audit` replaced by the SERVER's copy — the prior entries read
// off the stored row, plus `entry` when this write is auditable.
//
// The replacement is the security property, not a convenience. `audit` is a
// payload key like any other, so a caller could send its own; taking the prior
// list from `stored` and ignoring the incoming one means an agent can neither
// invent an approval-looking history nor drop the entry that records its own
// edit. It also survives the web editor, which sends a fresh TaskDraft with no
// audit key at all — without this, every human edit would wipe the log.
func carryContentAudit(incoming, stored json.RawMessage, entry *ContentAudit) (json.RawMessage, error) {
	p := map[string]any{}
	if len(incoming) > 0 {
		if err := json.Unmarshal(incoming, &p); err != nil {
			// Not an object — nothing to attach an audit to. Store as-is and let
			// the (already-run) type-specific validation own the shape question.
			return incoming, nil
		}
	}
	history := storedAudit(stored)
	if entry != nil {
		history = append(history, *entry)
	}
	if len(history) > MaxContentAudit {
		history = history[len(history)-MaxContentAudit:]
	}
	if len(history) == 0 {
		// Never introduce an empty array: most payloads have no edit history and
		// shouldn't grow a key for it.
		delete(p, "audit")
	} else {
		p["audit"] = history
	}
	return json.Marshal(p)
}

// storedAudit reads the existing (trusted) audit entries off a stored payload.
// Anything unparsable is treated as no history — a corrupt log must not block
// the write that would append to it.
func storedAudit(stored json.RawMessage) []ContentAudit {
	var p struct {
		Audit []ContentAudit `json:"audit"`
	}
	if len(stored) == 0 || json.Unmarshal(stored, &p) != nil {
		return nil
	}
	return p.Audit
}

// ContentUpdate reports what a payload write did at the gate. Changed is empty
// for an ordinary bookkeeping write (progress/links/assignee), which is the
// common case and involves the gate not at all.
type ContentUpdate struct {
	// Action is the fresh row, present only on the revert path (the conditional
	// UPDATE returns it); nil otherwise — the caller re-reads if it needs it.
	Action  *Action
	Version int
	// Changed is the ContentDiff result: which content fields moved.
	Changed []string
	// Reverted is true when this edit cost the action its approval.
	Reverted bool
	// FromState is the state the action was in when the edit arrived.
	FromState string
}

// DecideContentUpdate is the gate itself, as a PURE function of the stored
// action and the incoming payload: it returns the payload to store (with the
// server-owned audit trail attached) and what the write must do, or
// ErrContentLocked when the edit is refused.
//
// It is a separate function from the store write for two reasons. The rule is
// the security property and deserves to be readable in one place, free of
// PostgREST. And a test double — the fake stores the handler tests run against
// — can call exactly this, so those tests exercise the REAL rule instead of a
// second, drifting copy of it. A gate that only holds in production is a gate
// nobody can prove.
//
// The caller owns the write, and must honour out.Reverted by also resetting
// state to 'proposed' and clearing claimed_by / claimed_at / approved_by.
func DecideContentUpdate(current *Action, incoming json.RawMessage, actor string, at time.Time) (json.RawMessage, *ContentUpdate, error) {
	changed := ContentDiff(current.Payload, incoming)

	// Bookkeeping write (progress[], links[], assignee, linkedIds …): no gate,
	// no audit entry, allowed in every state. This is the hot path.
	if len(changed) == 0 {
		next, err := carryContentAudit(incoming, current.Payload, nil)
		if err != nil {
			return nil, nil, err
		}
		return next, &ContentUpdate{FromState: current.State}, nil
	}

	// Terminal: history is not rewritten.
	if current.State == "done" || current.State == "failed" {
		return nil, nil, fmt.Errorf("%w: cannot edit the %s of a %s task — a finished task is history",
			ErrContentLocked, strings.Join(changed, " and "), current.State)
	}

	// Approved or executing: the edit costs the approval and re-enters the gate.
	to := current.State
	if current.State == "approved" || current.State == "executing" {
		to = "proposed"
	}
	entry := NewContentAudit(actor, changed, current.Payload, incoming, current.State, to, at)
	next, err := carryContentAudit(incoming, current.Payload, &entry)
	if err != nil {
		return nil, nil, err
	}
	return next, &ContentUpdate{
		Changed:   changed,
		Reverted:  to != current.State,
		FromState: current.State,
	}, nil
}
