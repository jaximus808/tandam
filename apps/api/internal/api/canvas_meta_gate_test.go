package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// canvasMetaStore backs the GET /api/canvases/{code} metadata gate (TDM-139). It
// returns a fixed canvas and a configurable resolved role.
type canvasMetaStore struct {
	store.Store
	canvas *store.Canvas
	role   string
}

func (f *canvasMetaStore) GetCanvasByCode(_ context.Context, _ string) (*store.Canvas, error) {
	return f.canvas, nil
}
func (f *canvasMetaStore) ResolveCanvasRole(_ context.Context, _ *store.Canvas, _ *uuid.UUID) (string, error) {
	return f.role, nil
}

func metaRequest(t *testing.T, code string) *http.Request {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/canvases/"+code, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("code", code)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// A private canvas returns an existence-agnostic 404 to an ungranted caller —
// same as a nonexistent code, so a guesser can't confirm it exists or read its
// name/owner.
func TestGetCanvasByCodePrivateUngrantedIs404(t *testing.T) {
	fake := &canvasMetaStore{
		canvas: &store.Canvas{ID: uuid.New(), Name: "secret", Visibility: "private"},
		role:   "none",
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.GetCanvasByCode(w, metaRequest(t, "ABCD1234"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("private/ungranted = %d, want 404 (existence-agnostic); body %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), "secret") {
		t.Fatalf("404 body leaked the private canvas name: %s", w.Body)
	}
}

// A private canvas the caller IS granted on returns its metadata.
func TestGetCanvasByCodePrivateGrantedOK(t *testing.T) {
	fake := &canvasMetaStore{
		canvas: &store.Canvas{ID: uuid.New(), Name: "secret", Visibility: "private"},
		role:   "read",
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.GetCanvasByCode(w, metaRequest(t, "ABCD1234"))
	if w.Code != http.StatusOK {
		t.Fatalf("private/granted = %d, want 200; body %s", w.Code, w.Body)
	}
}

// A public canvas serves its metadata to anyone with the code (unchanged).
func TestGetCanvasByCodePublicOK(t *testing.T) {
	fake := &canvasMetaStore{
		canvas: &store.Canvas{ID: uuid.New(), Name: "open", Visibility: "public"},
		role:   "read",
	}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.GetCanvasByCode(w, metaRequest(t, "ABCD1234"))
	if w.Code != http.StatusOK {
		t.Fatalf("public = %d, want 200; body %s", w.Code, w.Body)
	}
}
