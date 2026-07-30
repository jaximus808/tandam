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

	"github.com/agentcanvas/api/internal/metrics"
	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// TDM-98 — claim fencing, at the HTTP layer, on every write path.
//
// THE RACE THESE TESTS EXIST FOR. A claim has a lease. A worker that goes quiet
// for longer than the lease has its task taken over — that is the queue not
// wedging, and it is deliberate. What must NOT happen is the worker coming back
// and writing anyway: completing a task somebody else is now doing, or reporting
// progress onto work that has moved on. Holder identity catches most of it; it
// does not catch a lease that came back to the same agent name, which is what the
// generation is for.
//
// The fake below mints generations the way the real store does (a counter on the
// task payload, bumped by every claim that stamps a fresh lease) and expires
// leases on demand, so the whole lifecycle — claim, lapse, take over, lapse, take
// back — is walkable in a test.

// ── Fake store ───────────────────────────────────────────────────────────────

type fenceFakeStore struct {
	store.Store
	mu      sync.Mutex
	actions map[uuid.UUID]*store.Action
	deleted []uuid.UUID
}

func newFenceStore(tasks ...*store.Action) *fenceFakeStore {
	f := &fenceFakeStore{actions: map[uuid.UUID]*store.Action{}}
	for _, a := range tasks {
		f.actions[a.ID] = a
	}
	return f
}

// ClaimAction models supabaseStore.ClaimAction including the fencing token: an
// approved task is claimed, an EXPIRED executing claim is taken over, a live one
// is idempotent for its own named holder and refused to anyone else. Every claim
// that stamps a fresh lease mints generation+1 onto the payload; the idempotent
// no-op hands back the generation already recorded.
func (f *fenceFakeStore) ClaimAction(_ context.Context, _ uuid.UUID, id uuid.UUID, claimedBy string) (*store.Action, store.ClaimOutcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ClaimOutcome{}, store.ErrActionNotFound
	}
	if a.Type != "task" {
		return nil, store.ClaimOutcome{}, fmt.Errorf("%w: only tasks can be claimed", store.ErrIllegalActionState)
	}
	expired := false
	switch a.State {
	case "approved":
	case "executing":
		holder := ""
		if a.ClaimedBy != nil {
			holder = *a.ClaimedBy
		}
		// The fake's expiry rule: a claim stamped in the past (see expireClaim) is
		// takeable. Anything else is idempotent for its holder, refused to others.
		expired = a.ClaimedAt != nil && time.Since(*a.ClaimedAt) >= time.Minute
		if !expired {
			if holder != "" && holder != "agent" && holder == claimedBy {
				return copyAction(a), store.ClaimOutcome{
					ClaimGeneration: store.ReadClaimRecord(a.Payload).Generation,
				}, nil
			}
			return nil, store.ClaimOutcome{}, &store.AlreadyClaimedError{ClaimedBy: holder}
		}
	default:
		return nil, store.ClaimOutcome{}, fmt.Errorf("%w: cannot claim task in state %q", store.ErrIllegalActionState, a.State)
	}
	now := time.Now().UTC()
	rec := store.NextClaimRecord(a.Payload, claimedBy, now)
	next, err := store.WithClaimRecord(a.Payload, rec)
	if err != nil {
		return nil, store.ClaimOutcome{}, err
	}
	holder := claimedBy
	a.State, a.ClaimedBy, a.ClaimedAt, a.Payload = "executing", &holder, &now, next
	out := store.ClaimOutcome{Version: 1, ClaimGeneration: rec.Generation}
	return copyAction(a), out, nil
}

func (f *fenceFakeStore) GetAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ErrActionNotFound
	}
	return copyAction(a), nil
}

func (f *fenceFakeStore) UpdateActionState(_ context.Context, _ uuid.UUID, id uuid.UUID, patch store.ActionStatePatch) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return 0, store.ErrActionNotFound
	}
	a.State = patch.State
	if patch.Result != nil {
		a.Result = patch.Result
	}
	if patch.Error != nil {
		a.Error = patch.Error
	}
	if len(patch.Payload) > 0 {
		a.Payload = patch.Payload
	}
	return 1, nil
}

// UpdateActionPayload runs the REAL content gate, so the claim record's
// carry-forward (it is server-owned, like the audit log) is exercised rather than
// assumed.
func (f *fenceFakeStore) UpdateActionPayload(_ context.Context, _ uuid.UUID, id uuid.UUID, payload json.RawMessage, actor string) (*store.ContentUpdate, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ErrActionNotFound
	}
	next, out, err := store.DecideContentUpdate(a, payload, actor, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	a.Payload = next
	if out.Reverted {
		a.State = "proposed"
		a.ClaimedBy, a.ClaimedAt, a.ApprovedBy = nil, nil, nil
	}
	out.Version = 1
	return out, nil
}

// TouchActionClaim is the holder-only lease refresh (the real one puts claimed_by
// in the UPDATE's WHERE clause).
func (f *fenceFakeStore) TouchActionClaim(_ context.Context, _ uuid.UUID, id uuid.UUID, claimedBy string) (*store.Action, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok || a.State != "executing" || claimedBy == "" {
		return nil, false, nil
	}
	if a.ClaimedBy == nil || *a.ClaimedBy != claimedBy {
		return nil, false, nil
	}
	now := time.Now().UTC()
	a.ClaimedAt = &now
	return copyAction(a), true, nil
}

func (f *fenceFakeStore) ReleaseAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, 0, store.ErrActionNotFound
	}
	if a.State != "executing" {
		return nil, 0, fmt.Errorf("%w: not executing", store.ErrIllegalActionState)
	}
	a.State, a.ClaimedBy, a.ClaimedAt = "approved", nil, nil
	return copyAction(a), 1, nil
}

func (f *fenceFakeStore) AppendActionAudit(_ context.Context, _ uuid.UUID, id uuid.UUID, entry store.ContentAudit) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
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

func (f *fenceFakeStore) DeleteAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.actions, id)
	f.deleted = append(f.deleted, id)
	return 1, nil
}

func (f *fenceFakeStore) TouchOrCreateAgent(context.Context, uuid.UUID, string) error { return nil }

func (f *fenceFakeStore) GetCanvasState(context.Context, uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in tests")
}

// expireClaim backdates the lease so the next claim takes it over — the lapse
// this whole file is about, without waiting 15 minutes for it.
func (f *fenceFakeStore) expireClaim(id uuid.UUID) {
	f.mu.Lock()
	defer f.mu.Unlock()
	old := time.Now().UTC().Add(-30 * time.Minute)
	f.actions[id].ClaimedAt = &old
}

func (f *fenceFakeStore) task(id uuid.UUID) *store.Action {
	f.mu.Lock()
	defer f.mu.Unlock()
	return copyAction(f.actions[id])
}

func (f *fenceFakeStore) generation(id uuid.UUID) int {
	return store.ReadClaimRecord(f.task(id).Payload).Generation
}

func (f *fenceFakeStore) holder(id uuid.UUID) string {
	a := f.task(id)
	if a == nil || a.ClaimedBy == nil {
		return ""
	}
	return *a.ClaimedBy
}

func (f *fenceFakeStore) wasDeleted(id uuid.UUID) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, d := range f.deleted {
		if d == id {
			return true
		}
	}
	return false
}

func copyAction(a *store.Action) *store.Action {
	if a == nil {
		return nil
	}
	cp := *a
	return &cp
}

// ── Request helpers ──────────────────────────────────────────────────────────

func fenceTask() *store.Action {
	return &store.Action{
		ID: uuid.New(), Kind: "action", Type: "task", State: "approved",
		Ticket:  ptr(98),
		Payload: json.RawMessage(`{"title":"fence every write path","assignee":"agent"}`),
	}
}

// claimVia is the MCP/web claim: PATCH {state:"executing"}. Returns the fencing
// token the response handed back.
func claimVia(t *testing.T, h *Handler, canvasID, id uuid.UUID, agent string) int {
	t.Helper()
	w := patchTask(t, h, canvasID, id, map[string]any{"state": "executing", "agentName": agent})
	if w.Code != http.StatusOK {
		t.Fatalf("%s claim: status %d, body %s", agent, w.Code, w.Body)
	}
	got := decodeMap(t, w)
	claim, ok := got["claim"].(map[string]any)
	if !ok {
		t.Fatalf("%s claim response carries no `claim` block: %s", agent, w.Body)
	}
	if claim["holder"] != agent {
		t.Fatalf("claim.holder = %v, want %q", claim["holder"], agent)
	}
	gen, ok := claim["generation"].(float64)
	if !ok || gen <= 0 {
		t.Fatalf("claim.generation = %v, want a positive number", claim["generation"])
	}
	return int(gen)
}

// assertFenced checks the ONE refusal shape: 409, fenced:true, the code, and the
// holder named twice (holder + the claimedBy alias older clients read).
func assertFenced(t *testing.T, w *httptest.ResponseRecorder, code, holder string) map[string]any {
	t.Helper()
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (fenced); body %s", w.Code, w.Body)
	}
	got := decodeMap(t, w)
	if got["fenced"] != true {
		t.Errorf("fenced = %v, want true — a client must be able to branch on one flag: %s", got["fenced"], w.Body)
	}
	if got["error"] != code || got["reason"] != code {
		t.Errorf("error/reason = %v/%v, want %q (body %s)", got["error"], got["reason"], code, w.Body)
	}
	if got["holder"] != holder || got["claimedBy"] != holder {
		t.Errorf("holder/claimedBy = %v/%v, want %q", got["holder"], got["claimedBy"], holder)
	}
	msg, _ := got["message"].(string)
	if len(msg) < 4 || msg[:4] != "STOP" {
		t.Errorf("message = %q, want it to open with STOP — the whole point is that the worker stops", msg)
	}
	return got
}

// asAgent stamps the provenance an MCP-gateway call arrives with (the
// X-Tandem-Agent header, already derived by the Provenance middleware), which is
// how surfaces with no agent field in their body — /move, DELETE — know who is
// calling.
func byAgent(r *http.Request, name string) *http.Request {
	return r.WithContext(WithAuthor(r.Context(), "agent:"+name))
}

func moveTask(t *testing.T, h *Handler, canvasID, id uuid.UUID, body map[string]any, agent string) *httptest.ResponseRecorder {
	t.Helper()
	r := canvasRequest(t, "POST", "/api/canvas/actions/"+id.String()+"/move", body, canvasID, id.String())
	if agent != "" {
		r = byAgent(r, agent)
	}
	w := httptest.NewRecorder()
	h.MoveAction(w, r)
	return w
}

// ── (1) The race: an expired lease's old holder cannot write ──────────────────

// THE test. worker-a claims, goes quiet past its lease, worker-b takes the task
// over — and everything worker-a does afterwards is refused, whether it presents
// its stale token or nothing at all. Then the case identity alone cannot see:
// worker-b lapses too, worker-a takes the task BACK, and worker-a's write from
// its FIRST lease is still refused, because the generation moved even though the
// holder's name came full circle.
func TestReclaimAfterExpiryFencesTheOldHolder(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	genA := claimVia(t, h, canvasID, task.ID, "worker-a")
	if genA != 1 {
		t.Fatalf("first claim generation = %d, want 1", genA)
	}

	// worker-a goes dark; worker-b takes over. A takeover is a NEW lease.
	fake.expireClaim(task.ID)
	genB := claimVia(t, h, canvasID, task.ID, "worker-b")
	if genB != 2 {
		t.Fatalf("takeover generation = %d, want 2 — a new lease must mint a new token", genB)
	}

	// worker-a comes back and tries to finish. Refused: it is not the holder.
	w := patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "claimGeneration": genA, "result": "I thought this was mine",
	})
	assertFenced(t, w, fenceCodeOther, "worker-b")
	if state := fake.task(task.ID).State; state != "executing" {
		t.Fatalf("task state = %q, want executing — the fenced write must not land", state)
	}

	// Same refusal for a worker-a that presents no token at all (every client that
	// predates the fencing token behaves exactly like this).
	w = patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "result": "still not mine",
	})
	assertFenced(t, w, fenceCodeOther, "worker-b")

	// Now the interesting half. worker-b lapses; worker-a legitimately takes the
	// task back, so it IS the holder again — and its lease-1 write must STILL die.
	fake.expireClaim(task.ID)
	genA2 := claimVia(t, h, canvasID, task.ID, "worker-a")
	if genA2 != 3 {
		t.Fatalf("re-claim generation = %d, want 3 (generations never reset)", genA2)
	}
	w = patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "claimGeneration": genA, "result": "a write from lease 1",
	})
	got := assertFenced(t, w, fenceCodeStale, "worker-a")
	if got["claimGeneration"] != float64(3) {
		t.Errorf("refusal reports claimGeneration=%v, want 3 — the caller needs the live token", got["claimGeneration"])
	}
	if state := fake.task(task.ID).State; state != "executing" {
		t.Fatalf("task state = %q, want executing — a stale-generation write must not land", state)
	}

	// The CURRENT lease's token still works, on the same task, right after.
	w = patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "claimGeneration": genA2, "result": "lease 3 finishing its own work",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("holder complete with the live generation = %d, want 200; body %s", w.Code, w.Body)
	}
	if state := fake.task(task.ID).State; state != "done" {
		t.Fatalf("task state = %q, want done", state)
	}
}

// Generations are a per-task counter that only ever goes up: across a takeover, a
// human release and a fresh claim, nothing resets and nothing is reused. If they
// reset, a stale token from an earlier lease would eventually verify as live.
func TestGenerationContinuityAcrossReclaims(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	if got := claimVia(t, h, canvasID, task.ID, "worker-a"); got != 1 {
		t.Fatalf("claim 1 generation = %d, want 1", got)
	}
	fake.expireClaim(task.ID)
	if got := claimVia(t, h, canvasID, task.ID, "worker-b"); got != 2 {
		t.Fatalf("takeover generation = %d, want 2", got)
	}

	// A human releases the stuck task (the escape hatch — unfenced, by design).
	r := canvasRequest(t, "POST", "/api/canvas/actions/"+task.ID.String()+"/release", map[string]any{}, canvasID, task.ID.String())
	w := httptest.NewRecorder()
	h.ReleaseAction(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("human release = %d, want 200; body %s", w.Code, w.Body)
	}
	if holder := fake.holder(task.ID); holder != "" {
		t.Fatalf("released task still claimed by %q", holder)
	}
	// The record SURVIVES the release: the next claim keeps counting up, so the
	// released holder's token can never come back into validity.
	if got := fake.generation(task.ID); got != 2 {
		t.Fatalf("generation after release = %d, want 2 (kept, not cleared)", got)
	}
	if got := claimVia(t, h, canvasID, task.ID, "worker-c"); got != 3 {
		t.Fatalf("claim after release = %d, want 3", got)
	}
}

// A claimant retrying its own live claim (a lost response, a harness retry) must
// get the SAME token back, not a new one — otherwise a retry silently invalidates
// the token the worker is already carrying.
func TestIdempotentReclaimKeepsTheGeneration(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	first := claimVia(t, h, canvasID, task.ID, "worker-a")
	again := claimVia(t, h, canvasID, task.ID, "worker-a")
	if first != again {
		t.Fatalf("idempotent reclaim changed the token: %d → %d", first, again)
	}
	if got := fake.generation(task.ID); got != first {
		t.Fatalf("stored generation = %d, want %d", got, first)
	}
}

// ── (2) Every write path refuses a non-holder, and identically ────────────────

// The uniformity test: one task held by worker-a, and every door worker-b can
// knock on. Before this the answer differed by door — the completion PATCH
// checked, /move did not, the payload PATCH did not. All of them must refuse, with
// the same body.
func TestNonHolderWritesAreFencedOnEveryPath(t *testing.T) {
	tests := []struct {
		name string
		// call performs the rival's write and returns the response.
		call func(t *testing.T, h *Handler, fake *fenceFakeStore, canvasID uuid.UUID, id uuid.UUID, staleGen int) *httptest.ResponseRecorder
	}{{
		name: "complete via PATCH (MCP task_complete)",
		call: func(t *testing.T, h *Handler, _ *fenceFakeStore, canvasID, id uuid.UUID, _ int) *httptest.ResponseRecorder {
			return patchTask(t, h, canvasID, id, map[string]any{
				"state": "done", "agentName": "worker-b", "result": "not mine to finish",
			})
		},
	}, {
		name: "fail via PATCH",
		call: func(t *testing.T, h *Handler, _ *fenceFakeStore, canvasID, id uuid.UUID, _ int) *httptest.ResponseRecorder {
			return patchTask(t, h, canvasID, id, map[string]any{
				"state": "failed", "agentName": "worker-b", "error": "not mine to fail",
			})
		},
	}, {
		name: "progress via the status API",
		call: func(t *testing.T, h *Handler, _ *fenceFakeStore, canvasID, id uuid.UUID, _ int) *httptest.ResponseRecorder {
			return postStatus(t, h, canvasID, id, map[string]any{
				"state": "progress", "agent": "worker-b", "summary": "reporting on someone else's task",
			})
		},
	}, {
		name: "complete via the status API",
		call: func(t *testing.T, h *Handler, _ *fenceFakeStore, canvasID, id uuid.UUID, _ int) *httptest.ResponseRecorder {
			return postStatus(t, h, canvasID, id, map[string]any{
				"state": "completed", "agent": "worker-b", "summary": "closing someone else's task",
			})
		},
	}, {
		name: "complete via POST /move",
		call: func(t *testing.T, h *Handler, _ *fenceFakeStore, canvasID, id uuid.UUID, _ int) *httptest.ResponseRecorder {
			return moveTask(t, h, canvasID, id, map[string]any{"to": "done", "note": "marking a peer's card done"}, "worker-b")
		},
	}, {
		name: "release via POST /move (rewind)",
		call: func(t *testing.T, h *Handler, _ *fenceFakeStore, canvasID, id uuid.UUID, _ int) *httptest.ResponseRecorder {
			return moveTask(t, h, canvasID, id, map[string]any{"to": "approved"}, "worker-b")
		},
	}, {
		name: "release via POST /release",
		call: func(t *testing.T, h *Handler, _ *fenceFakeStore, canvasID, id uuid.UUID, _ int) *httptest.ResponseRecorder {
			r := canvasRequest(t, "POST", "/api/canvas/actions/"+id.String()+"/release", map[string]any{"agent": "worker-b"}, canvasID, id.String())
			w := httptest.NewRecorder()
			h.ReleaseAction(w, r)
			return w
		},
	}, {
		name: "content edit via payload-only PATCH",
		call: func(t *testing.T, h *Handler, _ *fenceFakeStore, canvasID, id uuid.UUID, _ int) *httptest.ResponseRecorder {
			return patchTask(t, h, canvasID, id, map[string]any{
				"agentName": "worker-b",
				"payload":   map[string]any{"title": "rewritten under a peer's feet", "assignee": "agent"},
			})
		},
	}, {
		name: "delete",
		call: func(t *testing.T, h *Handler, _ *fenceFakeStore, canvasID, id uuid.UUID, _ int) *httptest.ResponseRecorder {
			r := byAgent(canvasRequest(t, "DELETE", "/api/canvas/actions/"+id.String(), nil, canvasID, id.String()), "worker-b")
			w := httptest.NewRecorder()
			h.DeleteAction(w, r)
			return w
		},
	}, {
		name: "stale generation, right name (progress)",
		call: func(t *testing.T, h *Handler, _ *fenceFakeStore, canvasID, id uuid.UUID, staleGen int) *httptest.ResponseRecorder {
			return postStatus(t, h, canvasID, id, map[string]any{
				"state": "progress", "agent": "worker-a", "summary": "from a lease that ended",
				"claimGeneration": staleGen,
			})
		},
	}}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			canvasID := uuid.New()
			task := fenceTask()
			fake := newFenceStore(task)
			h := NewHandler(fake, nil, nil)

			gen := claimVia(t, h, canvasID, task.ID, "worker-a")
			// The stale-generation row needs a lease that ended: bump the counter by
			// letting worker-a re-take its own lapsed claim, so `gen` is now old but
			// the holder is unchanged.
			staleGen := gen
			if tc.name == "stale generation, right name (progress)" {
				fake.expireClaim(task.ID)
				if next := claimVia(t, h, canvasID, task.ID, "worker-a"); next == staleGen {
					t.Fatalf("re-claim did not mint a new generation (%d)", next)
				}
			}

			w := tc.call(t, h, fake, canvasID, task.ID, staleGen)
			wantCode := fenceCodeOther
			if tc.name == "stale generation, right name (progress)" {
				wantCode = fenceCodeStale
			}
			assertFenced(t, w, wantCode, "worker-a")

			// Nothing moved, nothing was deleted, and the holder is untouched.
			if fake.wasDeleted(task.ID) {
				t.Fatalf("the task was deleted by a fenced caller")
			}
			stored := fake.task(task.ID)
			if stored.State != "executing" {
				t.Errorf("state = %q, want executing", stored.State)
			}
			if holder := fake.holder(task.ID); holder != "worker-a" {
				t.Errorf("holder = %q, want worker-a", holder)
			}
			var payload map[string]any
			if err := json.Unmarshal(stored.Payload, &payload); err != nil {
				t.Fatalf("payload: %v", err)
			}
			if payload["title"] != "fence every write path" {
				t.Errorf("title = %v, want it untouched", payload["title"])
			}
			if payload["progress"] != nil {
				t.Errorf("a fenced progress report was recorded anyway: %v", payload["progress"])
			}
		})
	}
}

// The holder's own writes must sail through — all of them. A fence that also
// stops the agent doing the work is worse than no fence, because every worker
// strands its task in 'executing'.
func TestHolderWritesPassTheFence(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	gen := claimVia(t, h, canvasID, task.ID, "worker-a")

	w := postStatus(t, h, canvasID, task.ID, map[string]any{
		"state": "progress", "agent": "worker-a", "summary": "halfway", "claimGeneration": gen,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("holder progress = %d, want 200; body %s", w.Code, w.Body)
	}
	w = patchTask(t, h, canvasID, task.ID, map[string]any{
		"agentName": "worker-a", "claimGeneration": gen,
		"payload": map[string]any{"title": "fence every write path", "assignee": "agent", "linkedIds": []string{}},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("holder payload write = %d, want 200; body %s", w.Code, w.Body)
	}
	w = patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "claimGeneration": gen, "result": "shipped",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("holder complete = %d, want 200; body %s", w.Code, w.Body)
	}
	if state := fake.task(task.ID).State; state != "done" {
		t.Fatalf("state = %q, want done", state)
	}
}

// ── (3) The human escape hatch stays open ─────────────────────────────────────

// A person on the board asserts no claim identity, and must therefore still be
// able to move, finish, release and delete a card an agent is holding — that IS
// what those controls are for (unsticking a dead worker). If the fence closed
// this, a fleet that died would leave a board nobody could clean up.
func TestUnidentifiedCallerKeepsTheEscapeHatch(t *testing.T) {
	canvasID := uuid.New()

	t.Run("complete", func(t *testing.T) {
		task := fenceTask()
		fake := newFenceStore(task)
		h := NewHandler(fake, nil, nil)
		claimVia(t, h, canvasID, task.ID, "worker-a")
		w := moveTask(t, h, canvasID, task.ID, map[string]any{"to": "done", "note": "the agent finished, I saw the PR"}, "")
		if w.Code != http.StatusOK {
			t.Fatalf("human complete of an agent-held task = %d, want 200; body %s", w.Code, w.Body)
		}
	})

	t.Run("release", func(t *testing.T) {
		task := fenceTask()
		fake := newFenceStore(task)
		h := NewHandler(fake, nil, nil)
		claimVia(t, h, canvasID, task.ID, "worker-a")
		w := moveTask(t, h, canvasID, task.ID, map[string]any{"to": "approved"}, "")
		if w.Code != http.StatusOK {
			t.Fatalf("human release of an agent-held task = %d, want 200; body %s", w.Code, w.Body)
		}
		if holder := fake.holder(task.ID); holder != "" {
			t.Fatalf("holder = %q, want the claim cleared", holder)
		}
	})

	t.Run("delete", func(t *testing.T) {
		task := fenceTask()
		fake := newFenceStore(task)
		h := NewHandler(fake, nil, nil)
		claimVia(t, h, canvasID, task.ID, "worker-a")
		r := canvasRequest(t, "DELETE", "/api/canvas/actions/"+task.ID.String(), nil, canvasID, task.ID.String())
		w := httptest.NewRecorder()
		h.DeleteAction(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("human delete of an agent-held task = %d, want 200; body %s", w.Code, w.Body)
		}
		if !fake.wasDeleted(task.ID) {
			t.Fatal("the task was not deleted")
		}
	})
}

// The generation cannot be forged through the one door that writes a payload
// wholesale alongside a state change: a caller that sends its own claim record on
// a completion gets the STORED one written back, so it cannot lower the number
// its next write will be fenced by.
func TestPayloadCannotForgeTheClaimRecord(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	gen := claimVia(t, h, canvasID, task.ID, "worker-a")
	w := patchTask(t, h, canvasID, task.ID, map[string]any{
		"state": "done", "agentName": "worker-a", "claimGeneration": gen,
		"payload": map[string]any{
			"title":    "fence every write path",
			"assignee": "agent",
			"claim":    map[string]any{"generation": 99, "holder": "worker-b"},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("holder complete = %d, want 200; body %s", w.Code, w.Body)
	}
	if got := fake.generation(task.ID); got != gen {
		t.Fatalf("stored generation = %d, want the server's %d — a caller rewrote the fencing token", got, gen)
	}
	rec := store.ReadClaimRecord(fake.task(task.ID).Payload)
	if rec.Holder != "worker-a" {
		t.Fatalf("stored claim holder = %q, want worker-a", rec.Holder)
	}
}

// ── (4) The rule itself, without HTTP ─────────────────────────────────────────

func TestFenceTaskWriteRules(t *testing.T) {
	withClaim := func(holder string, gen int) *store.Action {
		a := &store.Action{ID: uuid.New(), Type: "task", State: "executing",
			Payload: json.RawMessage(`{"title":"t"}`)}
		if holder != "" {
			h := holder
			now := time.Now().UTC()
			a.ClaimedBy, a.ClaimedAt = &h, &now
		}
		if gen > 0 {
			next, err := store.WithClaimRecord(a.Payload, store.ClaimRecord{Generation: gen, Holder: holder})
			if err != nil {
				t.Fatal(err)
			}
			a.Payload = next
		}
		return a
	}

	tests := []struct {
		name    string
		action  *store.Action
		caller  claimant
		wantNil bool
		wantOne string
	}{
		{"nobody presented anything", withClaim("worker-a", 3), claimant{}, true, ""},
		{"holder, matching generation", withClaim("worker-a", 3), claimant{name: "worker-a", generation: 3}, true, ""},
		{"holder, no generation presented", withClaim("worker-a", 3), claimant{name: "worker-a"}, true, ""},
		{"holder, task has no record", withClaim("worker-a", 0), claimant{name: "worker-a", generation: 7}, true, ""},
		{"rival", withClaim("worker-a", 3), claimant{name: "worker-b", generation: 3}, false, fenceCodeOther},
		{"holder, stale generation", withClaim("worker-a", 3), claimant{name: "worker-a", generation: 2}, false, fenceCodeStale},
		{"token only, stale", withClaim("worker-a", 3), claimant{generation: 1}, false, fenceCodeStale},
		{"anonymous holder blocks nobody", withClaim("agent", 0), claimant{name: "worker-b"}, true, ""},
		{"unclaimed task", withClaim("", 0), claimant{name: "worker-b", generation: 4}, true, ""},
		{"not a task", &store.Action{Type: "epic", State: "executing"}, claimant{name: "worker-b"}, true, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := fenceTaskWrite(tc.action, tc.caller)
			if tc.wantNil {
				if got != nil {
					t.Fatalf("fenced (%s: %s), want allowed", got.Code, got.Message)
				}
				return
			}
			if got == nil {
				t.Fatalf("allowed, want fenced with %s", tc.wantOne)
			}
			if got.Code != tc.wantOne {
				t.Fatalf("code = %q, want %q", got.Code, tc.wantOne)
			}
		})
	}
}

// callerClaim's header fallback is what fences the surfaces whose body has no
// agent field. It must read an agent identity and ONLY an agent identity: a
// human or anonymous provenance string presents nothing, which is what keeps the
// board's escape hatch open.
func TestCallerClaimIdentitySources(t *testing.T) {
	base := func(author string) *http.Request {
		r := httptest.NewRequest("POST", "/x", nil)
		if author != "" {
			r = r.WithContext(WithAuthor(r.Context(), author))
		}
		return r
	}
	tests := []struct {
		name      string
		author    string
		bodyAgent string
		bodyGen   int
		wantName  string
		wantGen   int
		wantOn    bool
	}{
		{"body agent wins", "agent:from-header", "from-body", 4, "from-body", 4, true},
		{"header fallback", "agent:from-header", "", 0, "from-header", 0, true},
		{"human presents nothing", AuthorHuman, "", 0, "", 0, false},
		{"anonymous presents nothing", AuthorAnonymous, "", 0, "", 0, false},
		{"no provenance at all", "", "", 0, "", 0, false},
		{"generation alone is enough to fence", AuthorHuman, "", 9, "", 9, true},
		{"negative generation is no generation", "", "", -3, "", 0, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := callerClaim(base(tc.author), tc.bodyAgent, tc.bodyGen)
			if got.name != tc.wantName || got.generation != tc.wantGen || got.presented() != tc.wantOn {
				t.Fatalf("callerClaim = %+v (presented %v), want name %q gen %d presented %v",
					got, got.presented(), tc.wantName, tc.wantGen, tc.wantOn)
			}
		})
	}
}

// Approve and reject must never be fenced: a proposed task has no holder, and
// the approval gate is the product. A regression that fenced them would break
// the queue for every task an agent proposed under its own identity.
func TestApprovalIsNotFenced(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	task.State = "proposed"
	fake := newFenceStore(task)
	h := NewHandler(fake, nil, nil)

	// The caller is a human — approval is the human gate (TDM-129); canvasRequest
	// stamps human provenance. The point here is the CLAIM FENCE: ApproveAction
	// passes a zero claimant, so approve is never fenced even on a task carrying
	// claim state.
	r := canvasRequest(t, "POST", "/api/canvas/actions/"+task.ID.String()+"/approve",
		nil, canvasID, task.ID.String())
	w := httptest.NewRecorder()
	h.ApproveAction(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("approve = %d, want 200; body %s", w.Code, w.Body)
	}
	if state := fake.task(task.ID).State; state != "approved" {
		t.Fatalf("state = %q, want approved", state)
	}
}

// A refused write is COUNTED (TDM-98): fenced_writes is the number of times an
// agent tried to write to work it had lost — the double-execution the fence
// prevented, which no other counter can show. It rides the shared refusal, so a
// new write path cannot start refusing silently.
func TestFencedWritesAreCounted(t *testing.T) {
	canvasID := uuid.New()
	task := fenceTask()
	fake := newFenceStore(task)
	reg := metrics.NewRegistry()
	h := NewHandler(fake, nil, nil, WithMetrics(reg))

	gen := claimVia(t, h, canvasID, task.ID, "worker-a")
	if got := counters(reg).FencedWrites; got != 0 {
		t.Fatalf("fenced_writes = %d before any refusal, want 0", got)
	}

	// A rival completing, then the old holder writing under a dead lease.
	patchTask(t, h, canvasID, task.ID, map[string]any{"state": "done", "agentName": "worker-b"})
	fake.expireClaim(task.ID)
	claimVia(t, h, canvasID, task.ID, "worker-a") // a new lease, so `gen` is stale
	postStatus(t, h, canvasID, task.ID, map[string]any{
		"state": "progress", "agent": "worker-a", "summary": "from the old lease", "claimGeneration": gen,
	})

	if got := counters(reg).FencedWrites; got != 2 {
		t.Fatalf("fenced_writes = %d, want 2 (one non-holder, one stale generation)", got)
	}

	// A claim LOST at the door is a DIFFERENT signal and must not be folded in:
	// that caller is told to take other work, not to stop writing.
	w := patchTask(t, h, canvasID, task.ID, map[string]any{"state": "executing", "agentName": "worker-b"})
	if w.Code != http.StatusConflict || decodeMap(t, w)["error"] != "already_claimed" {
		t.Fatalf("rival claim = %d %s, want 409 already_claimed", w.Code, w.Body)
	}
	got := counters(reg)
	if got.ClaimConflicts != 1 {
		t.Errorf("claim_conflicts = %d, want 1", got.ClaimConflicts)
	}
	if got.FencedWrites != 2 {
		t.Errorf("fenced_writes = %d, want 2 — a lost claim is not a fenced write", got.FencedWrites)
	}
}
