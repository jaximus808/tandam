package api

import (
	"context"
	"net/http"
	"strings"
	"unicode"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/google/uuid"
)

// Provenance (TDM-40, migration 0039): who authored a row, decided by the
// SERVER and never by the request body.
//
// The canvas already carries `created_by` / `proposed_by`, but those are
// freeform labels the CLIENT sends — the MCP gateway hardcodes 'agent', the web
// app sends 'human', and nothing checks either. `authored_by` is the trustworthy
// counterpart: it is computed here from the auth context, stamped on INSERT
// only, and there is deliberately NO request-body field for it anywhere. A
// caller that posts {"authoredBy":"human"} is not rejected — the field simply
// doesn't exist on any handler's body struct, so encoding/json drops it on the
// floor. See provenance_test.go, which asserts exactly that on every create path.
//
// WHAT IS AND ISN'T FORGEABLE — read this before trusting a chip:
//
//   - "human" is unforgeable. It requires a valid, HMAC-signed Google session
//     (browser cookie, or a WebSocket connection whose cookie resolved to a user
//     id). No agent credential produces it.
//   - "agent:<identity>" — the PREFIX is server-stamped, the <identity> is
//     CLIENT-ASSERTED. An agent picks its own name, exactly as it already does
//     for claimed_by. That's a known and accepted limit: the classification
//     (human vs agent vs anonymous) is what has to be server-derived, and it is.
//     Two agents can lie about which of them did the work; neither can pass as a
//     person.
//   - "anonymous" is the floor — a valid canvas token with neither.
//
// Ordering matters: the agent assertion is checked FIRST, before the session.
// The hosted claude.ai connector authenticates with a user's OAuth grant, so its
// requests can carry a user identity while still being an agent acting on that
// user's behalf. Agent-first keeps those stamped "agent:…". The browser never
// sends the header, so a signed-in human is never misclassified by this order.
// (A human COULD demote themselves by sending the header by hand. Nobody needs
// defending against choosing to look like a robot.)

const (
	// AuthorHuman and AuthorAnonymous, plus the "agent:" prefix, are the entire
	// vocabulary of the authored_by column. Keep in sync with 0039's header.
	AuthorHuman     = "human"
	AuthorAnonymous = "anonymous"

	authorAgentPrefix = "agent:"

	// AgentIdentityHeader is how a non-browser caller asserts WHICH agent it is.
	// The MCP gateway sets it on every canvas call to the same claimant string it
	// uses for task claims, so a task's provenance chip and its claimedBy agree.
	// Absent header ⇒ no agent identity asserted ⇒ human or anonymous.
	AgentIdentityHeader = "X-Tandem-Agent"

	// maxAuthorNameLen bounds the asserted identity. Same order as the status
	// API's maxStatusAgentLen — long enough for a descriptive agent name, short
	// enough that nobody stuffs a payload into a display string.
	maxAuthorNameLen = 120
)

const authorKey ctxKey = "authoredBy"

// Provenance derives this request's authored_by and stashes it in the context,
// so both handlers and the shared helpers below them (ensureDefaultDocInList,
// which only ever gets a ctx) can stamp it without threading a parameter through
// every create signature.
//
// Layer it inside the RequireJWT group. It performs no DB work: the only
// credential it inspects is the session cookie, and validating that is an HMAC
// check. A route WITHOUT this middleware stamps nothing (NULL = unknown) rather
// than guessing — which is the safe failure, not a silent lie.
func Provenance(authSvc *auth.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(
				WithAuthor(r.Context(), deriveAuthor(authSvc, r))))
		})
	}
}

// deriveAuthor is the whole derivation, as a pure function of the request so it
// can be tested without a router. See the file comment for why agent wins over
// session.
func deriveAuthor(authSvc *auth.Service, r *http.Request) string {
	if name, ok := assertedAgent(r); ok {
		return authorAgentPrefix + name
	}
	if authSvc != nil {
		if _, ok := sessionUserID(authSvc, r); ok {
			return AuthorHuman
		}
	}
	return AuthorAnonymous
}

// assertedAgent reads the agent identity the caller claims for itself. Sanitized
// but NOT verified against the agents table — see the file comment.
func assertedAgent(r *http.Request) (string, bool) {
	name := sanitizeAuthorName(r.Header.Get(AgentIdentityHeader))
	return name, name != ""
}

// AuthorForSession is the WebSocket counterpart of deriveAuthor. The browser
// socket has no agent path at all — it is the human channel by construction —
// so the connection's resolved user id is the whole decision. Nil = anonymous
// viewer on a public canvas.
func AuthorForSession(userID *uuid.UUID) string {
	if userID != nil {
		return AuthorHuman
	}
	return AuthorAnonymous
}

// WithAuthor stamps a derived author onto a context. Exported for the WS path,
// which builds its own background contexts per op.
func WithAuthor(ctx context.Context, author string) context.Context {
	return context.WithValue(ctx, authorKey, author)
}

// AuthorFromCtx returns the derived authored_by for this request, or nil when
// provenance wasn't derived (no middleware on the route) — nil stores as SQL
// NULL, which the vocabulary defines as "unknown", never as a guess.
func AuthorFromCtx(ctx context.Context) *string {
	a, ok := ctx.Value(authorKey).(string)
	if !ok || a == "" {
		return nil
	}
	return &a
}

// sanitizeAuthorName makes an asserted identity safe to store and render:
// control characters (which would let a name forge line breaks in logs or a
// second chip in the UI) are dropped, surrounding space trimmed, and the result
// capped by RUNE count so a multibyte name can't overflow the column budget.
func sanitizeAuthorName(raw string) string {
	cleaned := strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, raw)
	cleaned = strings.TrimSpace(cleaned)
	runes := []rune(cleaned)
	if len(runes) > maxAuthorNameLen {
		cleaned = strings.TrimSpace(string(runes[:maxAuthorNameLen]))
	}
	return cleaned
}
