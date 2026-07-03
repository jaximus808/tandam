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

// summarizeState builds the counts + per-kind name lists for the default read.
func summarizeState(canvas *store.Canvas, state *store.CanvasState, edits []*store.PendingEdit) summaryMsg {
	counts := map[string]int{}
	names := map[string][]string{}
	if state != nil {
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
		for _, a := range state.Actions {
			names["actions"] = append(names["actions"], a.Type+":"+a.State)
		}
		for _, ag := range state.Agents {
			names["agents"] = append(names["agents"], clip(ag.Name))
		}
	}
	// Map iteration is unordered; sort each list so repeated reads are stable and
	// diffable, then cap the length so a huge kind can't re-barf the summary.
	for k, list := range names {
		sort.Strings(list)
		names[k] = capNames(list)
	}

	msg := summaryMsg{
		Type:         "state.summary",
		Canvas:       canvas,
		Counts:       counts,
		Names:        names,
		PendingEdits: edits,
		Hint: "Summary only (counts + names). Re-read canvas_state_read with " +
			`fields=["roadmapItems"] (any of: ` + strings.Join(stateKinds, ", ") +
			") for the full objects of a kind, or full=true for the entire canvas. " +
			"Reading a sheet? request both \"sheets\" and \"sheetRows\".",
	}
	if state != nil {
		msg.Mode = state.Mode
		msg.Version = state.Version
		msg.EnabledModes = state.EnabledModes
	}
	return msg
}

func capNames(list []string) []string {
	if len(list) <= maxSummaryNames {
		return list
	}
	out := make([]string, 0, maxSummaryNames+1)
	out = append(out, list[:maxSummaryNames]...)
	out = append(out, fmt.Sprintf("…(+%d more)", len(list)-maxSummaryNames))
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
