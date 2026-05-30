package api

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
)

// GET /api/canvas/{code}/itinerary.ics
//
// Public endpoint — the canvas code is the access token, same model as the
// sheet export and the WS layer. Returns an iCalendar feed of every event on
// the canvas, suitable for both one-shot download AND calendar subscription
// (Google Calendar / Apple Calendar / Outlook can poll the URL to stay in sync
// as Tandem changes).
//
// Each event is emitted in its own IANA timezone via DTSTART;TZID= so a
// multi-zone trip displays correctly in the recipient's calendar regardless of
// where they are. Events with no timezone fall back to UTC.
func (h *Handler) ExportItineraryICS(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(chi.URLParam(r, "code"))
	if code == "" {
		writeError(w, http.StatusBadRequest, "code path parameter required")
		return
	}
	canvas, err := h.store.GetCanvasByCode(r.Context(), code)
	if err != nil {
		writeError(w, http.StatusNotFound, "canvas not found")
		return
	}
	_, state, _, err := h.store.GetCanvasState(r.Context(), canvas.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not load canvas state")
		return
	}

	events := make([]*store.Event, 0, len(state.Events))
	for _, ev := range state.Events {
		events = append(events, ev)
	}
	sort.Slice(events, func(i, j int) bool { return events[i].Start.Before(events[j].Start) })

	ics := buildICS(canvas, state, events)

	filename := sanitizeFilename(canvas.Name)
	if filename == "" {
		filename = "itinerary"
	}
	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.ics"`, filename))
	// Calendar clients re-poll subscription URLs frequently; a short cache
	// window keeps load reasonable without making sync feel stale.
	w.Header().Set("Cache-Control", "public, max-age=60")
	_, _ = w.Write([]byte(ics))
}

const icsCRLF = "\r\n"

func buildICS(canvas *store.Canvas, state *store.CanvasState, events []*store.Event) string {
	var b strings.Builder
	b.WriteString("BEGIN:VCALENDAR" + icsCRLF)
	b.WriteString("VERSION:2.0" + icsCRLF)
	b.WriteString("PRODID:-//Tandem//Canvas//EN" + icsCRLF)
	b.WriteString("CALSCALE:GREGORIAN" + icsCRLF)
	b.WriteString("METHOD:PUBLISH" + icsCRLF)
	fmt.Fprintf(&b, "X-WR-CALNAME:%s%s", icsEscape(canvas.Name), icsCRLF)

	stamp := time.Now().UTC().Format("20060102T150405Z")
	for _, ev := range events {
		b.WriteString("BEGIN:VEVENT" + icsCRLF)
		// Stable UID so re-imports/refreshes update the existing event in the
		// calendar app instead of creating duplicates.
		fmt.Fprintf(&b, "UID:%s-%s@tandemcanvas.com%s", canvas.ID, ev.ID, icsCRLF)
		fmt.Fprintf(&b, "DTSTAMP:%s%s", stamp, icsCRLF)
		writeICSTime(&b, "DTSTART", ev.Start, ev.Timezone)
		if ev.End != nil {
			writeICSTime(&b, "DTEND", *ev.End, ev.Timezone)
		}
		fmt.Fprintf(&b, "SUMMARY:%s%s", icsEscape(ev.Title), icsCRLF)
		if loc := eventLocation(ev, state); loc != "" {
			fmt.Fprintf(&b, "LOCATION:%s%s", icsEscape(loc), icsCRLF)
		}
		b.WriteString("END:VEVENT" + icsCRLF)
	}

	b.WriteString("END:VCALENDAR" + icsCRLF)
	return b.String()
}

// writeICSTime emits DTSTART/DTEND in TZID form when an IANA zone is set —
// modern calendar apps (Google / Apple / Outlook) display the event in THAT
// zone regardless of viewer zone. Falls back to UTC ('...Z') when no zone is
// given or the zone fails to load.
func writeICSTime(b *strings.Builder, name string, t time.Time, tz *string) {
	if tz != nil && *tz != "" {
		if loc, err := time.LoadLocation(*tz); err == nil {
			local := t.In(loc)
			fmt.Fprintf(b, "%s;TZID=%s:%s%s", name, *tz, local.Format("20060102T150405"), icsCRLF)
			return
		}
	}
	fmt.Fprintf(b, "%s:%s%s", name, t.UTC().Format("20060102T150405Z"), icsCRLF)
}

// eventLocation picks a useful LOCATION string from the event's associated
// pin(s) — first pinIds entry, falling back to pinId, then travel origin. Uses
// the pin's label; falls back to "lat, lng" when unlabeled.
func eventLocation(ev *store.Event, state *store.CanvasState) string {
	ids := make([]string, 0, 2)
	for _, id := range ev.PinIDs {
		ids = append(ids, id.String())
	}
	if len(ids) == 0 && ev.PinID != nil {
		ids = append(ids, ev.PinID.String())
	}
	if len(ids) == 0 && ev.FromPinID != nil {
		ids = append(ids, ev.FromPinID.String())
	}
	for _, id := range ids {
		if p, ok := state.Pins[id]; ok && p != nil {
			if p.Label != nil && *p.Label != "" {
				return *p.Label
			}
			return fmt.Sprintf("%.5f, %.5f", p.Lat, p.Lng)
		}
	}
	return ""
}

// icsEscape escapes the four characters RFC 5545 requires (\ ; , and newlines)
// in TEXT-typed fields like SUMMARY / LOCATION.
func icsEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, ";", `\;`)
	s = strings.ReplaceAll(s, ",", `\,`)
	s = strings.ReplaceAll(s, "\r\n", `\n`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	s = strings.ReplaceAll(s, "\r", `\n`)
	return s
}
