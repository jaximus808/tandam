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

// batchFakeStore backs the batch-honesty tests (TDM-138). It knows which pin ids
// exist in "this" canvas: UpdatePin/DeletePin return rows-affected = 1 for a known
// id and 0 for anything else (an absent or cross-canvas id — the silent no-op the
// real store returns via its canvas_id predicate). A failId is made to error, to
// exercise the partial-batch path.
type batchFakeStore struct {
	store.Store
	mu        sync.Mutex
	exists    map[uuid.UUID]bool
	failID    uuid.UUID
	bumpCalls int
}

func (f *batchFakeStore) affected(id uuid.UUID) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id == f.failID {
		return 0, fmt.Errorf("boom on %s", id)
	}
	if f.exists[id] {
		return 1, nil
	}
	return 0, nil
}

func (f *batchFakeStore) UpdatePin(_ context.Context, _ uuid.UUID, id uuid.UUID, _ store.PinPatch) (int, error) {
	return f.affected(id)
}
func (f *batchFakeStore) DeletePin(_ context.Context, _ uuid.UUID, id uuid.UUID) (int, error) {
	return f.affected(id)
}
func (f *batchFakeStore) BumpCanvasVersion(_ context.Context, _ uuid.UUID) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bumpCalls++
	return f.bumpCalls, nil
}

// GetCanvasState errors so the async post-write broadcast is a no-op in tests.
func (f *batchFakeStore) GetCanvasState(_ context.Context, _ uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in tests")
}

func batchReq(t *testing.T, path string, body any, canvasID uuid.UUID) *http.Request {
	t.Helper()
	return canvasRequest(t, "POST", path, body, canvasID, "")
}

// A batch update reports ONLY the ids that actually changed a row: an absent /
// cross-canvas id (0 rows) is not echoed back as applied (TDM-138).
func TestBatchUpdateReportsOnlyAffected(t *testing.T) {
	canvasID := uuid.New()
	real, absent := uuid.New(), uuid.New()
	fake := &batchFakeStore{exists: map[uuid.UUID]bool{real: true}}
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.UpdatePinsBatch(w, batchReq(t, "/api/canvas/pins/batch-update", map[string]any{
		"items": []map[string]any{
			{"id": real.String(), "label": "kept"},
			{"id": absent.String(), "label": "ghost"},
		},
	}, canvasID))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	var got struct {
		Updated []string `json:"updated"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if len(got.Updated) != 1 || got.Updated[0] != real.String() {
		t.Fatalf("updated = %v, want only the real id %s", got.Updated, real)
	}
	if fake.bumpCalls != 1 {
		t.Fatalf("bumpCalls = %d, want exactly 1 (something landed)", fake.bumpCalls)
	}
}

// A batch delete likewise reports only truly-deleted ids.
func TestBatchDeleteReportsOnlyAffected(t *testing.T) {
	canvasID := uuid.New()
	real, absent := uuid.New(), uuid.New()
	fake := &batchFakeStore{exists: map[uuid.UUID]bool{real: true}}
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.DeletePinsBatch(w, batchReq(t, "/api/canvas/pins/batch-delete", map[string]any{
		"ids": []string{real.String(), absent.String()},
	}, canvasID))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	var got struct {
		Deleted []string `json:"deleted"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if len(got.Deleted) != 1 || got.Deleted[0] != real.String() {
		t.Fatalf("deleted = %v, want only the real id %s", got.Deleted, real)
	}
}

// Nothing matched: no version bump, empty applied list — a batch of only
// cross-canvas / absent ids must not advance the version or claim success.
func TestBatchAllNoOpsDoesNotBump(t *testing.T) {
	canvasID := uuid.New()
	fake := &batchFakeStore{exists: map[uuid.UUID]bool{}}
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.DeletePinsBatch(w, batchReq(t, "/api/canvas/pins/batch-delete", map[string]any{
		"ids": []string{uuid.New().String(), uuid.New().String()},
	}, canvasID))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	if fake.bumpCalls != 0 {
		t.Fatalf("bumpCalls = %d, want 0 (nothing landed)", fake.bumpCalls)
	}
}

// A partial-batch failure STILL converges the canvas: the items that landed get a
// version bump + broadcast even though the batch as a whole returns 500 (TDM-138).
func TestPartialBatchFailureStillConverges(t *testing.T) {
	canvasID := uuid.New()
	good, bad := uuid.New(), uuid.New()
	fake := &batchFakeStore{exists: map[uuid.UUID]bool{good: true, bad: true}, failID: bad}
	h := NewHandler(fake, nil, nil)

	w := httptest.NewRecorder()
	h.DeletePinsBatch(w, batchReq(t, "/api/canvas/pins/batch-delete", map[string]any{
		"ids": []string{good.String(), bad.String()},
	}, canvasID))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 on partial failure; body %s", w.Code, w.Body)
	}
	// The good delete landed, so the version was bumped and viewers converge — the
	// whole point of the fix.
	if fake.bumpCalls != 1 {
		t.Fatalf("bumpCalls = %d, want 1 — a partial failure must still converge what landed", fake.bumpCalls)
	}
}

// A batch over the item cap is rejected up front with a 400, before any store call.
func TestBatchRejectsTooManyItems(t *testing.T) {
	canvasID := uuid.New()
	fake := &batchFakeStore{exists: map[uuid.UUID]bool{}}
	h := NewHandler(fake, nil, nil)

	ids := make([]string, maxBatchItems+1)
	for i := range ids {
		ids[i] = uuid.New().String()
	}
	w := httptest.NewRecorder()
	h.DeletePinsBatch(w, batchReq(t, "/api/canvas/pins/batch-delete", map[string]any{"ids": ids}, canvasID))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for an oversize batch; body %s", w.Code, w.Body)
	}
	if !strings.Contains(w.Body.String(), "too many items") {
		t.Fatalf("body = %s, want a 'too many items' message", w.Body)
	}
	if fake.bumpCalls != 0 {
		t.Fatalf("oversize batch must not touch the store; bumpCalls = %d", fake.bumpCalls)
	}
}
