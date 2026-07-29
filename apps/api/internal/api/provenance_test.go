package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// TDM-40 (E4.1). Two things are under test here and they are not the same
// thing:
//
//  1. the DERIVATION — does each auth context produce the right authored_by;
//  2. the SPOOF GATE — is a client-supplied authoredBy discarded on every
//     create path (the acceptance criterion).
//
// (2) matters more than it looks. The gate isn't an explicit "delete this
// field" branch anywhere — it's structural: no handler's body struct declares
// authoredBy, so encoding/json drops it. That's robust but INVISIBLE, and the
// obvious future regression is someone "helpfully" adding the field back to a
// body struct. These tests are what catches that.

const testSecret = "provenance-test-secret"

// ── 1. Derivation ────────────────────────────────────────────────────────────

func TestDeriveAuthorFromAuthContext(t *testing.T) {
	authSvc := auth.NewService(testSecret, time.Hour)
	signedIn := func(r *http.Request) {
		token, err := authSvc.IssueSession(uuid.New(), time.Hour)
		if err != nil {
			t.Fatalf("issue session: %v", err)
		}
		r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})
	}

	tests := []struct {
		name  string
		setup func(*http.Request)
		want  string
	}{
		{
			name:  "canvas token alone is anonymous",
			setup: func(*http.Request) {},
			want:  AuthorAnonymous,
		},
		{
			name:  "valid Google session is human",
			setup: signedIn,
			want:  AuthorHuman,
		},
		{
			name:  "asserted agent identity",
			setup: func(r *http.Request) { r.Header.Set(AgentIdentityHeader, "planner-1") },
			want:  "agent:planner-1",
		},
		{
			// The hosted claude.ai connector authenticates with a user's OAuth
			// grant, so an agent request CAN carry a user identity. It's still an
			// agent, and agent-first ordering is what keeps it labelled one.
			name: "agent identity beats a user session",
			setup: func(r *http.Request) {
				signedIn(r)
				r.Header.Set(AgentIdentityHeader, "hosted-connector")
			},
			want: "agent:hosted-connector",
		},
		{
			name:  "garbage session cookie falls through to anonymous",
			setup: func(r *http.Request) { r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "not-a-jwt"}) },
			want:  AuthorAnonymous,
		},
		{
			// A name that could forge a line break in a log, or a second chip in
			// the UI, is flattened before it's ever stored.
			name:  "control characters are stripped from the asserted name",
			setup: func(r *http.Request) { r.Header.Set(AgentIdentityHeader, "  ro\x00gue\nbot\x1b[31m  ") },
			want:  "agent:rogue bot[31m",
		},
		{
			name:  "whitespace-only assertion is no assertion",
			setup: func(r *http.Request) { r.Header.Set(AgentIdentityHeader, "   ") },
			want:  AuthorAnonymous,
		},
		{
			name:  "over-long name is truncated, not rejected",
			setup: func(r *http.Request) { r.Header.Set(AgentIdentityHeader, strings.Repeat("x", maxAuthorNameLen+50)) },
			want:  "agent:" + strings.Repeat("x", maxAuthorNameLen),
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/canvas/actions", nil)
			tc.setup(r)
			if got := deriveAuthor(authSvc, r); got != tc.want {
				t.Fatalf("deriveAuthor = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestProvenanceMiddlewareStampsContext(t *testing.T) {
	authSvc := auth.NewService(testSecret, time.Hour)
	r := httptest.NewRequest("POST", "/api/canvas/notes", nil)
	r.Header.Set(AgentIdentityHeader, "executor-7")

	var seen *string
	Provenance(authSvc)(http.HandlerFunc(func(_ http.ResponseWriter, rr *http.Request) {
		seen = AuthorFromCtx(rr.Context())
	})).ServeHTTP(httptest.NewRecorder(), r)

	if seen == nil || *seen != "agent:executor-7" {
		t.Fatalf("AuthorFromCtx = %v, want agent:executor-7", derefOr(seen, "<nil>"))
	}
}

// A route without the middleware must stamp NULL rather than guess. NULL is
// defined as "unknown"; a guess would be a lie in the one column that exists
// specifically not to lie.
func TestAuthorFromCtxIsNilWithoutMiddleware(t *testing.T) {
	if got := AuthorFromCtx(context.Background()); got != nil {
		t.Fatalf("AuthorFromCtx on a bare context = %q, want nil", *got)
	}
}

// The WebSocket is the browser's channel and has no agent path by construction,
// so the connection's resolved user id is the whole derivation.
func TestAuthorForSession(t *testing.T) {
	uid := uuid.New()
	if got := AuthorForSession(&uid); got != AuthorHuman {
		t.Fatalf("signed-in socket = %q, want %q", got, AuthorHuman)
	}
	if got := AuthorForSession(nil); got != AuthorAnonymous {
		t.Fatalf("anonymous socket = %q, want %q", got, AuthorAnonymous)
	}
}

// ── 2. The spoof gate, on every create path ──────────────────────────────────

// spoof is what a malicious caller adds to a create body to try to pass its
// writes off as a person's. Both spellings, because the wire format is camelCase
// and the column is snake_case and an attacker would try both.
func spoof(body map[string]any) map[string]any {
	body["authoredBy"] = AuthorHuman
	body["authored_by"] = AuthorHuman
	return body
}

func TestCreateTaskIgnoresClientSuppliedAuthoredBy(t *testing.T) {
	f := newProvFake()
	h := NewHandler(f, nil, nil)
	r := provRequest(t, "POST", "/api/canvas/actions",
		spoof(map[string]any{"type": "task", "proposedBy": "human", "payload": map[string]any{"title": "spoofed"}}),
		asAgent("rogue-agent"))

	h.ProposeAction(httptest.NewRecorder(), r)

	assertAuthored(t, "task", f.authoredActions(), "agent:rogue-agent")
}

func TestProposeActionsBatchIgnoresClientSuppliedAuthoredBy(t *testing.T) {
	f := newProvFake()
	h := NewHandler(f, nil, nil)
	r := provRequest(t, "POST", "/api/canvas/actions/batch", map[string]any{
		"actions": []map[string]any{
			spoof(map[string]any{"type": "task", "payload": map[string]any{"title": "one"}}),
			spoof(map[string]any{"type": "epic", "payload": map[string]any{"title": "two"}}),
		},
	}, asAgent("rogue-agent"))

	h.ProposeActionsBatch(httptest.NewRecorder(), r)

	got := f.authoredActions()
	if len(got) != 2 {
		t.Fatalf("created %d actions, want 2", len(got))
	}
	assertAuthored(t, "task batch", got, "agent:rogue-agent")
}

func TestCreateNoteIgnoresClientSuppliedAuthoredBy(t *testing.T) {
	f := newProvFake()
	h := NewHandler(f, nil, nil)
	r := provRequest(t, "POST", "/api/canvas/notes",
		spoof(map[string]any{"body": "spoofed note", "createdBy": "human"}),
		asAgent("rogue-agent"))

	h.CreateNote(httptest.NewRecorder(), r)

	assertAuthored(t, "note", f.authoredNotes(), "agent:rogue-agent")
	// The note had no target document, so the shared helper minted the canvas's
	// default notes doc on the way through. That implicit create is a create too.
	assertAuthored(t, "implicitly minted notes document", f.authoredDocs(), "agent:rogue-agent")
}

func TestCreateNotesBatchIgnoresClientSuppliedAuthoredBy(t *testing.T) {
	f := newProvFake()
	h := NewHandler(f, nil, nil)
	r := provRequest(t, "POST", "/api/canvas/notes/batch", map[string]any{
		"notes": []map[string]any{
			spoof(map[string]any{"body": "one"}),
			spoof(map[string]any{"body": "two"}),
		},
	}, asAgent("rogue-agent"))

	h.CreateNotesBatch(httptest.NewRecorder(), r)

	got := f.authoredNotes()
	if len(got) != 2 {
		t.Fatalf("created %d notes, want 2", len(got))
	}
	assertAuthored(t, "note batch", got, "agent:rogue-agent")
}

func TestCreateDocumentIgnoresClientSuppliedAuthoredBy(t *testing.T) {
	f := newProvFake()
	h := NewHandler(f, nil, nil)
	r := provRequest(t, "POST", "/api/canvas/documents",
		spoof(map[string]any{"type": "notes", "name": "Spoofed", "createdBy": "human"}),
		asAgent("rogue-agent"))

	h.CreateDocument(httptest.NewRecorder(), r)

	assertAuthored(t, "document", f.authoredDocs(), "agent:rogue-agent")
}

func TestCreateDocumentsBatchIgnoresClientSuppliedAuthoredBy(t *testing.T) {
	f := newProvFake()
	h := NewHandler(f, nil, nil)
	r := provRequest(t, "POST", "/api/canvas/documents/batch", map[string]any{
		"documents": []map[string]any{
			spoof(map[string]any{"type": "notes", "name": "A"}),
			spoof(map[string]any{"type": "roadmap", "name": "B"}),
		},
	}, asAgent("rogue-agent"))

	h.CreateDocumentsBatch(httptest.NewRecorder(), r)

	got := f.authoredDocs()
	if len(got) != 2 {
		t.Fatalf("created %d documents, want 2", len(got))
	}
	assertAuthored(t, "document batch", got, "agent:rogue-agent")
}

// The sharpest version of the criterion: no credential at all, a body screaming
// "a human wrote this", and the row still lands as anonymous. "human" is the one
// value a caller can never talk its way into.
func TestAnonymousCallerCannotClaimHuman(t *testing.T) {
	f := newProvFake()
	h := NewHandler(f, nil, nil)
	r := provRequest(t, "POST", "/api/canvas/actions",
		spoof(map[string]any{"type": "task", "proposedBy": AuthorHuman, "payload": map[string]any{"title": "trust me"}}),
		func(*http.Request) {})

	h.ProposeAction(httptest.NewRecorder(), r)

	assertAuthored(t, "anonymous task", f.authoredActions(), AuthorAnonymous)
	// The freeform legacy label is still whatever the client said — that's the
	// point of having both columns. proposedBy is a claim; authoredBy is a fact.
	if got := f.actions[0].ProposedBy; got != AuthorHuman {
		t.Fatalf("proposedBy = %q, want the client's own %q (untouched)", got, AuthorHuman)
	}
}

// A signed-in browser writing over HTTP is the one path that legitimately
// produces "human".
func TestSignedInSessionStampsHuman(t *testing.T) {
	f := newProvFake()
	h := NewHandler(f, nil, nil)
	authSvc := auth.NewService(testSecret, time.Hour)
	token, err := authSvc.IssueSession(uuid.New(), time.Hour)
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	r := provRequest(t, "POST", "/api/canvas/actions",
		map[string]any{"type": "task", "payload": map[string]any{"title": "typed by a person"}},
		func(r *http.Request) { r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token}) })

	h.ProposeAction(httptest.NewRecorder(), r)

	assertAuthored(t, "signed-in task", f.authoredActions(), AuthorHuman)
}

// ── 3. Reads surface it ──────────────────────────────────────────────────────

func TestCreateResponseSurfacesAuthoredByCamelCase(t *testing.T) {
	f := newProvFake()
	h := NewHandler(f, nil, nil)
	w := httptest.NewRecorder()
	r := provRequest(t, "POST", "/api/canvas/actions",
		map[string]any{"type": "task", "payload": map[string]any{"title": "readable"}},
		asAgent("planner-1"))

	h.ProposeAction(w, r)

	var got map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal response: %v (body %s)", err, w.Body.String())
	}
	if got["authoredBy"] != "agent:planner-1" {
		t.Fatalf("response authoredBy = %v, want agent:planner-1 (body %s)", got["authoredBy"], w.Body.String())
	}
	if _, unexpected := got["authored_by"]; unexpected {
		t.Fatal("response leaked the snake_case column name; the wire format is camelCase")
	}
}

// A row created before migration 0039 has no provenance, and must render as
// nothing rather than as a guess — so the field has to disappear from the JSON
// entirely (omitempty), not serialize as null or "".
func TestNilAuthoredByIsOmittedFromJSON(t *testing.T) {
	for _, v := range []any{
		&store.Action{ID: uuid.New(), Kind: "action", Type: "task"},
		&store.Note{ID: uuid.New(), Kind: "note"},
		&store.Document{ID: uuid.New(), Kind: "document", Type: "notes"},
	} {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("marshal %T: %v", v, err)
		}
		if bytes.Contains(b, []byte("authoredBy")) {
			t.Fatalf("%T with nil AuthoredBy serialized the key: %s", v, b)
		}
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func derefOr(s *string, fallback string) string {
	if s == nil {
		return fallback
	}
	return *s
}

func asAgent(name string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set(AgentIdentityHeader, name) }
}

// provRequest builds a canvas-authenticated request and runs it through the REAL
// Provenance middleware, so these tests exercise the shipped derivation rather
// than a stand-in for it.
func provRequest(t *testing.T, method, path string, body any, setup func(*http.Request)) *http.Request {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	setup(r)
	r = r.WithContext(context.WithValue(r.Context(), claimsKey,
		&auth.Claims{CanvasID: uuid.New(), Role: "write"}))

	var out *http.Request
	Provenance(auth.NewService(testSecret, time.Hour))(
		http.HandlerFunc(func(_ http.ResponseWriter, rr *http.Request) { out = rr }),
	).ServeHTTP(httptest.NewRecorder(), r)
	if out == nil {
		t.Fatal("Provenance middleware swallowed the request")
	}
	return out
}

// assertAuthored fails unless every created row carries exactly want.
func assertAuthored(t *testing.T, what string, got []*string, want string) {
	t.Helper()
	if len(got) == 0 {
		t.Fatalf("%s: nothing was created", what)
	}
	for i, a := range got {
		if a == nil {
			t.Fatalf("%s[%d]: authoredBy is nil, want %q", what, i, want)
		}
		if *a != want {
			t.Fatalf("%s[%d]: authoredBy = %q, want %q", what, i, *a, want)
		}
	}
}

// provFake stubs only what the create paths touch; every other Store method
// panics through the embedded nil interface, which is the house convention for
// "a test that reaches this is a test bug".
type provFake struct {
	store.Store
	actions []*store.Action
	notes   []*store.Note
	docs    []*store.Document
}

func newProvFake() *provFake { return &provFake{} }

func (f *provFake) authoredActions() []*string {
	out := make([]*string, 0, len(f.actions))
	for _, a := range f.actions {
		out = append(out, a.AuthoredBy)
	}
	return out
}

func (f *provFake) authoredNotes() []*string {
	out := make([]*string, 0, len(f.notes))
	for _, n := range f.notes {
		out = append(out, n.AuthoredBy)
	}
	return out
}

func (f *provFake) authoredDocs() []*string {
	out := make([]*string, 0, len(f.docs))
	for _, d := range f.docs {
		out = append(out, d.AuthoredBy)
	}
	return out
}

func (f *provFake) CreateAction(_ context.Context, _ uuid.UUID, a *store.Action) (int, error) {
	f.actions = append(f.actions, a)
	return 1, nil
}

func (f *provFake) CreateActions(_ context.Context, _ uuid.UUID, as []*store.Action) (int, error) {
	f.actions = append(f.actions, as...)
	return 1, nil
}

func (f *provFake) CreateNote(_ context.Context, _ uuid.UUID, n *store.Note) (int, error) {
	f.notes = append(f.notes, n)
	return 1, nil
}

func (f *provFake) CreateNotes(_ context.Context, _ uuid.UUID, ns []*store.Note) (int, error) {
	f.notes = append(f.notes, ns...)
	return 1, nil
}

func (f *provFake) CreateDocument(_ context.Context, _ uuid.UUID, d *store.Document) (int, error) {
	f.docs = append(f.docs, d)
	return 1, nil
}

func (f *provFake) CreateDocuments(_ context.Context, _ uuid.UUID, ds []*store.Document) (int, error) {
	f.docs = append(f.docs, ds...)
	return 1, nil
}

// Empty: forces the note path through ensureDefaultDocInList, so the implicitly
// minted default document is covered too.
func (f *provFake) ListDocuments(_ context.Context, _ uuid.UUID) ([]*store.Document, error) {
	return nil, nil
}

func (f *provFake) GetCanvasByID(_ context.Context, id uuid.UUID) (*store.Canvas, error) {
	return &store.Canvas{ID: id, ApprovalPolicy: "strict"}, nil
}

// Best-effort ticketing; failing keeps tasks ticketless without failing the create.
func (f *provFake) ReserveTaskTickets(_ context.Context, _ uuid.UUID, _ int) (int, error) {
	return 0, fmt.Errorf("no tickets in this fake")
}

// GetCanvasState backs the async post-write broadcast; erroring makes it a no-op.
func (f *provFake) GetCanvasState(_ context.Context, _ uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in this fake")
}
