package auth

import (
	"context"
	"fmt"

	"google.golang.org/api/idtoken"
)

// GoogleVerifier validates Google ID tokens (the credential the "Sign in with
// Google" button hands the browser). idtoken.Validate checks the signature
// against Google's rotating public keys and verifies issuer + audience, so we
// don't hand-roll JWKS handling. The validator caches certs across calls.
type GoogleVerifier struct {
	clientID  string
	validator *idtoken.Validator
}

type GoogleClaims struct {
	Sub     string
	Email   string
	Name    string
	Picture string
}

func NewGoogleVerifier(ctx context.Context, clientID string) (*GoogleVerifier, error) {
	v, err := idtoken.NewValidator(ctx)
	if err != nil {
		return nil, err
	}
	return &GoogleVerifier{clientID: clientID, validator: v}, nil
}

// Verify validates the token and confirms it was minted for our client id.
func (g *GoogleVerifier) Verify(ctx context.Context, idToken string) (*GoogleClaims, error) {
	payload, err := g.validator.Validate(ctx, idToken, g.clientID)
	if err != nil {
		return nil, fmt.Errorf("invalid google id token: %w", err)
	}
	c := &GoogleClaims{Sub: payload.Subject}
	if v, ok := payload.Claims["email"].(string); ok {
		c.Email = v
	}
	if v, ok := payload.Claims["name"].(string); ok {
		c.Name = v
	}
	if v, ok := payload.Claims["picture"].(string); ok {
		c.Picture = v
	}
	return c, nil
}
