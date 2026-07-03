package api

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// Documents are the named, multi-instance tabs of a canvas (migration 0024).
// This file is the "MCP document targeting" surface (roadmap item 7): agents
// list / create / address documents by id OR name ("the budget sheet"), and
// content-creating tools can target which document a new pin/note/event/roadmap
// item lands in.

// docTypesCreatable are the types canvas_document_add can mint directly. Charts
// are excluded: a chart needs a source sheet, so it's born from canvas_chart_add.
var docTypesCreatable = map[string]bool{
	"map": true, "notes": true, "itinerary": true, "roadmap": true, "sheet": true,
}

// defaultDocNames names an auto-created singleton document when content is added
// without targeting one (e.g. first pin on a fresh canvas → a "Map" document).
var defaultDocNames = map[string]string{
	"map": "Map", "notes": "Notes", "itinerary": "Itinerary", "roadmap": "Roadmap",
}

// resolveDocumentRef finds a document on the canvas by a ref that may be a UUID
// or a case-insensitive name. typeFilter scopes the match to one type ("" = any).
// Errors are written for the agent: an unknown ref lists the available documents;
// an ambiguous name says so.
func (h *Handler) resolveDocumentRef(ctx context.Context, canvasID uuid.UUID, ref, typeFilter string) (*store.Document, error) {
	docs, err := h.store.ListDocuments(ctx, canvasID)
	if err != nil {
		return nil, err
	}
	return resolveDocInList(docs, ref, typeFilter)
}

// resolveDocInList is the pure matching core (no store): find one document in
// docs by a ref that's a UUID or a case-insensitive name, scoped to typeFilter
// ("" = any). Split out so the id/name/ambiguity rules are unit-testable.
func resolveDocInList(docs []*store.Document, ref, typeFilter string) (*store.Document, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil, fmt.Errorf("no document specified")
	}
	inScope := func(d *store.Document) bool { return typeFilter == "" || d.Type == typeFilter }

	// A UUID ref addresses exactly one document.
	if id, perr := uuid.Parse(ref); perr == nil {
		for _, d := range docs {
			if d.ID == id && inScope(d) {
				return d, nil
			}
		}
		return nil, fmt.Errorf("no %s document with id %s", typeOrDoc(typeFilter), ref)
	}

	// Otherwise match by name (case-insensitive), erroring on ambiguity.
	var matches []*store.Document
	for _, d := range docs {
		if inScope(d) && strings.EqualFold(strings.TrimSpace(d.Name), ref) {
			matches = append(matches, d)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return nil, fmt.Errorf("no %s document named %q — have: %s", typeOrDoc(typeFilter), ref, documentNames(docs, typeFilter))
	default:
		return nil, fmt.Errorf("%q is ambiguous — %d documents share that name; address it by id instead", ref, len(matches))
	}
}

// documentForContent decides which document a new child of docType belongs to.
// A non-empty ref targets an existing document (by id or name). An empty ref
// falls back to the canvas's first document of that type, CREATING one if none
// exists — so legacy add calls that predate documents still land somewhere sane
// and every new child gets a document_id.
func (h *Handler) documentForContent(ctx context.Context, canvasID uuid.UUID, docType, ref string) (uuid.UUID, error) {
	docs, err := h.store.ListDocuments(ctx, canvasID)
	if err != nil {
		return uuid.Nil, err
	}
	if strings.TrimSpace(ref) != "" {
		doc, err := resolveDocInList(docs, ref, docType)
		if err != nil {
			return uuid.Nil, err
		}
		return doc.ID, nil
	}
	return ensureDefaultDocInList(ctx, h.store, canvasID, docs, docType, "agent")
}

// ensureDefaultDocument returns the id of the canvas's default document of
// docType, creating one if there is none. It's the "content added without a
// target lands in a sane default doc" rule, shared by the REST handlers and the
// WS ops (note.add / roadmap.add) so web- and agent-created content behave alike.
func ensureDefaultDocument(ctx context.Context, st store.Store, canvasID uuid.UUID, docType, createdBy string) (uuid.UUID, error) {
	docs, err := st.ListDocuments(ctx, canvasID)
	if err != nil {
		return uuid.Nil, err
	}
	return ensureDefaultDocInList(ctx, st, canvasID, docs, docType, createdBy)
}

// ensureDefaultDocInList is ensureDefaultDocument given an already-fetched list
// (avoids a redundant ListDocuments when the caller has one in hand).
func ensureDefaultDocInList(ctx context.Context, st store.Store, canvasID uuid.UUID, docs []*store.Document, docType, createdBy string) (uuid.UUID, error) {
	if def := pickDefaultDoc(docs, docType); def != nil {
		return def.ID, nil
	}
	name := defaultDocNames[docType]
	if name == "" {
		name = docType
	}
	doc := &store.Document{ID: uuid.New(), Kind: "document", Type: docType,
		Name: name, SortOrder: nextDocSortOrder(docs), CreatedBy: createdBy}
	if _, err := st.CreateDocument(ctx, canvasID, doc); err != nil {
		return uuid.Nil, err
	}
	return doc.ID, nil
}

// pickDefaultDoc returns the canvas's default document of docType — the one with
// the lowest sortOrder (stable across reads) — or nil if there are none.
func pickDefaultDoc(docs []*store.Document, docType string) *store.Document {
	var def *store.Document
	for _, d := range docs {
		if d.Type == docType && (def == nil || d.SortOrder < def.SortOrder) {
			def = d
		}
	}
	return def
}

// nextDocSortOrder appends new documents after the current last tab.
func nextDocSortOrder(docs []*store.Document) int {
	max := -1
	for _, d := range docs {
		if d.SortOrder > max {
			max = d.SortOrder
		}
	}
	return max + 1
}

func documentNames(docs []*store.Document, typeFilter string) string {
	var names []string
	for _, d := range docs {
		if typeFilter == "" || d.Type == typeFilter {
			names = append(names, fmt.Sprintf("%q (%s)", d.Name, d.Type))
		}
	}
	if len(names) == 0 {
		return "(none yet)"
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

func typeOrDoc(typeFilter string) string {
	if typeFilter == "" {
		return ""
	}
	return typeFilter
}

// attachDocument resolves which document a new child of docType belongs to and
// returns its id, or writes a 400 and returns ok=false. ref may be a document id
// or name; empty ref falls back to (or creates) the canvas's default doc of that
// type. Used by the content-add handlers to implement "add X to the budget sheet".
func (h *Handler) attachDocument(w http.ResponseWriter, r *http.Request, canvasID uuid.UUID, docType, ref string) (*uuid.UUID, bool) {
	docID, err := h.documentForContent(r.Context(), canvasID, docType, ref)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, false
	}
	return &docID, true
}

// GET /api/canvas/documents — the tab list, ordered for display.
func (h *Handler) ListDocuments(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	docs, err := h.store.ListDocuments(r.Context(), canvasID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	sort.SliceStable(docs, func(i, j int) bool { return docs[i].SortOrder < docs[j].SortOrder })
	writeJSON(w, http.StatusOK, map[string]any{"documents": docs})
}

// POST /api/canvas/documents — create a document (a new tab). For type "sheet"
// this also mints the empty backing sheet; charts must go through canvas_chart_add.
func (h *Handler) CreateDocument(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Type      string         `json:"type"`
		Name      string         `json:"name"`
		Config    map[string]any `json:"config"`
		SortOrder *int           `json:"sortOrder"`
		CreatedBy string         `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	body.Type = strings.TrimSpace(body.Type)
	if body.Type == "chart" {
		writeError(w, http.StatusBadRequest, "create charts with canvas_chart_add — a chart needs a source sheet")
		return
	}
	if !docTypesCreatable[body.Type] {
		writeError(w, http.StatusBadRequest, "invalid document type: "+body.Type+" (map, notes, itinerary, roadmap, sheet)")
		return
	}
	if body.CreatedBy == "" {
		body.CreatedBy = "agent"
	}
	if strings.TrimSpace(body.Name) == "" {
		if n := defaultDocNames[body.Type]; n != "" {
			body.Name = n
		} else {
			body.Name = "Untitled " + body.Type
		}
	}
	sortOrder := 0
	if body.SortOrder != nil {
		sortOrder = *body.SortOrder
	} else if docs, err := h.store.ListDocuments(r.Context(), canvasID); err == nil {
		sortOrder = nextDocSortOrder(docs)
	}

	// A sheet document is 1:1 with a sheet row — create the sheet and let the
	// store mint the matching document (keeps the pairing in one place).
	if body.Type == "sheet" {
		sh := &store.Sheet{ID: uuid.New(), Kind: "sheet", Name: body.Name,
			Columns: []store.SheetColumn{}, SortOrder: sortOrder, CreatedBy: body.CreatedBy}
		if _, err := h.store.CreateSheet(r.Context(), canvasID, sh); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		broadcastState(r.Context(), h.store, h.hub, canvasID)
		doc, _ := h.store.GetDocument(r.Context(), canvasID, *sh.DocumentID)
		writeJSON(w, http.StatusCreated, map[string]any{"document": doc, "sheetId": sh.ID})
		return
	}

	doc := &store.Document{ID: uuid.New(), Kind: "document", Type: body.Type,
		Name: body.Name, Config: body.Config, SortOrder: sortOrder, CreatedBy: body.CreatedBy}
	if _, err := h.store.CreateDocument(r.Context(), canvasID, doc); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, map[string]any{"document": doc})
}

// PATCH /api/canvas/documents/{ref} — rename / reorder / reconfigure. {ref} is a
// document id or name (url-encoded); name is resolved across all types.
func (h *Handler) UpdateDocument(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	doc, err := h.resolveDocumentRef(r.Context(), canvasID, chi.URLParam(r, "ref"), "")
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	var patch store.DocumentPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := h.store.UpdateDocument(r.Context(), canvasID, doc.ID, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/documents/{ref} — remove a document and cascade its children
// (its pins/notes/events/roadmap items, or its sheet/chart + rows).
func (h *Handler) DeleteDocument(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	doc, err := h.resolveDocumentRef(r.Context(), canvasID, chi.URLParam(r, "ref"), "")
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if _, err := h.store.DeleteDocument(r.Context(), canvasID, doc.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}
