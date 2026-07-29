package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type ctxKey string

const claimsKey ctxKey = "claims"
const userIDKey ctxKey = "userID"
const oauthClientKey ctxKey = "oauthClient"

func CanvasIDFromCtx(ctx context.Context) uuid.UUID {
	c, _ := ctx.Value(claimsKey).(*auth.Claims)
	if c == nil {
		return uuid.Nil
	}
	return c.CanvasID
}

// UserIDFromCtx returns the logged-in user's id (set by OptionalUser/RequireUser)
// and whether a session was present.
func UserIDFromCtx(ctx context.Context) (uuid.UUID, bool) {
	id, ok := ctx.Value(userIDKey).(uuid.UUID)
	return id, ok
}

// OAuthClientIDFromCtx returns the OAuth client_id when the caller authenticated
// via a hosted-connector OAuth access token (set by OptionalUser). Empty for
// cookie / PAT / anonymous callers — used to stamp a revocable grant binding
// onto issued canvas tokens.
func OAuthClientIDFromCtx(ctx context.Context) (string, bool) {
	cid, ok := ctx.Value(oauthClientKey).(string)
	return cid, ok && cid != ""
}

// RoleFromCtx returns the canvas role baked into the JWT ("write" | "read"),
// empty when no claims are present.
func RoleFromCtx(ctx context.Context) string {
	c, _ := ctx.Value(claimsKey).(*auth.Claims)
	if c == nil {
		return ""
	}
	return c.Role
}

// RequireWrite rejects a valid-but-read-only canvas token on mutating routes.
// Layer it AFTER RequireJWT — it reads the claims RequireJWT injects. This is the
// HTTP/agent counterpart to the WebSocket write gate in ws_handler.handleOp.
func RequireWrite(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if RoleFromCtx(r.Context()) != "write" {
			writeError(w, http.StatusForbidden, "this canvas is read-only for you")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireLiveGrant invalidates a canvas token whose issuing OAuth connection has
// since been revoked. A canvas JWT is self-contained and lives for its full TTL
// (24h), so disconnecting the app from /me otherwise wouldn't stop in-flight
// sessions until the token expired. When the token carries an OAuth grant binding
// (UID/CID — stamped only for hosted-connector callers), this re-checks per
// request that the grant is still live and 401s with invalid_token when it isn't,
// so the sidecar drops the dead token and re-runs OAuth. Layer AFTER RequireJWT.
// Unbound tokens (anonymous / PAT / cookie) skip the check entirely.
func RequireLiveGrant(s store.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c, _ := r.Context().Value(claimsKey).(*auth.Claims)
			if c == nil || c.UID == nil {
				next.ServeHTTP(w, r) // unbound token — nothing to re-check
				return
			}
			live, err := s.HasLiveOAuthGrant(r.Context(), *c.UID, c.CID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "could not verify authorization")
				return
			}
			if !live {
				writeError(w, http.StatusUnauthorized, "invalid_token")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// sessionUserID validates the session cookie and returns the user id, if any.
// Shared by the two user middlewares below; mirrors auth_handler.Me's logic.
func sessionUserID(authSvc *auth.Service, r *http.Request) (uuid.UUID, bool) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		return uuid.Nil, false
	}
	claims, err := authSvc.ValidateSession(cookie.Value)
	if err != nil {
		return uuid.Nil, false
	}
	return claims.UserID, true
}

// patUserID resolves a personal access token presented as
// `Authorization: Bearer tdm_pat_…` to its owning user. The prefix guard means a
// non-PAT bearer (or none) never hits the DB. This is how an MCP/agent caller —
// which carries no browser cookie — acts as the user: the gateway forwards the
// user's PAT on the auth handshake. Returns false on any miss.
func patUserID(s store.Store, r *http.Request) (uuid.UUID, bool) {
	header := r.Header.Get("Authorization")
	token := strings.TrimPrefix(header, "Bearer ")
	if token == header || !strings.HasPrefix(token, store.PATPrefix) {
		return uuid.Nil, false
	}
	uid, err := s.UserIDByTokenHash(r.Context(), store.HashToken(token))
	if err != nil {
		return uuid.Nil, false
	}
	return uid, true
}

// oauthUserID resolves an OAuth 2.1 access token (Authorization: Bearer
// tdm_oat_…) to its user + client_id — the hosted claude.ai connector path.
// Prefix-gated like patUserID so non-OAuth bearers skip the DB. Returns false on
// any miss (expired, revoked, unknown) so the caller falls through to anonymous.
func oauthUserID(s store.Store, r *http.Request) (uuid.UUID, string, bool) {
	header := r.Header.Get("Authorization")
	token := strings.TrimPrefix(header, "Bearer ")
	if token == header || !strings.HasPrefix(token, store.OAuthAccessPrefix) {
		return uuid.Nil, "", false
	}
	uid, clientID, err := s.OAuthUserByAccessHash(r.Context(), store.HashToken(token))
	if err != nil {
		return uuid.Nil, "", false
	}
	return uid, clientID, true
}

// hasOAuthBearer reports whether the request carries an OAuth access token
// (Authorization: Bearer tdm_oat_…), regardless of whether it's still valid.
// Paired with UserIDFromCtx after OptionalUser has run, it distinguishes a
// caller who presented a *revoked/expired* OAuth token (bearer present, no user
// resolved) from a genuinely anonymous caller (no bearer) — the former must be
// re-challenged so the hosted connector drops the dead token and re-runs OAuth.
func hasOAuthBearer(r *http.Request) bool {
	header := r.Header.Get("Authorization")
	token := strings.TrimPrefix(header, "Bearer ")
	return token != header && strings.HasPrefix(token, store.OAuthAccessPrefix)
}

// OptionalUser attaches the logged-in user's id to the context when a valid
// session cookie, personal access token, OR OAuth access token is present,
// otherwise lets the request through anonymously. Cookie is the browser path;
// the PAT is the stdio-agent path; the OAuth token is the hosted-connector path —
// each lets a caller act as that user. Used on create-canvas (owned vs
// anonymous) and /api/mcp/auth (real role vs public).
func OptionalUser(authSvc *auth.Service, s store.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			uid, ok := sessionUserID(authSvc, r)
			if !ok {
				uid, ok = patUserID(s, r)
			}
			var clientID string
			if !ok {
				uid, clientID, ok = oauthUserID(s, r)
			}
			if ok {
				ctx := context.WithValue(r.Context(), userIDKey, uid)
				// Only OAuth callers carry a client_id — it marks the credential as a
				// revocable connection so issued canvas tokens get a grant binding.
				if clientID != "" {
					ctx = context.WithValue(ctx, oauthClientKey, clientID)
				}
				r = r.WithContext(ctx)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireUser rejects requests without a valid session cookie (401) and
// otherwise injects the user id. Used on the "my canvases" + copy endpoints.
func RequireUser(authSvc *auth.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			uid, ok := sessionUserID(authSvc, r)
			if !ok {
				writeError(w, http.StatusUnauthorized, "not signed in")
				return
			}
			ctx := context.WithValue(r.Context(), userIDKey, uid)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireCanvasByCode authenticates a route whose canvas is named by a {code}
// path param instead of by the token — the inbound status API (TDM-38), where a
// CI job's URL is the human-shareable thing and the credential is whatever the
// job happens to have.
//
// It accepts EITHER credential, because "how long does the caller live" is the
// only question that matters here and the two answers want different tokens:
//
//   - a canvas JWT (from POST /api/mcp/auth): self-contained, 24h. Fine for a
//     job that exchanges the canvas code at the top of every run, useless as a
//     CI secret. It already names a canvas, so the {code} in the path must
//     resolve to that SAME canvas — a token for canvas A cannot be replayed
//     against canvas B's URL (403).
//   - a personal access token (tdm_pat_…) or an OAuth access token (tdm_oat_…):
//     long-lived, revocable, and validated against the DB on every request —
//     which is exactly what a `TANDEM_PAT` in CI secrets needs to be. Role comes
//     from ResolveCanvasRole, so a CI job has precisely the access its owner has
//     on that canvas, private canvases included.
//
// There is deliberately no anonymous path: a public canvas's write posture lets
// anyone MINT a canvas token, but reporting task status is a fleet-member act
// and must carry a credential, not just knowledge of the URL.
//
// Injects *auth.Claims exactly as RequireJWT does, so everything downstream
// (CanvasIDFromCtx, RoleFromCtx, RequireWrite, RequireLiveGrant) is unchanged.
// Claims synthesized for a PAT/OAuth caller carry no grant binding, so
// RequireLiveGrant no-ops on them — correct, since those tokens were just
// checked live against the DB.
func RequireCanvasByCode(authSvc *auth.Service, s store.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if !strings.HasPrefix(header, "Bearer ") {
				writeError(w, http.StatusUnauthorized, "missing or invalid Authorization header")
				return
			}
			token := strings.TrimPrefix(header, "Bearer ")
			canvas, err := s.GetCanvasByCode(r.Context(), chi.URLParam(r, "code"))
			if err != nil {
				writeError(w, http.StatusNotFound, "canvas not found — check the canvas code in the URL")
				return
			}

			var claims *auth.Claims
			if strings.HasPrefix(token, store.PATPrefix) || strings.HasPrefix(token, store.OAuthAccessPrefix) {
				uid, ok := patUserID(s, r)
				if !ok {
					uid, _, ok = oauthUserID(s, r)
				}
				if !ok {
					writeError(w, http.StatusUnauthorized, "invalid token: not a live access token")
					return
				}
				role, err := s.ResolveCanvasRole(r.Context(), canvas, &uid)
				if err != nil {
					writeError(w, http.StatusInternalServerError, "could not resolve canvas access")
					return
				}
				if role == "none" {
					writeError(w, http.StatusForbidden, "this canvas is private — ask its owner to share it with your account")
					return
				}
				claims = &auth.Claims{CanvasID: canvas.ID, Role: role}
			} else {
				c, err := authSvc.Validate(token)
				if err != nil {
					writeError(w, http.StatusUnauthorized, "invalid token: "+err.Error())
					return
				}
				// The whole reason the code is in the path: it is checkable. A
				// token scoped elsewhere is a 403, never a silent write to the
				// canvas the token happens to name.
				if c.CanvasID != canvas.ID {
					writeError(w, http.StatusForbidden, "this token is scoped to a different canvas than the one in the URL")
					return
				}
				claims = c
			}
			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireJWT validates the Authorization header and injects claims into context.
func RequireJWT(authSvc *auth.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if !strings.HasPrefix(header, "Bearer ") {
				writeError(w, http.StatusUnauthorized, "missing or invalid Authorization header")
				return
			}
			claims, err := authSvc.Validate(strings.TrimPrefix(header, "Bearer "))
			if err != nil {
				writeError(w, http.StatusUnauthorized, "invalid token: "+err.Error())
				return
			}
			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
