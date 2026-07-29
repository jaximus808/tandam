package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func sampleResults() Results {
	sr := baseResult()
	sr.Canvas = ScratchCanvas{Code: "ABCD1234", ID: "id-1", Name: "loadtest-tdm44-unit", Scenario: "unit"}
	sr.Assertions = evaluate(charterTargets(), sr)
	sr.Summary = summarize(sr.Assertions)
	return Results{
		Schema:  resultsSchema,
		Targets: charterTargets(),
		Run: RunInfo{
			RunID: "abcd1234", API: "http://localhost:7891",
			StartedAt: time.Unix(0, 0).UTC(), FinishedAt: time.Unix(60, 0).UTC(),
			GitRev: "deadbeefcafe", GoVersion: "go1.24.0", GOOS: "darwin", GOARCH: "arm64", NumCPU: 10,
		},
		Scenarios:       []ScenarioResult{sr},
		Summary:         sr.Summary,
		ScratchCanvases: []ScratchCanvas{sr.Canvas},
	}
}

// The schema is the contract that lets two baselines be compared. A rename of
// any of these keys silently breaks every historical file, so they are pinned.
func TestResultsSchemaTopLevelKeys(t *testing.T) {
	b, err := json.Marshal(sampleResults())
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"schema", "run", "targets", "scenarios", "summary", "scratch_canvases"} {
		if _, ok := m[key]; !ok {
			t.Errorf("results file lost its %q key", key)
		}
	}
	var schema string
	_ = json.Unmarshal(m["schema"], &schema)
	if schema != "tandem.loadtest.v1" {
		t.Errorf("schema = %q — bumping it invalidates every existing baseline, so do it deliberately", schema)
	}
}

func TestScenarioResultKeys(t *testing.T) {
	b, _ := json.Marshal(sampleResults().Scenarios[0])
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"name", "params", "wall_seconds", "measured_seconds", "task_ops_per_sec",
		"ops", "server", "invariant", "claim_cross_check", "assertions", "assertion_summary", "canvas",
	} {
		if _, ok := m[key]; !ok {
			t.Errorf("scenario result lost its %q key", key)
		}
	}
}

// Two runs of the same shape must serialize identically apart from the numbers
// that actually changed — otherwise `diff` between baselines is unreadable and
// nobody will use it.
func TestResultsSerializationIsDeterministic(t *testing.T) {
	first, err := json.MarshalIndent(sampleResults(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		next, _ := json.MarshalIndent(sampleResults(), "", "  ")
		if string(first) != string(next) {
			t.Fatal("identical results serialized differently — map iteration order is leaking into the file")
		}
	}
}

func TestWriteResultsCreatesDirsAndValidJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "baselines", "nested", "baseline-x.json")
	if err := writeResults(path, sampleResults()); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var back Results
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("written file is not valid JSON: %v", err)
	}
	if back.Schema != resultsSchema || len(back.Scenarios) != 1 {
		t.Errorf("round-trip lost content: %+v", back)
	}
	if b[len(b)-1] != '\n' {
		t.Error("results file should end with a newline so it diffs cleanly")
	}
}

// The scratch canvases cannot be deleted by the tool (owner-only endpoint), so
// the file IS the cleanup list. Losing a code means leaking a canvas.
func TestScratchCanvasesAreRecorded(t *testing.T) {
	res := sampleResults()
	if len(res.ScratchCanvases) != 1 || res.ScratchCanvases[0].Code == "" {
		t.Fatalf("scratch canvases = %+v, want the code recorded for cleanup", res.ScratchCanvases)
	}
	b, _ := json.Marshal(res)
	if !containsSub(string(b), "ABCD1234") {
		t.Error("the scratch canvas code did not survive serialization")
	}
}

func TestScenarioParamsAreRecorded(t *testing.T) {
	sc, _ := scenarioByName("agents-64")
	b, _ := json.Marshal(sc)
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"agents", "queue_depth", "rounds", "ops_per_agent_round", "mix"} {
		if _, ok := m[key]; !ok {
			t.Errorf("scenario params lost %q — a number nobody can reproduce is not a baseline", key)
		}
	}
	mix, _ := m["mix"].(map[string]any)
	for _, key := range []string{"queue_list", "task_get", "context_get", "task_claim", "status_post", "task_complete"} {
		if _, ok := mix[key]; !ok {
			t.Errorf("op mix lost %q", key)
		}
	}
}

func TestDedupeNotes(t *testing.T) {
	got := dedupe([]string{"a", "b", "a", "c", "b"})
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Errorf("dedupe = %v, want [a b c] in first-seen order", got)
	}
}

func containsSub(hay, needle string) bool {
	for i := 0; i+len(needle) <= len(hay); i++ {
		if hay[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
