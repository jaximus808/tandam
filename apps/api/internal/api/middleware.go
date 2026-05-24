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

func CanvasIDFromCtx(ctx context.Context) uuid.UUID {
	c, _ := ctx.Value(claimsKey).(*auth.Claims)
	if c == nil {
		return uuid.Nil
	}
	return c.CanvasID
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
