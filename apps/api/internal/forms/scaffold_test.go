package forms

import "testing"

func TestScaffoldMealsSheet(t *testing.T) {
	state, _, _, _, _, _ := newTestState()
	intent, res, err := Scaffold(state, "Meals")
	if err != nil {
		t.Fatalf("scaffold: %v", err)
	}
	if !res.OK {
		t.Fatalf("draft should compile clean, errors: %+v", res.Errors)
	}
	if len(intent.Fields) != 3 {
		t.Fatalf("want a field per column (3), got %d", len(intent.Fields))
	}
	if len(intent.Writes) != 1 || intent.Writes[0].Mode != "append" {
		t.Fatalf("want one append write, got %+v", intent.Writes)
	}
	// keys must be valid (slugified) and bindings must reference real fields.
	keys := map[string]bool{}
	for _, f := range intent.Fields {
		if !fieldKeyRe.MatchString(f.Key) {
			t.Errorf("scaffolded key %q is invalid", f.Key)
		}
		keys[f.Key] = true
	}
	for col, src := range intent.Writes[0].Columns {
		if !keys[src.Field] {
			t.Errorf("column %q bound to unknown field %q", col, src.Field)
		}
	}
}

func TestScaffoldUnknownSheet(t *testing.T) {
	state, _, _, _, _, _ := newTestState()
	if _, _, err := Scaffold(state, "Nope"); err == nil {
		t.Fatal("expected error for unknown sheet")
	}
}
