package store

import (
	"strings"
	"testing"
)

// A claim token must be impossible to confuse with a canvas code: different
// prefix, length, and alphabet (codes are uppercase A–Z/2–9, no "clm_"). This
// guards the property migration 0020 relies on for the two-capability split.
func TestClaimTokenFormatDistinctFromCode(t *testing.T) {
	for range 200 {
		tok := generateClaimToken()
		if !strings.HasPrefix(tok, "clm_") {
			t.Fatalf("claim token missing clm_ prefix: %q", tok)
		}
		hexPart := strings.TrimPrefix(tok, "clm_")
		if len(hexPart) != 32 {
			t.Fatalf("claim token hex part = %d chars, want 32: %q", len(hexPart), tok)
		}
		// A canvas code is 8 uppercase chars from codeChars — it can never contain
		// '_' or lowercase, so a token can never be parsed as a code.
		if strings.ToUpper(tok) == tok {
			t.Fatalf("claim token has no lowercase, could collide with code space: %q", tok)
		}
		code := generateCode()
		if len(code) != 8 || strings.Contains(code, "_") {
			t.Fatalf("canvas code unexpectedly shaped: %q", code)
		}
		if tok == code {
			t.Fatalf("claim token equals a canvas code: %q", tok)
		}
	}
}

// A personal access token must carry its namespace prefix (so the auth
// middleware can prefix-gate the DB lookup), be high-entropy, and hash
// deterministically to a fixed-width digest — the property the hash-at-rest
// storage model in migration 0027 relies on.
func TestGeneratePATFormatAndHash(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		tok := GeneratePAT()
		if !strings.HasPrefix(tok, PATPrefix) {
			t.Fatalf("PAT missing %q prefix: %q", PATPrefix, tok)
		}
		hexPart := strings.TrimPrefix(tok, PATPrefix)
		if len(hexPart) != 64 { // 32 bytes => 64 hex chars
			t.Fatalf("PAT hex part = %d chars, want 64: %q", len(hexPart), tok)
		}
		if seen[tok] {
			t.Fatalf("PAT collision — generator not random: %q", tok)
		}
		seen[tok] = true

		// Hash is deterministic, fixed-width (sha256 hex), and never the plaintext.
		h := HashToken(tok)
		if len(h) != 64 {
			t.Fatalf("token hash = %d chars, want 64 (sha256 hex): %q", len(h), h)
		}
		if h != HashToken(tok) {
			t.Fatalf("HashToken not deterministic for %q", tok)
		}
		if h == tok || strings.Contains(h, tok) {
			t.Fatalf("hash leaks the plaintext token")
		}
		if LastFour(tok) != tok[len(tok)-4:] {
			t.Fatalf("LastFour(%q) = %q, want last 4 chars", tok, LastFour(tok))
		}
	}
}

// OAuth secrets must carry their namespacing prefixes (so the auth middleware
// can prefix-gate and so token classes never collide) and be high-entropy.
func TestOAuthGeneratorsFormat(t *testing.T) {
	checks := []struct {
		name   string
		gen    func() string
		prefix string
		hexLen int
	}{
		{"access", GenerateAccessToken, OAuthAccessPrefix, 64},
		{"refresh", GenerateRefreshToken, oauthRefreshPrefix, 64},
		{"code", GenerateAuthCode, oauthCodePrefix, 64},
		{"client", GenerateOAuthClientID, oauthClientIDPrefix, 32},
	}
	seen := map[string]bool{}
	for _, c := range checks {
		for range 100 {
			tok := c.gen()
			if !strings.HasPrefix(tok, c.prefix) {
				t.Fatalf("%s token missing prefix %q: %q", c.name, c.prefix, tok)
			}
			if got := len(strings.TrimPrefix(tok, c.prefix)); got != c.hexLen {
				t.Fatalf("%s token hex len = %d, want %d: %q", c.name, got, c.hexLen, tok)
			}
			if seen[tok] {
				t.Fatalf("%s token collision — generator not random: %q", c.name, tok)
			}
			seen[tok] = true
		}
	}
	// Access tokens carry the prefix the middleware gates on, distinct from PATs.
	if strings.HasPrefix(GenerateAccessToken(), PATPrefix) {
		t.Fatal("OAuth access token collides with the PAT prefix")
	}
}

func TestResolveRowData(t *testing.T) {
	cols := []SheetColumn{
		{ID: "col-task", Name: "Task", Type: "text"},
		{ID: "col-done", Name: "Done", Type: "checkbox"},
	}

	tests := []struct {
		name string
		in   map[string]any
		want map[string]any
	}{
		{
			name: "exact name match",
			in:   map[string]any{"Task": "ship it", "Done": true},
			want: map[string]any{"col-task": "ship it", "col-done": true},
		},
		{
			name: "case-insensitive name match",
			in:   map[string]any{"task": "lower", "DONE": false},
			want: map[string]any{"col-task": "lower", "col-done": false},
		},
		{
			name: "column id passes through unchanged",
			in:   map[string]any{"col-task": "by id"},
			want: map[string]any{"col-task": "by id"},
		},
		{
			name: "unknown key left untouched",
			in:   map[string]any{"mystery": 1},
			want: map[string]any{"mystery": 1},
		},
		{
			name: "mixed names and ids",
			in:   map[string]any{"Task": "a", "col-done": true},
			want: map[string]any{"col-task": "a", "col-done": true},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveRowData(cols, tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("len = %d, want %d (got %v)", len(got), len(tc.want), got)
			}
			for k, v := range tc.want {
				if got[k] != v {
					t.Errorf("key %q = %v, want %v", k, got[k], v)
				}
			}
		})
	}
}

func TestResolveRowDataNoColumns(t *testing.T) {
	in := map[string]any{"anything": "value"}
	got := resolveRowData(nil, in)
	if got["anything"] != "value" {
		t.Errorf("with no columns, data should pass through unchanged, got %v", got)
	}
}
