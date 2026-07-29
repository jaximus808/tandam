package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/ws"
	"github.com/google/uuid"
)

// ── Pure helpers (no network, no store) ──────────────────────────────────────

func parseTestIP(t *testing.T, s string) net.IP {
	t.Helper()
	ip := net.ParseIP(s)
	if ip == nil {
		t.Fatalf("bad test fixture: %q is not an IP", s)
	}
	return ip
}

func TestNormalizeBriefingURL_GitHubBlobBecomesRaw(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			"blob url a human copies from the browser",
			"https://github.com/jaximus/tandem/blob/main/AGENTS.md",
			"https://raw.githubusercontent.com/jaximus/tandem/main/AGENTS.md",
		},
		{
			"nested path survives",
			"https://github.com/o/r/blob/feat/ctx/apps/api/CLAUDE.md",
			"https://raw.githubusercontent.com/o/r/feat/ctx/apps/api/CLAUDE.md",
		},
		{
			"the /raw/ variant normalises the same way",
			"https://github.com/o/r/raw/main/AGENTS.md",
			"https://raw.githubusercontent.com/o/r/main/AGENTS.md",
		},
		{
			"www host is handled",
			"https://www.github.com/o/r/blob/main/AGENTS.md",
			"https://raw.githubusercontent.com/o/r/main/AGENTS.md",
		},
		{
			"viewer query + line anchor are dropped — raw doesn't understand them",
			"https://github.com/o/r/blob/main/AGENTS.md?plain=1#L20",
			"https://raw.githubusercontent.com/o/r/main/AGENTS.md",
		},
		{
			"an already-raw url is left alone",
			"https://raw.githubusercontent.com/o/r/main/AGENTS.md",
			"https://raw.githubusercontent.com/o/r/main/AGENTS.md",
		},
		{
			"a non-file github url is not a blob url and passes through",
			"https://github.com/o/r",
			"https://github.com/o/r",
		},
		{
			"a gist url is not rewritten",
			"https://gist.githubusercontent.com/o/abc/raw/AGENTS.md",
			"https://gist.githubusercontent.com/o/abc/raw/AGENTS.md",
		},
		{
			"surrounding whitespace from a paste is trimmed",
			"  https://example.com/AGENTS.md  ",
			"https://example.com/AGENTS.md",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeBriefingURL(tc.in)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("normalizeBriefingURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestNormalizeBriefingURL_Rejects(t *testing.T) {
	tests := []struct {
		name, in, wantErr string
	}{
		{"empty", "   ", "empty"},
		{"plain http", "http://example.com/AGENTS.md", "must be https"},
		{"file scheme", "file:///etc/passwd", "must be https"},
		{"no host", "https:///AGENTS.md", "no host"},
		{"localhost", "https://localhost:7891/AGENTS.md", "private and internal"},
		{"loopback literal", "https://127.0.0.1/AGENTS.md", "private and internal"},
		{"ipv6 loopback", "https://[::1]/AGENTS.md", "private and internal"},
		{"rfc1918", "https://10.1.2.3/AGENTS.md", "private and internal"},
		{"cloud metadata", "https://169.254.169.254/latest/meta-data", "private and internal"},
		{"internal suffix", "https://wiki.internal/AGENTS.md", "private and internal"},
		{"mdns suffix", "https://nas.local/AGENTS.md", "private and internal"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeBriefingURL(tc.in)
			if err == nil {
				t.Fatalf("expected rejection, got %q", got)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %q, want it to mention %q", err, tc.wantErr)
			}
		})
	}
}

// The dial-time guard is what actually stops SSRF (a public hostname can resolve
// to any of these), so its classification is worth pinning directly.
func TestIsBlockedIP(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "0.0.0.0", "10.0.0.1", "172.16.0.1", "192.168.1.1",
		"169.254.169.254", "100.64.0.1", "192.0.0.1", "198.18.0.1",
		"::1", "fe80::1", "fd00::1", "ff02::1",
	}
	for _, s := range blocked {
		if !isBlockedIP(parseTestIP(t, s)) {
			t.Fatalf("%s should be blocked", s)
		}
	}
	allowed := []string{"140.82.121.4", "8.8.8.8", "185.199.108.153", "2606:50c0::153"}
	for _, s := range allowed {
		if isBlockedIP(parseTestIP(t, s)) {
			t.Fatalf("%s should be allowed", s)
		}
	}
	// Fail closed on anything unparseable.
	if !isBlockedIP(nil) {
		t.Fatalf("a nil IP must be blocked")
	}
}

func TestBlockPrivateAddrControl(t *testing.T) {
	if err := blockPrivateAddr("tcp", "127.0.0.1:443", nil); err == nil {
		t.Fatalf("dialing loopback must be refused")
	}
	if err := blockPrivateAddr("tcp", "140.82.121.4:443", nil); err != nil {
		t.Fatalf("dialing a public address must be allowed, got %v", err)
	}
	if err := blockPrivateAddr("tcp", "not-an-address", nil); err == nil {
		t.Fatalf("an unsplittable address must be refused")
	}
}

func TestReadCapped(t *testing.T) {
	// Exactly at the cap is fine — the cap is inclusive.
	body := strings.Repeat("a", 64)
	got, err := readCapped(strings.NewReader(body), 64)
	if err != nil || string(got) != body {
		t.Fatalf("at-cap read failed: %q err=%v", got, err)
	}
	// One byte over is rejected outright rather than silently truncated: half an
	// AGENTS.md reads as a complete one.
	if _, err := readCapped(strings.NewReader(body+"a"), 64); err == nil {
		t.Fatalf("over-cap read should error")
	} else if !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("error = %q, want a size message", err)
	}
	if got, err := readCapped(strings.NewReader(""), 64); err != nil || len(got) != 0 {
		t.Fatalf("empty read: %q err=%v", got, err)
	}
}

func TestBriefingContentTypeOK(t *testing.T) {
	ok := []string{"", "text/plain", "text/plain; charset=utf-8", "TEXT/MARKDOWN",
		"text/html", "application/json", "application/markdown"}
	for _, ct := range ok {
		if !briefingContentTypeOK(ct) {
			t.Fatalf("%q should be accepted", ct)
		}
	}
	bad := []string{"image/png", "application/pdf", "application/octet-stream", "video/mp4"}
	for _, ct := range bad {
		if briefingContentTypeOK(ct) {
			t.Fatalf("%q should be rejected", ct)
		}
	}
}

func TestLooksLikeText(t *testing.T) {
	if !looksLikeText([]byte("# AGENTS.md\n\nBe kind — émoji 🚀 ok\n")) {
		t.Fatalf("valid utf-8 markdown should pass")
	}
	if looksLikeText([]byte{0x89, 0x50, 0x4e, 0x47, 0x00, 0x01}) {
		t.Fatalf("binary should be rejected")
	}
	if looksLikeText([]byte("ok\x00then")) {
		t.Fatalf("an embedded NUL should be rejected")
	}
}

func TestFindNotesDocByName(t *testing.T) {
	brief := &store.Document{ID: uuid.New(), Type: "notes", Name: "Briefing", SortOrder: 3}
	docs := []*store.Document{
		{ID: uuid.New(), Type: "map", Name: "Briefing", SortOrder: 0}, // wrong type
		brief,
		{ID: uuid.New(), Type: "notes", Name: "Scratch", SortOrder: 1},
	}
	if got := findNotesDocByName(docs, "briefing"); got == nil || got.ID != brief.ID {
		t.Fatalf("case-insensitive notes-doc match failed: %v", got)
	}
	if got := findNotesDocByName(docs, "Nope"); got != nil {
		t.Fatalf("expected no match, got %v", got)
	}
}

// ── Handler tests ────────────────────────────────────────────────────────────

// briefingFakeStore stubs only what the import / designate paths touch; every
// other Store method panics through the embedded nil interface, so an unplanned
// round trip fails loudly.
type briefingFakeStore struct {
	store.Store

	mu    sync.Mutex
	docs  []*store.Document
	notes map[uuid.UUID][]*store.Note // documentID → notes

	briefingDocID  *uuid.UUID
	briefingSetSet int // how many times SetCanvasBriefingDoc was called
	createdDocs    int
	createdNotes   int
	updatedNotes   int
	docPatches     []store.DocumentPatch
}

func newBriefingFake() *briefingFakeStore {
	return &briefingFakeStore{notes: map[uuid.UUID][]*store.Note{}}
}

func (f *briefingFakeStore) ListDocuments(context.Context, uuid.UUID) ([]*store.Document, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*store.Document(nil), f.docs...), nil
}

func (f *briefingFakeStore) GetDocument(_ context.Context, _, id uuid.UUID) (*store.Document, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, d := range f.docs {
		if d.ID == id {
			return d, nil
		}
	}
	return nil, fmt.Errorf("document %s not found", id)
}

func (f *briefingFakeStore) CreateDocument(_ context.Context, _ uuid.UUID, d *store.Document) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.docs = append(f.docs, d)
	f.createdDocs++
	return 1, nil
}

func (f *briefingFakeStore) UpdateDocument(_ context.Context, _, id uuid.UUID, patch store.DocumentPatch) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.docPatches = append(f.docPatches, patch)
	for _, d := range f.docs {
		if d.ID == id {
			if patch.VerifiedAt != nil {
				d.VerifiedAt = patch.VerifiedAt
			}
			if patch.ClearStaleAfterSeconds {
				d.StaleAfterSeconds = nil
			} else if patch.StaleAfterSeconds != nil {
				d.StaleAfterSeconds = patch.StaleAfterSeconds
			}
			return 1, nil
		}
	}
	return 0, fmt.Errorf("document %s not found", id)
}

func (f *briefingFakeStore) ListNotesByDocument(_ context.Context, _, docID uuid.UUID) ([]*store.Note, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*store.Note(nil), f.notes[docID]...), nil
}

func (f *briefingFakeStore) CreateNote(_ context.Context, _ uuid.UUID, n *store.Note) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n.SortOrder = len(f.notes[*n.DocumentID])
	f.notes[*n.DocumentID] = append(f.notes[*n.DocumentID], n)
	f.createdNotes++
	return 1, nil
}

func (f *briefingFakeStore) UpdateNote(_ context.Context, _, id uuid.UUID, patch store.NotePatch) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updatedNotes++
	for _, list := range f.notes {
		for _, n := range list {
			if n.ID != id {
				continue
			}
			if patch.Body != nil {
				n.Body = *patch.Body
			}
			if patch.VerifiedAt != nil {
				n.VerifiedAt = patch.VerifiedAt
			}
			if patch.ClearStaleAfterSeconds {
				n.StaleAfterSeconds = nil
			} else if patch.StaleAfterSeconds != nil {
				n.StaleAfterSeconds = patch.StaleAfterSeconds
			}
			return 1, nil
		}
	}
	return 0, fmt.Errorf("note %s not found", id)
}

func (f *briefingFakeStore) SetCanvasBriefingDoc(_ context.Context, _ uuid.UUID, docID *uuid.UUID) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.briefingDocID = docID
	f.briefingSetSet++
	return 1, nil
}

// Backs the detached post-write broadcast; erroring makes it a logged no-op.
func (f *briefingFakeStore) GetCanvasState(context.Context, uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in tests")
}

type briefingResp struct {
	Document        *store.Document `json:"document"`
	BriefingDocID   uuid.UUID       `json:"briefingDocId"`
	NoteID          uuid.UUID       `json:"noteId"`
	CreatedDocument bool            `json:"createdDocument"`
	Bytes           int             `json:"bytes"`
	Error           string          `json:"error"`
}

func importBriefing(t *testing.T, f *briefingFakeStore, canvasID uuid.UUID, body any) (int, briefingResp) {
	t.Helper()
	h := NewHandler(f, ws.NewHub(), nil)
	r := canvasRequest(t, "POST", "/api/canvas/briefing/import", body, canvasID, "")
	w := httptest.NewRecorder()
	h.ImportBriefing(w, r)
	var out briefingResp
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func setBriefing(t *testing.T, f *briefingFakeStore, canvasID uuid.UUID, body any) int {
	t.Helper()
	h := NewHandler(f, ws.NewHub(), nil)
	r := canvasRequest(t, "PUT", "/api/canvas/briefing", body, canvasID, "")
	w := httptest.NewRecorder()
	h.SetBriefing(w, r)
	return w.Code
}

// The paste path: one call must leave the canvas with a notes document, the
// file inside it as a note, and briefing_doc_id pointing at that document.
func TestImportBriefing_PasteCreatesDocNoteAndDesignates(t *testing.T) {
	f := newBriefingFake()
	canvasID := uuid.New()
	content := "# AGENTS.md\n\nBuild all three packages before reporting.\n"

	code, resp := importBriefing(t, f, canvasID, map[string]any{"content": content})
	if code != 200 {
		t.Fatalf("status = %d (%s)", code, resp.Error)
	}
	if !resp.CreatedDocument || resp.Document == nil {
		t.Fatalf("expected a freshly created document, got %+v", resp)
	}
	if resp.Document.Type != "notes" || resp.Document.Name != defaultBriefingDocName {
		t.Fatalf("document = %+v, want a notes doc named %q", resp.Document, defaultBriefingDocName)
	}
	if f.createdDocs != 1 || f.createdNotes != 1 {
		t.Fatalf("created %d docs / %d notes, want 1 / 1", f.createdDocs, f.createdNotes)
	}

	notes := f.notes[resp.Document.ID]
	if len(notes) != 1 {
		t.Fatalf("expected one note in the briefing doc, got %d", len(notes))
	}
	// Content is trimmed but otherwise verbatim — an agent reads it as-is.
	if notes[0].Body != strings.TrimSpace(content) {
		t.Fatalf("note body = %q", notes[0].Body)
	}
	if notes[0].CreatedBy != briefingNoteAuthor {
		t.Fatalf("note author = %q, want the import marker %q", notes[0].CreatedBy, briefingNoteAuthor)
	}
	// Importing IS vouching: the note and its document are stamped verified.
	if notes[0].VerifiedAt == nil || time.Since(*notes[0].VerifiedAt) > time.Minute {
		t.Fatalf("note verifiedAt = %v, want ~now", notes[0].VerifiedAt)
	}
	if notes[0].StaleAfterSeconds != nil {
		t.Fatalf("staleAfterSeconds should stay nil when the caller declares none")
	}
	if resp.Document.VerifiedAt == nil {
		t.Fatalf("the briefing document should be stamped verified too")
	}
	// …and the designation actually landed.
	if f.briefingDocID == nil || *f.briefingDocID != resp.Document.ID {
		t.Fatalf("briefingDocId = %v, want %v", f.briefingDocID, resp.Document.ID)
	}
	if resp.Bytes != len(strings.TrimSpace(content)) {
		t.Fatalf("bytes = %d", resp.Bytes)
	}
}

// Re-import is the refresh: it must reuse the same document, REPLACE the note
// it wrote last time, leave a human's own notes alone, and not stack copies.
func TestImportBriefing_ReimportReplacesInPlace(t *testing.T) {
	f := newBriefingFake()
	canvasID := uuid.New()

	_, first := importBriefing(t, f, canvasID, map[string]any{"content": "v1 rules"})
	docID := first.Document.ID

	// A human adds their own note to the same document between imports.
	human := &store.Note{ID: uuid.New(), Kind: "note", DocumentID: &docID,
		Body: "my own note", CreatedBy: "human", SortOrder: 1}
	f.notes[docID] = append(f.notes[docID], human)

	code, second := importBriefing(t, f, canvasID, map[string]any{"content": "v2 rules"})
	if code != 200 {
		t.Fatalf("status = %d (%s)", code, second.Error)
	}
	if second.CreatedDocument || second.Document.ID != docID {
		t.Fatalf("re-import should reuse the same document, got %+v", second.Document)
	}
	if f.createdDocs != 1 {
		t.Fatalf("created %d documents across two imports, want 1", f.createdDocs)
	}
	if second.NoteID != first.NoteID {
		t.Fatalf("re-import should update note %s, not create %s", first.NoteID, second.NoteID)
	}
	if f.createdNotes != 1 || f.updatedNotes != 1 {
		t.Fatalf("created %d / updated %d notes, want 1 / 1", f.createdNotes, f.updatedNotes)
	}
	notes := f.notes[docID]
	if len(notes) != 2 {
		t.Fatalf("document should hold the import + the human note, got %d", len(notes))
	}
	if notes[0].Body != "v2 rules" {
		t.Fatalf("imported note body = %q, want the new content", notes[0].Body)
	}
	if human.Body != "my own note" {
		t.Fatalf("a human's note must survive a re-import untouched, got %q", human.Body)
	}
	if f.briefingSetSet != 2 {
		t.Fatalf("each import re-asserts the designation; calls = %d", f.briefingSetSet)
	}
}

// A named import lands in its own document, and a second import under the same
// name reuses it. Two DIFFERENT names are two documents, not one overwritten.
func TestImportBriefing_NamedDocument(t *testing.T) {
	f := newBriefingFake()
	canvasID := uuid.New()

	_, a := importBriefing(t, f, canvasID, map[string]any{"content": "a", "name": "AGENTS.md"})
	if a.Document.Name != "AGENTS.md" {
		t.Fatalf("name = %q", a.Document.Name)
	}
	// Case-insensitive reuse — nobody retypes the exact casing.
	_, again := importBriefing(t, f, canvasID, map[string]any{"content": "a2", "name": "agents.md"})
	if again.Document.ID != a.Document.ID {
		t.Fatalf("same name (different case) should reuse the document")
	}

	_, b := importBriefing(t, f, canvasID, map[string]any{"content": "b", "name": "CLAUDE.md"})
	if b.Document.ID == a.Document.ID {
		t.Fatalf("a different name must be a different document")
	}
	// The most recent import owns the designation.
	if f.briefingDocID == nil || *f.briefingDocID != b.Document.ID {
		t.Fatalf("briefingDocId = %v, want the newest import %v", f.briefingDocID, b.Document.ID)
	}
	if f.createdDocs != 2 {
		t.Fatalf("created %d documents, want 2", f.createdDocs)
	}
}

// A declared shelf life is carried onto the note; omitting it on a later import
// CLEARS the previous one, so re-importing the same file is idempotent.
func TestImportBriefing_ShelfLife(t *testing.T) {
	f := newBriefingFake()
	canvasID := uuid.New()

	_, resp := importBriefing(t, f, canvasID,
		map[string]any{"content": "x", "staleAfterSeconds": 1209600})
	note := f.notes[resp.Document.ID][0]
	if note.StaleAfterSeconds == nil || *note.StaleAfterSeconds != 1209600 {
		t.Fatalf("staleAfterSeconds = %v, want 1209600", note.StaleAfterSeconds)
	}

	if _, err := importBriefing(t, f, canvasID, map[string]any{"content": "y"}); err.Error != "" {
		t.Fatalf("second import failed: %s", err.Error)
	}
	if note.StaleAfterSeconds != nil {
		t.Fatalf("an import with no declared shelf life must clear the old one, got %v", *note.StaleAfterSeconds)
	}
}

func TestImportBriefing_BadRequests(t *testing.T) {
	canvasID := uuid.New()

	// Neither content nor a URL.
	if code, resp := importBriefing(t, newBriefingFake(), canvasID, map[string]any{}); code != 400 {
		t.Fatalf("empty import → %d (%s), want 400", code, resp.Error)
	}
	// Whitespace-only content is empty content.
	if code, _ := importBriefing(t, newBriefingFake(), canvasID, map[string]any{"content": "   \n "}); code != 400 {
		t.Fatalf("blank content → %d, want 400", code)
	}
	// A non-positive shelf life is meaningless (the DB CHECK rejects it too).
	if code, _ := importBriefing(t, newBriefingFake(), canvasID,
		map[string]any{"content": "x", "staleAfterSeconds": 0}); code != 400 {
		t.Fatalf("zero staleAfterSeconds → %d, want 400", code)
	}
	// A bad sourceUrl fails BEFORE any store write — no half-made document.
	f := newBriefingFake()
	code, resp := importBriefing(t, f, canvasID, map[string]any{"sourceUrl": "http://example.com/AGENTS.md"})
	if code != 400 || !strings.Contains(resp.Error, "https") {
		t.Fatalf("http sourceUrl → %d %q, want 400 about https", code, resp.Error)
	}
	if f.createdDocs != 0 || f.briefingSetSet != 0 {
		t.Fatalf("a rejected fetch must not touch the canvas")
	}
}

// The bare designation endpoint: point at an existing document, then clear it.
func TestSetBriefing_SetAndClear(t *testing.T) {
	f := newBriefingFake()
	canvasID := uuid.New()
	doc := &store.Document{ID: uuid.New(), Kind: "document", Type: "notes", Name: "Project brief"}
	f.docs = append(f.docs, doc)

	if code := setBriefing(t, f, canvasID, map[string]any{"docId": doc.ID.String()}); code != 200 {
		t.Fatalf("set by id → %d", code)
	}
	if f.briefingDocID == nil || *f.briefingDocID != doc.ID {
		t.Fatalf("briefingDocId = %v, want %v", f.briefingDocID, doc.ID)
	}

	// A name works too — every document-addressing route in this API takes either.
	f.briefingDocID = nil
	if code := setBriefing(t, f, canvasID, map[string]any{"docId": "project brief"}); code != 200 {
		t.Fatalf("set by name → %d", code)
	}
	if f.briefingDocID == nil || *f.briefingDocID != doc.ID {
		t.Fatalf("name resolve failed: %v", f.briefingDocID)
	}

	// Explicit null clears.
	if code := setBriefing(t, f, canvasID, map[string]any{"docId": nil}); code != 200 {
		t.Fatalf("clear → %d", code)
	}
	if f.briefingDocID != nil {
		t.Fatalf("expected the designation cleared, got %v", f.briefingDocID)
	}
}

func TestSetBriefing_UnknownDocIs404(t *testing.T) {
	f := newBriefingFake()
	if code := setBriefing(t, f, uuid.New(), map[string]any{"docId": uuid.New().String()}); code != 404 {
		t.Fatalf("unknown docId → %d, want 404", code)
	}
	if f.briefingSetSet != 0 {
		t.Fatalf("a failed resolve must not write")
	}
}
