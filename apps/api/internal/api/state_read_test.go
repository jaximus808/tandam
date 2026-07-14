package api

import (
	"strings"
	"testing"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

func strptr(s string) *string { return &s }

func sampleState() *store.CanvasState {
	rid := uuid.New()
	nid := uuid.New()
	pid := uuid.New()
	did := uuid.New()
	aid := uuid.New()
	return &store.CanvasState{
		Version:      7,
		Mode:         "roadmap",
		EnabledModes: []string{"roadmap", "map"},
		Documents:    map[string]*store.Document{did.String(): {ID: did, Type: "map", Name: "Japan"}},
		Pins:         map[string]*store.Pin{pid.String(): {ID: pid, DocumentID: &did, Label: strptr("Tokyo Tower")}},
		RoadmapItems: map[string]*store.RoadmapItem{rid.String(): {ID: rid, Title: "Fix the state barf"}},
		Notes:        map[string]*store.Note{nid.String(): {ID: nid, Body: "line one\nline two"}},
		Actions:      map[string]*store.Action{aid.String(): {ID: aid, Type: "task", State: "done"}},
	}
}

func TestValidateStateFields(t *testing.T) {
	got, err := validateStateFields("roadmapItems, notes ,roadmapItems")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// dedupes and trims.
	if len(got) != 2 || got[0] != "roadmapItems" || got[1] != "notes" {
		t.Fatalf("got %v, want [roadmapItems notes]", got)
	}

	if _, err := validateStateFields(""); err != nil {
		t.Fatalf("empty should be nil error, got %v", err)
	}

	_, err = validateStateFields("roadmapItems,bogus")
	if err == nil || !strings.Contains(err.Error(), "bogus") {
		t.Fatalf("expected error naming the bad field, got %v", err)
	}
}

func TestProjectStateKeepsOnlyRequested(t *testing.T) {
	out := projectState(sampleState(), []string{"roadmapItems"})
	if out.Version != 7 || out.Mode != "roadmap" || len(out.EnabledModes) != 2 {
		t.Fatalf("bearings (version/mode/enabledModes) must always ride along: %+v", out)
	}
	if len(out.RoadmapItems) != 1 {
		t.Fatalf("requested kind should be present, got %d", len(out.RoadmapItems))
	}
	if out.Notes != nil || out.Pins != nil || out.Documents != nil {
		t.Fatalf("unrequested kinds must be nil, got notes=%v pins=%v documents=%v", out.Notes, out.Pins, out.Documents)
	}

	// documents is a projectable kind.
	docsOnly := projectState(sampleState(), []string{"documents"})
	if len(docsOnly.Documents) != 1 || docsOnly.RoadmapItems != nil {
		t.Fatalf("documents projection wrong: docs=%d roadmap=%v", len(docsOnly.Documents), docsOnly.RoadmapItems)
	}
}

func TestSummarizeState(t *testing.T) {
	msg := summarizeState(nil, sampleState(), nil)
	if msg.Type != "state.summary" {
		t.Fatalf("type = %q", msg.Type)
	}
	if msg.Mode != "roadmap" || msg.Version != 7 {
		t.Fatalf("summary must carry mode/version, got %q/%d", msg.Mode, msg.Version)
	}
	if msg.Counts["roadmapItems"] != 1 || msg.Counts["notes"] != 1 || msg.Counts["events"] != 0 {
		t.Fatalf("counts wrong: %+v", msg.Counts)
	}
	if msg.Counts["documents"] != 1 {
		t.Fatalf("documents count wrong: %+v", msg.Counts)
	}
	if got := msg.Names["documents"]; len(got) != 1 || got[0] != "Japan (map)" {
		t.Fatalf("document name should carry type, got %v", got)
	}
	if got := msg.Names["roadmapItems"]; len(got) != 1 || got[0] != "Fix the state barf" {
		t.Fatalf("roadmap names wrong: %v", got)
	}
	// notes summarize to first line only.
	if got := msg.Names["notes"]; len(got) != 1 || got[0] != "line one" {
		t.Fatalf("note name should be first line, got %v", got)
	}
	// a kind with zero items has no names entry.
	if _, ok := msg.Names["events"]; ok {
		t.Fatalf("empty kind should not appear in names")
	}
	// Actions are counted but deliberately NOT name-listed — "type:state" is
	// non-identifying noise that scales with the action count. canvas_task_list /
	// canvas_action_list are the real views.
	if msg.Counts["actions"] != 1 {
		t.Fatalf("actions must still be counted: %+v", msg.Counts)
	}
	if _, ok := msg.Names["actions"]; ok {
		t.Fatalf("actions must not appear in names, got %v", msg.Names["actions"])
	}
}

func TestClipAndCapNames(t *testing.T) {
	long := strings.Repeat("x", 200)
	if got := clip(long); len([]rune(got)) > 81 { // 80 + ellipsis
		t.Fatalf("clip too long: %d", len([]rune(got)))
	}

	names := make([]string, maxSummaryNames+5)
	for i := range names {
		names[i] = "n"
	}
	capped := capNames(names)
	if len(capped) != maxSummaryNames+1 {
		t.Fatalf("capNames len = %d, want %d", len(capped), maxSummaryNames+1)
	}
	if !strings.Contains(capped[len(capped)-1], "more") {
		t.Fatalf("last entry should note truncation, got %q", capped[len(capped)-1])
	}
}
