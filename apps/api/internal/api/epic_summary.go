package api

import (
	"encoding/json"
	"strings"
	"time"
)

// Epic summaries (TDM-93).
//
// THE GAP. A task carries a `result` when it finishes — the one line that says
// what the work actually did. An epic carried nothing: to learn what
// "E5 · Observability & performance" delivered you opened all six of its tickets
// and read each result yourself. The batch-level answer existed nowhere, which
// is exactly the answer a human (or the next agent) wants first.
//
// So an epic payload gains `summary`: prose saying what the batch achieved.
// Three properties make it worth trusting:
//
//  1. NOT CONTENT. `summary` is not in store.contentFields (title/body), so
//     writing it to an approved epic is a bookkeeping write — silent, allowed,
//     and it does NOT revert the epic to 'proposed'. That is the whole reason
//     the write path can be agent-driven: a summary that un-approved its own
//     epic (and with it the approval its tasks inherit) would be unusable.
//  2. STAMPED BY THE SERVER. `summaryBy` / `summaryAt` are derived from the
//     request's provenance and clock, never read off the body — same rule as
//     authoredBy and audit[]. A caller cannot claim a human wrote its summary,
//     and cannot backdate one.
//  3. IDEMPOTENT. A payload write that leaves the summary text unchanged (a
//     title edit, a linkedIds change, the web editor round-tripping the whole
//     payload) carries the existing stamp forward rather than restamping it, so
//     "summarized 3d ago" stays true.
//
// The rollup that goes with it — counts, activity window, done-ticket lines —
// is derived, never stored: see epic_rollup.go.

// MaxEpicSummary bounds the stored summary in RUNES. An epic payload is re-read
// by every board load and every WS state broadcast, so this is prose with a
// budget, not a document: the batch-level answer in a paragraph or two. Longer
// context belongs in a note (doc_write) that the epic links.
const MaxEpicSummary = 2000

// epicSummaryKeys are the payload keys this file owns. summaryBy / summaryAt are
// SERVER-OWNED: whatever a caller sends under them is discarded.
const (
	epicSummaryKey   = "summary"
	epicSummaryByKey = "summaryBy"
	epicSummaryAtKey = "summaryAt"
)

// normalizeEpicSummary trims and caps a decoded epic payload's summary in place.
// An absent, blank, or non-string summary is deleted outright — the field means
// "somebody said what this batch achieved", and an empty string does not say it.
// Returns the normalized text ("" when there is none).
func normalizeEpicSummary(p map[string]any) string {
	raw, present := p[epicSummaryKey]
	if !present {
		return ""
	}
	s, _ := raw.(string)
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > MaxEpicSummary {
		// Truncate rather than refuse: an over-long summary is a verbose agent,
		// not an attack, and losing the tail beats losing the whole write. The
		// ellipsis marks the cut so nobody reads it as the complete account.
		s = strings.TrimSpace(string(r[:MaxEpicSummary])) + "…"
	}
	if s == "" {
		delete(p, epicSummaryKey)
		return ""
	}
	p[epicSummaryKey] = s
	return s
}

// stampEpicSummary reconciles an incoming epic payload's summary provenance
// against the stored row. Pure, so the rule is table-testable without a DB.
//
//	incoming summary absent/blank  → the stamp goes too (nothing to attribute)
//	unchanged from stored          → carry the stored stamp (no restamping)
//	new or edited                  → stamp actor + now
//
// `actor` is the server's conclusion about the caller (AuthorFromCtx: "human",
// "agent:<name>", "anonymous"); empty records nothing rather than guessing.
func stampEpicSummary(stored, incoming json.RawMessage, actor string, now time.Time) json.RawMessage {
	var p map[string]any
	if len(incoming) == 0 || json.Unmarshal(incoming, &p) != nil {
		// Not an object — canonicalizeEpicPayload already owns that complaint.
		return incoming
	}
	next := normalizeEpicSummary(p)
	// Server-owned either way: never let a caller's value through.
	delete(p, epicSummaryByKey)
	delete(p, epicSummaryAtKey)

	if next == "" {
		out, err := json.Marshal(p)
		if err != nil {
			return incoming
		}
		return out
	}

	prev := readEpicSummary(stored)
	if next == prev.Summary {
		// Same words: this write was about something else. Keep the original
		// attribution — a title edit must not make an old summary look fresh.
		if prev.SummaryBy != "" {
			p[epicSummaryByKey] = prev.SummaryBy
		}
		if prev.SummaryAt != "" {
			p[epicSummaryAtKey] = prev.SummaryAt
		}
	} else {
		if a := strings.TrimSpace(actor); a != "" {
			p[epicSummaryByKey] = a
		}
		p[epicSummaryAtKey] = now.UTC().Format(time.RFC3339)
	}
	out, err := json.Marshal(p)
	if err != nil {
		return incoming
	}
	return out
}

// epicSummaryFields is the summary slice of a stored epic payload.
type epicSummaryFields struct {
	Summary   string `json:"summary"`
	SummaryBy string `json:"summaryBy"`
	SummaryAt string `json:"summaryAt"`
}

// readEpicSummary reads the summary trio off a stored payload. Unparseable
// payloads read as "no summary" — a corrupt row must not block the write that
// would replace it.
func readEpicSummary(raw json.RawMessage) epicSummaryFields {
	var f epicSummaryFields
	if len(raw) == 0 {
		return f
	}
	_ = json.Unmarshal(raw, &f)
	f.Summary = strings.TrimSpace(f.Summary)
	return f
}
