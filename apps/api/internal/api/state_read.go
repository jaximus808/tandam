package api

import (
	"fmt"
	"sort"
	"strings"

	"github.com/agentcanvas/api/internal/store"
)

// canvas_state_read used to dump the ENTIRE canvas as one JSON blob. On a real
// canvas that's 100k+ chars — it blows the agent's token budget and the read
// literally errors out. This file adds two cheaper read shapes so an agent can
// navigate a big canvas without the barf:
//
//   - default (no fields, no full): a lightweight SUMMARY — per-kind counts plus
//     the name/title of each item, so the agent can see what's there and decide
//     what to pull.
//   - fields=[...]: only the requested kinds returned in full (e.g. just
//     roadmapItems, or notes+sheets).
//   - full=true: the entire payload, back-compat escape hatch.
//
// stateKinds are the projectable kind keys, matching CanvasState's JSON field
// names so the agent uses the same vocabulary it sees in the payload.
var stateKinds = []string{
	"documents", "pins", "events", "notes", "roadmapItems", "sheets",
	"sheetRows", "charts", "forms", "actions", "agents",
}

// maxSummaryNames caps how many names we list per kind so the summary itself
// can't become a second barf on a canvas with thousands of rows.
const maxSummaryNames = 200

// summaryMsg is the default (cheap) shape returned by GET /api/canvas/state.
type summaryMsg struct {
	Type         string               `json:"type"` // "state.summary"
	Canvas       *store.Canvas        `json:"canvas"`
	Mode         string               `json:"mode"`
	Version      int                  `json:"version"`
	EnabledModes []string             `json:"enabledModes"`
	Counts       map[string]int       `json:"counts"`
	Names        map[string][]string  `json:"names"`
	PendingEdits []*store.PendingEdit `json:"pendingEdits"`
	Hint         string               `json:"_hint"`
}

// validateStateFields parses a comma-separated fields list, lowercasing-agnostic
// but exact-match against stateKinds, and returns an actionable error naming the
// valid kinds if one is unknown (the agent gets told how to fix it).
func validateStateFields(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	valid := make(map[string]bool, len(stateKinds))
	for _, k := range stateKinds {
		valid[k] = true
	}
	var out []string
	seen := make(map[string]bool)
	for _, part := range strings.Split(raw, ",") {
		k := strings.TrimSpace(part)
		if k == "" {
			continue
		}
		if !valid[k] {
			return nil, fmt.Errorf("unknown field %q — valid kinds are: %s", k, strings.Join(stateKinds, ", "))
		}
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out, nil
}

// projectState returns a copy of state carrying only the requested kinds; the
// rest are left nil so they serialize to null and cost nothing. Version/Mode/
// EnabledModes always ride along so the agent keeps its bearings.
func projectState(state *store.CanvasState, fields []string) *store.CanvasState {
	if state == nil {
		return nil
	}
	out := &store.CanvasState{
		Version:      state.Version,
		Mode:         state.Mode,
		EnabledModes: state.EnabledModes,
	}
	for _, k := range fields {
		switch k {
		case "documents":
			out.Documents = state.Documents
		case "pins":
			out.Pins = state.Pins
		case "events":
			out.Events = state.Events
		case "notes":
			out.Notes = state.Notes
		case "roadmapItems":
			out.RoadmapItems = state.RoadmapItems
		case "sheets":
			out.Sheets = state.Sheets
		case "sheetRows":
			out.SheetRows = state.SheetRows
		case "charts":
			out.Charts = state.Charts
		case "forms":
			out.Forms = state.Forms
		case "actions":
			out.Actions = state.Actions
		case "agents":
			out.Agents = state.Agents
		}
	}
	return out
}

// countsFromState derives the per-kind counts from a fully-loaded state. Used by
// the in-memory summarize path (tests, and any caller that already holds the whole
// canvas); the cheap DB path gets exact counts straight from the store instead.
func countsFromState(state *store.CanvasState) map[string]int {
	counts := map[string]int{}
	if state == nil {
		return counts
	}
	counts["documents"] = len(state.Documents)
	counts["pins"] = len(state.Pins)
	counts["events"] = len(state.Events)
	counts["notes"] = len(state.Notes)
	counts["roadmapItems"] = len(state.RoadmapItems)
	counts["sheets"] = len(state.Sheets)
	counts["sheetRows"] = len(state.SheetRows)
	counts["charts"] = len(state.Charts)
	counts["forms"] = len(state.Forms)
	counts["actions"] = len(state.Actions)
	counts["agents"] = len(state.Agents)
	return counts
}

// namesFromState builds the raw (unsorted, uncapped) per-kind name lists from a
// state. The state may be a full canvas OR a capped Sample from GetCanvasSummary —
// the formatting is identical either way, so both read paths share it. Sorting,
// capping, and the "+N more" note are applied later by assembleSummary.
func namesFromState(state *store.CanvasState) map[string][]string {
	names := map[string][]string{}
	if state == nil {
		return names
	}
	for _, d := range state.Documents {
		names["documents"] = append(names["documents"], clip(d.Name)+" ("+d.Type+")")
	}
	for _, p := range state.Pins {
		names["pins"] = append(names["pins"], derefName(p.Label, "(pin)"))
	}
	for _, e := range state.Events {
		names["events"] = append(names["events"], clip(e.Title))
	}
	for _, n := range state.Notes {
		names["notes"] = append(names["notes"], clip(firstLine(n.Body)))
	}
	for _, r := range state.RoadmapItems {
		names["roadmapItems"] = append(names["roadmapItems"], clip(r.Title))
	}
	for _, s := range state.Sheets {
		names["sheets"] = append(names["sheets"], clip(s.Name))
	}
	for _, c := range state.Charts {
		names["charts"] = append(names["charts"], clip(c.Name))
	}
	for _, f := range state.Forms {
		names["forms"] = append(names["forms"], clip(f.Name))
	}
	// Actions are deliberately NOT listed by name. Their only cheap projection
	// is "type:state" (e.g. "task:done"), which is non-identifying noise that
	// scales linearly with the action count — on a busy board it's tens of
	// duplicate "task:done" strings that cost tokens and tell the agent nothing.
	// The count still appears, and the dedicated canvas_task_list /
	// canvas_action_list tools give the real, identifying view. See _hint.
	for _, ag := range state.Agents {
		names["agents"] = append(names["agents"], clip(ag.Name))
	}
	return names
}

// assembleSummary is the shared tail of both summary read paths: given exact
// counts and raw per-kind names, it sorts each list for stable/diffable output,
// caps it (the "+N more" note is computed against the EXACT count so it's correct
// even when names came from a capped DB sample), and packs the summaryMsg.
func assembleSummary(canvas *store.Canvas, mode string, version int, enabledModes []string,
	counts map[string]int, names map[string][]string, edits []*store.PendingEdit) summaryMsg {
	capped := make(map[string][]string, len(names))
	for k, list := range names {
		sort.Strings(list)
		capped[k] = capNamesToCount(list, counts[k])
	}
	return summaryMsg{
		Type:         "state.summary",
		Canvas:       canvas,
		Mode:         mode,
		Version:      version,
		EnabledModes: enabledModes,
		Counts:       counts,
		Names:        capped,
		PendingEdits: edits,
		Hint: "Summary only (counts + names). Re-read canvas_state_read with " +
			`fields=["roadmapItems"] (any of: ` + strings.Join(stateKinds, ", ") +
			") for the full objects of a kind, or full=true for the entire canvas. " +
			"Reading a sheet? request both \"sheets\" and \"sheetRows\". " +
			"Actions aren't listed by name — use canvas_task_list for the task queue " +
			"or canvas_action_list for other actions.",
	}
}

// summarizeState builds the summary from a fully-loaded state (in-memory counts +
// names). The cheap DB path builds the same message from store data via
// summarizeFromStore; both funnel through assembleSummary.
func summarizeState(canvas *store.Canvas, state *store.CanvasState, edits []*store.PendingEdit) summaryMsg {
	mode, version := "", 0
	var enabledModes []string
	if state != nil {
		mode, version, enabledModes = state.Mode, state.Version, state.EnabledModes
	}
	return assembleSummary(canvas, mode, version, enabledModes,
		countsFromState(state), namesFromState(state), edits)
}

// summarizeFromStore builds the summary from GetCanvasSummary's exact counts + a
// capped, name-column Sample — no full-canvas load. Names are derived from the
// Sample; counts are authoritative from the store.
func summarizeFromStore(canvas *store.Canvas, sum *store.CanvasSummary, edits []*store.PendingEdit) summaryMsg {
	if sum == nil {
		return assembleSummary(canvas, "", 0, nil, map[string]int{}, map[string][]string{}, edits)
	}
	return assembleSummary(canvas, sum.Mode, sum.Version, sum.EnabledModes,
		sum.Counts, namesFromState(sum.Sample), edits)
}

// capNames caps a fully-materialized name list (len == total), keeping the
// classic "first maxSummaryNames + (+N more)" shape. Thin wrapper over
// capNamesToCount for callers that hold every name.
func capNames(list []string) []string {
	return capNamesToCount(list, len(list))
}

// capNamesToCount caps a name list to maxSummaryNames and appends a "…(+N more)"
// marker for the rows not shown, where N is measured against the EXACT total —
// so truncation is reported correctly even when `list` is a capped DB sample
// (len(list) < total) rather than the full set (len(list) == total).
func capNamesToCount(list []string, total int) []string {
	shown := list
	if len(shown) > maxSummaryNames {
		shown = shown[:maxSummaryNames]
	}
	hidden := total - len(shown)
	if hidden <= 0 {
		return shown
	}
	out := make([]string, 0, len(shown)+1)
	out = append(out, shown...)
	out = append(out, fmt.Sprintf("…(+%d more)", hidden))
	return out
}

func derefName(p *string, fallback string) string {
	if p == nil || strings.TrimSpace(*p) == "" {
		return fallback
	}
	return clip(*p)
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// clip trims a name to a readable length so the summary stays cheap even when an
// individual title/note is a paragraph.
func clip(s string) string {
	s = strings.TrimSpace(s)
	const max = 80
	if len(s) <= max {
		return s
	}
	return strings.TrimSpace(s[:max]) + "…"
}
