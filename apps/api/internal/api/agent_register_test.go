package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// agentFakeStore stubs the methods the agent-register and claim paths touch.
// Every other Store method panics via the embedded nil interface.
type agentFakeStore struct {
	store.Store
	registered []*store.Agent
	agents     map[uuid.UUID]*store.Agent // pre-seeded rows for GetAgent
	actions    map[uuid.UUID]*store.Action
	touchMu    sync.Mutex // guards touched AND registered (claim goroutines write both)
	touched    []string   // claimant identities passed to TouchOrCreateAgent
}

// RegisterAgent models the store's (canvas_id, name) UPSERT: an existing name
// keeps its id and gets its fields refreshed in place; a new name gets a
// DB-style generated id. Mirrors the real contract — a.ID carries the
// surviving row's id on return.
func (f *agentFakeStore) RegisterAgent(_ context.Context, _ uuid.UUID, a *store.Agent) (int, error) {
	f.touchMu.Lock()
	defer f.touchMu.Unlock()
	for _, existing := range f.registered {
		if existing.Name == a.Name {
			a.ID = existing.ID
			*existing = *a
			return 1, nil
		}
	}
	a.ID = uuid.New()
	f.registered = append(f.registered, a)
	return 1, nil
}

// agentNamed returns the registered agent with the given name, mutex-guarded —
// the detached claim goroutines mutate registered concurrently with test
// assertions.
func (f *agentFakeStore) agentNamed(name string) *store.Agent {
	f.touchMu.Lock()
	defer f.touchMu.Unlock()
	for _, a := range f.registered {
		if a.Name == name {
			return a
		}
	}
	return nil
}

func (f *agentFakeStore) registeredCount() int {
	f.touchMu.Lock()
	defer f.touchMu.Unlock()
	return len(f.registered)
}

// GetAgent resolves against previously-registered agents plus any pre-seeded
// rows in agents — the parentAgentId validation path.
func (f *agentFakeStore) GetAgent(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Agent, error) {
	if a, ok := f.agents[id]; ok {
		return a, nil
	}
	for _, a := range f.registered {
		if a.ID == id {
			return a, nil
		}
	}
	return nil, fmt.Errorf("agent %s not found", id)
}

// TouchOrCreateAgent records the claimant and models the claim path's
// touch-or-create: a NAME claimant with no registered row gets a minimal
// executor registration (the founder-request behavior under test); a known
// name is only refreshed. ""/"agent" and id claimants create nothing, like
// the real store.
func (f *agentFakeStore) TouchOrCreateAgent(_ context.Context, _ uuid.UUID, claimant string) error {
	f.touchMu.Lock()
	defer f.touchMu.Unlock()
	f.touched = append(f.touched, claimant)
	if claimant == "" || claimant == "agent" {
		return nil
	}
	if _, err := uuid.Parse(claimant); err == nil {
		return nil
	}
	for _, a := range f.registered {
		if a.Name == claimant {
			a.Status = "online"
			a.LastSeenAt = time.Now().UTC()
			return nil
		}
	}
	f.registered = append(f.registered, &store.Agent{
		ID: uuid.New(), Kind: "agent", Name: claimant, Role: "executor",
		Status: "online", LastSeenAt: time.Now().UTC(),
	})
	return nil
}

// waitTouched polls for the detached liveness goroutines to have recorded
// exactly `want` touches (2s deadline), then returns a copy.
func (f *agentFakeStore) waitTouched(t *testing.T, want int) []string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		f.touchMu.Lock()
		got := append([]string(nil), f.touched...)
		f.touchMu.Unlock()
		if len(got) == want {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("touched = %v, want %d entries", got, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (f *agentFakeStore) ClaimAction(_ context.Context, _ uuid.UUID, id uuid.UUID, claimedBy string) (*store.Action, int, error) {
	a, ok := f.actions[id]
	if !ok {
		return nil, 0, store.ErrActionNotFound
	}
	a.State = "executing"
	a.ClaimedBy = &claimedBy
	return a, 1, nil
}

func (f *agentFakeStore) GetAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, error) {
	if a, ok := f.actions[id]; ok {
		return a, nil
	}
	return nil, fmt.Errorf("action %s not found", id)
}

func (f *agentFakeStore) UpdateActionState(_ context.Context, _ uuid.UUID, id uuid.UUID, patch store.ActionStatePatch) (int, error) {
	if a, ok := f.actions[id]; ok {
		a.State = patch.State
	}
	return 1, nil
}

// GetCanvasState backs the async post-write broadcast; erroring makes it a no-op.
func (f *agentFakeStore) GetCanvasState(_ context.Context, _ uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in tests")
}

func TestRegisterAgentWithParent(t *testing.T) {
	canvasID := uuid.New()
	parentID := uuid.New()
	fake := &agentFakeStore{agents: map[uuid.UUID]*store.Agent{
		parentID: {ID: parentID, Name: "orchestrator", Role: "planner"},
	}}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	body := map[string]any{
		"name": "executor-1", "role": "executor",
		"parentAgentId": parentID.String(),
	}
	h.RegisterAgent(w, canvasRequest(t, "POST", "/api/canvas/agents", body, canvasID, ""))
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	if len(fake.registered) != 1 {
		t.Fatalf("registered %d agents, want 1", len(fake.registered))
	}
	got := fake.registered[0]
	if got.ParentAgentID == nil || *got.ParentAgentID != parentID {
		t.Fatalf("persisted parentAgentId = %v, want %s", got.ParentAgentID, parentID)
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp["agentId"] != got.ID.String() {
		t.Fatalf("response agentId = %q, want %q", resp["agentId"], got.ID)
	}
	if resp["parentAgentId"] != parentID.String() {
		t.Fatalf("response parentAgentId = %q, want %q", resp["parentAgentId"], parentID)
	}
}

// A parentAgentId that names no registered agent on this canvas is a 400, not
// a silent flat child or an FK 500.
func TestRegisterAgentUnknownParentRejected(t *testing.T) {
	canvasID := uuid.New()
	fake := &agentFakeStore{}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	body := map[string]any{
		"name": "executor-1", "role": "executor",
		"parentAgentId": uuid.New().String(),
	}
	h.RegisterAgent(w, canvasRequest(t, "POST", "/api/canvas/agents", body, canvasID, ""))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", w.Code, w.Body.String())
	}
	if len(fake.registered) != 0 {
		t.Fatalf("registered %d agents despite invalid parent, want 0", len(fake.registered))
	}
}

func TestRegisterAgentWithoutParent(t *testing.T) {
	canvasID := uuid.New()
	fake := &agentFakeStore{}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	body := map[string]any{"name": "orchestrator", "role": "planner"}
	h.RegisterAgent(w, canvasRequest(t, "POST", "/api/canvas/agents", body, canvasID, ""))
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	if got := fake.registered[0]; got.ParentAgentID != nil {
		t.Fatalf("parentAgentId = %v, want nil", got.ParentAgentID)
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if _, present := resp["parentAgentId"]; present {
		t.Fatalf("response should omit parentAgentId when unparented, got %v", resp)
	}
	if resp["agentId"] == "" {
		t.Fatalf("response missing agentId: %v", resp)
	}
}

func TestRegisterAgentBadParentID(t *testing.T) {
	fake := &agentFakeStore{}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	body := map[string]any{"role": "executor", "parentAgentId": "not-a-uuid"}
	h.RegisterAgent(w, canvasRequest(t, "POST", "/api/canvas/agents", body, uuid.New(), ""))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", w.Code, w.Body.String())
	}
	if len(fake.registered) != 0 {
		t.Fatalf("registered %d agents, want 0", len(fake.registered))
	}
}

// A successful claim (task_start) and a named terminal transition
// (task_complete) both refresh the agent's last_seen_at — the liveness
// heartbeat the swarm view's staleness threshold depends on.
func TestClaimAndCompleteTouchAgentLiveness(t *testing.T) {
	canvasID := uuid.New()
	taskID := uuid.New()
	fake := &agentFakeStore{actions: map[uuid.UUID]*store.Action{
		taskID: {ID: taskID, Type: "task", State: "approved",
			Payload: json.RawMessage(`{"title":"t"}`)},
	}}
	h := NewHandler(fake, nil, nil)

	// task_start: approved → executing, claimed by "executor-1".
	w := httptest.NewRecorder()
	h.UpdateActionState(w, canvasRequest(t, "PATCH", "/api/canvas/actions/"+taskID.String(),
		map[string]any{"state": "executing", "agentName": "executor-1"}, canvasID, taskID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("claim status = %d, body %s", w.Code, w.Body.String())
	}
	if got := fake.waitTouched(t, 1); got[0] != "executor-1" {
		t.Fatalf("after claim, touched = %v, want [executor-1]", got)
	}

	// task_complete: executing → done by the same holder.
	w = httptest.NewRecorder()
	h.UpdateActionState(w, canvasRequest(t, "PATCH", "/api/canvas/actions/"+taskID.String(),
		map[string]any{"state": "done", "agentName": "executor-1"}, canvasID, taskID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("complete status = %d, body %s", w.Code, w.Body.String())
	}
	if got := fake.waitTouched(t, 2); got[1] != "executor-1" {
		t.Fatalf("after complete, touched = %v, want [executor-1 executor-1]", got)
	}
}

// registerResponse registers via the handler and returns the response agentId.
func registerResponse(t *testing.T, h *Handler, canvasID uuid.UUID, body map[string]any) string {
	t.Helper()
	w := httptest.NewRecorder()
	h.RegisterAgent(w, canvasRequest(t, "POST", "/api/canvas/agents", body, canvasID, ""))
	if w.Code != http.StatusCreated {
		t.Fatalf("register status = %d, body %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal register response: %v", err)
	}
	if resp["agentId"] == "" {
		t.Fatalf("register response missing agentId: %v", resp)
	}
	return resp["agentId"]
}

// TDM-8: re-registering the same name is an UPSERT — the SAME agentId comes
// back (no ghost row) and role/model are refreshed on the existing row.
func TestReRegisterSameNameKeepsAgentID(t *testing.T) {
	canvasID := uuid.New()
	fake := &agentFakeStore{}
	h := NewHandler(fake, nil, nil)

	first := registerResponse(t, h, canvasID,
		map[string]any{"name": "executor-1", "role": "executor", "model": "claude-opus-4-8"})
	second := registerResponse(t, h, canvasID,
		map[string]any{"name": "executor-1", "role": "planner", "model": "claude-fable-5"})

	if second != first {
		t.Fatalf("re-register minted a new agentId: %q then %q", first, second)
	}
	if n := fake.registeredCount(); n != 1 {
		t.Fatalf("registered rows = %d, want 1 (upsert, not insert)", n)
	}
	got := fake.agentNamed("executor-1")
	if got == nil {
		t.Fatalf("agent row missing after re-register")
	}
	if got.Role != "planner" || got.Model == nil || *got.Model != "claude-fable-5" {
		t.Fatalf("re-register did not refresh fields: role=%q model=%v", got.Role, got.Model)
	}
}

// Different names stay distinct agents — uniqueness is per (canvas, name),
// not per canvas.
func TestRegisterDistinctNamesDistinctIDs(t *testing.T) {
	canvasID := uuid.New()
	fake := &agentFakeStore{}
	h := NewHandler(fake, nil, nil)

	a := registerResponse(t, h, canvasID, map[string]any{"name": "executor-1", "role": "executor"})
	b := registerResponse(t, h, canvasID, map[string]any{"name": "executor-2", "role": "executor"})
	if a == b {
		t.Fatalf("distinct names shared an agentId: %q", a)
	}
	if n := fake.registeredCount(); n != 2 {
		t.Fatalf("registered rows = %d, want 2", n)
	}
}

// Founder request ("when an agent takes a task it should still be connected"):
// a successful claim by a session that never called agent_register creates a
// minimal executor presence row, so the claimant shows in the swarm view
// labelled with its task.
func TestClaimByUnregisteredClaimantCreatesPresence(t *testing.T) {
	canvasID := uuid.New()
	taskID := uuid.New()
	fake := &agentFakeStore{actions: map[uuid.UUID]*store.Action{
		taskID: {ID: taskID, Type: "task", State: "approved",
			Payload: json.RawMessage(`{"title":"t"}`)},
	}}
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.UpdateActionState(w, canvasRequest(t, "PATCH", "/api/canvas/actions/"+taskID.String(),
		map[string]any{"state": "executing", "agentName": "drive-by-session"}, canvasID, taskID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("claim status = %d, body %s", w.Code, w.Body.String())
	}
	fake.waitTouched(t, 1)
	created := fake.agentNamed("drive-by-session")
	if created == nil {
		t.Fatalf("claim by unregistered claimant did not create a presence row")
	}
	if created.Role != "executor" || created.Status != "online" {
		t.Fatalf("created presence row = role %q status %q, want executor/online",
			created.Role, created.Status)
	}
}

// A claim by an already-registered claimant only refreshes the existing row —
// same id, no duplicate.
func TestClaimByRegisteredClaimantOnlyRefreshes(t *testing.T) {
	canvasID := uuid.New()
	taskID := uuid.New()
	fake := &agentFakeStore{actions: map[uuid.UUID]*store.Action{
		taskID: {ID: taskID, Type: "task", State: "approved",
			Payload: json.RawMessage(`{"title":"t"}`)},
	}}
	h := NewHandler(fake, nil, nil)

	originalID := registerResponse(t, h, canvasID,
		map[string]any{"name": "executor-1", "role": "executor"})

	w := httptest.NewRecorder()
	h.UpdateActionState(w, canvasRequest(t, "PATCH", "/api/canvas/actions/"+taskID.String(),
		map[string]any{"state": "executing", "agentName": "executor-1"}, canvasID, taskID.String()))
	if w.Code != http.StatusOK {
		t.Fatalf("claim status = %d, body %s", w.Code, w.Body.String())
	}
	fake.waitTouched(t, 1)
	if n := fake.registeredCount(); n != 1 {
		t.Fatalf("registered rows = %d, want 1 (claim must not duplicate a registered agent)", n)
	}
	if got := fake.agentNamed("executor-1"); got == nil || got.ID.String() != originalID {
		t.Fatalf("claim re-keyed the registered agent: got %v, want id %s", got, originalID)
	}
}
