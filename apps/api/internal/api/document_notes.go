package api

import (
	"net/http"
	"sort"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// The document-scoped notes read (TDM-179) — "read the tab I wrote" in ONE call.
//
// WHY AN ENDPOINT AND NOT THE STATE READ. Agents write documents with doc_write,
// and until now the only way to read one back was GET /api/canvas/state
// ?fields=notes, which returns EVERY note on the canvas and leaves the caller to
// match documentId against a second read of fields=documents. On a board whose
// docs are the strategy writing, that is the whole corpus pulled into a context
// window to answer a question about one tab. This is the same read, scoped
// server-side: one document's notes, in the order the tab shows them.
//
// NOT A NEW QUERY. store.ListNotesByDocument already exists (it backs the
// briefing render in context_get) and already matches canvas_id alongside
// document_id, so a document id from another canvas cannot read across the
// tenancy boundary. This ticket is the HTTP surface over it, nothing more.

// documentNoteLine is one note as a reader meets it: what it says, who put it
// there, when it last changed. Deliberately NOT store.Note — a document read
// wants the body and its provenance, not sortOrder/imageRefs/parentKind/the
// freshness pair, all of which are canvas-editor plumbing. The full row is still
// one state read away for anything that needs it.
type documentNoteLine struct {
	ID        uuid.UUID `json:"id"`
	Body      string    `json:"body"`
	CreatedBy string    `json:"createdBy"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// documentNotesRef identifies the tab that answered, so a caller who addressed
// it BY NAME ("Thesis") can see which document that resolved to.
type documentNotesRef struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
	Type string    `json:"type"`
}

// documentNotesBody is the endpoint's response.
type documentNotesBody struct {
	Document documentNotesRef   `json:"document"`
	Notes    []documentNoteLine `json:"notes"`
	Hint     string             `json:"_hint"`
}

// buildDocumentNotes is the whole projection, PURE: a document and its notes in,
// the response out. Split from the handler so the ordering rule and the
// this-tab-only guarantee are testable without a store.
//
// Ordering is sortOrder, then id as a tiebreak — the order the tab renders in,
// made explicit here rather than inherited from the query, so the contract holds
// whatever the store hands back.
//
// The document_id filter is belt-and-braces: ListNotesByDocument already scopes
// the query, and re-checking here means "exactly this tab's notes and nothing
// else" is a property of the endpoint rather than a property of a SQL clause
// somewhere else.
func buildDocumentNotes(doc *store.Document, notes []*store.Note) documentNotesBody {
	mine := make([]*store.Note, 0, len(notes))
	for _, n := range notes {
		if n == nil || n.DocumentID == nil || *n.DocumentID != doc.ID {
			continue
		}
		mine = append(mine, n)
	}
	sort.SliceStable(mine, func(i, j int) bool {
		if mine[i].SortOrder != mine[j].SortOrder {
			return mine[i].SortOrder < mine[j].SortOrder
		}
		return mine[i].ID.String() < mine[j].ID.String()
	})

	lines := make([]documentNoteLine, 0, len(mine))
	for _, n := range mine {
		lines = append(lines, documentNoteLine{
			ID:        n.ID,
			Body:      n.Body,
			CreatedBy: n.CreatedBy,
			UpdatedAt: n.UpdatedAt,
		})
	}
	return documentNotesBody{
		Document: documentNotesRef{ID: doc.ID, Name: doc.Name, Type: doc.Type},
		Notes:    lines,
		Hint: "One document's notes, in the order the tab shows them — the read side of doc_write. " +
			"Addressed by document id or name. This is the whole tab: nothing from any other document " +
			"is here, and nothing here is elided.",
	}
}

// GET /api/canvas/documents/{ref}/notes   (canvas JWT required; any role)
//
// {ref} is a document id OR name, url-encoded — the same ref every other
// document-addressing route in this API takes (PATCH/DELETE /documents/{ref}),
// which matters here because the agent that wrote the tab with doc_write knows
// it by the name it passed, not by a uuid it never saw. An unresolvable ref is a
// 404 whose message lists the canvas's documents.
func (h *Handler) ListDocumentNotes(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	canvasID := CanvasIDFromCtx(ctx)

	doc, err := h.resolveDocumentRef(ctx, canvasID, chi.URLParam(r, "ref"), "")
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	notes, err := h.store.ListNotesByDocument(ctx, canvasID, doc.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Same pulse as the other agent read paths — a session reading a document is
	// presence the board should show.
	broadcastActivity(h.hub, canvasID, "read")

	writeJSON(w, http.StatusOK, buildDocumentNotes(doc, notes))
}
