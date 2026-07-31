package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// Peer approval (TDM-145). The tests below exist to hold three lines that are
// easy to erode:
//   1. a peer approval is decided from SERVER-side provenance, so no request
//      body can buy one (the forgery vector TDM-40/TDM-129 closed);
//   2. self-approval is refused;
//   3. a canvas on strict|epic|auto behaves EXACTLY as before — same status,
//      same refusal text, same cascade.

// ── The pure rule ────────────────────────────────────────────────────────────

func agentAuthor(name string) *string { s := "agent:" + name; return &s }

func TestPeerApprovalRefusal(t *testing.T) {
	proposer := "agent:proposer-1"
	task := func(authoredBy *string) *store.Action {
		return &store.Action{ID: uuid.New(), Type: "task", State: "proposed", AuthoredBy: authoredBy}
	}
	human := AuthorHuman

	tests := []struct {
		name     string
		approver string
		target   *store.Action
		wantCode string // "" = allowed
	}{
		{"a different agent approves", "agent:reviewer-9", task(&proposer), ""},
		{"the proposer approves itself", proposer, task(&proposer), "peer_self_approval"},
		{"anonymous cannot approve", AuthorAnonymous, task(&proposer), "peer_identity_required"},
		{"empty author cannot approve", "", task(&proposer), "peer_identity_required"},
		// A "human" author never reaches this function (callerIsHuman short-circuits
		// first), but the rule must still be agent-only on its own terms: it is the
		// peer door, not a second human door.
		{"human string is not an agent identity", human, task(&proposer), "peer_identity_required"},
		{"epics stay human-only", "agent:reviewer-9",
			&store.Action{ID: uuid.New(), Type: "epic", State: "proposed", AuthoredBy: &proposer}, "peer_epic_human_only"},
		{"unknown proposer fails closed", "agent:reviewer-9", task(nil), "peer_proposer_unknown"},
		// Same NAME asserted twice is the same identity — the rule compares the
		// server-derived strings, so "agent:x" approving "agent:x" is self-approval
		// however many sessions are behind it.
		{"same identity from another session is still self", "agent:proposer-1", task(&proposer), "peer_self_approval"},
		// A human-proposed task may be approved by an agent under 'peer': the
		// identities differ, and the owner opted in.
		{"agent approves a human's proposal", "agent:reviewer-9", task(&human), ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := peerApprovalRefusal(tc.approver, tc.target)
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

// The epic cascade is a property of the permissive policies only: 'strict' and
// 'peer' both keep a per-task gate, so approving an epic must not mass-approve.
func TestPolicyCascadesToEpicTasks(t *testing.T) {
	for policy, want := range map[string]bool{
		"epic": true, "auto": true, "": true, // legacy empty behaves as 'epic'
		"strict": false, "peer": false,
	} {
		if got := policyCascadesToEpicTasks(policy); got != want {
			t.Fatalf("policyCascadesToEpicTasks(%q) = %v, want %v", policy, got, want)
		}
	}
}

// 'peer' never births an approved task: it changes WHO may approve, not whether
// approval is needed. (The legacy modes are covered in approval_policy_test.go.)
func TestPolicyApprovalPeerNeverBornApproved(t *testing.T) {
	approvedEpic := uuid.New()
	epicApproved := func(id uuid.UUID) bool { return id == approvedEpic }
	for _, payload := range []string{
		`{"title":"t"}`,
		`{"title":"t","epicId":"` + approvedEpic.String() + `"}`,
	} {
		if got := policyApproval(policyPeer, json.RawMessage(payload), epicApproved); got != "" {
			t.Fatalf("policyApproval(peer, %s) = %q, want \"\" (lands proposed)", payload, got)
		}
	}
}

// ── Handler level ────────────────────────────────────────────────────────────

// peerFakeStore adds the agent roster to the policy fake — peer approval needs
// to resolve the approver against the canvas's registered agents.
type peerFakeStore struct {
	*policyFakeStore
	agents    []*store.Agent
	agentsErr error
}

func (f *peerFakeStore) ListAgents(_ context.Context, _ uuid.UUID) ([]*store.Agent, error) {
	if f.agentsErr != nil {
		return nil, f.agentsErr
	}
	return f.agents, nil
}

// peerStore builds a canvas on `policy` holding `actions`, with `agentNames`
// registered on it.
func peerStore(policy string, actions map[uuid.UUID]*store.Action, agentNames ...string) *peerFakeStore {
	roster := make([]*store.Agent, 0, len(agentNames))
	for _, n := range agentNames {
		roster = append(roster, &store.Agent{ID: uuid.New(), Kind: "agent", Name: n, Role: "executor"})
	}
	return &peerFakeStore{
		policyFakeStore: &policyFakeStore{policy: policy, actions: actions},
		agents:          roster,
	}
}

// withAgentAuthor re-stamps a canvasRequest's server-derived author. This is the ONLY
// way a test (or a caller) can present an agent identity — there is deliberately
// no body field for it, which is the property the peer path must preserve.
func withAgentAuthor(r *http.Request, author string) *http.Request {
	return r.WithContext(WithAuthor(r.Context(), author))
}

func approveRequest(t *testing.T, canvasID, id uuid.UUID, body map[string]any) *http.Request {
	t.Helper()
	if body == nil {
		body = map[string]any{}
	}
	return canvasRequest(t, "POST", "/api/canvas/actions/"+id.String()+"/approve", body, canvasID, id.String())
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal error body %q: %v", w.Body.String(), err)
	}
	s, _ := resp["error"].(string)
	return s
}

// THE ACCEPTANCE CASE: under 'peer', agent B approves agent A's proposed task,
// it enters the ready queue, and the stamp names the APPROVING agent.
func TestPeerApprovalCrossAgentSucceeds(t *testing.T) {
	canvasID, taskID := uuid.New(), uuid.New()
	fake := peerStore(policyPeer, map[uuid.UUID]*store.Action{
		taskID: {ID: taskID, Type: "task", State: "proposed", AuthoredBy: agentAuthor("proposer-a")},
	}, "proposer-a", "reviewer-b")
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, taskID, nil), "agent:reviewer-b"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	got := fake.actions[taskID]
	if got.State != "approved" {
		t.Fatalf("state = %q, want approved", got.State)
	}
	// Distinguishable from a human approval by the server-stamped "agent:" prefix,
	// from the stored record alone — that is the whole provenance requirement.
	if got.ApprovedBy == nil || *got.ApprovedBy != "agent:reviewer-b" {
		t.Fatalf("approvedBy = %v, want agent:reviewer-b", got.ApprovedBy)
	}
	if got.ApprovedBy != nil && !authorIsAgent(*got.ApprovedBy) {
		t.Fatalf("approvedBy %q must be readable as an agent approval", *got.ApprovedBy)
	}
}

// Self-approval is refused, and the refusal names why.
func TestPeerApprovalSelfRefused(t *testing.T) {
	canvasID, taskID := uuid.New(), uuid.New()
	fake := peerStore(policyPeer, map[uuid.UUID]*store.Action{
		taskID: {ID: taskID, Type: "task", State: "proposed", AuthoredBy: agentAuthor("proposer-a")},
	}, "proposer-a", "reviewer-b")
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, taskID, nil), "agent:proposer-a"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
	}
	if code := errorCode(t, w); code != "peer_self_approval" {
		t.Fatalf("error code = %q, want peer_self_approval", code)
	}
	if fake.actions[taskID].State != "proposed" {
		t.Fatalf("state = %q, want proposed (the refusal must not have written)", fake.actions[taskID].State)
	}
}

// THE FORGERY TEST: the body cannot buy an approval or launder an identity. A
// request that says every flattering thing about itself — proposedBy/approvedBy/
// authoredBy/agentName "human" — is still judged on its server-derived author,
// which here is the proposer, so it is refused as self-approval.
func TestPeerApprovalIgnoresRequestBodyIdentity(t *testing.T) {
	canvasID, taskID := uuid.New(), uuid.New()
	fake := peerStore(policyPeer, map[uuid.UUID]*store.Action{
		taskID: {ID: taskID, Type: "task", State: "proposed", AuthoredBy: agentAuthor("proposer-a")},
	}, "proposer-a", "reviewer-b")
	h := NewHandler(fake, nil, nil)

	body := map[string]any{
		"approvedBy": "human", "authoredBy": "human", "proposedBy": "agent:reviewer-b",
		"agentName": "reviewer-b", "approver": "agent:reviewer-b",
	}
	w := httptest.NewRecorder()
	h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, taskID, body), "agent:proposer-a"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 — the body must not buy an approval (body %s)", w.Code, w.Body.String())
	}
	if code := errorCode(t, w); code != "peer_self_approval" {
		t.Fatalf("error code = %q, want peer_self_approval", code)
	}
	if fake.actions[taskID].ApprovedBy != nil {
		t.Fatalf("approvedBy = %v, want nil", *fake.actions[taskID].ApprovedBy)
	}
}

// The approver must be an agent registered on THIS canvas, and an unattributable
// (anonymous) caller is refused outright.
func TestPeerApprovalIdentityRequirements(t *testing.T) {
	proposer := agentAuthor("proposer-a")
	tests := []struct {
		name     string
		author   string
		roster   []string
		wantCode string
	}{
		{"unregistered agent", "agent:drive-by", []string{"proposer-a", "reviewer-b"}, "peer_agent_unregistered"},
		{"anonymous canvas token", AuthorAnonymous, []string{"proposer-a", "reviewer-b"}, "peer_identity_required"},
		{"registered reviewer", "agent:reviewer-b", []string{"proposer-a", "reviewer-b"}, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			canvasID, taskID := uuid.New(), uuid.New()
			fake := peerStore(policyPeer, map[uuid.UUID]*store.Action{
				taskID: {ID: taskID, Type: "task", State: "proposed", AuthoredBy: proposer},
			}, tc.roster...)
			h := NewHandler(fake, nil, nil)
			w := httptest.NewRecorder()
			h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, taskID, nil), tc.author))
			if tc.wantCode == "" {
				if w.Code != http.StatusOK {
					t.Fatalf("status = %d, want 200 (body %s)", w.Code, w.Body.String())
				}
				return
			}
			if w.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
			}
			if code := errorCode(t, w); code != tc.wantCode {
				t.Fatalf("error code = %q, want %q", code, tc.wantCode)
			}
			if fake.actions[taskID].State != "proposed" {
				t.Fatalf("state = %q, want proposed", fake.actions[taskID].State)
			}
		})
	}
}

// An unreadable roster fails CLOSED: "we couldn't check" is never "allowed".
func TestPeerApprovalRosterErrorFailsClosed(t *testing.T) {
	canvasID, taskID := uuid.New(), uuid.New()
	fake := peerStore(policyPeer, map[uuid.UUID]*store.Action{
		taskID: {ID: taskID, Type: "task", State: "proposed", AuthoredBy: agentAuthor("proposer-a")},
	}, "reviewer-b")
	fake.agentsErr = fmt.Errorf("supabase down")
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, taskID, nil), "agent:reviewer-b"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
	if fake.actions[taskID].State != "proposed" {
		t.Fatalf("state = %q, want proposed", fake.actions[taskID].State)
	}
}

// A task with no recorded proposer cannot be peer-approved — non-self is
// unprovable, so the human gate stands.
func TestPeerApprovalUnknownProposerRefused(t *testing.T) {
	canvasID, taskID := uuid.New(), uuid.New()
	fake := peerStore(policyPeer, map[uuid.UUID]*store.Action{
		taskID: {ID: taskID, Type: "task", State: "proposed"}, // legacy row, AuthoredBy nil
	}, "reviewer-b")
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, taskID, nil), "agent:reviewer-b"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
	}
	if code := errorCode(t, w); code != "peer_proposer_unknown" {
		t.Fatalf("error code = %q, want peer_proposer_unknown", code)
	}
}

// Epics stay human-only under 'peer', and the refusal happens BEFORE any write —
// so the cascade that would have approved every task under the epic never runs.
func TestPeerApprovalEpicRefusedAndDoesNotCascade(t *testing.T) {
	canvasID, epicID := uuid.New(), uuid.New()
	fake := peerStore(policyPeer, map[uuid.UUID]*store.Action{
		epicID: {ID: epicID, Type: "epic", State: "proposed", AuthoredBy: agentAuthor("proposer-a")},
	}, "proposer-a", "reviewer-b")
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, epicID, nil), "agent:reviewer-b"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
	}
	if code := errorCode(t, w); code != "peer_epic_human_only" {
		t.Fatalf("error code = %q, want peer_epic_human_only", code)
	}
	if fake.actions[epicID].State != "proposed" {
		t.Fatalf("epic state = %q, want proposed", fake.actions[epicID].State)
	}
	settleEpicCalls(t, fake.policyFakeStore, 0)
}

// A human approving on a 'peer' canvas is untouched: still allowed, still
// stamped "human".
func TestPeerCanvasHumanApprovalUnchanged(t *testing.T) {
	canvasID, taskID := uuid.New(), uuid.New()
	fake := peerStore(policyPeer, map[uuid.UUID]*store.Action{
		taskID: {ID: taskID, Type: "task", State: "proposed", AuthoredBy: agentAuthor("proposer-a")},
	}, "proposer-a")
	h := NewHandler(fake, nil, nil)

	// canvasRequest stamps a human author, as the board does.
	w := httptest.NewRecorder()
	h.ApproveAction(w, approveRequest(t, canvasID, taskID, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	got := fake.actions[taskID]
	if got.State != "approved" {
		t.Fatalf("state = %q, want approved", got.State)
	}
	if got.ApprovedBy == nil || *got.ApprovedBy != AuthorHuman {
		t.Fatalf("approvedBy = %v, want %q", got.ApprovedBy, AuthorHuman)
	}
}

// Under 'peer' a human approving an EPIC does not cascade either: every task
// keeps the gate a reviewer (or the human) has to open. Same rule as 'strict'.
func TestPeerCanvasEpicApprovalDoesNotCascade(t *testing.T) {
	canvasID, epicID := uuid.New(), uuid.New()
	fake := peerStore(policyPeer, map[uuid.UUID]*store.Action{
		epicID: {ID: epicID, Type: "epic", State: "proposed"},
	}, "reviewer-b")
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ApproveAction(w, approveRequest(t, canvasID, epicID, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	settleEpicCalls(t, fake.policyFakeStore, 0)
}

// THE REGRESSION GUARD: on every legacy policy an agent approve is refused with
// the byte-identical pre-peer answer — plain {"error": "<prose>"}, 403, no code —
// so nothing about an existing board changed, not even what it says.
func TestLegacyPoliciesUnchangedByPeerApproval(t *testing.T) {
	for _, policy := range []string{"strict", "epic", "auto", ""} {
		t.Run("policy="+policy, func(t *testing.T) {
			canvasID, taskID := uuid.New(), uuid.New()
			fake := peerStore(policy, map[uuid.UUID]*store.Action{
				taskID: {ID: taskID, Type: "task", State: "proposed", AuthoredBy: agentAuthor("proposer-a")},
			}, "proposer-a", "reviewer-b")
			h := NewHandler(fake, nil, nil)

			// A registered, non-self agent — the case 'peer' would allow — is still
			// refused here, because the canvas never opted in.
			w := httptest.NewRecorder()
			h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, taskID, nil), "agent:reviewer-b"))
			if w.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
			}
			var resp map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("unmarshal %q: %v", w.Body.String(), err)
			}
			if resp["error"] != refusalApproveHumanOnly {
				t.Fatalf("error = %v, want the legacy text %q", resp["error"], refusalApproveHumanOnly)
			}
			if _, ok := resp["message"]; ok {
				t.Fatalf("legacy refusal grew a `message` field: %s", w.Body.String())
			}
			if fake.actions[taskID].State != "proposed" {
				t.Fatalf("state = %q, want proposed", fake.actions[taskID].State)
			}

			// …and a human still approves exactly as before.
			w = httptest.NewRecorder()
			h.ApproveAction(w, approveRequest(t, canvasID, taskID, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("human approve: status = %d, body %s", w.Code, w.Body.String())
			}
			if got := fake.actions[taskID].ApprovedBy; got == nil || *got != AuthorHuman {
				t.Fatalf("human approve stamped %v, want %q", got, AuthorHuman)
			}
		})
	}
}

// An unreadable canvas policy fails closed to the human gate.
func TestPeerApprovalUnreadablePolicyFailsClosed(t *testing.T) {
	canvasID, taskID := uuid.New(), uuid.New()
	fake := &peerCanvasErrStore{peerStore(policyPeer, map[uuid.UUID]*store.Action{
		taskID: {ID: taskID, Type: "task", State: "proposed", AuthoredBy: agentAuthor("proposer-a")},
	}, "reviewer-b")}
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, taskID, nil), "agent:reviewer-b"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
	if got := errorCode(t, w); got != refusalApproveHumanOnly {
		t.Fatalf("error = %q, want the legacy human-only refusal", got)
	}
	if fake.actions[taskID].State != "proposed" {
		t.Fatalf("state = %q, want proposed", fake.actions[taskID].State)
	}
}

type peerCanvasErrStore struct{ *peerFakeStore }

func (f *peerCanvasErrStore) GetCanvasByID(_ context.Context, _ uuid.UUID) (*store.Canvas, error) {
	return nil, fmt.Errorf("supabase down")
}

// 'peer' relaxes ONE door. These are the ones it must not touch: born-approved,
// reject, and bulk approve all stay human-only on a 'peer' canvas.
func TestPeerPolicyDoesNotRelaxTheOtherDoors(t *testing.T) {
	canvasID, taskID := uuid.New(), uuid.New()
	newFake := func() *peerFakeStore {
		return peerStore(policyPeer, map[uuid.UUID]*store.Action{
			taskID: {ID: taskID, Type: "task", State: "proposed", AuthoredBy: agentAuthor("proposer-a")},
		}, "proposer-a", "reviewer-b")
	}

	t.Run("born approved", func(t *testing.T) {
		fake := newFake()
		h := NewHandler(fake, nil, nil)
		w := httptest.NewRecorder()
		body := map[string]any{"type": "task", "state": "approved", "payload": map[string]any{"title": "self-served"}}
		h.ProposeAction(w, withAgentAuthor(canvasRequest(t, "POST", "/api/canvas/actions", body, canvasID, ""), "agent:reviewer-b"))
		if w.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
		}
	})

	t.Run("reject", func(t *testing.T) {
		fake := newFake()
		h := NewHandler(fake, nil, nil)
		w := httptest.NewRecorder()
		h.RejectAction(w, withAgentAuthor(canvasRequest(t, "POST", "/api/canvas/actions/"+taskID.String()+"/reject",
			map[string]any{"reason": "not mine to kill"}, canvasID, taskID.String()), "agent:reviewer-b"))
		if w.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
		}
		if fake.actions[taskID].State != "proposed" {
			t.Fatalf("state = %q, want proposed", fake.actions[taskID].State)
		}
	})

	t.Run("bulk approve", func(t *testing.T) {
		fake := newFake()
		h := NewHandler(fake, nil, nil)
		w := httptest.NewRecorder()
		h.ApproveActionsBatch(w, withAgentAuthor(canvasRequest(t, "POST", "/api/canvas/actions/approve-batch",
			map[string]any{"ids": []string{taskID.String()}}, canvasID, ""), "agent:reviewer-b"))
		if w.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
		}
		if fake.actions[taskID].State != "proposed" {
			t.Fatalf("state = %q, want proposed", fake.actions[taskID].State)
		}
	})
}

// Birth under 'peer': every agent task lands proposed, even under an APPROVED
// epic (which under the default 'epic' policy would have been born approved).
func TestProposeUnderPeerPolicyLandsProposed(t *testing.T) {
	canvasID, epicID := uuid.New(), uuid.New()
	fake := peerStore(policyPeer, map[uuid.UUID]*store.Action{
		epicID: {ID: epicID, Type: "epic", State: "approved"},
	}, "proposer-a")
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ProposeAction(w, withAgentAuthor(canvasRequest(t, "POST", "/api/canvas/actions",
		taskBody(map[string]any{"title": "t", "epicId": epicID.String()}), canvasID, ""), "agent:proposer-a"))
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	if len(fake.created) != 1 {
		t.Fatalf("created %d actions, want 1", len(fake.created))
	}
	if got := fake.created[0]; got.State != "proposed" || got.ApprovedBy != nil {
		t.Fatalf("state/approvedBy = %q/%v, want proposed/nil", got.State, got.ApprovedBy)
	}
}

// ── The owner-only setter ────────────────────────────────────────────────────

// policySetterFakeStore is the owner-lookup + write pair PATCH
// /api/canvases/{code}/approval-policy needs.
type policySetterFakeStore struct {
	store.Store
	owner uuid.UUID
	set   string
}

func (f *policySetterFakeStore) GetCanvasByCode(_ context.Context, _ string) (*store.Canvas, error) {
	return &store.Canvas{ID: uuid.New(), OwnerUserID: &f.owner, ApprovalPolicy: "epic"}, nil
}

func (f *policySetterFakeStore) SetCanvasApprovalPolicy(_ context.Context, _ uuid.UUID, policy string) (int, error) {
	f.set = policy
	return 1, nil
}

func (f *policySetterFakeStore) GetCanvasState(_ context.Context, _ uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in tests")
}

// 'peer' is settable (that opt-in is the ONLY way a canvas ever enters the mode)
// and near-misses are still rejected — a typo must not land a canvas in a policy
// the CHECK constraint would take but the server does not understand.
func TestSetCanvasApprovalPolicyAcceptsPeer(t *testing.T) {
	tests := []struct {
		policy   string
		wantCode int
	}{
		{"strict", http.StatusOK}, {"epic", http.StatusOK}, {"auto", http.StatusOK}, {"peer", http.StatusOK},
		{"", http.StatusBadRequest}, {"PEER", http.StatusBadRequest},
		{"peers", http.StatusBadRequest}, {"human", http.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run("policy="+tc.policy, func(t *testing.T) {
			owner := uuid.New()
			fake := &policySetterFakeStore{owner: owner}
			h := NewHandler(fake, nil, nil)
			r := canvasRequest(t, "PATCH", "/api/canvases/ABCD1234/approval-policy",
				map[string]any{"approvalPolicy": tc.policy}, uuid.New(), "")
			r = r.WithContext(context.WithValue(r.Context(), userIDKey, owner))
			w := httptest.NewRecorder()
			h.SetCanvasApprovalPolicy(w, r)
			if w.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d (body %s)", w.Code, tc.wantCode, w.Body.String())
			}
			if tc.wantCode == http.StatusOK && fake.set != tc.policy {
				t.Fatalf("stored policy = %q, want %q", fake.set, tc.policy)
			}
			if tc.wantCode != http.StatusOK && fake.set != "" {
				t.Fatalf("rejected policy %q was still written as %q", tc.policy, fake.set)
			}
		})
	}
}
