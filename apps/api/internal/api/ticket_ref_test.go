package api

import (
	"context"
	"net/http"
	"net/http/httptest"
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
// path never touches the store.
type ticketRefFakeStore struct {
	store.Store
	byTicket map[int]*store.Action
	lookups  int
}

func (f *ticketRefFakeStore) GetActionByTicket(_ context.Context, _ uuid.UUID, ticket int) (*store.Action, error) {
	f.lookups++
	if a, ok := f.byTicket[ticket]; ok {
		return a, nil
	}
	return nil, errNoSuchTicket
}

var errNoSuchTicket = &ticketErr{}

type ticketErr struct{}

func (*ticketErr) Error() string { return "no such ticket" }

// serveTicketRef runs one request through the middleware and reports the {id}
// the downstream handler observed.
func serveTicketRef(t *testing.T, s store.Store, canvasID uuid.UUID, rawID string) string {
	t.Helper()
	var seen string
	r := chi.NewRouter()
	r.With(ResolveTicketRef(s)).Get("/api/canvas/actions/{id}", func(w http.ResponseWriter, req *http.Request) {
		seen = chi.URLParam(req, "id")
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/canvas/actions/"+rawID, nil)
	ctx := context.WithValue(req.Context(), claimsKey, &auth.Claims{CanvasID: canvasID, Role: "write"})
	r.ServeHTTP(httptest.NewRecorder(), req.WithContext(ctx))
	return seen
}

func TestResolveTicketRefRewritesTicketToUUID(t *testing.T) {
	canvasID := uuid.New()
	taskID := uuid.New()
	ticket := 21
	fake := &ticketRefFakeStore{byTicket: map[int]*store.Action{
		ticket: {ID: taskID, Type: "task", State: "approved", Ticket: &ticket},
	}}

	if got := serveTicketRef(t, fake, canvasID, "TDM-21"); got != taskID.String() {
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

	if got := serveTicketRef(t, fake, canvasID, taskID.String()); got != taskID.String() {
		t.Errorf("handler saw id %q, want the uuid unchanged %q", got, taskID)
	}
	if fake.lookups != 0 {
		t.Errorf("uuid path did %d ticket lookups, want 0 — existing callers must pay nothing", fake.lookups)
	}
}

func TestResolveTicketRefUnknownTicketPassesThrough(t *testing.T) {
	canvasID := uuid.New()
	fake := &ticketRefFakeStore{byTicket: map[int]*store.Action{}}

	// A well-formed ref for a task that doesn't exist is left alone, so the
	// handler emits its own error in its own shape rather than the middleware
	// inventing one.
	if got := serveTicketRef(t, fake, canvasID, "TDM-99999"); got != "TDM-99999" {
		t.Errorf("handler saw id %q, want the ref passed through unchanged", got)
	}
	if fake.lookups != 1 {
		t.Errorf("ticket lookups = %d, want 1", fake.lookups)
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
