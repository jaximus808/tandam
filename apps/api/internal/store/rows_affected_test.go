package store

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// TDM-138: the element UPDATE/DELETE store methods must surface the TRUE
// rows-affected (from PostgREST's count=exact Content-Range), so a batch handler
// can tell a real write from a 0-row no-op (an absent or cross-canvas id). This
// drives the shipped supabaseStore over a fake PostgREST that echoes the affected
// count in Content-Range, exactly as PostgREST does for a count-requested mutation.
type rowsAffectedServer struct{ affected string }

func (f *rowsAffectedServer) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "/rpc/bump_canvas_version") {
			w.Write([]byte("1"))
			return
		}
		// A count=exact mutation returns the affected count as the total in
		// Content-Range (the "*/N" form for a minimal return).
		w.Header().Set("Content-Range", "*/"+f.affected)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("[]"))
	})
}

func newRowsStore(t *testing.T, affected string) (Store, func()) {
	t.Helper()
	srv := httptest.NewServer((&rowsAffectedServer{affected: affected}).handler())
	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		srv.Close()
		t.Fatalf("NewSupabase: %v", err)
	}
	return st, srv.Close
}

func TestDeletePinReturnsRowsAffected(t *testing.T) {
	canvasID, id := uuid.New(), uuid.New()

	t.Run("hit → 1", func(t *testing.T) {
		st, done := newRowsStore(t, "1")
		defer done()
		n, err := st.DeletePin(context.Background(), canvasID, id)
		if err != nil {
			t.Fatalf("DeletePin: %v", err)
		}
		if n != 1 {
			t.Fatalf("rows-affected = %d, want 1", n)
		}
	})

	t.Run("miss (absent / cross-canvas) → 0", func(t *testing.T) {
		st, done := newRowsStore(t, "0")
		defer done()
		n, err := st.DeletePin(context.Background(), canvasID, id)
		if err != nil {
			t.Fatalf("DeletePin: %v", err)
		}
		if n != 0 {
			t.Fatalf("rows-affected = %d, want 0 — a no-op/cross-canvas delete must report 0", n)
		}
	})
}

func TestUpdatePinReturnsRowsAffected(t *testing.T) {
	canvasID, id := uuid.New(), uuid.New()
	st, done := newRowsStore(t, "1")
	defer done()
	label := "x"
	n, err := st.UpdatePin(context.Background(), canvasID, id, PinPatch{Label: &label})
	if err != nil {
		t.Fatalf("UpdatePin: %v", err)
	}
	if n != 1 {
		t.Fatalf("rows-affected = %d, want 1", n)
	}
}
