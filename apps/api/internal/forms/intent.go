// Package forms implements the direct-input layer's three deterministic
// transforms (scaffold / compile / resolve) from docs/DESIGN_DIRECT_INPUT.md.
//
//	AUTHOR (once):   intent ──compile(intent, state)──▶ DSL (store.FormAction[])
//	                  scaffold(sheet, state) ─▶ draft intent (read-only)
//	SUBMIT (per tap): DSL + values ──resolve(form, values, state)──▶ store.Batch
//
// The agent expresses Intent; compile() validates + expands it into the canonical
// DSL stored on the form. resolve() evaluates that DSL against submitted values
// into a concrete, scope-checked Batch the RPC applies atomically.
package forms

import "encoding/json"

// Intent is the authoring artifact: what scaffold emits and define accepts.
// Bindings are explicit — no runtime name-matching (scaffold matches once,
// visibly, in the draft).
type Intent struct {
	Name        string  `json:"name"`
	Description string  `json:"description,omitempty"`
	Fields      []Field `json:"fields"`
	Writes      []Write `json:"writes"`
}

// Field is one declared input. Type ∈ text|number|date|select|checkbox.
type Field struct {
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Type        string   `json:"type"`
	Required    bool     `json:"required,omitempty"`
	Options     []string `json:"options,omitempty"`     // required iff select
	Default     any      `json:"default,omitempty"`     // type-compatible; select ⇒ ∈ options
	Placeholder string   `json:"placeholder,omitempty"` // text/number only
}

// Write is a discriminated union: SheetWrite (has Sheet) or PinWrite (has Pin).
type Write struct {
	// SheetWrite
	Sheet   string            `json:"sheet,omitempty"`
	Mode    string            `json:"mode,omitempty"` // append | upsert
	Match   []string          `json:"match,omitempty"`
	Columns map[string]Source `json:"columns,omitempty"`
	Inc     []string          `json:"inc,omitempty"`

	// PinWrite
	Pin string            `json:"pin,omitempty"`
	Set map[string]Source `json:"set,omitempty"`
}

func (w Write) isPin() bool   { return w.Pin != "" }
func (w Write) isSheet() bool { return w.Sheet != "" }

// Source is exactly one of Field / Computed / Literal. The exactly-one-key
// invariant is checked by compile (SOURCE_SHAPE).
type Source struct {
	Field    string          `json:"field,omitempty"`
	Computed string          `json:"computed,omitempty"`
	Literal  json.RawMessage `json:"literal,omitempty"`
}

// keyCount reports how many of the three Source variants are populated.
func (s Source) keyCount() int {
	n := 0
	if s.Field != "" {
		n++
	}
	if s.Computed != "" {
		n++
	}
	if len(s.Literal) > 0 {
		n++
	}
	return n
}

// ── Compile diagnostics ───────────────────────────────────────────────────────

type CompileResult struct {
	OK       bool         `json:"ok"`
	Errors   []Diagnostic `json:"errors"`
	Warnings []Diagnostic `json:"warnings"`
	FormID   string       `json:"formId,omitempty"`
}

type Diagnostic struct {
	Code       string         `json:"code"`
	Severity   string         `json:"severity"` // "error" | "warning" | "info"
	Path       string         `json:"path"`
	Message    string         `json:"message"`
	Suggestion string         `json:"suggestion,omitempty"`
	Meta       map[string]any `json:"meta,omitempty"`
}
