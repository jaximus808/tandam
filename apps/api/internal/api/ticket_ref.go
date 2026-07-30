package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// Ticket references as action ids.
//
// A ticket ("TDM-21") is the identifier that actually travels: it goes in commit
// messages, in the web Tasks panel, in what a human types at an agent ("take on
// TDM-21"). The uuid is what the API addresses. Before this, closing that gap
// was the caller's problem — an agent handed a ticket had to LIST every task and
// scan for a matching ticketId, because /api/canvas/actions/{id} accepted only a
// uuid. That is a whole extra round trip (and a full board read) to learn
// something the server already knows.
//
// So every action route accepts either form. The resolution happens ONCE, in
// middleware, by rewriting the {id} route param to the canonical uuid — not in
// each handler. Two reasons that shape and not a helper per call site:
//
//  1. Coverage. Read, claim, transition, payload-edit, release, requeue, move,
//     delete and the inbound status endpoint all parse {id}, several of them
//     more than once in a single request (the claim guard and the payload merge
//     re-parse it). A helper is something a call site can forget to call; a
//     rewritten param is something none of them can bypass.
//  2. Cost. One lookup per request instead of one per parse, and uuid callers —
//     every existing client — pay nothing: the uuid fast path returns before any
//     store access.
//
// On anything it cannot resolve the middleware passes the param through
// UNCHANGED, so the handler produces its own native error in its own shape
// (writeError vs the task-status endpoint's error envelope). The tradeoff: a
// well-formed but nonexistent ticket ("TDM-99999") reports as the handler's 400
// invalid-id rather than a 404, which is why those messages name the ticket form.

// parseTicketRef reads the forms a ticket is written in the wild, and returns
// the bare number. Accepted: "TDM-21", "tdm-21", "#21", "21", with surrounding
// whitespace. A bare integer is unambiguous here because a uuid never parses as
// one, and "21" is what a model abbreviates a ticket to about as often as it
// spells it out.
func parseTicketRef(raw string) (int, bool) {
	s := strings.TrimSpace(raw)
	s = strings.TrimPrefix(s, "#")
	if len(s) > len(ticketRefPrefix) && strings.EqualFold(s[:len(ticketRefPrefix)], ticketRefPrefix) {
		s = s[len(ticketRefPrefix):]
	}
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil || n < 1 {
		return 0, false
	}
	return n, true
}

// ticketRefPrefix is the display prefix store.TicketID renders ("TDM-"). Derived
// from that one definition rather than repeating the literal, so the parser and
// the renderer cannot drift apart.
var ticketRefPrefix = strings.TrimSuffix(store.TicketID(0), "0")

// ResolveTicketRef rewrites an {id} route param written as a ticket reference
// into the task's uuid, for the routes whose {id} addresses an ACTION. Mount it
// per-route: other {id} params in this API address pins, notes, sheets, forms
// and webhooks, none of which have tickets, and a numeric ref there must keep
// failing the way it does today.
func ResolveTicketRef(s store.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw := chi.URLParam(r, "id")
			// Fast path: already a uuid. No store access, no rewrite — the shape
			// every existing caller uses stays exactly as cheap as it was.
			if _, err := uuid.Parse(raw); err == nil {
				next.ServeHTTP(w, r)
				return
			}
			n, ok := parseTicketRef(raw)
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			canvasID := CanvasIDFromCtx(r.Context())
			if canvasID == uuid.Nil {
				next.ServeHTTP(w, r)
				return
			}
			action, err := s.GetActionByTicket(r.Context(), canvasID, n)
			if err != nil || action == nil {
				next.ServeHTTP(w, r)
				return
			}
			setURLParam(r, "id", action.ID.String())
			next.ServeHTTP(w, r)
		})
	}
}

// setURLParam replaces a resolved route param in place. chi exposes the parsed
// params as parallel Keys/Values slices on the RouteContext and has no setter,
// so this writes the slot the router already filled. Scanning from the END
// matters: chi appends a param per matching route pattern, and for a nested
// mount the LAST entry for a key is the one chi.URLParam returns.
func setURLParam(r *http.Request, key, value string) {
	rctx := chi.RouteContext(r.Context())
	if rctx == nil {
		return
	}
	for i := len(rctx.URLParams.Keys) - 1; i >= 0; i-- {
		if rctx.URLParams.Keys[i] == key {
			rctx.URLParams.Values[i] = value
			return
		}
	}
}
