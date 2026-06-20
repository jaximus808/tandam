package forms

import (
	"encoding/json"
	"testing"
)

func litSource(v any) Source {
	b, _ := json.Marshal(v)
	return Source{Literal: b}
}

func codes(ds []Diagnostic) map[string]bool {
	m := map[string]bool{}
	for _, d := range ds {
		m[d.Code] = true
	}
	return m
}

// The canonical meal example compiles clean and expands to one append action.
func TestCompileHappyPath(t *testing.T) {
	state, mealCols, _, _, _, _ := newTestState()
	_ = mealCols
	intent := Intent{
		Name: "Log a meal",
		Fields: []Field{
			{Key: "meal", Label: "Meal", Type: "text", Required: true},
			{Key: "calories", Label: "Calories", Type: "number"},
		},
		Writes: []Write{{
			Sheet: "Meals", Mode: "append",
			Columns: map[string]Source{
				"Meal":     {Field: "meal"},
				"Calories": {Field: "calories"},
				"Date":     {Computed: "today"},
			},
		}},
	}
	res, fields, actions := Compile(intent, state)
	if !res.OK {
		t.Fatalf("expected ok, got errors: %+v", res.Errors)
	}
	if len(fields) != 2 {
		t.Errorf("want 2 fields, got %d", len(fields))
	}
	if len(actions) != 1 || actions[0].Op != "sheet.row.append" {
		t.Fatalf("want 1 append action, got %+v", actions)
	}
	if len(actions[0].Set) != 3 {
		t.Errorf("want 3 set bindings, got %d", len(actions[0].Set))
	}
}

// Mirrors the doc's rendered failing example: a misspelled field and column.
func TestCompileReportsFieldAndColumnErrors(t *testing.T) {
	state, _, _, _, _, _ := newTestState()
	intent := Intent{
		Name: "Log a meal",
		Fields: []Field{
			{Key: "meal", Label: "Meal", Type: "text", Required: true},
			{Key: "calories", Label: "Calories", Type: "number"},
		},
		Writes: []Write{{
			Sheet: "Meals", Mode: "append",
			Columns: map[string]Source{
				"Calories": {Field: "calorie"},  // typo → SOURCE_FIELD_UNKNOWN
				"Dat":      {Computed: "today"}, // typo → COLUMN_NOT_FOUND
			},
		}},
	}
	res, _, _ := Compile(intent, state)
	if res.OK {
		t.Fatal("expected failure")
	}
	cs := codes(res.Errors)
	if !cs["SOURCE_FIELD_UNKNOWN"] {
		t.Error("missing SOURCE_FIELD_UNKNOWN")
	}
	if !cs["COLUMN_NOT_FOUND"] {
		t.Error("missing COLUMN_NOT_FOUND")
	}
	// did-you-mean should fire on both
	var fieldDiag *Diagnostic
	for i := range res.Errors {
		if res.Errors[i].Code == "SOURCE_FIELD_UNKNOWN" {
			fieldDiag = &res.Errors[i]
		}
	}
	if fieldDiag == nil || fieldDiag.Suggestion == "" {
		t.Error("expected a 'did you mean' suggestion for the misspelled field")
	}
}

func TestCompileStructural(t *testing.T) {
	state, _, _, _, _, _ := newTestState()
	res, _, _ := Compile(Intent{}, state)
	cs := codes(res.Errors)
	for _, want := range []string{"FORM_NAME_REQUIRED", "FORM_NO_FIELDS", "FORM_NO_WRITES"} {
		if !cs[want] {
			t.Errorf("missing %s", want)
		}
	}
}

func TestCompileFieldKeyInvalid(t *testing.T) {
	state, _, _, _, _, _ := newTestState()
	intent := Intent{
		Name:   "F",
		Fields: []Field{{Key: "Bad Key", Label: "X", Type: "text"}},
		Writes: []Write{{Sheet: "Meals", Mode: "append", Columns: map[string]Source{"Meal": {Literal: json.RawMessage(`"x"`)}}}},
	}
	res, _, _ := Compile(intent, state)
	if !codes(res.Errors)["FIELD_KEY_INVALID"] {
		t.Fatalf("expected FIELD_KEY_INVALID, errors: %+v", res.Errors)
	}
}

func TestCompileUpsertRequiresMatch(t *testing.T) {
	state, _, _, _, _, _ := newTestState()
	intent := Intent{
		Name:   "Daily total",
		Fields: []Field{{Key: "calories", Label: "Calories", Type: "number"}},
		Writes: []Write{{
			Sheet: "Daily", Mode: "upsert",
			Columns: map[string]Source{
				"Date":  {Computed: "today"},
				"Total": {Field: "calories"},
			},
			Inc: []string{"Total"},
			// no match → UPSERT_MATCH_REQUIRED
		}},
	}
	res, _, _ := Compile(intent, state)
	if !codes(res.Errors)["UPSERT_MATCH_REQUIRED"] {
		t.Fatalf("expected UPSERT_MATCH_REQUIRED, errors: %+v", res.Errors)
	}
}

func TestCompileUpsertExpands(t *testing.T) {
	state, _, _, _, _, _ := newTestState()
	intent := Intent{
		Name:   "Daily total",
		Fields: []Field{{Key: "calories", Label: "Calories", Type: "number"}},
		Writes: []Write{{
			Sheet: "Daily", Mode: "upsert",
			Columns: map[string]Source{
				"Date":  {Computed: "today"},
				"Total": {Field: "calories"},
			},
			Match: []string{"Date"},
			Inc:   []string{"Total"},
		}},
	}
	res, _, actions := Compile(intent, state)
	if !res.OK {
		t.Fatalf("expected ok, errors: %+v", res.Errors)
	}
	a := actions[0]
	if a.Op != "sheet.row.upsert" {
		t.Errorf("op = %s", a.Op)
	}
	if len(a.Match) != 1 || a.Match[0].Column != "Date" {
		t.Errorf("match = %+v", a.Match)
	}
	if len(a.Inc) != 1 || a.Inc[0] != "Total" {
		t.Errorf("inc = %+v", a.Inc)
	}
}

func TestCompileSheetNotFoundDidYouMean(t *testing.T) {
	state, _, _, _, _, _ := newTestState()
	intent := Intent{
		Name:   "X",
		Fields: []Field{{Key: "a", Label: "A", Type: "text"}},
		Writes: []Write{{Sheet: "Meal", Mode: "append", Columns: map[string]Source{"Meal": {Field: "a"}}}}, // "Meal" vs "Meals"
	}
	res, _, _ := Compile(intent, state)
	var d *Diagnostic
	for i := range res.Errors {
		if res.Errors[i].Code == "SHEET_NOT_FOUND" {
			d = &res.Errors[i]
		}
	}
	if d == nil {
		t.Fatal("expected SHEET_NOT_FOUND")
	}
	if d.Suggestion == "" {
		t.Error("expected did-you-mean for Meal→Meals")
	}
}

func TestCompileSourceShape(t *testing.T) {
	state, _, _, _, _, _ := newTestState()
	intent := Intent{
		Name:   "X",
		Fields: []Field{{Key: "a", Label: "A", Type: "text"}},
		Writes: []Write{{Sheet: "Meals", Mode: "append", Columns: map[string]Source{
			"Meal": {Field: "a", Computed: "today"}, // two keys → SOURCE_SHAPE
		}}},
	}
	res, _, _ := Compile(intent, state)
	if !codes(res.Errors)["SOURCE_SHAPE"] {
		t.Fatalf("expected SOURCE_SHAPE, errors: %+v", res.Errors)
	}
}

func TestCompileLiteralNotCoercible(t *testing.T) {
	state, _, _, _, _, _ := newTestState()
	intent := Intent{
		Name:   "X",
		Fields: []Field{{Key: "a", Label: "A", Type: "text"}},
		Writes: []Write{{Sheet: "Meals", Mode: "append", Columns: map[string]Source{
			"Calories": litSource("not a number"), // text literal into number column
			"Meal":     {Field: "a"},
		}}},
	}
	res, _, _ := Compile(intent, state)
	if !codes(res.Errors)["LITERAL_NOT_COERCIBLE"] {
		t.Fatalf("expected LITERAL_NOT_COERCIBLE, errors: %+v", res.Errors)
	}
}
