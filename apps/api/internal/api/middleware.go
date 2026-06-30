package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/google/uuid"
)

type ctxKey string

const claimsKey ctxKey = "claims"
const userIDKey ctxKey = "userID"

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

// OptionalUser attaches the logged-in user's id to the context when a valid
// session cookie is present, otherwise lets the request through anonymously.
// Used on create-canvas: logged-in creates get owned, anonymous ones don't.
func OptionalUser(authSvc *auth.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if uid, ok := sessionUserID(authSvc, r); ok {
				r = r.WithContext(context.WithValue(r.Context(), userIDKey, uid))
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
