package api

import (
	"errors"
	"log"
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
// On anything that is not a ticket at all — a malformed id, a uuid, a ref this
// middleware cannot even look up because the canvas is unknown — the param is
// passed through UNCHANGED, so the handler produces its own native error in its
// own shape (writeError vs the task-status endpoint's error envelope).
//
// A WELL-FORMED ref that resolves to nothing is different, and used to be the
// one dishonest answer on this path: passing "TDM-99999" through made every
// handler call it a malformed id (400 invalid_id), when the true fact is that the
// ref is fine and the task isn't here. The middleware is the only layer that
// knows that, so it answers itself — 404 task_not_found, in the shared coded
// envelope (writeCodedError), naming the ref. That is safe to do for EVERY route
// this is mounted on precisely because it can only fire for a ticket-form id:
// the web app and every other existing client address actions by uuid and take
// the fast path above, so nothing that parses today's 400 can see this 404.
// TDM-95.

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
			switch {
			case err == nil && action != nil:
				setURLParam(r, "id", action.ID.String())
			case err == nil || errors.Is(err, store.ErrActionNotFound):
				// The canvas is known, the ref is well-formed, and no task here
				// carries that number. Say exactly that.
				writeTicketNotFound(w, n)
				return
			default:
				// A store/transport failure is NOT "no such ticket" — reporting it
				// as a 404 would send a caller off checking a number that is fine.
				// Fall through to the handler, which will fail on the unresolved id
				// the way it always did, and leave a trace of the real cause.
				log.Printf("ticket ref %s: lookup failed, passing the ref through: %v", store.TicketID(n), err)
				next.ServeHTTP(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// writeTicketNotFound is the honest answer for a ticket ref that parses but
// names nothing on this canvas. It routes the caller two ways because the two
// causes are equally likely: a wrong number, or the right number on the wrong
// canvas. The tool names are the DEFAULT MCP surface — an agent told to "take on
// TDM-99999" is the caller that hits this, and pointing it at a tool its manifest
// doesn't advertise would be a dead end.
func writeTicketNotFound(w http.ResponseWriter, ticket int) {
	ref := store.TicketID(ticket)
	writeCodedError(w, http.StatusNotFound, "task_not_found",
		"no task "+ref+" on this canvas — the ticket ref is well-formed, so either the number is "+
			"wrong or you are connected to a different canvas than the one it belongs to. Check "+
			"queue_next / board_status for the tasks that ARE here (each carries its ticketId), or "+
			"task_find to look one up by title; over plain HTTP, GET /api/canvas/actions?type=task.",
		map[string]string{"ticketRef": ref})
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
