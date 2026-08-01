package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// Cross-model review (TDM-155). The flag extends the peer non-self rule from "a
// different agent" to "a different model". These tests hold five lines:
//
//  1. same model ⇒ refused, on BOTH reviewer doors (approve and rework), with
//     distinct codes;
//  2. different model ⇒ allowed, unchanged;
//  3. an UNRECORDED model fails OPEN — the deliberate opposite of the
//     proposer/completer unknown checks, which fail closed. An optional field
//     nobody has filled in must not brick peer review on a live canvas;
//  4. flag OFF is a byte-for-byte no-op, which is what "default off" has to mean;
//  5. the refusal states the honesty rail — model is self-asserted — because the
//     refusal is the one place a reader is guaranteed to look.

// ── The comparison ───────────────────────────────────────────────────────────

func TestNormalizeModelID(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{
		{"claude-opus-5", "claude-opus-5"},
		{"  Claude-Opus-5  ", "claude-opus-5"},
		// A context-window variant is the same model. If "[1m]" read as a second
		// model, the check would be defeated by a suffix rather than by a second
		// architecture.
		{"claude-opus-5[1m]", "claude-opus-5"},
		{"anthropic/claude-opus-5", "claude-opus-5"},
		{"us.anthropic.claude-opus-5", "claude-opus-5"},
		{"openai/gpt-5-codex", "gpt-5-codex"},
		{"", ""},
		{"   ", ""},
	} {
		if got := normalizeModelID(tc.raw); got != tc.want {
			t.Fatalf("normalizeModelID(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

func TestModelsCollide(t *testing.T) {
	for _, tc := range []struct {
		a, b          string
		collide, know bool
	}{
		{"claude-opus-5", "claude-opus-5", true, true},
		{"claude-opus-5", "claude-opus-5[1m]", true, true},
		{"claude-opus-5", "anthropic/claude-opus-5", true, true},
		{"claude-opus-5", "gpt-5-codex", false, true},
		// Deliberately NOT family-aware: two different Anthropic models are two
		// models. Inferring architecture lineage from a free-text string would be a
		// guess wearing a uniform — see normalizeModelID.
		{"claude-opus-4-8", "claude-opus-5", false, true},
		// Unknown on either side ⇒ the check abstains. `collide` must be false AND
		// `known` false; a caller that reads only the first value still fails open.
		{"", "claude-opus-5", false, false},
		{"claude-opus-5", "", false, false},
		{"", "", false, false},
	} {
		collide, known := modelsCollide(tc.a, tc.b)
		if collide != tc.collide || known != tc.know {
			t.Fatalf("modelsCollide(%q, %q) = (%v, %v), want (%v, %v)", tc.a, tc.b, collide, known, tc.collide, tc.know)
		}
	}
}

// ── The pure branches ────────────────────────────────────────────────────────

func TestPeerSameModelRefusal(t *testing.T) {
	tests := []struct {
		name                         string
		approverModel, proposerModel string
		wantCode                     string // "" = allowed
	}{
		{"same model is refused", "claude-opus-5", "claude-opus-5", "peer_same_model"},
		{"same model spelled two ways is still the same", "claude-opus-5[1m]", "anthropic/claude-opus-5", "peer_same_model"},
		{"a different model passes", "gpt-5-codex", "claude-opus-5", ""},
		{"unknown approver model fails OPEN", "", "claude-opus-5", ""},
		{"unknown proposer model fails OPEN", "claude-opus-5", "", ""},
		{"both unknown fails OPEN", "", "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := peerSameModelRefusal("agent:reviewer-b", tc.approverModel, "agent:proposer-a", tc.proposerModel)
			if tc.wantCode == "" {
				if got != nil {
					t.Fatalf("refused with %q (%s), want allowed", got.code, got.message)
				}
				return
			}
			if got == nil {
				t.Fatalf("allowed, want refusal %q", tc.wantCode)
			}
			if got.code != tc.wantCode {
				t.Fatalf("code = %q, want %q", got.code, tc.wantCode)
			}
			assertHonestRefusal(t, got, "agent:reviewer-b", "agent:proposer-a")
		})
	}
}

func TestPeerReworkSameModelRefusal(t *testing.T) {
	tests := []struct {
		name                          string
		reviewerModel, completerModel string
		wantCode                      string
	}{
		{"same model is refused", "claude-opus-5", "claude-opus-5", "rework_same_model"},
		{"a different model passes", "gpt-5-codex", "claude-opus-5", ""},
		{"unknown reviewer model fails OPEN", "", "claude-opus-5", ""},
		{"unknown completer model fails OPEN", "claude-opus-5", "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := peerReworkSameModelRefusal("agent:reviewer-b", tc.reviewerModel, "worker-a", tc.completerModel)
			if tc.wantCode == "" {
				if got != nil {
					t.Fatalf("refused with %q (%s), want allowed", got.code, got.message)
				}
				return
			}
			if got == nil {
				t.Fatalf("allowed, want refusal %q", tc.wantCode)
			}
			if got.code != tc.wantCode {
				t.Fatalf("code = %q, want %q", got.code, tc.wantCode)
			}
			assertHonestRefusal(t, got, "agent:reviewer-b", "worker-a")
		})
	}
}

// THE HONESTY RAIL. A same-model refusal must (a) name both identities and the
// model, so the caller can act on it, and (b) say the model is self-asserted.
// This check is a cost-raiser, not a guarantee, and the refusal is the one place
// a reader is guaranteed to look — if this assertion is ever deleted, the feature
// starts quietly claiming more than it can do.
func assertHonestRefusal(t *testing.T, r *peerRefusal, actor, author string) {
	t.Helper()
	for _, want := range []string{actor, author, "self-asserted", "not a guarantee", "different model"} {
		if !strings.Contains(r.message, want) {
			t.Fatalf("refusal message is missing %q:\n%s", want, r.message)
		}
	}
	if r.extra == nil {
		t.Fatalf("refusal carries no machine-readable extra — a client cannot report which models collided")
	}
}

// ── Handler level ────────────────────────────────────────────────────────────

// crossModelStore layers the opt-in flag and per-agent models onto the peer fake.
// policyFakeStore.GetCanvasByID does not know about the flag, so the override
// lives here rather than in the shared fake — this file adds a posture, it does
// not change the one the other suites assert.
type crossModelStore struct {
	*peerFakeStore
	crossModel bool
}

func (f *crossModelStore) GetCanvasByID(_ context.Context, id uuid.UUID) (*store.Canvas, error) {
	return &store.Canvas{ID: id, ApprovalPolicy: f.policy, RequireCrossModelReview: f.crossModel}, nil
}

// withModels stamps self-asserted models onto the already-registered roster, by
// name. A name absent from the map keeps a nil model — the unrecorded case.
func withModels(agents []*store.Agent, models map[string]string) {
	for _, a := range agents {
		if m, ok := models[a.Name]; ok {
			model := m
			a.Model = &model
		}
	}
}

// crossModelApproveStore: canvas on 'peer' (unless overridden), one proposed task
// authored by proposer-a, roster of proposer-a + reviewer-b with the given models.
func crossModelApproveStore(policy string, crossModel bool, models map[string]string) (*crossModelStore, uuid.UUID) {
	taskID := uuid.New()
	fake := peerStore(policy, map[uuid.UUID]*store.Action{
		taskID: {ID: taskID, Type: "task", State: "proposed", AuthoredBy: agentAuthor("proposer-a")},
	}, "proposer-a", "reviewer-b")
	withModels(fake.agents, models)
	return &crossModelStore{peerFakeStore: fake, crossModel: crossModel}, taskID
}

// THE REFUSAL: flag on, both agents on Opus. Different agents, same brain — the
// approval is refused and nothing is written.
func TestCrossModelApprovalSameModelRefused(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := crossModelApproveStore(policyPeer, true, map[string]string{
		"proposer-a": "claude-opus-5", "reviewer-b": "claude-opus-5[1m]",
	})
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, taskID, nil), "agent:reviewer-b"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
	}
	if code := errorCode(t, w); code != "peer_same_model" {
		t.Fatalf("error code = %q, want peer_same_model", code)
	}
	if got := fake.actions[taskID]; got.State != "proposed" || got.ApprovedBy != nil {
		t.Fatalf("state/approvedBy = %q/%v, want proposed/nil — the refusal must not have written", got.State, got.ApprovedBy)
	}
	if !strings.Contains(w.Body.String(), "self-asserted") {
		t.Fatalf("the wire refusal dropped the honesty rail: %s", w.Body.String())
	}
}

// THE ACCEPTANCE CASE the flag exists for: a Codex reviewer approves an Opus
// proposal. Different agent AND different model, so it goes through.
func TestCrossModelApprovalDifferentModelSucceeds(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := crossModelApproveStore(policyPeer, true, map[string]string{
		"proposer-a": "claude-opus-5", "reviewer-b": "gpt-5-codex",
	})
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, taskID, nil), "agent:reviewer-b"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	if got := fake.actions[taskID]; got.State != "approved" {
		t.Fatalf("state = %q, want approved", got.State)
	}
}

// FAIL OPEN on an unrecorded model — the deliberate asymmetry with
// peer_proposer_unknown. `model` is optional on canvas_connect, so most existing
// agents have none; failing closed would turn ticking a box into an outage on a
// live 'peer' canvas. Every other guard still had to pass to get here.
func TestCrossModelApprovalUnknownModelFailsOpen(t *testing.T) {
	cases := map[string]map[string]string{
		"proposer has no model": {"reviewer-b": "claude-opus-5"},
		"reviewer has no model": {"proposer-a": "claude-opus-5"},
		"neither has a model":   {},
		// Empty string is as unrecorded as absent — a blank `model` argument must
		// not compare equal to another blank one and read as same-model.
		"both blank": {"proposer-a": "   ", "reviewer-b": ""},
	}
	for name, models := range cases {
		t.Run(name, func(t *testing.T) {
			canvasID := uuid.New()
			fake, taskID := crossModelApproveStore(policyPeer, true, models)
			h := NewHandler(fake, nil, nil)

			w := httptest.NewRecorder()
			h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, taskID, nil), "agent:reviewer-b"))
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 — an unknown model must fail OPEN (body %s)", w.Code, w.Body.String())
			}
			if got := fake.actions[taskID]; got.State != "approved" {
				t.Fatalf("state = %q, want approved", got.State)
			}
		})
	}
}

// DEFAULT OFF: with the flag clear, two agents on the identical model approve
// each other exactly as they did before TDM-155 existed. This is the whole
// promise of an opt-in — no existing canvas changes behaviour.
func TestCrossModelFlagOffIsANoOp(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := crossModelApproveStore(policyPeer, false, map[string]string{
		"proposer-a": "claude-opus-5", "reviewer-b": "claude-opus-5",
	})
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, taskID, nil), "agent:reviewer-b"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	if got := fake.actions[taskID]; got.State != "approved" || got.ApprovedBy == nil || *got.ApprovedBy != "agent:reviewer-b" {
		t.Fatalf("state/approvedBy = %q/%v, want approved/agent:reviewer-b", got.State, got.ApprovedBy)
	}
}

// The flag never overrides the checks that come before it: self-approval is still
// refused as SELF, not as same-model. Ordering matters for the error a caller
// reads — "you are the proposer" is more actionable than "you share a model".
func TestCrossModelDoesNotMaskSelfApproval(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := crossModelApproveStore(policyPeer, true, map[string]string{
		"proposer-a": "claude-opus-5", "reviewer-b": "claude-opus-5",
	})
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ApproveAction(w, withAgentAuthor(approveRequest(t, canvasID, taskID, nil), "agent:proposer-a"))
	if code := errorCode(t, w); code != "peer_self_approval" {
		t.Fatalf("error code = %q, want peer_self_approval (the older, more specific refusal)", code)
	}
}

// A human approving on a cross-model canvas is untouched: the flag governs the
// PEER door only, and a human has no model to compare.
func TestCrossModelHumanApprovalUnaffected(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := crossModelApproveStore(policyPeer, true, map[string]string{
		"proposer-a": "claude-opus-5", "reviewer-b": "claude-opus-5",
	})
	h := NewHandler(fake, nil, nil)

	// canvasRequest stamps a human author, as the board does.
	w := httptest.NewRecorder()
	h.ApproveAction(w, approveRequest(t, canvasID, taskID, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	if got := fake.actions[taskID]; got.ApprovedBy == nil || *got.ApprovedBy != AuthorHuman {
		t.Fatalf("approvedBy = %v, want %q", got.ApprovedBy, AuthorHuman)
	}
}

// ── The rework door (TDM-154) gets the same bar ──────────────────────────────
//
// A same-model "no" is exactly as much theatre as a same-model "yes", so the flag
// covers both halves of the reviewer's job — with its own code, so a client can
// tell which door closed.

type crossModelReworkStore struct {
	*reworkFakeStore
	crossModel bool
}

func (f *crossModelReworkStore) GetCanvasByID(_ context.Context, id uuid.UUID) (*store.Canvas, error) {
	return &store.Canvas{ID: id, ApprovalPolicy: f.policy, RequireCrossModelReview: f.crossModel}, nil
}

func crossModelReworkFake(crossModel bool, models map[string]string) (*crossModelReworkStore, uuid.UUID) {
	fake, taskID := reworkStore(policyPeer, "worker-a", "worker-a", "reviewer-b")
	withModels(fake.agents, models)
	return &crossModelReworkStore{reworkFakeStore: fake, crossModel: crossModel}, taskID
}

func TestCrossModelReworkSameModelRefused(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := crossModelReworkFake(true, map[string]string{
		"worker-a": "claude-opus-5", "reviewer-b": "claude-opus-5",
	})
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ReworkAction(w, withAgentAuthor(reworkRequest(t, canvasID, taskID,
		map[string]any{"reason": "I would have written it differently"}), "agent:reviewer-b"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
	}
	if code := errorCode(t, w); code != "rework_same_model" {
		t.Fatalf("error code = %q, want rework_same_model", code)
	}
	if fake.actions[taskID].State != "done" {
		t.Fatalf("state = %q, want done — the refused bounce must not have moved it", fake.actions[taskID].State)
	}
	if fake.reopenCount() != 0 {
		t.Fatalf("reopens = %d, want 0", fake.reopenCount())
	}
}

func TestCrossModelReworkDifferentModelSucceeds(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := crossModelReworkFake(true, map[string]string{
		"worker-a": "claude-opus-5", "reviewer-b": "gpt-5-codex",
	})
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ReworkAction(w, withAgentAuthor(reworkRequest(t, canvasID, taskID,
		map[string]any{"reason": "the guard fails open where the ticket says closed; redo it with a test"}), "agent:reviewer-b"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	if fake.actions[taskID].State != "approved" {
		t.Fatalf("state = %q, want approved (back in the ready queue)", fake.actions[taskID].State)
	}
}

// Flag off ⇒ TDM-154 behaves exactly as it shipped, same-model reviewer and all.
func TestCrossModelReworkFlagOffIsANoOp(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := crossModelReworkFake(false, map[string]string{
		"worker-a": "claude-opus-5", "reviewer-b": "claude-opus-5",
	})
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ReworkAction(w, withAgentAuthor(reworkRequest(t, canvasID, taskID,
		map[string]any{"reason": "this is still wrong for the reasons in the thread"}), "agent:reviewer-b"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	if fake.actions[taskID].State != "approved" {
		t.Fatalf("state = %q, want approved", fake.actions[taskID].State)
	}
}

// Unknown model on the rework door fails OPEN too — same posture, one rule.
func TestCrossModelReworkUnknownModelFailsOpen(t *testing.T) {
	canvasID := uuid.New()
	fake, taskID := crossModelReworkFake(true, map[string]string{"reviewer-b": "claude-opus-5"})
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.ReworkAction(w, withAgentAuthor(reworkRequest(t, canvasID, taskID,
		map[string]any{"reason": "the completer never reported a model, so this check abstains"}), "agent:reviewer-b"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — an unknown model must fail OPEN (body %s)", w.Code, w.Body.String())
	}
}

// ── The roster lookup ────────────────────────────────────────────────────────

// Both spellings of an identity resolve: the gateway sends the registered NAME
// and falls back to the agent id, the same tolerance approverIsRegisteredAgent
// has. An agent with no model is simply absent from the index.
func TestAgentModelIndex(t *testing.T) {
	opus, blank := "claude-opus-5", "  "
	withModel := &store.Agent{ID: uuid.New(), Name: "reviewer-b", Model: &opus}
	noModel := &store.Agent{ID: uuid.New(), Name: "worker-a"}
	blankModel := &store.Agent{ID: uuid.New(), Name: "ghost", Model: &blank}

	fake := peerStore(policyPeer, map[uuid.UUID]*store.Action{})
	fake.agents = []*store.Agent{withModel, noModel, blankModel, nil}
	h := NewHandler(fake, nil, nil)

	index, err := h.agentModelIndex(context.Background(), uuid.New())
	if err != nil {
		t.Fatalf("agentModelIndex: %v", err)
	}
	for _, identity := range []string{"reviewer-b", "agent:reviewer-b", withModel.ID.String()} {
		if got := modelFor(index, identity); got != opus {
			t.Fatalf("modelFor(%q) = %q, want %q", identity, got, opus)
		}
	}
	for _, identity := range []string{"worker-a", "ghost", "never-registered", ""} {
		if got := modelFor(index, identity); got != "" {
			t.Fatalf("modelFor(%q) = %q, want \"\" (unrecorded)", identity, got)
		}
	}
}

// ── The owner-only setter ────────────────────────────────────────────────────

type crossModelSetterStore struct {
	*policySetterFakeStore
	current  bool
	set      *bool
	setCalls int
}

func (f *crossModelSetterStore) GetCanvasByCode(_ context.Context, _ string) (*store.Canvas, error) {
	return &store.Canvas{ID: uuid.New(), OwnerUserID: &f.owner, ApprovalPolicy: "epic", RequireCrossModelReview: f.current}, nil
}

func (f *crossModelSetterStore) SetCanvasCrossModelReview(_ context.Context, _ uuid.UUID, required bool) (int, error) {
	f.setCalls++
	f.set = &required
	return 1, nil
}

// The flag rides the existing owner-only approval-policy PATCH — no new route.
// Omitting it must leave the stored value alone, which is how every caller that
// predates TDM-155 (the web ShareDialog) keeps its behaviour.
func TestSetCanvasCrossModelReviewFlag(t *testing.T) {
	tru, fls := true, false
	tests := []struct {
		name      string
		current   bool
		send      *bool
		wantCalls int
		wantSet   *bool
	}{
		{"omitted leaves it alone", false, nil, 0, nil},
		{"omitted leaves it alone when on", true, nil, 0, nil},
		{"turning it on writes", false, &tru, 1, &tru},
		{"turning it off writes", true, &fls, 1, &fls},
		{"setting it to what it already is does not write", true, &tru, 0, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			owner := uuid.New()
			fake := &crossModelSetterStore{
				policySetterFakeStore: &policySetterFakeStore{owner: owner},
				current:               tc.current,
			}
			h := NewHandler(fake, nil, nil)
			body := map[string]any{"approvalPolicy": policyPeer}
			if tc.send != nil {
				body["requireCrossModelReview"] = *tc.send
			}
			r := canvasRequest(t, "PATCH", "/api/canvases/ABCD1234/approval-policy", body, uuid.New(), "")
			r = r.WithContext(context.WithValue(r.Context(), userIDKey, owner))
			w := httptest.NewRecorder()
			h.SetCanvasApprovalPolicy(w, r)
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %s)", w.Code, w.Body.String())
			}
			if fake.setCalls != tc.wantCalls {
				t.Fatalf("SetCanvasCrossModelReview calls = %d, want %d", fake.setCalls, tc.wantCalls)
			}
			if tc.wantSet != nil && (fake.set == nil || *fake.set != *tc.wantSet) {
				t.Fatalf("stored flag = %v, want %v", fake.set, *tc.wantSet)
			}
			// The policy itself is written on every call, flag or no flag.
			if fake.policySetterFakeStore.set != policyPeer {
				t.Fatalf("approvalPolicy = %q, want %q", fake.policySetterFakeStore.set, policyPeer)
			}
		})
	}
}
