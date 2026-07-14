package auth

import (
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type Claims struct {
	CanvasID uuid.UUID `json:"canvas_id"`
	Role     string    `json:"role"`
	// OAuth grant binding: set only when this canvas token was minted off a
	// hosted-connector OAuth session, so mid-session revocation can invalidate it
	// before its TTL. Present ⇒ RequireLiveGrant re-checks the grant per request;
	// absent (anonymous / PAT / cookie origins) ⇒ no DB check, token is self-
	// contained. UID is the authorizing user, CID the OAuth client_id.
	UID *uuid.UUID `json:"uid,omitempty"`
	CID string     `json:"cid,omitempty"`
	jwt.RegisteredClaims
}

// GrantBinding ties a canvas token back to the OAuth authorization that minted
// it. Pass to Issue when the caller authenticated via the hosted OAuth connector
// so revoking the connection kills the token; nil for all other origins.
type GrantBinding struct {
	UserID   uuid.UUID
	ClientID string
}

// SessionClaims identifies a logged-in human (separate from the canvas-scoped
// Claims used by agents/MCP). Carried in an httpOnly cookie, signed with the
// same secret.
type SessionClaims struct {
	UserID uuid.UUID `json:"user_id"`
	jwt.RegisteredClaims
}

type Service struct {
	secret   []byte
	tokenTTL time.Duration
}

func NewService(secret string, tokenTTL time.Duration) *Service {
	return &Service{secret: []byte(secret), tokenTTL: tokenTTL}
}

// Issue mints a canvas token carrying the resolved role. binding is non-nil only
// for hosted-connector OAuth callers — it stamps the grant onto the token so
// RequireLiveGrant can invalidate it on revocation before the TTL elapses.
func (s *Service) Issue(canvasID uuid.UUID, role string, binding *GrantBinding) (string, error) {
	claims := Claims{
		CanvasID: canvasID,
		Role:     role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(s.tokenTTL)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	if binding != nil {
		uid := binding.UserID
		claims.UID = &uid
		claims.CID = binding.ClientID
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.secret)
}

// IssueSession mints a user-session token. ttl is typically much longer than
// the canvas-token TTL (e.g. 30 days) since it backs a browser login.
func (s *Service) IssueSession(userID uuid.UUID, ttl time.Duration) (string, error) {
	claims := SessionClaims{
		UserID: userID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.secret)
}

func (s *Service) ValidateSession(tokenStr string) (*SessionClaims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &SessionClaims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return s.secret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*SessionClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid session token")
	}
	return claims, nil
}

func (s *Service) Validate(tokenStr string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return s.secret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	return claims, nil
}
