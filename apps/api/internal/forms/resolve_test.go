package forms

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// ── test fixtures ─────────────────────────────────────────────────────────────

func lit(v any) store.ValueExpr {
	b, _ := json.Marshal(v)
	return store.ValueExpr{Literal: b}
}
func from(k string) store.ValueExpr     { return store.ValueExpr{From: k} }
func computed(c string) store.ValueExpr { return store.ValueExpr{Computed: c} }

var fixedNow = time.Date(2026, 6, 19, 23, 50, 0, 0, time.UTC)

// stateWithSheets builds a canvas state with a Meals sheet, a Daily sheet, and a
// pin, returning the state plus the column-id lookups the assertions need.
func newTestState() (*store.CanvasState, map[string]string, map[string]string, uuid.UUID, uuid.UUID, uuid.UUID) {
	mealsID := uuid.New()
	dailyID := uuid.New()
	pinID := uuid.New()

	mealCols := []store.SheetColumn{
		{ID: uuid.NewString(), Name: "Meal", Type: "text"},
		{ID: uuid.NewString(), Name: "Calories", Type: "number"},
		{ID: uuid.NewString(), Name: "Date", Type: "date"},
	}
	dailyCols := []store.SheetColumn{
		{ID: uuid.NewString(), Name: "Date", Type: "date"},
		{ID: uuid.NewString(), Name: "Total", Type: "number"},
	}
	mealColIDs := map[string]string{}
	for _, c := range mealCols {
		mealColIDs[c.Name] = c.ID
	}
	dailyColIDs := map[string]string{}
	for _, c := range dailyCols {
		dailyColIDs[c.Name] = c.ID
	}

	state := &store.CanvasState{
		Sheets: map[string]*store.Sheet{
			mealsID.String(): {ID: mealsID, Name: "Meals", Columns: mealCols},
			dailyID.String(): {ID: dailyID, Name: "Daily", Columns: dailyCols},
		},
		SheetRows: map[string]*store.SheetRow{},
		Pins: map[string]*store.Pin{
			pinID.String(): {ID: pinID},
		},
	}
	return state, mealColIDs, dailyColIDs, mealsID, dailyID, pinID
}

// ── append ────────────────────────────────────────────────────────────────────

func TestResolveAppend(t *testing.T) {
	state, mealCols, _, mealsID, _, _ := newTestState()
	form := &store.Form{
		Fields: []store.FormField{
			{Key: "meal", Label: "Meal", Type: "text", Required: true},
			{Key: "calories", Label: "Calories", Type: "number"},
		},
		Actions: []store.FormAction{{
			Op:     "sheet.row.append",
			Target: store.FormTarget{Sheet: "Meals"},
			Set: []store.Binding{
				{Column: "Meal", Value: from("meal")},
				{Column: "Calories", Value: from("calories")},
				{Column: "Date", Value: computed("today")},
			},
		}},
	}
	// calories arrives as a string (as it would from an HTML number input).
	batch, err := Resolve(form, map[string]any{"meal": "Chicken bowl", "calories": "620"}, state, fixedNow)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(batch.Inserts) != 1 || len(batch.Patches) != 0 {
		t.Fatalf("want 1 insert/0 patch, got %d/%d", len(batch.Inserts), len(batch.Patches))
	}
	ins := batch.Inserts[0]
	if ins.SheetID != mealsID.String() {
		t.Errorf("sheet id = %s, want %s", ins.SheetID, mealsID)
	}
	if got := ins.Data[mealCols["Meal"]]; got != "Chicken bowl" {
		t.Errorf("Meal = %v, want Chicken bowl", got)
	}
	if got := ins.Data[mealCols["Calories"]]; got != float64(620) {
		t.Errorf("Calories = %v (%T), want 620 float64", got, got)
	}
	if got := ins.Data[mealCols["Date"]]; got != "2026-06-19" {
		t.Errorf("Date = %v, want 2026-06-19", got)
	}
}

func TestResolveRequiredMissing(t *testing.T) {
	state, _, _, _, _, _ := newTestState()
	form := &store.Form{
		Fields:  []store.FormField{{Key: "meal", Label: "Meal", Type: "text", Required: true}},
		Actions: []store.FormAction{{Op: "sheet.row.append", Target: store.FormTarget{Sheet: "Meals"}, Set: []store.Binding{{Column: "Meal", Value: from("meal")}}}},
	}
	if _, err := Resolve(form, map[string]any{}, state, fixedNow); err == nil {
		t.Fatal("expected required-field error, got nil")
	}
}

func TestResolveOptionalAbsentOmitted(t *testing.T) {
	state, mealCols, _, _, _, _ := newTestState()
	form := &store.Form{
		Fields: []store.FormField{
			{Key: "meal", Label: "Meal", Type: "text", Required: true},
			{Key: "calories", Label: "Calories", Type: "number"},
		},
		Actions: []store.FormAction{{Op: "sheet.row.append", Target: store.FormTarget{Sheet: "Meals"}, Set: []store.Binding{
			{Column: "Meal", Value: from("meal")},
			{Column: "Calories", Value: from("calories")},
		}}},
	}
	batch, err := Resolve(form, map[string]any{"meal": "Toast"}, state, fixedNow)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if _, present := batch.Inserts[0].Data[mealCols["Calories"]]; present {
		t.Error("absent optional field should be omitted from row data")
	}
}

// ── upsert ────────────────────────────────────────────────────────────────────

// The flagship two-action meal form: append a Meals row AND advance Daily total.
func TestResolveUpsertInsertThenIncrement(t *testing.T) {
	state, _, dailyCols, _, dailyID, _ := newTestState()
	upsert := store.FormAction{
		Op:     "sheet.row.upsert",
		Target: store.FormTarget{Sheet: "Daily"},
		Set: []store.Binding{
			{Column: "Date", Value: computed("today")},
			{Column: "Total", Value: from("calories")},
		},
		Match: []store.Binding{{Column: "Date", Value: computed("today")}},
		Inc:   []string{"Total"},
	}
	form := &store.Form{
		Fields:  []store.FormField{{Key: "calories", Label: "Calories", Type: "number"}},
		Actions: []store.FormAction{upsert},
	}

	// 1st submit: no row for today → insert seeding Total=620.
	batch, err := Resolve(form, map[string]any{"calories": 620.0}, state, fixedNow)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(batch.Inserts) != 1 || len(batch.Patches) != 0 {
		t.Fatalf("first submit: want 1 insert/0 patch, got %d/%d", len(batch.Inserts), len(batch.Patches))
	}
	if got := batch.Inserts[0].Data[dailyCols["Total"]]; got != float64(620) {
		t.Errorf("seed Total = %v, want 620", got)
	}

	// Simulate the row now existing in state with today's date.
	rowID := uuid.New()
	state.SheetRows[rowID.String()] = &store.SheetRow{
		ID: rowID, SheetID: dailyID,
		Data: map[string]any{dailyCols["Date"]: "2026-06-19", dailyCols["Total"]: float64(620)},
	}

	// 2nd submit: row found → patch incrementing Total by 500.
	batch, err = Resolve(form, map[string]any{"calories": 500.0}, state, fixedNow)
	if err != nil {
		t.Fatalf("resolve 2: %v", err)
	}
	if len(batch.Inserts) != 0 || len(batch.Patches) != 1 {
		t.Fatalf("second submit: want 0 insert/1 patch, got %d/%d", len(batch.Inserts), len(batch.Patches))
	}
	p := batch.Patches[0]
	if p.RowID == nil || *p.RowID != rowID.String() {
		t.Fatalf("patch row id = %v, want %s", p.RowID, rowID)
	}
	if got := p.Inc[dailyCols["Total"]]; got != 500 {
		t.Errorf("inc Total = %v, want 500", got)
	}
	// Match column must NOT be overwritten via Set.
	if _, ok := p.Set[dailyCols["Date"]]; ok {
		t.Error("matched column Date should not be in Set")
	}
}

// ── pin.patch ─────────────────────────────────────────────────────────────────

func TestResolvePinPatch(t *testing.T) {
	state, _, _, _, _, pinID := newTestState()
	form := &store.Form{
		Fields: []store.FormField{{Key: "note", Label: "Note", Type: "text"}},
		Actions: []store.FormAction{{
			Op:     "pin.patch",
			Target: store.FormTarget{Pin: pinID.String()},
			Set: []store.Binding{
				{Column: "color", Value: lit("#10B981")},
				{Column: "body", Value: from("note")},
			},
		}},
	}
	batch, err := Resolve(form, map[string]any{"note": "Loved it"}, state, fixedNow)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(batch.Patches) != 1 {
		t.Fatalf("want 1 patch, got %d", len(batch.Patches))
	}
	p := batch.Patches[0]
	if p.PinID == nil || *p.PinID != pinID.String() {
		t.Fatalf("pin id = %v, want %s", p.PinID, pinID)
	}
	if p.Set["color"] != "#10B981" {
		t.Errorf("color = %v", p.Set["color"])
	}
	if p.Set["body"] != "Loved it" {
		t.Errorf("body = %v", p.Set["body"])
	}
}

func TestResolveUnknownSheet(t *testing.T) {
	state, _, _, _, _, _ := newTestState()
	form := &store.Form{
		Actions: []store.FormAction{{Op: "sheet.row.append", Target: store.FormTarget{Sheet: "Nope"}, Set: []store.Binding{{Column: "X", Value: lit("y")}}}},
	}
	if _, err := Resolve(form, map[string]any{}, state, fixedNow); err == nil {
		t.Fatal("expected unknown-sheet error")
	}
}

func TestResolveBadNumberRejected(t *testing.T) {
	state, _, _, _, _, _ := newTestState()
	form := &store.Form{
		Fields:  []store.FormField{{Key: "calories", Label: "Calories", Type: "number"}},
		Actions: []store.FormAction{{Op: "sheet.row.append", Target: store.FormTarget{Sheet: "Meals"}, Set: []store.Binding{{Column: "Calories", Value: from("calories")}}}},
	}
	if _, err := Resolve(form, map[string]any{"calories": "abc"}, state, fixedNow); err == nil {
		t.Fatal("expected number-coercion error")
	}
}
