package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// The reviewer's "no" (TDM-154). These tests hold four lines:
//
//  1. a bounce is decided from SERVER-side provenance — the reviewer identity is
//     never read off the body, exactly as for peer approval;
//  2. the reviewer may not be the agent that FINISHED the work, and an
//     unattributable worker fails CLOSED;
//  3. the reason is required and survives verbatim (an 80-rune audit excerpt is
//     not a usable instruction);
//  4. a canvas that is not on 'peer' does not grow an agent-movable board — the
//     endpoint refuses there, and the human's own reopen is what remains.

// ── The pure rule ────────────────────────────────────────────────────────────

func doneTask(claimedBy *string) *store.Action {
	return &store.Action{ID: uuid.New(), Type: "task", State: "done", ClaimedBy: claimedBy}
}

func TestPeerReworkRefusal(t *testing.T) {
	worker := "worker-a"

	tests := []struct {
		name     string
		reviewer string
		target   *store.Action
		wantCode string // "" = allowed
	}{
		{"a different agent bounces the work", "agent:reviewer-b", doneTask(strPtr(worker)), ""},
		{"the worker bounces its own work", "agent:worker-a", doneTask(strPtr(worker)), "rework_self_review"},
		// claimed_by may already carry the prefix depending on the surface that
		// stamped it; the comparison is on the NAME either way.
		{"prefixed claimant is still self", "agent:worker-a", doneTask(strPtr("agent:worker-a")), "rework_self_review"},
		{"anonymous cannot review", AuthorAnonymous, doneTask(strPtr(worker)), "rework_identity_required"},
		{"empty author cannot review", "", doneTask(strPtr(worker)), "rework_identity_required"},
		// A human never reaches this function (callerIsHuman short-circuits), but
		// the rule must still be agent-only on its own terms.
		{"human string is not an agent identity", AuthorHuman, doneTask(strPtr(worker)), "rework_identity_required"},
		{"epics are not work", "agent:reviewer-b",
			&store.Action{ID: uuid.New(), Type: "epic", State: "done", ClaimedBy: strPtr(worker)}, "rework_task_only"},
		{"no claimant at all fails closed", "agent:reviewer-b", doneTask(nil), "rework_completer_unknown"},
		{"empty claimant fails closed", "agent:reviewer-b", doneTask(strPtr("  ")), "rework_completer_unknown"},
		// "agent" is the generic fallback the claim path writes when no name was
		// asserted. It names nobody, so non-self is unprovable.
		{"generic agent claimant fails closed", "agent:reviewer-b", doneTask(strPtr("agent")), "rework_completer_unknown"},
		// A human finished it: the identities differ, and bouncing a human's
		// finished work on a canvas the owner put on 'peer' is the opted-in case.
		{"agent bounces a human's finished task", "agent:reviewer-b", doneTask(strPtr(humanClaimant)), ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := peerReworkRefusal(tc.reviewer, tc.target)
			switch {
			case tc.wantCode == "" && got != nil:
				t.Fatalf("refused with %q (%s), want allowed", got.code, got.message)
			case tc.wantCode != "" && got == nil:
				t.Fatalf("allowed, want refusal %q", tc.wantCode)
			case tc.wantCode != "" && got.code != tc.wantCode:
				t.Fatalf("refusal code = %q, want %q", got.code, tc.wantCode)
			}
		})
	}
}

func TestSameAgentIdentity(t *testing.T) {
	for _, tc := range []struct {
		author, claimant string
		want             bool
	}{
		{"agent:a", "a", true},
		{"agent:a", "agent:a", true},
		{"agent:a", "b", false},
		{"agent:a", "human", false},
		// An empty name matches nothing — otherwise a stripped-to-nothing author
		// would "equal" a stripped-to-nothing claimant and read as self-review on
		// two identities that are both unknown.
		{"agent:", "", false},
		{"", "", false},
	} {
		if got := sameAgentIdentity(tc.author, tc.claimant); got != tc.want {
			t.Fatalf("sameAgentIdentity(%q, %q) = %v, want %v", tc.author, tc.claimant, got, tc.want)
		}
	}
}

// ── Handler level ────────────────────────────────────────────────────────────

// reworkFakeStore adds the rewind + audit writes to the peer fake. ReopenAction
// mirrors the real store's contract: predicated on `from`, clearing the claim
// and the result of the life being undone.
type reworkFakeStore struct {
	*peerFakeStore

	mu       sync.Mutex
	reopens  int
	audits   []store.ContentAudit
	reopenTo string
}

func (f *reworkFakeStore) ReopenAction(_ context.Context, _ uuid.UUID, id uuid.UUID, from, to string) (*store.Action, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, 0, store.ErrActionNotFound
	}
	if a.State != from {
		return nil, 0, fmt.Errorf("%w: cannot move task from %q to %q (it is %q now)",
			store.ErrIllegalActionState, from, to, a.State)
	}
	f.reopens++
	f.reopenTo = to
	a.State = to
	a.ClaimedBy = nil
	a.ClaimedAt = nil
	a.Result = nil
	a.Error = nil
	return a, 1, nil
}

func (f *reworkFakeStore) AppendActionAudit(_ context.Context, _ uuid.UUID, id uuid.UUID, entry store.ContentAudit) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.audits = append(f.audits, entry)
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ErrActionNotFound
	}
	next, err := store.AppendAudit(a.Payload, entry)
	if err != nil {
		return nil, err
	}
	a.Payload = next
	return next, nil
}

func (f *reworkFakeStore) lastAudit(t *testing.T) store.ContentAudit {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.audits) == 0 {
		t.Fatalf("no audit entry recorded — the bounce left no trail")
	}
	return f.audits[len(f.audits)-1]
}

func (f *reworkFakeStore) reopenCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reopens
}

// reworkStore builds a canvas on `policy` holding one finished task claimed by
// `completedBy`, with `agentNames` registered on it.
func reworkStore(policy, completedBy string, agentNames ...string) (*reworkFakeStore, uuid.UUID) {
	taskID := uuid.New()
	result := "shipped in abc1234"
	actions := map[uuid.UUID]*store.Action{
		taskID: {
			ID: taskID, Type: "task", State: "done",
			ClaimedBy: strPtr(completedBy), Result: &result,
			Payload:    json.RawMessage(`{"title":"the reviewed task"}`),
			AuthoredBy: agentAuthor("worker-a"),
		},
	}
	return &reworkFakeStore{peerFakeStore: peerStore(policy, actions, agentNames...)}, taskID
}

func reworkRequest(t *testing.T, canvasID, id uuid.UUID, body map[string]any) *http.Request {
	t.Helper()
	if body == nil {
		body = map[string]any{}
	}
	return canvasRequest(t, "POST", "/api/canvas/actions/"+id.String()+"/rework", body, canvasID, id.String())
}

// THE ACCEPTANCE CASE: on 'peer', reviewer B sends worker A's finished task back
// with a reason. It lands in the ready queue, the claim and the stale result are
// gone, and the trail names the REVIEWER and carries the reason verbatim.
func TestReworkCrossAgentSucceeds(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := reworkStore(policyPeer, "worker-a", "worker-a", "reviewer-b")
	h := NewHandler(fake, nil, nil)

	reason := "the migration is missing and the guard fails open on an unreadable policy — " +
		"redo it with the fail-closed branch and a test that proves it, then re-submit"
	w := httptest.NewRecorder()
	h.ReworkAction(w, withAgentAuthor(reworkRequest(t, canvasID, taskID,
		map[string]any{"reason": reason}), "agent:reviewer-b"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}

	got := fake.actions[taskID]
	if got.State != "approved" {
		t.Fatalf("state = %q, want approved (back in the ready queue)", got.State)
	}
	if got.ClaimedBy != nil {
		t.Fatalf("claimedBy = %q, want cleared — the author must be able to re-claim it", *got.ClaimedBy)
	}
	if got.Result != nil {
		t.Fatalf("result = %q, want cleared — a bounced task must not advertise the outcome being undone", *got.Result)
	}
	if n := fake.reopenCount(); n != 1 {
		t.Fatalf("ReopenAction called %d times, want 1", n)
	}

	entry := fake.lastAudit(t)
	if entry.Actor != "agent:reviewer-b" {
		t.Fatalf("audit actor = %q, want agent:reviewer-b (the server-derived reviewer)", entry.Actor)
	}
	if entry.FromState != "done" || entry.ToState != "approved" {
		t.Fatalf("audit states = %q → %q, want done → approved", entry.FromState, entry.ToState)
	}
	// THE POINT OF THE FEATURE: the author has to be able to read what to fix.
	// Summary excerpts at 80 runes, so the verbatim note is the durable copy.
	if entry.Note != reason {
		t.Fatalf("audit note = %q, want the reason verbatim", entry.Note)
	}
	if len(reason) <= len(entry.Summary) {
		t.Fatalf("this test no longer proves anything: the reason (%d) must be longer than the excerpted summary (%d)",
			len(reason), len(entry.Summary))
	}
}

// Self-review is refused, nothing moves, and the refusal says why.
func TestReworkSelfReviewRefused(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := reworkStore(policyPeer, "worker-a", "worker-a", "reviewer-b")
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ReworkAction(w, withAgentAuthor(reworkRequest(t, canvasID, taskID,
		map[string]any{"reason": "on reflection I should redo this"}), "agent:worker-a"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
	}
	if code := errorCode(t, w); code != "rework_self_review" {
		t.Fatalf("error code = %q, want rework_self_review", code)
	}
	if fake.actions[taskID].State != "done" {
		t.Fatalf("state = %q, want done — the refusal must not have written", fake.actions[taskID].State)
	}
	if n := fake.reopenCount(); n != 0 {
		t.Fatalf("ReopenAction called %d times, want 0", n)
	}
}

// THE FORGERY TEST: the body cannot launder an identity. A request that says
// every flattering thing about itself is still judged on its server-derived
// author, which here is the worker — so it is refused as self-review.
func TestReworkIgnoresRequestBodyIdentity(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := reworkStore(policyPeer, "worker-a", "worker-a", "reviewer-b")
	h := NewHandler(fake, nil, nil)

	body := map[string]any{
		"reason": "needs another pass",
		// None of these exist as fields, and that is the property under test.
		"reviewer": "agent:reviewer-b", "reviewedBy": "agent:reviewer-b",
		"agentName": "reviewer-b", "claimedBy": "someone-else", "actor": "human",
	}
	w := httptest.NewRecorder()
	h.ReworkAction(w, withAgentAuthor(reworkRequest(t, canvasID, taskID, body), "agent:worker-a"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 — the body must not buy a bounce (body %s)", w.Code, w.Body.String())
	}
	if code := errorCode(t, w); code != "rework_self_review" {
		t.Fatalf("error code = %q, want rework_self_review", code)
	}
	if fake.actions[taskID].State != "done" {
		t.Fatalf("state = %q, want done", fake.actions[taskID].State)
	}
}

// The reason is REQUIRED: a bounce with no instruction is a task the author has
// to reverse-engineer.
func TestReworkReasonRequired(t *testing.T) {
	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{"absent", map[string]any{}},
		{"empty", map[string]any{"reason": ""}},
		{"whitespace only", map[string]any{"reason": "   \n\t "}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			canvasID := uuid.New()
			fake, taskID := reworkStore(policyPeer, "worker-a", "worker-a", "reviewer-b")
			h := NewHandler(fake, nil, nil)

			w := httptest.NewRecorder()
			h.ReworkAction(w, withAgentAuthor(reworkRequest(t, canvasID, taskID, tc.body), "agent:reviewer-b"))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", w.Code, w.Body.String())
			}
			if code := errorCode(t, w); code != "rework_reason_required" {
				t.Fatalf("error code = %q, want rework_reason_required", code)
			}
			if fake.actions[taskID].State != "done" {
				t.Fatalf("state = %q, want done — an empty reason must not bounce anything", fake.actions[taskID].State)
			}
		})
	}
}

// Every policy but 'peer' keeps this move human-only, and the refusal points at
// the door that still works.
func TestReworkRefusedOffPeerPolicy(t *testing.T) {
	for _, policy := range []string{"strict", "epic", "auto", ""} {
		t.Run("policy="+policy, func(t *testing.T) {
			canvasID := uuid.New()
			fake, taskID := reworkStore(policy, "worker-a", "worker-a", "reviewer-b")
			h := NewHandler(fake, nil, nil)

			w := httptest.NewRecorder()
			h.ReworkAction(w, withAgentAuthor(reworkRequest(t, canvasID, taskID,
				map[string]any{"reason": "needs another pass"}), "agent:reviewer-b"))
			if w.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
			}
			if code := errorCode(t, w); code != "rework_policy_required" {
				t.Fatalf("error code = %q, want rework_policy_required", code)
			}
			if fake.actions[taskID].State != "done" {
				t.Fatalf("state = %q, want done", fake.actions[taskID].State)
			}
			if !strings.Contains(w.Body.String(), "move") {
				t.Fatalf("the refusal should point at the human's own reopen; got %s", w.Body.String())
			}
		})
	}
}

// An unattributable worker fails CLOSED — "we couldn't tell who finished it" is
// never "anyone may bounce it".
func TestReworkUnknownCompleterFailsClosed(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := reworkStore(policyPeer, "", "worker-a", "reviewer-b")
	fake.actions[taskID].ClaimedBy = nil
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ReworkAction(w, withAgentAuthor(reworkRequest(t, canvasID, taskID,
		map[string]any{"reason": "needs another pass"}), "agent:reviewer-b"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
	}
	if code := errorCode(t, w); code != "rework_completer_unknown" {
		t.Fatalf("error code = %q, want rework_completer_unknown", code)
	}
	if fake.actions[taskID].State != "done" {
		t.Fatalf("state = %q, want done", fake.actions[taskID].State)
	}
}

// The reviewer must be an agent registered on THIS canvas: a bounce is
// attributable to a row on the fleet view or it does not happen.
func TestReworkUnregisteredReviewerRefused(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := reworkStore(policyPeer, "worker-a", "worker-a")
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ReworkAction(w, withAgentAuthor(reworkRequest(t, canvasID, taskID,
		map[string]any{"reason": "needs another pass"}), "agent:drive-by"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
	}
	if code := errorCode(t, w); code != "rework_agent_unregistered" {
		t.Fatalf("error code = %q, want rework_agent_unregistered", code)
	}
}

// Only FINISHED work can be bounced. Every other state answers with what the
// task actually is, rather than a 200 and a second audit entry.
func TestReworkOnlyFinishedWork(t *testing.T) {
	for _, state := range []string{"proposed", "approved", "executing", "failed", "rejected"} {
		t.Run(state, func(t *testing.T) {
			canvasID := uuid.New()
			fake, taskID := reworkStore(policyPeer, "worker-a", "worker-a", "reviewer-b")
			fake.actions[taskID].State = state
			h := NewHandler(fake, nil, nil)

			w := httptest.NewRecorder()
			h.ReworkAction(w, withAgentAuthor(reworkRequest(t, canvasID, taskID,
				map[string]any{"reason": "needs another pass"}), "agent:reviewer-b"))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", w.Code, w.Body.String())
			}
			if code := errorCode(t, w); code != "rework_not_finished" {
				t.Fatalf("error code = %q, want rework_not_finished", code)
			}
			if n := fake.reopenCount(); n != 0 {
				t.Fatalf("ReopenAction called %d times, want 0", n)
			}
		})
	}
}

// A signed-in human is not gated by the peer rule — they can already make this
// move from the board — but the reason is still required, because the author's
// need for one does not depend on who pressed the button.
func TestReworkHumanBypassesPeerRuleButNotTheReason(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := reworkStore("strict", "worker-a", "worker-a")
	h := NewHandler(fake, nil, nil)

	// canvasRequest stamps a human author by default.
	w := httptest.NewRecorder()
	h.ReworkAction(w, reworkRequest(t, canvasID, taskID, map[string]any{"reason": "not what I asked for"}))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	if fake.actions[taskID].State != "approved" {
		t.Fatalf("state = %q, want approved", fake.actions[taskID].State)
	}
	if entry := fake.lastAudit(t); entry.Actor != AuthorHuman {
		t.Fatalf("audit actor = %q, want %q", entry.Actor, AuthorHuman)
	}

	// …and with no reason, even a human gets the 400.
	fake2, taskID2 := reworkStore("strict", "worker-a", "worker-a")
	h2 := NewHandler(fake2, nil, nil)
	w2 := httptest.NewRecorder()
	h2.ReworkAction(w2, reworkRequest(t, canvasID, taskID2, map[string]any{}))
	if w2.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", w2.Code, w2.Body.String())
	}
}

// The human board's move matrix is UNCHANGED by this feature: moveRework is a
// second caller for the done → approved rewind, not a new row in the table.
func TestReworkDoesNotWidenTheHumanMatrix(t *testing.T) {
	moves := humanMoveTargets["done"]
	if len(moves) != 1 || moves[0] != moveReopen {
		t.Fatalf("humanMoveTargets[done] = %+v, want exactly {moveReopen}", moves)
	}
	if moveRework.from != "done" || moveRework.to != "approved" {
		t.Fatalf("moveRework = %+v, want done → approved", moveRework)
	}
	if moveRework.verb != activityReworked {
		t.Fatalf("moveRework.verb = %q, want %q — the bounce must be distinguishable from a human requeue",
			moveRework.verb, activityReworked)
	}
}
