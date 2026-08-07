package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
)

// ResubmitAction is the AUTHOR's rewind: rejected → proposed, made by the agent
// that wrote the ticket (TDM-3). It is ReopenAction's shape with two additions
// that ReopenAction deliberately does not have, which is why it is its own
// method rather than a widened one:
//
//  1. IT WRITES THE PAYLOAD. A resubmit is an amend-and-retry — the whole point
//     is that the author answers the rejection by changing the ticket — and
//     ReopenAction touches no payload at all. Bending it into taking one would
//     give three existing human callers a payload argument they must always pass
//     nil for, on the one method whose narrowness is its safety property.
//  2. IT APPENDS THE AUDIT ENTRY IN THE SAME WRITE. Every other rewind records
//     its entry afterwards, best-effort, through AppendActionAudit — right for a
//     human whose card has already moved, wrong here: the entry is the only
//     surviving copy of the rejection reason this very write is about to clear
//     out of `error`, so a dropped entry would silently destroy the feedback the
//     next attempt is supposed to answer. Folding it into the UPDATE makes the
//     trail and the state move commit together or not at all.
//
// Everything else is ReopenAction's discipline, unchanged: ONE conditional
// UPDATE predicated on (state='rejected', type='task'), so a ticket a human
// revived or re-triaged under the request matches nothing and comes back as
// ErrIllegalActionState rather than a lost update.
//
// DELIBERATELY NOT IDEMPOTENT on 'proposed', unlike the human rewinds — the same
// call ReworkAction makes for the same reason. A ticket already back at the gate
// answers with its state, so an author re-sending a lost request learns what
// happened instead of quietly appending a second audit entry and a second copy
// of its note.
//
// `payload` is the FULL payload to store (the caller merges its patch onto the
// stored one and validates the result — see api.ResubmitAction); empty means
// "leave the content alone". Whatever it says about the server-owned keys —
// claim, contention, audit — is discarded and the stored row's copies carried
// instead, because it goes through carryContentAudit exactly like every other
// payload write. That is what stops a resubmit from being the one door through
// which an agent can author its own approval-looking history.
func (s *supabaseStore) ResubmitAction(ctx context.Context, canvasID, id uuid.UUID, payload json.RawMessage, entry ContentAudit) (*Action, int, error) {
	current, err := s.GetAction(ctx, canvasID, id)
	if err != nil {
		return nil, 0, ErrActionNotFound
	}
	if current.Type != "task" {
		return nil, 0, fmt.Errorf("%w: only tasks can be resubmitted (this is a %q)",
			ErrIllegalActionState, current.Type)
	}
	// The audit entry rides the same write, appended to the STORED history — the
	// caller's payload can neither invent prior entries nor drop this one.
	base := payload
	if len(base) == 0 {
		base = current.Payload
	}
	next, err := carryContentAudit(base, current.Payload, &entry)
	if err != nil {
		return nil, 0, err
	}
	var rows []dbAction
	_, err = s.client.From("actions").
		Update(map[string]any{
			"state":   "proposed",
			"payload": next,
			// Back INTO the gate: a ticket waiting on a human must not render
			// "approved by …", and the claim of the life it already lived is over.
			"approved_by": nil,
			"claimed_by":  nil,
			"claimed_at":  nil,
			// The rejection reason, now preserved in the audit entry above. A ticket
			// at the gate carrying the last verdict's error would read as rejected
			// twice over.
			"error": nil,
			// Same rule ReopenAction and RequeueAction apply: a ticket about to be
			// worked again must not advertise the outcome of a run that no longer
			// stands. (A rejected task rarely has one; a rejection that followed a
			// re-open does.)
			"result": nil,
		}, "representation", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()).
		Eq("state", "rejected").
		Eq("type", "task").
		ExecuteTo(&rows)
	if err != nil {
		return nil, 0, err
	}
	if len(rows) == 1 {
		v, verr := s.bumpVersion(ctx, canvasID)
		if verr != nil {
			return nil, 0, verr
		}
		return toAction(rows[0]), v, nil
	}
	// Nothing matched: the row moved between the read above and the write. Re-read
	// to say WHAT it is now rather than "no rows".
	existing, gerr := s.GetAction(ctx, canvasID, id)
	if gerr != nil {
		return nil, 0, ErrActionNotFound
	}
	return nil, 0, fmt.Errorf("%w: only a rejected task can be resubmitted (it is %q now)",
		ErrIllegalActionState, existing.State)
}
