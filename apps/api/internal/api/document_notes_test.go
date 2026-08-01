package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/ws"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// docNotesFakeStore stubs only the two reads this endpoint makes; every other
// Store method panics through the embedded nil interface, so an unplanned round
// trip fails loudly rather than silently costing a query.
type docNotesFakeStore struct {
	store.Store

	docs  []*store.Document
	notes map[uuid.UUID][]*store.Note // documentID → notes

	listNoteCalls int
	// scopedTo records the documentID the handler asked the store for, so the
	// test can prove the scoping happens in the QUERY and not by filtering a
	// whole-canvas read afterwards.
	scopedTo []uuid.UUID
}

func (f *docNotesFakeStore) ListDocuments(context.Context, uuid.UUID) ([]*store.Document, error) {
	return append([]*store.Document(nil), f.docs...), nil
}

func (f *docNotesFakeStore) ListNotesByDocument(_ context.Context, _, docID uuid.UUID) ([]*store.Note, error) {
	f.listNoteCalls++
	f.scopedTo = append(f.scopedTo, docID)
	return append([]*store.Note(nil), f.notes[docID]...), nil
}

type docNotesResp struct {
	Document struct {
		ID   uuid.UUID `json:"id"`
		Name string    `json:"name"`
		Type string    `json:"type"`
	} `json:"document"`
	Notes []struct {
		ID        uuid.UUID `json:"id"`
		Body      string    `json:"body"`
		CreatedBy string    `json:"createdBy"`
		UpdatedAt time.Time `json:"updatedAt"`
	} `json:"notes"`
	Error string `json:"error"`
}

// readDocNotes drives the handler the way the router does: a canvas JWT in the
// context and {ref} as a chi URL param.
func readDocNotes(t *testing.T, f *docNotesFakeStore, canvasID uuid.UUID, ref string) (int, docNotesResp) {
	t.Helper()
	h := NewHandler(f, ws.NewHub(), nil)

	r := httptest.NewRequest("GET", "/api/canvas/documents/"+ref+"/notes", nil)
	ctx := context.WithValue(r.Context(), claimsKey, &auth.Claims{CanvasID: canvasID, Role: "read"})
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("ref", ref)
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)

	w := httptest.NewRecorder()
	h.ListDocumentNotes(w, r.WithContext(ctx))

	var out docNotesResp
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON: %v (%s)", err, w.Body.String())
	}
	return w.Code, out
}

// docNotesFixture: two notes documents, each with notes, so "only this tab's
// notes" is a claim the fixture can actually falsify.
func docNotesFixture() (*docNotesFakeStore, *store.Document, *store.Document) {
	thesis := &store.Document{ID: uuid.New(), Kind: "document", Type: "notes", Name: "Thesis", SortOrder: 0}
	strategy := &store.Document{ID: uuid.New(), Kind: "document", Type: "notes", Name: "Strategy", SortOrder: 1}
	at := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)

	f := &docNotesFakeStore{
		docs:  []*store.Document{thesis, strategy},
		notes: map[uuid.UUID][]*store.Note{},
	}
	// Deliberately inserted out of order: the endpoint promises the tab's
	// reading order, so it must not inherit whatever order the store hands back.
	f.notes[thesis.ID] = []*store.Note{
		{ID: uuid.New(), Kind: "note", DocumentID: &thesis.ID, Body: "second", SortOrder: 1,
			CreatedBy: "agent", UpdatedAt: at.Add(time.Minute)},
		{ID: uuid.New(), Kind: "note", DocumentID: &thesis.ID, Body: "first", SortOrder: 0,
			CreatedBy: "human", UpdatedAt: at},
	}
	f.notes[strategy.ID] = []*store.Note{
		{ID: uuid.New(), Kind: "note", DocumentID: &strategy.ID, Body: "other tab", SortOrder: 0,
			CreatedBy: "agent", UpdatedAt: at},
	}
	return f, thesis, strategy
}

// The happy path: exactly this tab's notes, in the tab's order, and no note from
// the neighbouring document.
func TestListDocumentNotes_ReturnsOnlyThatTabsNotesInOrder(t *testing.T) {
	f, thesis, _ := docNotesFixture()
	canvasID := uuid.New()

	code, resp := readDocNotes(t, f, canvasID, thesis.ID.String())
	if code != 200 {
		t.Fatalf("status = %d (%s)", code, resp.Error)
	}
	if resp.Document.ID != thesis.ID || resp.Document.Name != "Thesis" || resp.Document.Type != "notes" {
		t.Fatalf("document = %+v, want the Thesis tab", resp.Document)
	}
	if len(resp.Notes) != 2 {
		t.Fatalf("got %d notes, want the Thesis tab's 2: %+v", len(resp.Notes), resp.Notes)
	}
	if resp.Notes[0].Body != "first" || resp.Notes[1].Body != "second" {
		t.Fatalf("notes out of tab order: %q then %q", resp.Notes[0].Body, resp.Notes[1].Body)
	}
	// The named fields all survive the projection.
	if resp.Notes[0].CreatedBy != "human" || resp.Notes[1].CreatedBy != "agent" {
		t.Fatalf("createdBy lost: %+v", resp.Notes)
	}
	if resp.Notes[0].UpdatedAt.IsZero() || !resp.Notes[1].UpdatedAt.After(resp.Notes[0].UpdatedAt) {
		t.Fatalf("updatedAt lost or wrong: %+v", resp.Notes)
	}
	for _, n := range resp.Notes {
		if n.Body == "other tab" {
			t.Fatalf("a note from the Strategy tab leaked into the Thesis read")
		}
	}
	// Scoped in the query, not by filtering the whole canvas afterwards.
	if f.listNoteCalls != 1 || len(f.scopedTo) != 1 || f.scopedTo[0] != thesis.ID {
		t.Fatalf("store was asked for %v in %d calls, want one scoped to %s",
			f.scopedTo, f.listNoteCalls, thesis.ID)
	}
}

// An unknown document id is a clean 404 — not a 500, not an empty 200 that a
// caller would read as "the tab exists and is empty".
func TestListDocumentNotes_UnknownIDIs404(t *testing.T) {
	f, _, _ := docNotesFixture()
	missing := uuid.New()

	code, resp := readDocNotes(t, f, uuid.New(), missing.String())
	if code != 404 {
		t.Fatalf("status = %d, want 404 (body %+v)", code, resp)
	}
	if !strings.Contains(resp.Error, missing.String()) {
		t.Fatalf("404 message %q should name the id that missed", resp.Error)
	}
	if f.listNoteCalls != 0 {
		t.Fatalf("a missing document must not cost a notes query (got %d)", f.listNoteCalls)
	}
}

// A ref that is neither a uuid nor a known name 404s too, listing what IS there
// — the agent that wrote a tab addresses it by name.
func TestListDocumentNotes_ByNameAndUnknownName(t *testing.T) {
	f, thesis, _ := docNotesFixture()
	canvasID := uuid.New()

	// Case-insensitive, like every other document ref in this API.
	code, resp := readDocNotes(t, f, canvasID, "thesis")
	if code != 200 {
		t.Fatalf("name ref: status = %d (%s)", code, resp.Error)
	}
	if resp.Document.ID != thesis.ID {
		t.Fatalf("name ref resolved to %s, want %s", resp.Document.ID, thesis.ID)
	}

	code, resp = readDocNotes(t, f, canvasID, "Nope")
	if code != 404 {
		t.Fatalf("unknown name: status = %d, want 404", code)
	}
	if !strings.Contains(resp.Error, "Thesis") {
		t.Fatalf("404 message %q should list the documents that exist", resp.Error)
	}
}

// An empty tab is a 200 with an empty array, never a null — a caller iterating
// the result must not have to nil-check.
func TestListDocumentNotes_EmptyTabIsEmptyArray(t *testing.T) {
	empty := &store.Document{ID: uuid.New(), Kind: "document", Type: "notes", Name: "Scratch"}
	f := &docNotesFakeStore{docs: []*store.Document{empty}, notes: map[uuid.UUID][]*store.Note{}}

	code, _ := readDocNotes(t, f, uuid.New(), empty.ID.String())
	if code != 200 {
		t.Fatalf("status = %d, want 200", code)
	}
	body := buildDocumentNotes(empty, nil)
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"notes":[]`) {
		t.Fatalf("empty tab serialised as %s, want an empty array", raw)
	}
}

// The route is registered and reachable. Pinned because this pattern sits one
// segment past PATCH/DELETE /api/canvas/documents/{ref}: a param-name mismatch
// at that position is the kind of thing chi resolves quietly, and a handler
// nobody can reach passes every test above.
func TestDocumentNotesRouteIsRegistered(t *testing.T) {
	r := NewRouter(nil, nil, auth.NewService("test-secret-for-tdm-179", time.Hour), nil, false, nil, "", t.TempDir(), "", nil, nil)
	mux, ok := r.(*chi.Mux)
	if !ok {
		t.Fatal("NewRouter no longer returns a *chi.Mux; this route-walk test needs updating")
	}
	seen := map[string]bool{}
	if err := chi.Walk(mux, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		seen[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if !seen["GET /api/canvas/documents/{ref}/notes"] {
		t.Fatalf("the document-notes route is missing from the router")
	}
	// A read, and only a read — writing to a document goes through the notes
	// routes, not through this one.
	for route := range seen {
		if strings.Contains(route, "/documents/{ref}/notes") && !strings.HasPrefix(route, "GET ") {
			t.Errorf("%s is a non-GET on the document-notes read", route)
		}
	}
}

// buildDocumentNotes is the guarantee itself: whatever the store hands back, the
// response carries this document's notes and nothing else.
func TestBuildDocumentNotes_DropsForeignAndOrphanNotes(t *testing.T) {
	doc := &store.Document{ID: uuid.New(), Type: "notes", Name: "Thesis"}
	other := uuid.New()
	mine := uuid.New()

	body := buildDocumentNotes(doc, []*store.Note{
		{ID: uuid.New(), DocumentID: &other, Body: "someone else's tab"},
		{ID: uuid.New(), DocumentID: nil, Body: "orphan"},
		nil,
		{ID: mine, DocumentID: &doc.ID, Body: "mine"},
	})
	if len(body.Notes) != 1 || body.Notes[0].ID != mine {
		t.Fatalf("notes = %+v, want only the note belonging to this document", body.Notes)
	}
}
