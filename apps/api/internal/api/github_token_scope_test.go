package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TDM-140: a GH_STATUS_TOKEN that can read private repos must not power the
// process-wide, cross-canvas status proxy. The scope check is a pure function of
// the classic PAT's X-OAuth-Scopes header.
func TestGithubScopesGrantPrivateRead(t *testing.T) {
	cases := []struct {
		header string
		want   bool
	}{
		{"", false},                                  // fine-grained / no scopes → safe
		{"public_repo", false},                       // public-only → safe
		{"public_repo, read:org, gist", false},       // none private → safe
		{"repo", true},                               // full private control
		{"repo, workflow", true},                     // repo among others
		{"repo:status", true},                        // private commit-status read
		{"read:user, repo:status, gist", true},       // repo:status among others
		{"repo_deployment", false},                   // not private content/status read
		{"admin:org, workflow, public_repo", false},  // safe set
	}
	for _, tc := range cases {
		if got := githubScopesGrantPrivateRead(tc.header); got != tc.want {
			t.Errorf("githubScopesGrantPrivateRead(%q) = %v, want %v", tc.header, got, tc.want)
		}
	}
}

// githubTokenIsPublicSafe returns false only when it positively confirms a
// private scope; a private-capable token is caught, a public one and an
// unreachable probe are left alone (fail-open on availability).
func TestGithubTokenIsPublicSafe(t *testing.T) {
	newServer := func(scopes string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/rate_limit" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if r.Header.Get("Authorization") == "" {
				t.Errorf("scope probe sent no Authorization header")
			}
			w.Header().Set("X-OAuth-Scopes", scopes)
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{}`))
		}))
	}
	client := &http.Client{Timeout: 2 * time.Second}

	t.Run("public token is safe", func(t *testing.T) {
		srv := newServer("public_repo, read:org")
		defer srv.Close()
		if !githubTokenIsPublicSafe(srv.URL, "ghp_pub", client) {
			t.Fatal("public-scope token should be treated as safe")
		}
	})

	t.Run("private-repo token is unsafe", func(t *testing.T) {
		srv := newServer("repo, workflow")
		defer srv.Close()
		if githubTokenIsPublicSafe(srv.URL, "ghp_priv", client) {
			t.Fatal("repo-scope token must be flagged unsafe")
		}
	})

	t.Run("unreachable probe fails open (kept)", func(t *testing.T) {
		// A base that immediately refuses/closes → Do errors → safe=true (leave the
		// token; don't knock out the rate-limit lift over a transient blip).
		if !githubTokenIsPublicSafe("http://127.0.0.1:1", "ghp_x", &http.Client{Timeout: 200 * time.Millisecond}) {
			t.Fatal("an unverifiable token should be left in place (fail-open on availability)")
		}
	})
}
