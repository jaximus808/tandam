package store

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TDM-40 (E4.1) — the store half of provenance: the authored_by column
// (migration 0039) reaches the INSERT payload on every create path, comes back
// out of a read, and — the part that's easy to get wrong — does BOTH without
// breaking bulk inserts or an API deployed before the migration lands.

func strp(s string) *string { return &s }

// Each row builder must name the column when provenance was derived, and must
// NOT name it when it wasn't. The omission is deliberate: PostgREST 400s on an
// unknown column, so an API that shipped ahead of 0039 keeps inserting cleanly
// instead of failing every create on the canvas.
func TestRowBuildersCarryAuthoredBy(t *testing.T) {
	canvasID, now := uuid.New(), time.Now().UTC()
	author := strp("agent:planner-1")

	actionSet, err := actionRow(canvasID, &Action{ID: uuid.New(), Type: "task", AuthoredBy: author}, now)
	if err != nil {
		t.Fatalf("actionRow: %v", err)
	}
	actionUnset, err := actionRow(canvasID, &Action{ID: uuid.New(), Type: "task"}, now)
	if err != nil {
		t.Fatalf("actionRow (unset): %v", err)
	}
	docSet, err := documentRow(canvasID, &Document{ID: uuid.New(), Type: "notes", AuthoredBy: author}, now)
	if err != nil {
		t.Fatalf("documentRow: %v", err)
	}
	docUnset, err := documentRow(canvasID, &Document{ID: uuid.New(), Type: "notes"}, now)
	if err != nil {
		t.Fatalf("documentRow (unset): %v", err)
	}

	set := map[string]map[string]any{
		"action":   actionSet,
		"note":     noteRow(canvasID, &Note{ID: uuid.New(), AuthoredBy: author}, now),
		"document": docSet,
	}
	for name, row := range set {
		if row["authored_by"] != *author {
			t.Errorf("%sRow: authored_by = %v, want %q", name, row["authored_by"], *author)
		}
	}

	unset := map[string]map[string]any{
		"action":   actionUnset,
		"note":     noteRow(canvasID, &Note{ID: uuid.New()}, now),
		"document": docUnset,
	}
	for name, row := range unset {
		if _, present := row["authored_by"]; present {
			t.Errorf("%sRow named authored_by with nil provenance — that breaks a pre-0039 deploy", name)
		}
	}
}

// PostgREST rejects a bulk INSERT whose objects don't all share a key set
// (PGRST102), which is exactly what a conditionally-added column produces on a
// mixed batch. backfillNullKey is the leveller — and it must stay a no-op when
// nothing has the key, or it would reintroduce the pre-migration failure.
func TestBackfillNullKeyLevelsMixedBatches(t *testing.T) {
	rows := []map[string]any{
		{"id": "a", "authored_by": "human"},
		{"id": "b"},
	}
	backfillNullKey(rows, "authored_by")
	v, present := rows[1]["authored_by"]
	if !present {
		t.Fatal("row without the key was not backfilled")
	}
	if v != nil {
		t.Fatalf("backfilled value = %v, want nil", v)
	}

	none := []map[string]any{{"id": "a"}, {"id": "b"}}
	backfillNullKey(none, "authored_by")
	for i, r := range none {
		if _, present := r["authored_by"]; present {
			t.Fatalf("row %d gained authored_by from an all-absent batch", i)
		}
	}
}

// Reads are select=* into a db* DTO, so a new column only surfaces if the DTO
// and the converter both know about it. This is the test that fails if someone
// adds the column to the row builders and forgets the read side.
func TestReadsSurfaceAuthoredBy(t *testing.T) {
	id := uuid.New().String()

	var da dbAction
	if err := json.Unmarshal([]byte(`{"id":"`+id+`","type":"task","state":"approved","authored_by":"agent:executor-3"}`), &da); err != nil {
		t.Fatalf("unmarshal dbAction: %v", err)
	}
	if got := toAction(da).AuthoredBy; got == nil || *got != "agent:executor-3" {
		t.Fatalf("toAction AuthoredBy = %v, want agent:executor-3", got)
	}

	var dn dbNote
	if err := json.Unmarshal([]byte(`{"id":"`+id+`","body":"hi","authored_by":"human"}`), &dn); err != nil {
		t.Fatalf("unmarshal dbNote: %v", err)
	}
	if got := toNote(dn).AuthoredBy; got == nil || *got != "human" {
		t.Fatalf("toNote AuthoredBy = %v, want human", got)
	}

	var dd dbDocument
	if err := json.Unmarshal([]byte(`{"id":"`+id+`","type":"notes","name":"Notes","authored_by":"anonymous"}`), &dd); err != nil {
		t.Fatalf("unmarshal dbDocument: %v", err)
	}
	if got := toDocument(dd).AuthoredBy; got == nil || *got != "anonymous" {
		t.Fatalf("toDocument AuthoredBy = %v, want anonymous", got)
	}
}

// A row written before 0039 comes back with the column absent (or NULL). It must
// stay nil — "unknown" — rather than be coerced into an empty string that the UI
// would then have to special-case.
func TestPreProvenanceRowsReadBackAsNil(t *testing.T) {
	id := uuid.New().String()

	var da dbAction
	_ = json.Unmarshal([]byte(`{"id":"`+id+`","type":"task","state":"approved"}`), &da)
	if got := toAction(da).AuthoredBy; got != nil {
		t.Fatalf("action AuthoredBy = %q, want nil", *got)
	}

	var dn dbNote
	_ = json.Unmarshal([]byte(`{"id":"`+id+`","body":"hi","authored_by":null}`), &dn)
	if got := toNote(dn).AuthoredBy; got != nil {
		t.Fatalf("note AuthoredBy = %q, want nil", *got)
	}

	var dd dbDocument
	_ = json.Unmarshal([]byte(`{"id":"`+id+`","type":"notes","name":"Notes"}`), &dd)
	if got := toDocument(dd).AuthoredBy; got != nil {
		t.Fatalf("document AuthoredBy = %q, want nil", *got)
	}
}

// Provenance is stamped at creation and is not a field anything can edit later.
// If a patch struct ever grows an AuthoredBy, the column stops being a fact
// about who made the row — so assert the update payloads stay clean.
func TestUpdatePathsCannotRewriteAuthoredBy(t *testing.T) {
	body, name := "edited", "renamed"
	patches := map[string]any{
		"NotePatch":        NotePatch{Body: &body},
		"DocumentPatch":    DocumentPatch{Name: &name},
		"ActionStatePatch": ActionStatePatch{State: "approved"},
	}
	for kind, p := range patches {
		b, err := json.Marshal(p)
		if err != nil {
			t.Fatalf("marshal %s: %v", kind, err)
		}
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		for k := range m {
			if k == "authoredBy" || k == "AuthoredBy" || k == "authored_by" {
				t.Fatalf("%s exposes %q — authorship must be create-only", kind, k)
			}
		}
	}
}
