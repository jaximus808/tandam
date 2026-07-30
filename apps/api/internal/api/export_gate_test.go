package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// exportGateStore is a minimal store for the export visibility gate (TDM-130). It
// resolves a canvas by code and answers ResolveCanvasRole the way the real store
// does for an ANONYMOUS caller: a private canvas is "none", anything else is read.
type exportGateStore struct {
	store.Store
	canvas *store.Canvas
}

func (f *exportGateStore) GetCanvasByCode(_ context.Context, _ string) (*store.Canvas, error) {
	return f.canvas, nil
}
func (f *exportGateStore) ResolveCanvasRole(_ context.Context, canvas *store.Canvas, uid *uuid.UUID) (string, error) {
	if uid == nil && canvas.Visibility == "private" {
		return "none", nil
	}
	return "read", nil
}
func (f *exportGateStore) GetCanvasState(_ context.Context, id uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return f.canvas, &store.CanvasState{
		Events:    map[string]*store.Event{},
		Sheets:    map[string]*store.Sheet{},
		SheetRows: map[string]*store.SheetRow{},
	}, nil, nil
}

func exportRequest(t *testing.T, path, code string, pathParams map[string]string, query string) *http.Request {
	t.Helper()
	r := httptest.NewRequest("GET", path+query, nil)
	rctx := chi.NewRouteContext()
	for k, v := range pathParams {
		rctx.URLParams.Add(k, v)
	}
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// A private canvas must NOT expose its itinerary to an anonymous code-holder
// (no session cookie → nil uid → role "none" → 403), the same gate ServeWS applies.
func TestItineraryExportBlocksPrivateAnon(t *testing.T) {
	fake := &exportGateStore{canvas: &store.Canvas{ID: uuid.New(), Name: "secret trip", Visibility: "private"}}
	h := NewHandler(fake, nil, nil) // no authSvc → every caller is anonymous
	w := httptest.NewRecorder()
	h.ExportItineraryICS(w, exportRequest(t, "/api/canvas/ABCD1234/itinerary.ics", "", map[string]string{"code": "ABCD1234"}, ""))
	if w.Code != http.StatusForbidden {
		t.Fatalf("private itinerary export = %d, want 403; body %s", w.Code, w.Body)
	}
}

// A public canvas still serves the itinerary to an anonymous caller.
func TestItineraryExportAllowsPublic(t *testing.T) {
	fake := &exportGateStore{canvas: &store.Canvas{ID: uuid.New(), Name: "open trip", Visibility: "public"}}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ExportItineraryICS(w, exportRequest(t, "/api/canvas/ABCD1234/itinerary.ics", "", map[string]string{"code": "ABCD1234"}, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("public itinerary export = %d, want 200; body %s", w.Code, w.Body)
	}
}

// Same gate for the sheet export.
func TestSheetExportBlocksPrivateAnon(t *testing.T) {
	fake := &exportGateStore{canvas: &store.Canvas{ID: uuid.New(), Name: "secret", Visibility: "private"}}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ExportSheet(w, exportRequest(t, "/api/canvas/sheets/"+uuid.New().String()+"/export",
		"", map[string]string{"id": uuid.New().String()}, "?code=ABCD1234"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("private sheet export = %d, want 403; body %s", w.Code, w.Body)
	}
}
