package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func TestParseTicketRef(t *testing.T) {
	ok := map[string]int{
		"TDM-21":   21,
		"tdm-21":   21,
		"Tdm-21":   21,
		"#21":      21,
		"21":       21,
		"  TDM-7 ": 7,
		"TDM-142":  142,
	}
	for in, want := range ok {
		got, valid := parseTicketRef(in)
		if !valid || got != want {
			t.Errorf("parseTicketRef(%q) = (%d, %v), want (%d, true)", in, got, valid, want)
		}
	}

	// A uuid must NOT parse as a ticket — it takes the fast path instead, and a
	// ticket parse that swallowed it would resolve the wrong row.
	bad := []string{
		"", "TDM-", "TDM-x", "abc", "TDM-0", "0", "-4", "TDM--1", "1.5", "21abc",
		"9f1c4b2a-0000-4000-8000-000000000000",
	}
	for _, in := range bad {
		if got, valid := parseTicketRef(in); valid {
			t.Errorf("parseTicketRef(%q) = (%d, true), want invalid", in, got)
		}
	}
}

// ticketRefFakeStore records ticket lookups so a test can prove the uuid fast
// path never touches the store. `failWith`, when set, is returned instead of a
// not-found — the store-is-broken case, which must NOT be reported as a 404.
type ticketRefFakeStore struct {
	store.Store
	byTicket map[int]*store.Action
	lookups  int
	failWith error
}

func (f *ticketRefFakeStore) GetActionByTicket(_ context.Context, _ uuid.UUID, ticket int) (*store.Action, error) {
	f.lookups++
	if f.failWith != nil {
		return nil, f.failWith
	}
	if a, ok := f.byTicket[ticket]; ok {
		return a, nil
	}
	// Same contract the real store honours: a missing ticket wraps
	// ErrActionNotFound so the middleware can tell it from a lookup failure.
	return nil, fmt.Errorf("no task %s: %w", store.TicketID(ticket), store.ErrActionNotFound)
}

// serveTicketRef runs one request through the middleware and reports the {id}
// the downstream handler observed (empty when the middleware answered itself),
// plus the response it produced.
func serveTicketRef(t *testing.T, s store.Store, canvasID uuid.UUID, rawID string) (string, *httptest.ResponseRecorder) {
	t.Helper()
	var seen string
	r := chi.NewRouter()
	r.With(ResolveTicketRef(s)).Get("/api/canvas/actions/{id}", func(w http.ResponseWriter, req *http.Request) {
		seen = chi.URLParam(req, "id")
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/canvas/actions/"+rawID, nil)
	ctx := context.WithValue(req.Context(), claimsKey, &auth.Claims{CanvasID: canvasID, Role: "write"})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req.WithContext(ctx))
	return seen, rec
}

func TestResolveTicketRefRewritesTicketToUUID(t *testing.T) {
	canvasID := uuid.New()
	taskID := uuid.New()
	ticket := 21
	fake := &ticketRefFakeStore{byTicket: map[int]*store.Action{
		ticket: {ID: taskID, Type: "task", State: "approved", Ticket: &ticket},
	}}

	if got, _ := serveTicketRef(t, fake, canvasID, "TDM-21"); got != taskID.String() {
		t.Errorf("handler saw id %q, want the resolved uuid %q", got, taskID)
	}
	if fake.lookups != 1 {
		t.Errorf("ticket lookups = %d, want exactly 1", fake.lookups)
	}
}

func TestResolveTicketRefUUIDFastPathSkipsStore(t *testing.T) {
	canvasID := uuid.New()
	taskID := uuid.New()
	fake := &ticketRefFakeStore{byTicket: map[int]*store.Action{}}

	if got, _ := serveTicketRef(t, fake, canvasID, taskID.String()); got != taskID.String() {
		t.Errorf("handler saw id %q, want the uuid unchanged %q", got, taskID)
	}
	if fake.lookups != 0 {
		t.Errorf("uuid path did %d ticket lookups, want 0 — existing callers must pay nothing", fake.lookups)
	}
}

// TDM-95: a well-formed ref for a task that isn't here is answered by the
// middleware — 404 task_not_found, naming the ref — instead of being passed
// through for the handler to mislabel as a malformed id (400 invalid_id).
func TestResolveTicketRefUnknownTicket404s(t *testing.T) {
	canvasID := uuid.New()
	fake := &ticketRefFakeStore{byTicket: map[int]*store.Action{}}

	seen, rec := serveTicketRef(t, fake, canvasID, "TDM-99999")
	if seen != "" {
		t.Errorf("handler ran with id %q; the middleware should have answered instead", seen)
	}
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not the coded error envelope: %v (%s)", err, rec.Body.String())
	}
	if body["error"] != "task_not_found" {
		t.Errorf(`error = %q, want "task_not_found"`, body["error"])
	}
	if body["ticketRef"] != "TDM-99999" {
		t.Errorf(`ticketRef = %q, want "TDM-99999"`, body["ticketRef"])
	}
	// The message has to name the ref (that is the whole complaint: the old 400
	// said "invalid id" about an id that was perfectly valid) and route the caller
	// somewhere real.
	if !strings.Contains(body["message"], "TDM-99999") || !strings.Contains(body["message"], "queue_next") {
		t.Errorf("message does not name the ref and a way out: %q", body["message"])
	}
	if fake.lookups != 1 {
		t.Errorf("ticket lookups = %d, want 1", fake.lookups)
	}
}

// A BROKEN lookup is not a missing ticket: reporting it as 404 would send the
// caller off double-checking a number that was fine. It keeps the old
// pass-through behaviour so the handler answers as it always did.
func TestResolveTicketRefLookupFailurePassesThrough(t *testing.T) {
	canvasID := uuid.New()
	fake := &ticketRefFakeStore{
		byTicket: map[int]*store.Action{},
		failWith: errors.New("supabase: connection refused"),
	}

	seen, rec := serveTicketRef(t, fake, canvasID, "TDM-21")
	if seen != "TDM-21" {
		t.Errorf("handler saw id %q, want the ref passed through unchanged", seen)
	}
	if rec.Code == http.StatusNotFound {
		t.Error("a store failure was reported as 404 task_not_found")
	}
}

func TestResolveTicketRefNoCanvasSkipsLookup(t *testing.T) {
	fake := &ticketRefFakeStore{byTicket: map[int]*store.Action{}}
	// No claims in context (uuid.Nil canvas): resolving a per-canvas ticket
	// without knowing the canvas would be a cross-canvas read.
	var seen string
	r := chi.NewRouter()
	r.With(ResolveTicketRef(fake)).Get("/api/canvas/actions/{id}", func(w http.ResponseWriter, req *http.Request) {
		seen = chi.URLParam(req, "id")
	})
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/canvas/actions/TDM-21", nil))

	if seen != "TDM-21" {
		t.Errorf("handler saw id %q, want unchanged", seen)
	}
	if fake.lookups != 0 {
		t.Errorf("did %d lookups with no canvas in context, want 0", fake.lookups)
	}
}
