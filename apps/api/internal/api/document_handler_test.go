package api

import (
	"strings"
	"testing"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

func doc(t, name string, sort int) *store.Document {
	return &store.Document{ID: uuid.New(), Kind: "document", Type: t, Name: name, SortOrder: sort}
}

func TestResolveDocInList_ByName(t *testing.T) {
	budget := doc("sheet", "Budget", 1)
	docs := []*store.Document{doc("map", "Japan", 0), budget, doc("notes", "Ideas", 2)}

	// case-insensitive name match.
	got, err := resolveDocInList(docs, "budget", "")
	if err != nil || got.ID != budget.ID {
		t.Fatalf("expected Budget, got %v err=%v", got, err)
	}

	// type filter excludes a same-named doc of another type.
	if _, err := resolveDocInList(docs, "Japan", "notes"); err == nil {
		t.Fatalf("expected no notes doc named Japan")
	}

	// unknown name lists what's available.
	_, err = resolveDocInList(docs, "Nope", "")
	if err == nil || !strings.Contains(err.Error(), "Budget") {
		t.Fatalf("expected helpful error listing docs, got %v", err)
	}
}

func TestResolveDocInList_ByID(t *testing.T) {
	target := doc("map", "Japan", 0)
	docs := []*store.Document{target, doc("sheet", "Budget", 1)}

	got, err := resolveDocInList(docs, target.ID.String(), "")
	if err != nil || got.ID != target.ID {
		t.Fatalf("id lookup failed: %v err=%v", got, err)
	}
	// a well-formed id that isn't present errors.
	if _, err := resolveDocInList(docs, uuid.New().String(), ""); err == nil {
		t.Fatalf("expected miss for absent id")
	}
	// id of the wrong type is out of scope.
	if _, err := resolveDocInList(docs, target.ID.String(), "sheet"); err == nil {
		t.Fatalf("expected type-scoped id miss")
	}
}

func TestResolveDocInList_Ambiguous(t *testing.T) {
	docs := []*store.Document{doc("map", "Trip", 0), doc("notes", "Trip", 1)}
	_, err := resolveDocInList(docs, "Trip", "")
	if err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("expected ambiguity error, got %v", err)
	}
	// but scoping by type disambiguates.
	if got, err := resolveDocInList(docs, "Trip", "map"); err != nil || got.Type != "map" {
		t.Fatalf("type-scoped resolve should be unambiguous, got %v err=%v", got, err)
	}
}

// A folder is resolvable like any other document, and the "folder" type filter
// (used when moving a document into a folder, item 8.5) excludes non-folders so a
// document can't be nested under, say, a sheet that happens to share a name.
func TestResolveDocInList_Folder(t *testing.T) {
	trips := doc("folder", "Trips", 0)
	docs := []*store.Document{trips, doc("sheet", "Trips", 1)}

	got, err := resolveDocInList(docs, "Trips", "folder")
	if err != nil || got.ID != trips.ID {
		t.Fatalf("expected the Trips folder, got %v err=%v", got, err)
	}
	// A name that only matches a non-folder is out of scope under the folder filter.
	if _, err := resolveDocInList([]*store.Document{doc("sheet", "Budget", 0)}, "Budget", "folder"); err == nil {
		t.Fatalf("expected no folder named Budget")
	}
}

func TestResolveDocInList_Empty(t *testing.T) {
	if _, err := resolveDocInList(nil, "  ", ""); err == nil {
		t.Fatalf("blank ref should error")
	}
}

func TestPickDefaultDoc(t *testing.T) {
	first := doc("map", "A", 1)
	docs := []*store.Document{doc("notes", "N", 0), doc("map", "B", 5), first}
	got := pickDefaultDoc(docs, "map")
	if got == nil || got.ID != first.ID {
		t.Fatalf("expected lowest-sortOrder map doc, got %v", got)
	}
	if pickDefaultDoc(docs, "itinerary") != nil {
		t.Fatalf("expected nil when no doc of type exists")
	}
}

func TestNextDocSortOrder(t *testing.T) {
	if n := nextDocSortOrder(nil); n != 0 {
		t.Fatalf("empty → 0, got %d", n)
	}
	docs := []*store.Document{doc("map", "A", 0), doc("sheet", "B", 3), doc("notes", "C", 1)}
	if n := nextDocSortOrder(docs); n != 4 {
		t.Fatalf("expected max+1=4, got %d", n)
	}
}
