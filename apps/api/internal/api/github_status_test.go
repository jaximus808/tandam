package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// TDM-45 — the read-only GitHub status proxy. Three things are defended here:
//
//  1. THE FENCE. Read-only is a charter commitment, not a habit: the route is
//     GET-only and every outbound request is a GET to api.github.com. Both are
//     asserted mechanically (route walk / recording fake) rather than by reading
//     the code, so a later "just one webhook registration" can't slip in.
//  2. THE RATE LIMIT. Unauthenticated GitHub allows 60 requests/hour for the
//     whole server, so the cache is correctness, not speed. It's tested with a
//     fake clock — a sleeping test would be slow AND flaky.
//  3. THE NORMALIZER. A merged PR, a red build and a draft must map onto states
//     the board can colour, from real GitHub response shapes.
//
// NOTHING HERE TOUCHES THE NETWORK: every test points the client at an httptest
// server. A test that called api.github.com would burn the same 60/hour budget
// production runs on, and fail in CI the moment it ran twice.

// ── Fake GitHub ──────────────────────────────────────────────────────────────

// fakeGitHub records every request it receives, so the tests can assert the
// method, the path, and — the point of the cache tests — how MANY landed.
type fakeGitHub struct {
	srv *httptest.Server

	mu       sync.Mutex
	requests []*http.Request
	// routes maps a path to its canned response.
	routes map[string]fakeGitHubResponse
}

type fakeGitHubResponse struct {
	code int
	body string
}

func newFakeGitHub(t *testing.T, routes map[string]fakeGitHubResponse) *fakeGitHub {
	t.Helper()
	f := &fakeGitHub{routes: routes}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.requests = append(f.requests, r.Clone(context.Background()))
		res, ok := f.routes[r.URL.Path]
		f.mu.Unlock()
		if !ok {
			http.Error(w, `{"message":"Not Found"}`, http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(res.code)
		w.Write([]byte(res.body))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGitHub) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func (f *fakeGitHub) methods() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.requests))
	for _, r := range f.requests {
		out = append(out, r.Method)
	}
	return out
}

// clientFor builds a githubClient pointed at the fake, with an injected clock.
func (f *fakeGitHub) clientFor(now func() time.Time) *githubClient {
	c := newGitHubClient()
	c.base = f.srv.URL
	c.token = ""
	c.cache = newTTLCache(githubCacheTTL, githubCacheMax, now)
	return c
}

// ── Fixtures: real GitHub response shapes, trimmed to the fields we read ─────

const (
	fixtureMergedPR = `{
	  "number": 12, "title": "Add the status proxy", "state": "closed",
	  "draft": false, "merged": true, "merged_at": "2026-07-20T10:00:00Z",
	  "head": {"sha": "b7f1a2c3d4e5f60718293a4b5c6d7e8f90112233"}
	}`
	fixtureOpenPR = `{
	  "number": 13, "title": "Wire the board chips", "state": "open",
	  "draft": false, "merged": false,
	  "head": {"sha": "aa11bb22cc33dd44ee55ff6677889900aabbccdd"}
	}`
	fixtureDraftPR = `{
	  "number": 14, "title": "Spike: fleet metrics", "state": "open",
	  "draft": true, "merged": false, "head": {"sha": "0f0f0f0f0f0f0f0f"}
	}`
	fixtureClosedPR = `{
	  "number": 15, "title": "Abandoned approach", "state": "closed",
	  "draft": false, "merged": false, "head": {"sha": "1a1a1a1a1a1a1a1a"}
	}`
	fixtureStatusSuccess = `{"state":"success","total_count":2,"sha":"b7f1a2c","statuses":[{"state":"success"}]}`
	fixtureStatusFailure = `{"state":"failure","total_count":3,"sha":"aa11bb2","statuses":[{"state":"failure"}]}`
	fixtureStatusPending = `{"state":"pending","total_count":1,"sha":"aa11bb2","statuses":[{"state":"pending"}]}`
	// GitHub reports a commit with NO configured checks as pending/total_count 0.
	fixtureStatusNone = `{"state":"pending","total_count":0,"sha":"deadbee","statuses":[]}`
	fixtureBranch     = `{"name":"main","commit":{"sha":"b7f1a2c3","commit":{"message":"fix(web): board chips\n\nlonger body"}}}`
)

// ── Parsing ──────────────────────────────────────────────────────────────────

func TestParseGitHubRef(t *testing.T) {
	tests := []struct {
		name      string
		url       string
		wantKind  githubRefKind
		wantRef   string
		wantOwner string
		wantRepo  string
		wantErr   string
	}{
		{
			name: "commit", url: "https://github.com/jaximus808/tandam/commit/B7F1A2C3D4E5",
			wantKind: refCommit, wantOwner: "jaximus808", wantRepo: "tandam", wantRef: "b7f1a2c3d4e5",
		},
		{
			name: "commit with trailing segments", url: "https://github.com/o/r/commit/abc1234#diff-9",
			wantKind: refCommit, wantOwner: "o", wantRepo: "r", wantRef: "abc1234",
		},
		{
			name: "commits/<sha> is a commit", url: "https://github.com/o/r/commits/abc1234def",
			wantKind: refCommit, wantOwner: "o", wantRepo: "r", wantRef: "abc1234def",
		},
		{
			name: "pull request", url: "https://github.com/o/r/pull/123",
			wantKind: refPR, wantOwner: "o", wantRepo: "r", wantRef: "123",
		},
		{
			name: "pull request with /files", url: "https://github.com/o/r/pull/123/files",
			wantKind: refPR, wantRef: "123", wantOwner: "o", wantRepo: "r",
		},
		{
			name: "branch via tree", url: "https://github.com/o/r/tree/main",
			wantKind: refBranch, wantOwner: "o", wantRepo: "r", wantRef: "main",
		},
		{
			name: "branch with a slash in the name", url: "https://github.com/o/r/tree/feature/tdm-45",
			wantKind: refBranch, wantOwner: "o", wantRepo: "r", wantRef: "feature/tdm-45",
		},
		{
			name: "commits/<name> is a branch", url: "https://github.com/o/r/commits/release-2",
			wantKind: refBranch, wantOwner: "o", wantRepo: "r", wantRef: "release-2",
		},
		{
			name: "www host is still github", url: "https://WWW.GitHub.com/o/r/pull/7",
			wantKind: refPR, wantOwner: "o", wantRepo: "r", wantRef: "7",
		},
		{
			name: "repo suffix is trimmed", url: "https://github.com/o/r.git/pull/7",
			wantKind: refPR, wantOwner: "o", wantRepo: "r", wantRef: "7",
		},
		// ── Rejections ──
		{name: "empty", url: "", wantErr: "github.com"},
		{name: "not github", url: "https://gitlab.com/o/r/merge_requests/3", wantErr: "only github.com"},
		{
			name: "lookalike host", url: "https://github.com.evil.example/o/r/pull/1",
			wantErr: "only github.com",
		},
		{name: "not http(s)", url: "ftp://github.com/o/r/pull/1", wantErr: "http(s)"},
		{name: "bare repo", url: "https://github.com/o/r", wantErr: "no status"},
		{name: "issue", url: "https://github.com/o/r/issues/12", wantErr: "only commit"},
		{name: "release", url: "https://github.com/o/r/releases/tag/v1", wantErr: "only commit"},
		{name: "pr without a number", url: "https://github.com/o/r/pull/abc", wantErr: "PR number"},
		{name: "commit without a sha", url: "https://github.com/o/r/commit/HEAD", wantErr: "commit sha"},
		{name: "bad owner", url: "https://github.com/o$$/r/pull/1", wantErr: "owner/repo"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseGitHubRef(tt.url)
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("parseGitHubRef(%q) = %+v, want an error", tt.url, got)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error %q does not mention %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseGitHubRef(%q): %v", tt.url, err)
			}
			if got.Kind != tt.wantKind || got.Owner != tt.wantOwner || got.Repo != tt.wantRepo || got.Ref != tt.wantRef {
				t.Fatalf("got %+v, want kind=%s %s/%s@%s", got, tt.wantKind, tt.wantOwner, tt.wantRepo, tt.wantRef)
			}
			// The echoed URL is REBUILT from the parsed parts, so nothing the
			// caller sent (fragments, query, casing) is reflected back.
			if !strings.HasPrefix(got.URL, "https://github.com/"+tt.wantOwner+"/"+tt.wantRepo+"/") {
				t.Fatalf("canonical url %q is not rebuilt from the parsed parts", got.URL)
			}
		})
	}
}

// An over-long URL is rejected before anything tries to parse it.
func TestParseGitHubRefLengthCap(t *testing.T) {
	long := "https://github.com/o/r/tree/" + strings.Repeat("a", githubMaxURLLen)
	if _, err := parseGitHubRef(long); err == nil {
		t.Fatal("expected an over-long url to be rejected")
	}
}

// The endpoint a ref resolves to is the ONE api.github.com path it may cost.
func TestGitHubRefEndpoint(t *testing.T) {
	cases := map[string]string{
		"https://github.com/o/r/commit/abc1234":      "/repos/o/r/commits/abc1234/status",
		"https://github.com/o/r/pull/42":             "/repos/o/r/pulls/42",
		"https://github.com/o/r/tree/main":           "/repos/o/r/branches/main",
		"https://github.com/o/r/tree/feature/tdm-45": "/repos/o/r/branches/feature/tdm-45",
	}
	for in, want := range cases {
		ref, err := parseGitHubRef(in)
		if err != nil {
			t.Fatalf("parse %q: %v", in, err)
		}
		if got := ref.endpoint(); got != want {
			t.Errorf("endpoint(%q) = %q, want %q", in, got, want)
		}
	}
}

// ── Normalizing ──────────────────────────────────────────────────────────────

func TestNormalizeFromFixtures(t *testing.T) {
	prRef, _ := parseGitHubRef("https://github.com/o/r/pull/12")
	commitRef, _ := parseGitHubRef("https://github.com/o/r/commit/b7f1a2c")
	branchRef, _ := parseGitHubRef("https://github.com/o/r/tree/main")

	tests := []struct {
		name       string
		got        fetchResult
		wantState  string
		wantChecks string
		wantTitle  string
	}{
		{"merged pr", normalizePR(prRef, []byte(fixtureMergedPR)), "merged", "", "Add the status proxy"},
		{"open pr", normalizePR(prRef, []byte(fixtureOpenPR)), "open", "", "Wire the board chips"},
		{"draft pr", normalizePR(prRef, []byte(fixtureDraftPR)), "draft", "", "Spike: fleet metrics"},
		{"closed unmerged pr", normalizePR(prRef, []byte(fixtureClosedPR)), "closed", "", "Abandoned approach"},
		{"green commit", normalizeCommitStatus(commitRef, []byte(fixtureStatusSuccess)), "ok", "pass", ""},
		{"red commit", normalizeCommitStatus(commitRef, []byte(fixtureStatusFailure)), "failure", "fail", ""},
		{"running commit", normalizeCommitStatus(commitRef, []byte(fixtureStatusPending)), "pending", "pending", ""},
		// No checks configured is NOT "pending forever" — see normalizeCommitStatus.
		{"commit with no checks", normalizeCommitStatus(commitRef, []byte(fixtureStatusNone)), "ok", "", ""},
		{"branch", normalizeBranch(branchRef, []byte(fixtureBranch)), "ok", "", "fix(web): board chips"},
		{"garbage json", normalizePR(prRef, []byte("<html>nope")), "unknown", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.got.State != tt.wantState {
				t.Errorf("state = %q, want %q", tt.got.State, tt.wantState)
			}
			if tt.got.Checks != tt.wantChecks {
				t.Errorf("checks = %q, want %q", tt.got.Checks, tt.wantChecks)
			}
			if tt.got.Title != tt.wantTitle {
				t.Errorf("title = %q, want %q", tt.got.Title, tt.wantTitle)
			}
			if tt.got.URL == "" {
				t.Error("url must always be echoed back")
			}
		})
	}
}

// A commit subject is one line and bounded — a 4KB commit body must not ride
// into every board render.
func TestCommitSubject(t *testing.T) {
	if got := commitSubject("  feat: thing\n\nbody\n"); got != "feat: thing" {
		t.Errorf("commitSubject = %q", got)
	}
	long := commitSubject(strings.Repeat("x", 400))
	if len([]rune(long)) > 121 {
		t.Errorf("commitSubject not clipped: %d runes", len([]rune(long)))
	}
}

// ── Fetching ─────────────────────────────────────────────────────────────────

// An OPEN PR costs a second call — for its checks, the question a green/red dot
// on an open PR actually answers. A red build escalates the STATE, so the board
// needs no extra vocabulary to colour it.
func TestOpenPRPicksUpRedChecks(t *testing.T) {
	gh := newFakeGitHub(t, map[string]fakeGitHubResponse{
		"/repos/o/r/pulls/13": {http.StatusOK, fixtureOpenPR},
		"/repos/o/r/commits/aa11bb22cc33dd44ee55ff6677889900aabbccdd/status": {http.StatusOK, fixtureStatusFailure},
	})
	c := gh.clientFor(time.Now)
	ref, _ := parseGitHubRef("https://github.com/o/r/pull/13")

	got := c.status(context.Background(), ref)
	if got.State != "failure" || got.Checks != "fail" {
		t.Fatalf("open PR with red checks = %+v, want state failure / checks fail", got)
	}
	if gh.calls() != 2 {
		t.Fatalf("open PR cost %d calls, want exactly 2 (the PR + its checks)", gh.calls())
	}
}

// A MERGED PR is settled history: no follow-up call, no checks. This is the
// rate-limit rule in test form.
func TestMergedPRCostsOneCall(t *testing.T) {
	gh := newFakeGitHub(t, map[string]fakeGitHubResponse{
		"/repos/o/r/pulls/12": {http.StatusOK, fixtureMergedPR},
	})
	c := gh.clientFor(time.Now)
	ref, _ := parseGitHubRef("https://github.com/o/r/pull/12")

	got := c.status(context.Background(), ref)
	if got.State != "merged" {
		t.Fatalf("state = %q, want merged", got.State)
	}
	if gh.calls() != 1 {
		t.Fatalf("merged PR cost %d calls, want 1", gh.calls())
	}
}

// Upstream failures degrade; they never surface as an error to the board.
func TestFetchFailuresDegradeToUnknown(t *testing.T) {
	tests := []struct {
		name       string
		code       int
		wantReason string
	}{
		{"deleted or private", http.StatusNotFound, "not_found"},
		{"rate limited", http.StatusForbidden, "rate_limited"},
		{"too many requests", http.StatusTooManyRequests, "rate_limited"},
		{"github is having a day", http.StatusInternalServerError, "unavailable"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gh := newFakeGitHub(t, map[string]fakeGitHubResponse{
				"/repos/o/r/pulls/9": {tt.code, `{"message":"nope"}`},
			})
			c := gh.clientFor(time.Now)
			ref, _ := parseGitHubRef("https://github.com/o/r/pull/9")
			got := c.status(context.Background(), ref)
			if got.State != "unknown" || got.Reason != tt.wantReason {
				t.Fatalf("got %+v, want unknown/%s", got, tt.wantReason)
			}
			if got.URL == "" {
				t.Error("an unknown still identifies the link it is about")
			}
		})
	}
}

// ── Cache ────────────────────────────────────────────────────────────────────

// The cache is the rate limit's only defence, so its behaviour is pinned with a
// fake clock rather than a sleep: hits inside the TTL cost nothing, the first
// call after it goes back to GitHub.
func TestStatusCacheHonoursTTL(t *testing.T) {
	gh := newFakeGitHub(t, map[string]fakeGitHubResponse{
		"/repos/o/r/pulls/12": {http.StatusOK, fixtureMergedPR},
	})
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	c := gh.clientFor(func() time.Time { return now })
	ref, _ := parseGitHubRef("https://github.com/o/r/pull/12")

	for i := 0; i < 5; i++ {
		if got := c.status(context.Background(), ref); got.State != "merged" {
			t.Fatalf("call %d: state = %q", i, got.State)
		}
	}
	if gh.calls() != 1 {
		t.Fatalf("%d upstream calls inside the TTL, want 1", gh.calls())
	}

	// Two different URLs for the SAME ref share the entry (the key is the ref).
	alias, _ := parseGitHubRef("https://github.com/o/r/pull/12/files")
	c.status(context.Background(), alias)
	if gh.calls() != 1 {
		t.Fatalf("an alias URL cost another call (%d) — the key is not the ref", gh.calls())
	}

	now = now.Add(githubCacheTTL + time.Second)
	c.status(context.Background(), ref)
	if gh.calls() != 2 {
		t.Fatalf("after the TTL: %d calls, want 2", gh.calls())
	}
}

// Unknowns are cached too — a rate-limited board must not spend the rest of its
// budget rediscovering that it is rate-limited.
func TestUnknownsAreCached(t *testing.T) {
	gh := newFakeGitHub(t, map[string]fakeGitHubResponse{
		"/repos/o/r/pulls/9": {http.StatusForbidden, `{"message":"rate limit"}`},
	})
	now := time.Now()
	c := gh.clientFor(func() time.Time { return now })
	ref, _ := parseGitHubRef("https://github.com/o/r/pull/9")
	for i := 0; i < 4; i++ {
		c.status(context.Background(), ref)
	}
	if gh.calls() != 1 {
		t.Fatalf("%d calls for a repeated failure, want 1", gh.calls())
	}
}

// The cap bounds memory; entries beyond it are evicted rather than accumulated.
func TestCacheEvictsAtCapacity(t *testing.T) {
	now := time.Now()
	c := newTTLCache(time.Minute, 4, func() time.Time { return now })
	for i := 0; i < 20; i++ {
		c.put(string(rune('a'+i)), githubStatus{State: "ok"})
	}
	c.mu.Lock()
	n := len(c.entries)
	c.mu.Unlock()
	if n > 4 {
		t.Fatalf("cache holds %d entries, cap is 4", n)
	}
}

func TestCacheExpiryIsExclusive(t *testing.T) {
	now := time.Now()
	c := newTTLCache(time.Minute, 8, func() time.Time { return now })
	c.put("k", githubStatus{State: "ok"})
	now = now.Add(time.Minute)
	if _, ok := c.get("k"); ok {
		t.Fatal("an entry exactly at its expiry must be a miss")
	}
}

// ── Handler ──────────────────────────────────────────────────────────────────

func githubStatusRequest(t *testing.T, canvasID uuid.UUID, rawURL string) *http.Request {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/canvas/github/status?url="+rawURL, nil)
	ctx := context.WithValue(r.Context(), claimsKey, &auth.Claims{CanvasID: canvasID, Role: "read"})
	return r.WithContext(ctx)
}

func TestGetGitHubStatusHandler(t *testing.T) {
	gh := newFakeGitHub(t, map[string]fakeGitHubResponse{
		"/repos/o/r/pulls/12": {http.StatusOK, fixtureMergedPR},
	})
	h := NewHandler(nil, nil, nil)
	h.github = gh.clientFor(time.Now)

	w := httptest.NewRecorder()
	h.GetGitHubStatus(w, githubStatusRequest(t, uuid.New(), "https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F12"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got githubStatus
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("response is not JSON: %s", w.Body)
	}
	if got.Kind != "pr" || got.State != "merged" || got.Title != "Add the status proxy" {
		t.Fatalf("got %+v, want a merged pr", got)
	}
	if got.URL != "https://github.com/o/r/pull/12" {
		t.Fatalf("url = %q", got.URL)
	}
}

// A URL this endpoint cannot address is the ONLY 400 — everything else degrades
// to a 200 unknown so a card never sprouts an error because GitHub blinked.
func TestGetGitHubStatusRejectsUnaddressableURLs(t *testing.T) {
	h := NewHandler(nil, nil, nil)
	h.github = newFakeGitHub(t, nil).clientFor(time.Now)

	for _, raw := range []string{
		"", // no url at all
		"https%3A%2F%2Fgitlab.com%2Fo%2Fr%2Fcommit%2Fabc1234",
		"https%3A%2F%2Fexample.com%2Fanything",
		"https%3A%2F%2Fgithub.com%2Fo%2Fr", // a repo has no status
		"file%3A%2F%2F%2Fetc%2Fpasswd",
	} {
		w := httptest.NewRecorder()
		h.GetGitHubStatus(w, githubStatusRequest(t, uuid.New(), raw))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("url=%q gave %d, want 400: %s", raw, w.Code, w.Body)
		}
		var body map[string]string
		json.Unmarshal(w.Body.Bytes(), &body)
		if body["error"] != "invalid_url" || body["message"] == "" {
			t.Fatalf("url=%q: error body %v lacks a code or a next step", raw, body)
		}
	}
}

func TestGetGitHubStatusUpstreamDownIsATwoHundred(t *testing.T) {
	gh := newFakeGitHub(t, nil) // every path 404s
	h := NewHandler(nil, nil, nil)
	h.github = gh.clientFor(time.Now)

	w := httptest.NewRecorder()
	h.GetGitHubStatus(w, githubStatusRequest(t, uuid.New(), "https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F404"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (a missing ref is not a board error)", w.Code)
	}
	var got githubStatus
	json.Unmarshal(w.Body.Bytes(), &got)
	if got.State != "unknown" || got.Reason != "not_found" {
		t.Fatalf("got %+v, want unknown/not_found", got)
	}
}

// ── The fence ────────────────────────────────────────────────────────────────

// READ-ONLY, asserted at the router: the GitHub surface is one GET. If anyone
// ever registers a POST/PATCH/DELETE under it — a "sync back", a webhook
// registration — this fails, which is the whole point of pinning it.
func TestGitHubStatusRouteIsGetOnly(t *testing.T) {
	r := NewRouter(nil, nil, auth.NewService("test-secret-for-tdm-45", time.Hour), nil, false, nil, "", t.TempDir(), "", nil, nil)
	mux, ok := r.(*chi.Mux)
	if !ok {
		t.Fatal("NewRouter no longer returns a *chi.Mux; this route-walk test needs updating")
	}
	seen := map[string]bool{}
	err := chi.Walk(mux, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if strings.Contains(strings.ToLower(route), "github") {
			seen[method+" "+route] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	for r := range seen {
		if !strings.HasPrefix(r, "GET ") {
			t.Errorf("%s is a non-GET github route — the charter fence is read-only", r)
		}
	}
	if !seen["GET /api/canvas/github/status"] {
		t.Errorf("the status route is missing; found %v", seen)
	}
}

// And read-only OUTBOUND: whatever the proxy is asked for, every request it
// makes to GitHub is a GET. A write would need a method this test would catch.
func TestOutboundRequestsAreAllGET(t *testing.T) {
	gh := newFakeGitHub(t, map[string]fakeGitHubResponse{
		"/repos/o/r/pulls/13": {http.StatusOK, fixtureOpenPR},
		"/repos/o/r/commits/aa11bb22cc33dd44ee55ff6677889900aabbccdd/status": {http.StatusOK, fixtureStatusSuccess},
		"/repos/o/r/commits/abc1234/status":                                  {http.StatusOK, fixtureStatusSuccess},
		"/repos/o/r/branches/main":                                           {http.StatusOK, fixtureBranch},
	})
	c := gh.clientFor(time.Now)
	for _, raw := range []string{
		"https://github.com/o/r/pull/13",
		"https://github.com/o/r/commit/abc1234",
		"https://github.com/o/r/tree/main",
	} {
		ref, err := parseGitHubRef(raw)
		if err != nil {
			t.Fatalf("parse %q: %v", raw, err)
		}
		c.status(context.Background(), ref)
	}
	if gh.calls() == 0 {
		t.Fatal("no upstream calls were recorded — the assertion below would be vacuous")
	}
	for _, m := range gh.methods() {
		if m != http.MethodGet {
			t.Errorf("outbound %s request — this proxy may only read", m)
		}
	}
}

// The token is a rate-limit lift and nothing else: present it is sent, absent
// nothing is. (Scope is GitHub's business; ours is never to write.)
func TestTokenIsSentOnlyWhenConfigured(t *testing.T) {
	gh := newFakeGitHub(t, map[string]fakeGitHubResponse{
		"/repos/o/r/pulls/12": {http.StatusOK, fixtureMergedPR},
	})
	ref, _ := parseGitHubRef("https://github.com/o/r/pull/12")

	anon := gh.clientFor(time.Now)
	anon.status(context.Background(), ref)

	withToken := gh.clientFor(time.Now)
	withToken.token = "ghp_example"
	withToken.status(context.Background(), ref)

	gh.mu.Lock()
	defer gh.mu.Unlock()
	if len(gh.requests) != 2 {
		t.Fatalf("expected 2 requests, got %d", len(gh.requests))
	}
	if got := gh.requests[0].Header.Get("Authorization"); got != "" {
		t.Errorf("unauthenticated client sent Authorization %q", got)
	}
	if got := gh.requests[1].Header.Get("Authorization"); got != "Bearer ghp_example" {
		t.Errorf("token client sent Authorization %q", got)
	}
	// GitHub rejects a request with no User-Agent, so both must carry one.
	for i, req := range gh.requests {
		if req.Header.Get("User-Agent") == "" {
			t.Errorf("request %d has no User-Agent", i)
		}
	}
}
