package forms

import (
	"fmt"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/store"
)

// pinSettable maps the whitelisted pin-patch keys to their pins-table columns.
var pinSettable = map[string]string{
	"color": "color", "label": "label", "body": "body", "pintype": "pin_type",
}

// Resolve evaluates a form's stored DSL against submitted values into a concrete,
// scope-checked Batch. Pure: same inputs → same Batch. `now` must already be in
// the canvas timezone (the caller localizes it), so computed:"today" lands on the
// right day. Returns an error on any invalid/required-missing value or any target
// that no longer resolves against live state.
func Resolve(form *store.Form, values map[string]any, state *store.CanvasState, now time.Time) (store.Batch, error) {
	// 1. Validate + coerce submitted values against the field schema.
	fv := map[string]any{}
	for _, f := range form.Fields {
		raw, ok := values[f.Key]
		if !ok || raw == nil || raw == "" {
			switch {
			case f.Default != nil:
				raw = f.Default
			case f.Required:
				return store.Batch{}, fmt.Errorf("field %q (%s) is required", f.Key, f.Label)
			default:
				continue // optional + absent → omit
			}
		}
		cv, err := coerceFieldValue(f.Type, f.Options, raw)
		if err != nil {
			return store.Batch{}, fmt.Errorf("field %q: %w", f.Key, err)
		}
		fv[f.Key] = cv
	}

	batch := store.Batch{Inserts: []store.RowInsert{}, Patches: []store.Patch{}}

	for ai, a := range form.Actions {
		switch a.Op {
		case "sheet.row.append":
			sheet, err := resolveSheet(state, a.Target.Sheet)
			if err != nil {
				return store.Batch{}, fmt.Errorf("action %d: %w", ai, err)
			}
			data, err := buildRowData(sheet, a.Set, fv, now)
			if err != nil {
				return store.Batch{}, fmt.Errorf("action %d: %w", ai, err)
			}
			batch.Inserts = append(batch.Inserts, store.RowInsert{SheetID: sheet.ID.String(), Data: data})

		case "sheet.row.upsert":
			sheet, err := resolveSheet(state, a.Target.Sheet)
			if err != nil {
				return store.Batch{}, fmt.Errorf("action %d: %w", ai, err)
			}
			if err := resolveUpsert(&batch, sheet, a, fv, state, now); err != nil {
				return store.Batch{}, fmt.Errorf("action %d: %w", ai, err)
			}

		case "pin.patch":
			pinID, set, err := resolvePinPatch(state, a, fv, now)
			if err != nil {
				return store.Batch{}, fmt.Errorf("action %d: %w", ai, err)
			}
			if len(set) > 0 {
				id := pinID
				batch.Patches = append(batch.Patches, store.Patch{PinID: &id, Set: set})
			}

		default:
			return store.Batch{}, fmt.Errorf("action %d: unknown op %q", ai, a.Op)
		}
	}
	return batch, nil
}

func resolveSheet(state *store.CanvasState, name string) (*store.Sheet, error) {
	want := strings.ToLower(strings.TrimSpace(name))
	var found *store.Sheet
	count := 0
	for _, sh := range state.Sheets {
		if strings.ToLower(strings.TrimSpace(sh.Name)) == want {
			found = sh
			count++
		}
	}
	switch count {
	case 0:
		return nil, fmt.Errorf("sheet %q not found", name)
	case 1:
		return found, nil
	default:
		return nil, fmt.Errorf("sheet name %q is ambiguous", name)
	}
}

func columnByName(sheet *store.Sheet, name string) (store.SheetColumn, bool) {
	want := strings.ToLower(strings.TrimSpace(name))
	for _, c := range sheet.Columns {
		if strings.ToLower(strings.TrimSpace(c.Name)) == want {
			return c, true
		}
	}
	return store.SheetColumn{}, false
}

// evalExpr evaluates a ValueExpr. present=false means "omit this binding" — an
// optional field that wasn't filled in.
func evalExpr(ve store.ValueExpr, fv map[string]any, now time.Time) (value any, present bool, err error) {
	switch {
	case ve.From != "":
		v, ok := fv[ve.From]
		if !ok {
			return nil, false, nil
		}
		return v, true, nil
	case ve.Computed != "":
		switch ve.Computed {
		case "today":
			return now.Format("2006-01-02"), true, nil
		case "now":
			return now.Format(time.RFC3339), true, nil
		default:
			return nil, false, fmt.Errorf("unknown computed %q", ve.Computed)
		}
	case len(ve.Literal) > 0:
		v, err := literalValue(ve.Literal)
		if err != nil {
			return nil, false, err
		}
		return v, true, nil
	default:
		return nil, false, nil
	}
}

func buildRowData(sheet *store.Sheet, set []store.Binding, fv map[string]any, now time.Time) (map[string]any, error) {
	data := map[string]any{}
	for _, b := range set {
		col, ok := columnByName(sheet, b.Column)
		if !ok {
			return nil, fmt.Errorf("column %q not found in sheet %q", b.Column, sheet.Name)
		}
		v, present, err := evalExpr(b.Value, fv, now)
		if err != nil {
			return nil, err
		}
		if !present {
			continue
		}
		cv, err := coerceToType(v, col.Type)
		if err != nil {
			return nil, fmt.Errorf("column %q: %w", b.Column, err)
		}
		data[col.ID] = cv
	}
	return data, nil
}

type evalCell struct {
	id   string
	typ  string
	name string
	val  any
}

func resolveUpsert(batch *store.Batch, sheet *store.Sheet, a store.FormAction, fv map[string]any, state *store.CanvasState, now time.Time) error {
	incSet := lowerSet(a.Inc)
	matchSet := map[string]bool{}
	for _, b := range a.Match {
		matchSet[strings.ToLower(strings.TrimSpace(b.Column))] = true
	}

	// Evaluate every set binding into a concrete cell (column id + coerced value).
	cells := []evalCell{}
	byName := map[string]evalCell{}
	for _, b := range a.Set {
		col, ok := columnByName(sheet, b.Column)
		if !ok {
			return fmt.Errorf("column %q not found in sheet %q", b.Column, sheet.Name)
		}
		v, present, err := evalExpr(b.Value, fv, now)
		if err != nil {
			return err
		}
		if !present {
			continue
		}
		cv, err := coerceToType(v, col.Type)
		if err != nil {
			return fmt.Errorf("column %q: %w", b.Column, err)
		}
		c := evalCell{id: col.ID, typ: col.Type, name: b.Column, val: cv}
		cells = append(cells, c)
		byName[strings.ToLower(strings.TrimSpace(b.Column))] = c
	}

	// Build match criteria from the evaluated cells. If any match column's value
	// is absent, the match is undefined → fall through to an insert.
	matchCells := []evalCell{}
	matchable := len(a.Match) > 0
	for _, b := range a.Match {
		c, ok := byName[strings.ToLower(strings.TrimSpace(b.Column))]
		if !ok {
			matchable = false
			break
		}
		matchCells = append(matchCells, c)
	}

	var hit *store.SheetRow
	if matchable {
		for _, row := range state.SheetRows {
			if row.SheetID != sheet.ID {
				continue
			}
			ok := true
			for _, mc := range matchCells {
				rv, has := row.Data[mc.id]
				if !has || !cellEqual(rv, mc.val, mc.typ) {
					ok = false
					break
				}
			}
			if ok {
				hit = row
				break
			}
		}
	}

	if hit != nil {
		setMap := map[string]any{}
		incMap := map[string]float64{}
		for _, c := range cells {
			low := strings.ToLower(strings.TrimSpace(c.name))
			switch {
			case matchSet[low]:
				continue // already matched; don't overwrite
			case incSet[low]:
				f, err := toFloat(c.val)
				if err != nil {
					return fmt.Errorf("inc column %q: %w", c.name, err)
				}
				incMap[c.id] = f
			default:
				setMap[c.id] = c.val
			}
		}
		rid := hit.ID.String()
		p := store.Patch{RowID: &rid}
		if len(setMap) > 0 {
			p.Set = setMap
		}
		if len(incMap) > 0 {
			p.Inc = incMap
		}
		batch.Patches = append(batch.Patches, p)
		return nil
	}

	// No match → insert a fresh row (inc columns seed their starting value).
	data := map[string]any{}
	for _, c := range cells {
		data[c.id] = c.val
	}
	batch.Inserts = append(batch.Inserts, store.RowInsert{SheetID: sheet.ID.String(), Data: data})
	return nil
}

func resolvePinPatch(state *store.CanvasState, a store.FormAction, fv map[string]any, now time.Time) (string, map[string]any, error) {
	pinID := a.Target.Pin
	if _, ok := state.Pins[pinID]; !ok {
		return "", nil, fmt.Errorf("pin %q not found", pinID)
	}
	set := map[string]any{}
	for _, b := range a.Set {
		dbCol, ok := pinSettable[strings.ToLower(strings.TrimSpace(b.Column))]
		if !ok {
			return "", nil, fmt.Errorf("pin field %q is not settable", b.Column)
		}
		v, present, err := evalExpr(b.Value, fv, now)
		if err != nil {
			return "", nil, err
		}
		if !present {
			continue
		}
		set[dbCol] = toStringScalar(v)
	}
	return pinID, set, nil
}

// cellEqual compares a stored row value to a match value, normalized to the
// column type so 620 (number) matches "620" and a date matches regardless of
// timestamp precision.
func cellEqual(rowVal, matchVal any, typ string) bool {
	rc, err := coerceToType(rowVal, typ)
	if err != nil {
		return false
	}
	if typ == "number" {
		a, _ := rc.(float64)
		b, _ := matchVal.(float64)
		return a == b
	}
	return toStringScalar(rc) == toStringScalar(matchVal)
}

func lowerSet(xs []string) map[string]bool {
	m := make(map[string]bool, len(xs))
	for _, x := range xs {
		m[strings.ToLower(strings.TrimSpace(x))] = true
	}
	return m
}
