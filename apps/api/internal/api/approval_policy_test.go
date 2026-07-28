package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// ── policyApproval: the pure cascade rule ────────────────────────────────────

func TestPolicyApproval(t *testing.T) {
	approvedEpic := uuid.New()
	proposedEpic := uuid.New()
	epicApproved := func(id uuid.UUID) bool { return id == approvedEpic }

	payload := func(fields map[string]any) json.RawMessage {
		b, _ := json.Marshal(fields)
		return b
	}

	tests := []struct {
		name    string
		policy  string
		payload json.RawMessage
		want    string
	}{
		// strict: everything lands proposed.
		{"strict no epic", "strict", payload(map[string]any{"title": "t"}), ""},
		{"strict approved epic", "strict", payload(map[string]any{"title": "t", "epicId": approvedEpic.String()}), ""},

		// auto: everything born approved.
		{"auto no epic", "auto", payload(map[string]any{"title": "t"}), "policy:auto"},
		{"auto approved epic", "auto", payload(map[string]any{"title": "t", "epicId": approvedEpic.String()}), "policy:auto"},

		// epic (default): only tasks under an APPROVED epic flow.
		{"epic approved epic", "epic", payload(map[string]any{"title": "t", "epicId": approvedEpic.String()}), "policy:epic"},
		{"epic proposed epic", "epic", payload(map[string]any{"title": "t", "epicId": proposedEpic.String()}), ""},
		{"epic no epicId", "epic", payload(map[string]any{"title": "t"}), ""},
		{"epic malformed epicId", "epic", payload(map[string]any{"title": "t", "epicId": "not-a-uuid"}), ""},
		// Legacy canvases (column empty pre-migration) behave as the 'epic' default.
		{"empty policy = epic", "", payload(map[string]any{"title": "t", "epicId": approvedEpic.String()}), "policy:epic"},

		// requiresApproval:true forces proposed REGARDLESS of policy.
		{"auto requiresApproval", "auto", payload(map[string]any{"title": "t", "requiresApproval": true}), ""},
		{"epic requiresApproval", "epic", payload(map[string]any{"title": "t", "epicId": approvedEpic.String(), "requiresApproval": true}), ""},
		{"strict requiresApproval", "strict", payload(map[string]any{"title": "t", "requiresApproval": true}), ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := policyApproval(tc.policy, tc.payload, epicApproved); got != tc.want {
				t.Fatalf("policyApproval(%q) = %q, want %q", tc.policy, got, tc.want)
			}
		})
	}
}

// ── Handler-level cascade (fake store) ───────────────────────────────────────

// policyFakeStore stubs just the methods the action create/approve paths touch.
// Every other Store method panics via the embedded nil interface — a test
// reaching one is a test bug.
type policyFakeStore struct {
	store.Store
	policy  string
	actions map[uuid.UUID]*store.Action

	created []*store.Action
	// epic batch-approve call record
	epicApprovedID uuid.UUID
	epicApprovedBy string
	epicCalls      int
}

func (f *policyFakeStore) GetCanvasByID(_ context.Context, id uuid.UUID) (*store.Canvas, error) {
	return &store.Canvas{ID: id, ApprovalPolicy: f.policy}, nil
}

func (f *policyFakeStore) GetAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, error) {
	if a, ok := f.actions[id]; ok {
		return a, nil
	}
	return nil, fmt.Errorf("action %s not found", id)
}

func (f *policyFakeStore) CreateAction(_ context.Context, _ uuid.UUID, a *store.Action) (int, error) {
	f.created = append(f.created, a)
	return 1, nil
}

func (f *policyFakeStore) CreateActions(_ context.Context, _ uuid.UUID, actions []*store.Action) (int, error) {
	f.created = append(f.created, actions...)
	return 1, nil
}

func (f *policyFakeStore) UpdateActionState(_ context.Context, _ uuid.UUID, id uuid.UUID, patch store.ActionStatePatch) (int, error) {
	if a, ok := f.actions[id]; ok {
		a.State = patch.State
		if patch.ApprovedBy != nil {
			a.ApprovedBy = patch.ApprovedBy
		}
	}
	return 1, nil
}

func (f *policyFakeStore) ApproveEpicTasks(_ context.Context, _ uuid.UUID, epicID uuid.UUID, approvedBy string) (int, error) {
	f.epicCalls++
	f.epicApprovedID = epicID
	f.epicApprovedBy = approvedBy
	return 1, nil
}

// GetCanvasState backs the async post-write broadcast; erroring makes it a no-op.
func (f *policyFakeStore) GetCanvasState(_ context.Context, _ uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in tests")
}

// canvasRequest builds a request carrying canvas JWT claims (and an optional
// chi {id} URL param) the way the middleware would.
func canvasRequest(t *testing.T, method, path string, body any, canvasID uuid.UUID, urlID string) *http.Request {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	ctx := context.WithValue(r.Context(), claimsKey, &auth.Claims{CanvasID: canvasID, Role: "write"})
	if urlID != "" {
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", urlID)
		ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	}
	return r.WithContext(ctx)
}

func taskBody(payload map[string]any) map[string]any {
	return map[string]any{"type": "task", "payload": payload}
}

func TestProposeTaskApprovalCascade(t *testing.T) {
	canvasID := uuid.New()
	approvedEpic := uuid.New()
	proposedEpic := uuid.New()
	epics := map[uuid.UUID]*store.Action{
		approvedEpic: {ID: approvedEpic, Type: "epic", State: "approved"},
		proposedEpic: {ID: proposedEpic, Type: "epic", State: "proposed"},
	}

	tests := []struct {
		name           string
		policy         string
		payload        map[string]any
		wantState      string
		wantApprovedBy string // "" = nil
	}{
		{"strict lands proposed", "strict", map[string]any{"title": "t"}, "proposed", ""},
		{"strict ignores approved epic", "strict", map[string]any{"title": "t", "epicId": approvedEpic.String()}, "proposed", ""},
		{"auto born approved", "auto", map[string]any{"title": "t"}, "approved", "policy:auto"},
		{"epic under approved epic", "epic", map[string]any{"title": "t", "epicId": approvedEpic.String()}, "approved", "policy:epic"},
		{"epic under proposed epic", "epic", map[string]any{"title": "t", "epicId": proposedEpic.String()}, "proposed", ""},
		{"epic without epicId", "epic", map[string]any{"title": "t"}, "proposed", ""},
		{"requiresApproval overrides auto", "auto", map[string]any{"title": "t", "requiresApproval": true}, "proposed", ""},
		{"requiresApproval overrides epic", "epic", map[string]any{"title": "t", "epicId": approvedEpic.String(), "requiresApproval": true}, "proposed", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fake := &policyFakeStore{policy: tc.policy, actions: epics}
			h := NewHandler(fake, nil, nil)
			w := httptest.NewRecorder()
			h.ProposeAction(w, canvasRequest(t, "POST", "/api/canvas/actions", taskBody(tc.payload), canvasID, ""))
			if w.Code != http.StatusCreated {
				t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
			}
			if len(fake.created) != 1 {
				t.Fatalf("created %d actions, want 1", len(fake.created))
			}
			got := fake.created[0]
			if got.State != tc.wantState {
				t.Fatalf("state = %q, want %q", got.State, tc.wantState)
			}
			switch {
			case tc.wantApprovedBy == "" && got.ApprovedBy != nil:
				t.Fatalf("approvedBy = %q, want nil", *got.ApprovedBy)
			case tc.wantApprovedBy != "" && (got.ApprovedBy == nil || *got.ApprovedBy != tc.wantApprovedBy):
				t.Fatalf("approvedBy = %v, want %q", got.ApprovedBy, tc.wantApprovedBy)
			}
		})
	}
}

// The batch path applies the same cascade per item (one resolver for the batch).
func TestProposeTasksBatchApprovalCascade(t *testing.T) {
	canvasID := uuid.New()
	approvedEpic := uuid.New()
	fake := &policyFakeStore{
		policy:  "epic",
		actions: map[uuid.UUID]*store.Action{approvedEpic: {ID: approvedEpic, Type: "epic", State: "approved"}},
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	body := map[string]any{"actions": []map[string]any{
		taskBody(map[string]any{"title": "flows", "epicId": approvedEpic.String()}),
		taskBody(map[string]any{"title": "gated"}),
		taskBody(map[string]any{"title": "self-flagged", "epicId": approvedEpic.String(), "requiresApproval": true}),
	}}
	h.ProposeActionsBatch(w, canvasRequest(t, "POST", "/api/canvas/actions/batch", body, canvasID, ""))
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	if len(fake.created) != 3 {
		t.Fatalf("created %d actions, want 3", len(fake.created))
	}
	wantStates := []string{"approved", "proposed", "proposed"}
	for i, want := range wantStates {
		if fake.created[i].State != want {
			t.Fatalf("task %d state = %q, want %q", i, fake.created[i].State, want)
		}
	}
	if got := fake.created[0].ApprovedBy; got == nil || *got != "policy:epic" {
		t.Fatalf("task 0 approvedBy = %v, want policy:epic", got)
	}
}

// Approving an epic batch-approves its currently-proposed tasks in one bulk
// update, stamped 'policy:epic'.
func TestApproveEpicBatchApprovesTasks(t *testing.T) {
	canvasID := uuid.New()
	epicID := uuid.New()
	fake := &policyFakeStore{
		policy:  "epic",
		actions: map[uuid.UUID]*store.Action{epicID: {ID: epicID, Type: "epic", State: "proposed"}},
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ApproveAction(w, canvasRequest(t, "POST", "/api/canvas/actions/"+epicID.String()+"/approve",
		map[string]any{"approvedBy": "human"}, canvasID, epicID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	if fake.epicCalls != 1 {
		t.Fatalf("ApproveEpicTasks called %d times, want 1", fake.epicCalls)
	}
	if fake.epicApprovedID != epicID {
		t.Fatalf("cascade targeted epic %s, want %s", fake.epicApprovedID, epicID)
	}
	if fake.epicApprovedBy != "policy:epic" {
		t.Fatalf("cascade stamped %q, want policy:epic", fake.epicApprovedBy)
	}
}

// Approving a plain TASK must not trigger the epic cascade.
func TestApproveTaskDoesNotCascade(t *testing.T) {
	canvasID := uuid.New()
	taskID := uuid.New()
	fake := &policyFakeStore{
		policy:  "epic",
		actions: map[uuid.UUID]*store.Action{taskID: {ID: taskID, Type: "task", State: "proposed"}},
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ApproveAction(w, canvasRequest(t, "POST", "/api/canvas/actions/"+taskID.String()+"/approve",
		map[string]any{}, canvasID, taskID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	if fake.epicCalls != 0 {
		t.Fatalf("ApproveEpicTasks called %d times, want 0", fake.epicCalls)
	}
}
