package api

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"testing"

	"github.com/agentcanvas/api/internal/store"
)

// verifyPKCE must accept exactly the challenge the client derives from its
// verifier (S256, RFC 7636) and reject anything else — the guard that stops a
// stolen authorization code from being redeemed without the original verifier.
func TestVerifyPKCE(t *testing.T) {
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	if !verifyPKCE(verifier, challenge) {
		t.Fatal("verifyPKCE rejected the matching verifier/challenge pair")
	}
	if verifyPKCE("wrong-verifier", challenge) {
		t.Fatal("verifyPKCE accepted a non-matching verifier")
	}
	if verifyPKCE(verifier, "") {
		t.Fatal("verifyPKCE accepted an empty challenge")
	}
	// A plain (non-hashed) verifier must not pass an S256 challenge.
	if verifyPKCE(verifier, verifier) {
		t.Fatal("verifyPKCE accepted the verifier as its own challenge (plain, not S256)")
	}
}

func TestScopeOrDefault(t *testing.T) {
	if got := scopeOrDefault(""); got != oauthScope {
		t.Fatalf("scopeOrDefault(\"\") = %q, want %q", got, oauthScope)
	}
	if got := scopeOrDefault("  "); got != oauthScope {
		t.Fatalf("scopeOrDefault(spaces) = %q, want %q", got, oauthScope)
	}
	if got := scopeOrDefault("custom"); got != "custom" {
		t.Fatalf("scopeOrDefault(custom) = %q, want custom", got)
	}
}

// hasOAuthBearer gates the stale-token → 401 re-challenge in MCPAuth: it must
// fire only for an OAuth access token (tdm_oat_…), not for a PAT, a canvas JWT,
// or a missing header — otherwise a genuinely anonymous caller would be told to
// re-auth on a private canvas instead of getting the plain "private" dead-end.
func TestHasOAuthBearer(t *testing.T) {
	cases := []struct {
		name string
		auth string
		want bool
	}{
		{"oauth token", "Bearer " + store.OAuthAccessPrefix + "abc123", true},
		{"pat", "Bearer " + store.PATPrefix + "abc123", false},
		{"raw jwt", "Bearer eyJhbGciOi.foo.bar", false},
		{"no prefix", store.OAuthAccessPrefix + "abc123", false},
		{"empty", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r, _ := http.NewRequest("POST", "/api/mcp/auth", nil)
			if c.auth != "" {
				r.Header.Set("Authorization", c.auth)
			}
			if got := hasOAuthBearer(r); got != c.want {
				t.Fatalf("hasOAuthBearer(%q) = %v, want %v", c.auth, got, c.want)
			}
		})
	}
}
