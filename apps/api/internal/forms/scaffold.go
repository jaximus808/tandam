package forms

import (
	"fmt"

	"github.com/agentcanvas/api/internal/store"
)

// columnToFieldType maps a sheet column type to the closest field input type.
// Sheets have no "select", so every column maps 1:1.
func columnToFieldType(colType string) string {
	switch colType {
	case "number", "date", "checkbox":
		return colType
	default:
		return "text"
	}
}

// Scaffold reads an existing sheet and returns a draft Intent — one explicit
// field + append binding per column — plus the CompileResult of that draft (so
// issues surface before the agent even edits). Stateless and idempotent: it
// stores nothing. The easy on-ramp; the agent then edits the draft (rename, mark
// required, swap a field for {computed:"today"}, add pin/upsert writes) and calls
// define.
func Scaffold(state *store.CanvasState, sheetName string) (Intent, CompileResult, error) {
	sheet, err := resolveSheet(state, sheetName)
	if err != nil {
		return Intent{}, CompileResult{}, err
	}

	fields := make([]Field, 0, len(sheet.Columns))
	columns := map[string]Source{}
	usedKeys := map[string]bool{}
	for _, col := range sheet.Columns {
		key := uniqueKey(slugify(col.Name), usedKeys)
		usedKeys[key] = true
		fields = append(fields, Field{
			Key:   key,
			Label: col.Name,
			Type:  columnToFieldType(col.Type),
		})
		columns[col.Name] = Source{Field: key}
	}

	intent := Intent{
		Name:   "Log to " + sheet.Name,
		Fields: fields,
		Writes: []Write{{Sheet: sheet.Name, Mode: "append", Columns: columns}},
	}
	res, _, _ := Compile(intent, state)
	return intent, res, nil
}

// uniqueKey ensures a slug is unique within a form, suffixing _2, _3, … and
// falling back to f1, f2… for empty/degenerate slugs.
func uniqueKey(base string, used map[string]bool) string {
	if base == "" {
		base = "field"
	}
	if !used[base] {
		return base
	}
	for i := 2; ; i++ {
		k := fmt.Sprintf("%s_%d", base, i)
		if !used[k] {
			return k
		}
	}
}
