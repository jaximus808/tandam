package forms

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/agentcanvas/api/internal/store"
)

var (
	fieldKeyRe       = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	validFieldTypes  = map[string]bool{"text": true, "number": true, "date": true, "select": true, "checkbox": true}
	validComputed    = map[string]bool{"today": true, "now": true}
	pinSettableKeys  = []string{"color", "label", "body", "pinType"}
	pinSettableValid = map[string]bool{"color": true, "label": true, "body": true, "pinType": true}
)

// Compile validates an authoring Intent against live canvas state and expands it
// into the canonical DSL. ok === (len(errors)==0); the caller stores iff ok.
// Warnings/info never block. Checks run in phases; we report all independent
// problems (only same-node dependents are skipped) so the agent can fix
// everything in one more turn. Deterministic: same intent+state → same result.
//
// On ok, the returned fields/actions are what to persist; otherwise both are nil.
func Compile(intent Intent, state *store.CanvasState) (CompileResult, []store.FormField, []store.FormAction) {
	c := &compiler{}

	c.phase1Form(intent)
	fieldTypes := c.phase2Fields(intent)
	c.phase3Writes(intent, fieldTypes)
	c.phase4and5State(intent, state, fieldTypes)
	c.phase6Advisory(intent)

	res := CompileResult{
		OK:       len(c.errors) == 0,
		Errors:   c.errors,
		Warnings: c.warnings,
	}
	if !res.OK {
		if res.Errors == nil {
			res.Errors = []Diagnostic{}
		}
		if res.Warnings == nil {
			res.Warnings = []Diagnostic{}
		}
		return res, nil, nil
	}
	fields, actions := expand(intent)
	if res.Warnings == nil {
		res.Warnings = []Diagnostic{}
	}
	res.Errors = []Diagnostic{}
	return res, fields, actions
}

type compiler struct {
	errors   []Diagnostic
	warnings []Diagnostic
}

func (c *compiler) err(code, path, msg string) *Diagnostic {
	c.errors = append(c.errors, Diagnostic{Code: code, Severity: "error", Path: path, Message: msg})
	return &c.errors[len(c.errors)-1]
}
func (c *compiler) warn(code, path, msg string) *Diagnostic {
	c.warnings = append(c.warnings, Diagnostic{Code: code, Severity: "warning", Path: path, Message: msg})
	return &c.warnings[len(c.warnings)-1]
}
func (c *compiler) info(code, path, msg string) *Diagnostic {
	c.warnings = append(c.warnings, Diagnostic{Code: code, Severity: "info", Path: path, Message: msg})
	return &c.warnings[len(c.warnings)-1]
}

// ── Phase 1 — Form structural ─────────────────────────────────────────────────

func (c *compiler) phase1Form(in Intent) {
	if strings.TrimSpace(in.Name) == "" {
		c.err("FORM_NAME_REQUIRED", "name", "form name is required.")
	} else if len(in.Name) > 80 {
		c.err("FORM_NAME_TOO_LONG", "name", "form name must be at most 80 characters.")
	}
	if len(in.Fields) == 0 {
		c.err("FORM_NO_FIELDS", "fields", "a form needs at least one field.")
	} else if len(in.Fields) > 20 {
		c.err("FORM_TOO_MANY_FIELDS", "fields", "a form can have at most 20 fields.")
	}
	if len(in.Writes) == 0 {
		c.err("FORM_NO_WRITES", "writes", "a form needs at least one write.")
	} else if len(in.Writes) > 8 {
		c.err("FORM_TOO_MANY_WRITES", "writes", "a form can have at most 8 writes.")
	}
}

// ── Phase 2 — Field structural ────────────────────────────────────────────────
// Returns a key→type map of the structurally-valid fields (used by later phases).

func (c *compiler) phase2Fields(in Intent) map[string]string {
	types := map[string]string{}
	seen := map[string]bool{}
	for i, f := range in.Fields {
		path := fmt.Sprintf("fields[%d]", i)
		if !fieldKeyRe.MatchString(f.Key) {
			d := c.err("FIELD_KEY_INVALID", path+".key", fmt.Sprintf("field key %q is invalid (use lowercase letters, digits, underscores; start with a letter).", f.Key))
			if s := slugify(f.Key); s != "" {
				d.Suggestion = "did you mean '" + s + "'?"
			}
		} else if seen[f.Key] {
			c.err("FIELD_KEY_DUPLICATE", path+".key", fmt.Sprintf("field key %q is used more than once.", f.Key))
		} else {
			seen[f.Key] = true
		}
		if strings.TrimSpace(f.Label) == "" {
			c.err("FIELD_LABEL_REQUIRED", path+".label", "field label is required.")
		}
		if !validFieldTypes[f.Type] {
			c.err("FIELD_TYPE_INVALID", path+".type", fmt.Sprintf("field type %q is not allowed.", f.Type)).Meta =
				map[string]any{"allowed": []string{"text", "number", "date", "select", "checkbox"}}
			continue
		}
		// type is valid from here
		if f.Type == "select" {
			if len(f.Options) == 0 {
				c.err("FIELD_SELECT_NO_OPTIONS", path+".options", "a select field needs at least one option.")
			} else {
				optSeen := map[string]bool{}
				for _, o := range f.Options {
					if optSeen[o] {
						c.warn("FIELD_OPTION_DUPLICATE", path+".options", fmt.Sprintf("duplicate option %q.", o))
					}
					optSeen[o] = true
				}
			}
		} else if len(f.Options) > 0 {
			c.warn("FIELD_OPTIONS_IGNORED", path+".options", "options are ignored on a non-select field.")
		}
		if f.Default != nil {
			c.checkDefault(f, path)
		}
		if f.Key != "" {
			types[f.Key] = f.Type
		}
	}
	return types
}

func (c *compiler) checkDefault(f Field, path string) {
	switch f.Type {
	case "number":
		if _, ok := f.Default.(float64); !ok {
			c.err("FIELD_DEFAULT_TYPE", path+".default", "default must be a number.")
		}
	case "checkbox":
		if _, ok := f.Default.(bool); !ok {
			c.err("FIELD_DEFAULT_TYPE", path+".default", "default must be true or false.")
		}
	case "date":
		s, ok := f.Default.(string)
		if !ok {
			c.err("FIELD_DEFAULT_TYPE", path+".default", "default must be a YYYY-MM-DD date string.")
		} else if _, err := toDate(s); err != nil {
			c.err("FIELD_DEFAULT_TYPE", path+".default", "default is not a valid YYYY-MM-DD date.")
		}
	case "select":
		s, ok := f.Default.(string)
		if !ok {
			c.err("FIELD_DEFAULT_TYPE", path+".default", "default must be one of the options.")
			return
		}
		found := false
		for _, o := range f.Options {
			if o == s {
				found = true
				break
			}
		}
		if !found {
			c.err("FIELD_DEFAULT_NOT_OPTION", path+".default", fmt.Sprintf("default %q is not one of the options.", s)).Meta =
				map[string]any{"options": f.Options}
		}
	default: // text
		if _, ok := f.Default.(string); !ok {
			c.err("FIELD_DEFAULT_TYPE", path+".default", "default must be a string.")
		}
	}
}

// ── Phase 3 — Write internal refs (no state) ──────────────────────────────────

func (c *compiler) phase3Writes(in Intent, fieldTypes map[string]string) {
	for i, w := range in.Writes {
		path := fmt.Sprintf("writes[%d]", i)
		switch {
		case w.isSheet():
			c.phase3Sheet(w, path, fieldTypes)
		case w.isPin():
			c.phase3Pin(w, path, fieldTypes)
		default:
			c.err("WRITE_KIND_UNKNOWN", path, "write must target either a sheet or a pin.")
		}
	}
}

func (c *compiler) phase3Sheet(w Write, path string, fieldTypes map[string]string) {
	if w.Mode != "append" && w.Mode != "upsert" {
		c.err("WRITE_MODE_INVALID", path+".mode", fmt.Sprintf("mode %q is invalid (use append or upsert).", w.Mode))
	}
	if len(w.Columns) == 0 {
		c.err("WRITE_COLUMNS_EMPTY", path+".columns", "a sheet write needs at least one column.")
	}
	colKeys := map[string]bool{}
	for k := range w.Columns {
		colKeys[k] = true
	}
	if w.Mode == "upsert" && len(w.Match) == 0 {
		c.err("UPSERT_MATCH_REQUIRED", path+".match", "an upsert write needs at least one match column.")
	}
	for _, m := range w.Match {
		if !colKeys[m] {
			c.err("UPSERT_MATCH_NOT_COLUMN", path+".match", fmt.Sprintf("match column %q is not one of the written columns.", m)).Meta =
				map[string]any{"columns": sortedKeys(w.Columns)}
		}
	}
	for _, inc := range w.Inc {
		if !colKeys[inc] {
			c.err("INC_NOT_COLUMN", path+".inc", fmt.Sprintf("inc column %q is not one of the written columns.", inc)).Meta =
				map[string]any{"columns": sortedKeys(w.Columns)}
		}
	}
	if w.Mode == "append" && len(w.Inc) > 0 {
		c.warn("INC_ON_APPEND", path+".inc", "inc has no effect on an append write.")
	}
	for _, col := range sortedKeys(w.Columns) {
		c.checkSource(w.Columns[col], path+".columns."+col, fieldTypes)
	}
}

func (c *compiler) phase3Pin(w Write, path string, fieldTypes map[string]string) {
	for _, k := range sortedKeys(w.Set) {
		if !pinSettableValid[k] {
			c.err("PIN_SET_KEY", path+".set."+k, fmt.Sprintf("pin field %q is not settable.", k)).Meta =
				map[string]any{"settable": pinSettableKeys}
			continue
		}
		c.checkSource(w.Set[k], path+".set."+k, fieldTypes)
	}
}

func (c *compiler) checkSource(s Source, path string, fieldTypes map[string]string) {
	if s.keyCount() != 1 {
		c.err("SOURCE_SHAPE", path, "a source must have exactly one of: field, computed, literal.")
		return
	}
	switch {
	case s.Field != "":
		if _, ok := fieldTypes[s.Field]; !ok {
			d := c.err("SOURCE_FIELD_UNKNOWN", path, fmt.Sprintf("source field %q is not a declared field.", s.Field))
			cands := keysOf(fieldTypes)
			if m := didYouMean(s.Field, cands); m != "" {
				d.Suggestion = "did you mean '" + m + "'?"
			}
			d.Meta = map[string]any{"fields": cands}
		}
	case s.Computed != "":
		if !validComputed[s.Computed] {
			c.err("SOURCE_COMPUTED_UNKNOWN", path, fmt.Sprintf("computed %q is not allowed.", s.Computed)).Meta =
				map[string]any{"allowed": []string{"today", "now"}}
		}
	}
}

// ── Phase 4 (state) + Phase 5 (type compatibility) ────────────────────────────

func (c *compiler) phase4and5State(in Intent, state *store.CanvasState, fieldTypes map[string]string) {
	for i, w := range in.Writes {
		path := fmt.Sprintf("writes[%d]", i)
		if w.isSheet() {
			sheet, ok := c.resolveSheetDiag(state, w.Sheet, path)
			if !ok {
				continue // same-node dependent: skip column resolution
			}
			c.checkSheetColumns(w, sheet, path, fieldTypes)
		} else if w.isPin() {
			if _, ok := state.Pins[w.Pin]; !ok {
				c.err("PIN_NOT_FOUND", path+".pin", fmt.Sprintf("pin %q not found on this canvas.", w.Pin)).Meta =
					map[string]any{"pins": pinIDs(state)}
			}
		}
	}
}

func (c *compiler) resolveSheetDiag(state *store.CanvasState, name, path string) (*store.Sheet, bool) {
	want := strings.ToLower(strings.TrimSpace(name))
	var found *store.Sheet
	count := 0
	names := []string{}
	for _, sh := range state.Sheets {
		names = append(names, sh.Name)
		if strings.ToLower(strings.TrimSpace(sh.Name)) == want {
			found = sh
			count++
		}
	}
	sort.Strings(names)
	switch count {
	case 0:
		d := c.err("SHEET_NOT_FOUND", path+".sheet", fmt.Sprintf("sheet %q not found on this canvas.", name))
		if m := didYouMean(name, names); m != "" {
			d.Suggestion = "did you mean '" + m + "'?"
		}
		d.Meta = map[string]any{"sheets": names}
		return nil, false
	case 1:
		return found, true
	default:
		c.err("SHEET_AMBIGUOUS", path+".sheet", fmt.Sprintf("more than one sheet is named %q; rename to disambiguate.", name))
		return nil, false
	}
}

func (c *compiler) checkSheetColumns(w Write, sheet *store.Sheet, path string, fieldTypes map[string]string) {
	byName := map[string]store.SheetColumn{}
	colNames := []string{}
	for _, col := range sheet.Columns {
		byName[strings.ToLower(strings.TrimSpace(col.Name))] = col
		colNames = append(colNames, col.Name)
	}
	sort.Strings(colNames)
	for _, colKey := range sortedKeys(w.Columns) {
		col, ok := byName[strings.ToLower(strings.TrimSpace(colKey))]
		if !ok {
			d := c.err("COLUMN_NOT_FOUND", path+".columns."+colKey, fmt.Sprintf("column %q not found in sheet %q.", colKey, sheet.Name))
			if m := didYouMean(colKey, colNames); m != "" {
				d.Suggestion = "did you mean '" + m + "'?"
			}
			d.Meta = map[string]any{"columns": colNames}
			continue
		}
		c.checkSourceTypes(w.Columns[colKey], col, path+".columns."+colKey, fieldTypes)
	}
}

// Phase 5 type compatibility against a resolved column.
func (c *compiler) checkSourceTypes(s Source, col store.SheetColumn, path string, fieldTypes map[string]string) {
	switch {
	case len(s.Literal) > 0:
		v, err := literalValue(s.Literal)
		if err != nil {
			c.err("LITERAL_NOT_COERCIBLE", path, "literal value is not valid JSON.")
			return
		}
		if _, err := coerceToType(v, col.Type); err != nil {
			c.err("LITERAL_NOT_COERCIBLE", path, fmt.Sprintf("literal cannot be stored in a %s column.", col.Type))
		}
	case s.Computed != "":
		if col.Type != "date" {
			c.warn("COMPUTED_COLUMN_TYPE", path, fmt.Sprintf("@%s writes a date/time into a %s column.", s.Computed, col.Type))
		}
	case s.Field != "":
		ft, ok := fieldTypes[s.Field]
		if ok && !fieldColumnCompatible(ft, col.Type) {
			c.warn("FIELD_COLUMN_TYPE", path, fmt.Sprintf("field %q is %s but column %q is %s; the value may be rejected at submit.", s.Field, ft, col.Name, col.Type))
		}
	}
}

// ── Phase 6 — Advisory ────────────────────────────────────────────────────────

func (c *compiler) phase6Advisory(in Intent) {
	used := map[string]bool{}
	for _, w := range in.Writes {
		if w.isSheet() {
			for _, s := range w.Columns {
				if s.Field != "" {
					used[s.Field] = true
				}
			}
		} else if w.isPin() {
			for _, s := range w.Set {
				if s.Field != "" {
					used[s.Field] = true
				}
			}
		}
	}
	for i, f := range in.Fields {
		if f.Key == "" || used[f.Key] {
			continue
		}
		path := fmt.Sprintf("fields[%d]", i)
		if f.Required {
			c.warn("REQUIRED_FIELD_UNUSED", path, fmt.Sprintf("required field %q is never written by any action.", f.Key))
		} else {
			c.warn("FIELD_UNUSED", path, fmt.Sprintf("field %q is never written by any action.", f.Key))
		}
	}
}

// ── Expansion: Intent → canonical DSL ─────────────────────────────────────────

func expand(in Intent) ([]store.FormField, []store.FormAction) {
	fields := make([]store.FormField, 0, len(in.Fields))
	for _, f := range in.Fields {
		fields = append(fields, store.FormField{
			Key: f.Key, Label: f.Label, Type: f.Type,
			Required: f.Required, Options: f.Options,
			Default: f.Default, Placeholder: f.Placeholder,
		})
	}
	actions := make([]store.FormAction, 0, len(in.Writes))
	for _, w := range in.Writes {
		if w.isPin() {
			a := store.FormAction{Op: "pin.patch", Target: store.FormTarget{Pin: w.Pin}}
			for _, k := range sortedKeys(w.Set) {
				a.Set = append(a.Set, store.Binding{Column: k, Value: sourceToExpr(w.Set[k])})
			}
			actions = append(actions, a)
			continue
		}
		op := "sheet.row.append"
		if w.Mode == "upsert" {
			op = "sheet.row.upsert"
		}
		a := store.FormAction{Op: op, Target: store.FormTarget{Sheet: w.Sheet}, Inc: w.Inc}
		for _, k := range sortedKeys(w.Columns) {
			a.Set = append(a.Set, store.Binding{Column: k, Value: sourceToExpr(w.Columns[k])})
		}
		// Match bindings reuse the same source as the matching column.
		for _, m := range w.Match {
			a.Match = append(a.Match, store.Binding{Column: m, Value: sourceToExpr(w.Columns[m])})
		}
		actions = append(actions, a)
	}
	return fields, actions
}

func sourceToExpr(s Source) store.ValueExpr {
	return store.ValueExpr{From: s.Field, Computed: s.Computed, Literal: s.Literal}
}

// ── helpers ───────────────────────────────────────────────────────────────────

func fieldColumnCompatible(fieldType, colType string) bool {
	norm := fieldType
	if fieldType == "select" {
		norm = "text"
	}
	return norm == colType
}

func sortedKeys[V any](m map[string]V) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func keysOf(m map[string]string) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func pinIDs(state *store.CanvasState) []string {
	ids := make([]string, 0, len(state.Pins))
	for id := range state.Pins {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// slugify turns an arbitrary label/key into a valid field key, best-effort.
func slugify(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '_':
			b.WriteRune('_')
		}
	}
	out := strings.Trim(b.String(), "_")
	for len(out) > 0 && (out[0] >= '0' && out[0] <= '9') {
		out = out[1:]
	}
	if len(out) > 32 {
		out = out[:32]
	}
	return out
}

// didYouMean returns the closest candidate within Levenshtein distance 2
// (case-insensitive), or "" if none. Deterministic: ties break by sort order.
func didYouMean(q string, candidates []string) string {
	ql := strings.ToLower(q)
	best := ""
	bestD := 3
	sorted := append([]string(nil), candidates...)
	sort.Strings(sorted)
	for _, c := range sorted {
		d := levenshtein(ql, strings.ToLower(c))
		if d < bestD {
			bestD = d
			best = c
		}
	}
	return best
}

func levenshtein(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur := make([]int, len(rb)+1)
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min3(cur[j-1]+1, prev[j]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(rb)]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}
