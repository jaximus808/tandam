package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// GitHub ground truth (TDM-45) — the board reads the state of the work an agent
// says it did, from the place that actually knows.
//
// A completion report carries evidence links (payload.links[], written by the
// inbound status API and by task_complete). A link is a claim; this endpoint
// turns it into a fact: is that PR merged, did the checks go red, does the
// branch still exist. The board renders it as one small dot on the link chip.
//
// ── THE FENCE (charter) ──────────────────────────────────────────────────────
// READ-ONLY, and structurally so:
//
//   - the only route is r.Get(…/github/status) — there is no POST/PATCH/DELETE
//     handler in this file to register (TestGitHubStatusRouteIsGetOnly walks the
//     router and pins it);
//   - every outbound request this file can build is http.MethodGet, to a URL we
//     construct ourselves from a parsed owner/repo/ref against api.github.com
//     (githubRef.endpoint) — the caller's URL is never dereferenced, so there is
//     no SSRF surface here at all and no user-controlled host;
//   - GH_STATUS_TOKEN, when set, is used ONLY as a rate-limit lift. Nothing here
//     writes to GitHub: no comment, no status, no webhook registration, no
//     dispatch. This is not a sync engine and must not become one — Tandem does
//     not own anything in GitHub, it reads.
//
// ── CONFIDENTIALITY: the token must be PUBLIC-SCOPE (TDM-140) ──────────────────
// The lookups this file serves are cached PROCESS-WIDE (keyed by owner/repo/ref,
// not by canvas or viewer) and any board can query any URL. That is fine for
// PUBLIC ground truth — but a classic PAT carrying `repo` (or `repo:status`)
// scope also grants PRIVATE-repo read, which would turn this into a way for any
// viewer on any canvas to pull a private repo's PR title / CI state via the
// server's token. So the token is VETTED at startup (VetGitHubTokenEnv): a
// private-capable classic token is dropped, and the proxy runs unauthenticated
// (public repos only) rather than leak. Deploy a public-scope token (public_repo,
// or a fine-grained token restricted to public repos) to keep the rate-limit lift.
//
// ── RATE LIMIT ───────────────────────────────────────────────────────────────
// Unauthenticated api.github.com allows 60 requests/hour PER IP — for the whole
// server, not per canvas. That number is the reason the cache below exists and
// is load-bearing rather than an optimisation: a board with six evidence links
// open in three tabs would exhaust an hour's budget in a minute without it.
// Hence also the strict one-call-per-ref rule (see githubRef.endpoint) and the
// single extra call for an OPEN pr's checks. With GH_STATUS_TOKEN set the ceiling
// is 5,000/hour and the cache merely stops being critical.
//
// Being rate-limited is NOT an error the board should shout about: the lookup
// degrades to {state:"unknown", reason:"rate_limited"} and the chip simply shows
// no dot. A link with an unknown status must read exactly like a link nobody
// asked about — see the UI note in TaskLinks.tsx.

const (
	githubAPIDefaultBase = "https://api.github.com"
	// One minute is short enough that a merge shows up while the human is still
	// looking at the board, and long enough that a re-render, a tab switch, or a
	// second viewer costs nothing.
	githubCacheTTL = 60 * time.Second
	// Bounded so a canvas with hundreds of distinct links can't grow the process
	// heap; oldest-expiry-first eviction, which for a uniform TTL is FIFO.
	githubCacheMax    = 512
	githubHTTPTimeout = 6 * time.Second
	githubMaxBody     = 1 << 20 // 1 MiB — a PR body is the largest thing we read
	githubMaxURLLen   = 2048
)

// ── The normalized answer ────────────────────────────────────────────────────

// githubStatus is the compact shape the board renders. Deliberately small: the
// UI needs a dot, a tooltip, and nothing else. Everything optional is omitted
// rather than sent empty, so an unknown reads as an absence on the wire too.
type githubStatus struct {
	// commit | pr | branch
	Kind string `json:"kind"`
	// merged | open | closed | draft | ok | failure | pending | unknown
	State string `json:"state"`
	Title string `json:"title,omitempty"`
	// pass | fail | pending — only when the ref actually has checks.
	Checks string `json:"checks,omitempty"`
	URL    string `json:"url"`
	// Why the state is unknown: not_found | rate_limited | unavailable. Present
	// ONLY with state "unknown"; it drives tooltip copy, never a colour.
	Reason string `json:"reason,omitempty"`
}

// GetGitHubStatus handles GET /api/canvas/github/status?url=<github url>.
//
// Canvas-JWT read auth (any role) — the same credential the board already holds
// for GET /api/canvas/state, because this is a read that only makes sense while
// looking at a board.
//
// 400 only for a URL this endpoint cannot address: not github.com, or a github
// path that isn't a commit / PR / branch. EVERYTHING ELSE IS A 200 with
// state "unknown": GitHub being down, slow, or rate-limiting is a fact about
// GitHub, not a failure of the board, and a card must not sprout an error
// because a lookup missed.
func (h *Handler) GetGitHubStatus(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimSpace(r.URL.Query().Get("url"))
	ref, err := parseGitHubRef(raw)
	if err != nil {
		writeTaskStatusError(w, http.StatusBadRequest, "invalid_url", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, h.githubClient().status(r.Context(), ref))
}

// githubClient returns the handler's client, defaulting a nil one so a Handler
// built without the option (every existing test) still answers.
func (h *Handler) githubClient() *githubClient {
	if h.github == nil {
		h.github = newGitHubClient()
	}
	return h.github
}

// ── Parsing ──────────────────────────────────────────────────────────────────

type githubRefKind string

const (
	refCommit githubRefKind = "commit"
	refPR     githubRefKind = "pr"
	refBranch githubRefKind = "branch"
)

// githubRef is a parsed github.com URL: the pieces needed to build an
// api.github.com path, and nothing from the caller's string beyond them.
type githubRef struct {
	Kind  githubRefKind
	Owner string
	Repo  string
	// The sha (commit), the PR number as text (pr), or the branch name (branch).
	Ref string
	// The canonical github.com URL, rebuilt from the parsed parts — what the
	// response echoes back, so nothing the caller sent is reflected verbatim.
	URL string
}

var (
	// GitHub's own rules, conservatively: owners and repos are alphanumerics
	// plus - _ . and nothing else. This is also what keeps the constructed API
	// path free of traversal or query injection.
	githubNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)
	githubShaRe  = regexp.MustCompile(`^[0-9a-fA-F]{7,40}$`)
)

// parseGitHubRef turns a github.com URL into an addressable ref.
//
// Accepted forms (trailing segments — /files, .diff-style suffixes, anchors —
// are ignored):
//
//	https://github.com/{owner}/{repo}/commit/{sha}
//	https://github.com/{owner}/{repo}/commits/{sha}      (same thing)
//	https://github.com/{owner}/{repo}/pull/{number}
//	https://github.com/{owner}/{repo}/tree/{branch}
//	https://github.com/{owner}/{repo}/commits/{branch}   (branch, not a sha)
//
// Anything else — another host, a bare repo, an issue, a release — is an error,
// and the caller renders that link as a plain link with no status.
func parseGitHubRef(raw string) (githubRef, error) {
	if raw == "" {
		return githubRef{}, errors.New("pass ?url= a github.com commit, pull request, or branch URL")
	}
	if len(raw) > githubMaxURLLen {
		return githubRef{}, fmt.Errorf("url must be at most %d characters", githubMaxURLLen)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return githubRef{}, errors.New("url is not a valid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return githubRef{}, errors.New("url must be http(s)")
	}
	host := strings.ToLower(u.Hostname())
	if host != "github.com" && host != "www.github.com" {
		// The fence, stated where a caller will read it: this endpoint talks to
		// exactly one upstream, so it can never be pointed at anything else.
		return githubRef{}, errors.New("only github.com links have a status here")
	}
	segs := strings.Split(strings.Trim(u.EscapedPath(), "/"), "/")
	for i, s := range segs {
		if d, derr := url.PathUnescape(s); derr == nil {
			segs[i] = d
		}
	}
	if len(segs) < 4 {
		return githubRef{}, errors.New("link a commit, pull request, or branch — a repo URL has no status")
	}
	owner, repo := segs[0], strings.TrimSuffix(segs[1], ".git")
	if !githubNameRe.MatchString(owner) || !githubNameRe.MatchString(repo) {
		return githubRef{}, errors.New("that doesn't look like an owner/repo path")
	}

	switch segs[2] {
	case "commit":
		if !githubShaRe.MatchString(segs[3]) {
			return githubRef{}, errors.New("commit link must end in a commit sha")
		}
		return mkRef(refCommit, owner, repo, strings.ToLower(segs[3])), nil
	case "commits":
		// /commits/<sha> is a commit; /commits/<name> is that branch's history.
		if githubShaRe.MatchString(segs[3]) {
			return mkRef(refCommit, owner, repo, strings.ToLower(segs[3])), nil
		}
		return branchRef(owner, repo, segs[3:])
	case "pull", "pulls":
		n, cerr := strconv.Atoi(segs[3])
		if cerr != nil || n <= 0 {
			return githubRef{}, errors.New("pull request link must end in a PR number")
		}
		return mkRef(refPR, owner, repo, strconv.Itoa(n)), nil
	case "tree":
		return branchRef(owner, repo, segs[3:])
	}
	return githubRef{}, errors.New("only commit, pull request, and branch links have a status")
}

// branchRef builds a branch ref from the trailing path segments.
//
// AMBIGUOUS BY CONSTRUCTION, and knowingly so: github.com/o/r/tree/main/apps/api
// is a directory inside `main`, but the URL gives us no way to tell where the
// branch name ends and the path begins (branch names contain slashes too —
// feature/foo). We join everything and let GitHub answer; a wrong guess 404s
// into state "unknown", which is exactly the "no claim" rendering. Guessing
// "the first segment" would instead confidently show a green dot for a branch
// the human never linked.
func branchRef(owner, repo string, segs []string) (githubRef, error) {
	name := strings.Join(segs, "/")
	if name == "" || len(name) > 255 || strings.Contains(name, "..") {
		return githubRef{}, errors.New("branch link must name a branch")
	}
	return mkRef(refBranch, owner, repo, name), nil
}

func mkRef(kind githubRefKind, owner, repo, ref string) githubRef {
	g := githubRef{Kind: kind, Owner: owner, Repo: repo, Ref: ref}
	switch kind {
	case refCommit:
		g.URL = fmt.Sprintf("https://github.com/%s/%s/commit/%s", owner, repo, ref)
	case refPR:
		g.URL = fmt.Sprintf("https://github.com/%s/%s/pull/%s", owner, repo, ref)
	case refBranch:
		g.URL = fmt.Sprintf("https://github.com/%s/%s/tree/%s", owner, repo, ref)
	}
	return g
}

// cacheKey identifies the ref, not the URL string: two links that differ only
// in case or a trailing /files share one upstream call.
func (g githubRef) cacheKey() string {
	return string(g.Kind) + " " + g.Owner + "/" + g.Repo + "@" + g.Ref
}

// endpoint is the ONE api.github.com path this ref costs. One ref, one request
// — the rate-limit rule stated as code (the open-PR checks call is the single
// documented exception, see status).
func (g githubRef) endpoint() string {
	o, r := url.PathEscape(g.Owner), url.PathEscape(g.Repo)
	switch g.Kind {
	case refCommit:
		// The COMBINED STATUS, not the commit itself. The commit endpoint would
		// give us a message to show but says nothing about CI, and CI is the
		// whole question a commit link raises. Fetching both would double the
		// cost of every commit chip against a 60/hour budget.
		return fmt.Sprintf("/repos/%s/%s/commits/%s/status", o, r, url.PathEscape(g.Ref))
	case refPR:
		return fmt.Sprintf("/repos/%s/%s/pulls/%s", o, r, url.PathEscape(g.Ref))
	default:
		// Branch names contain slashes; the API takes them unescaped per segment.
		segs := strings.Split(g.Ref, "/")
		for i, s := range segs {
			segs[i] = url.PathEscape(s)
		}
		return fmt.Sprintf("/repos/%s/%s/branches/%s", o, r, strings.Join(segs, "/"))
	}
}

// ── The client ───────────────────────────────────────────────────────────────

type githubClient struct {
	base  string
	token string
	http  *http.Client
	cache *ttlCache
}

// newGitHubClient builds the process-wide client. GH_STATUS_TOKEN is optional and
// read once here: with it the rate limit is 5,000/hour instead of 60, and that
// is the ONLY thing it does — see the fence note at the top of this file.
func newGitHubClient() *githubClient {
	return &githubClient{
		base:  githubAPIDefaultBase,
		token: strings.TrimSpace(os.Getenv("GH_STATUS_TOKEN")),
		http: &http.Client{
			Timeout: githubHTTPTimeout,
			// api.github.com does not redirect for these reads; a redirect would
			// mean we're being sent somewhere we didn't choose, so refuse rather
			// than follow. (No dialer guard needed: unlike the briefing import,
			// the host here is a constant, never caller-supplied.)
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		cache: newTTLCache(githubCacheTTL, githubCacheMax, time.Now),
	}
}

// VetGitHubTokenEnv enforces the status proxy's confidentiality contract at
// STARTUP (TDM-140): if the configured GH_STATUS_TOKEN can read PRIVATE repos, it is
// unset so the proxy runs unauthenticated (public repos only) rather than leak
// private-repo state cross-canvas. Call it once, before the router is built, so
// the lazily-constructed client (which reads the env) never sees a unsafe token.
//
// Best-effort: a network error verifying scopes leaves the token in place (with a
// warning) rather than knocking out the rate-limit lift over a transient blip —
// the same posture the rest of this file takes toward an unreachable GitHub.
func VetGitHubTokenEnv() {
	token := strings.TrimSpace(os.Getenv("GH_STATUS_TOKEN"))
	if token == "" {
		return
	}
	if !githubTokenIsPublicSafe(githubAPIDefaultBase, token, &http.Client{Timeout: githubHTTPTimeout}) {
		log.Printf("github_status: GH_STATUS_TOKEN grants PRIVATE-repo read — DISABLING it so private-repo " +
			"state cannot leak cross-canvas via the status proxy (TDM-140). Deploy a public-scope token " +
			"(public_repo, or a fine-grained token limited to public repos) to keep the rate-limit lift.")
		_ = os.Unsetenv("GH_STATUS_TOKEN")
	}
}

// githubTokenIsPublicSafe returns false ONLY when it can POSITIVELY confirm the
// token grants private-repo read. It probes /rate_limit (which does not itself
// count against the limit) purely to read the granted scopes from the classic
// PAT's X-OAuth-Scopes response header. A network/parse failure returns true
// (fail-open on availability, since the safe default for confidentiality is
// handled by requiring a positive private-scope signal to disable).
func githubTokenIsPublicSafe(base, token string, client *http.Client) bool {
	req, err := http.NewRequest(http.MethodGet, base+"/rate_limit", nil)
	if err != nil {
		return true
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "tandem-canvas")
	res, err := client.Do(req)
	if err != nil {
		log.Printf("github_status: could not verify GH_STATUS_TOKEN scopes (%v) — leaving it set; "+
			"ensure the deployed token is PUBLIC-scope only (TDM-140)", err)
		return true
	}
	defer res.Body.Close()
	io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	return !githubScopesGrantPrivateRead(res.Header.Get("X-OAuth-Scopes"))
}

// githubScopesGrantPrivateRead reports whether a classic PAT's X-OAuth-Scopes
// header grants read of PRIVATE repositories. `repo` is full private control and
// `repo:status` grants commit-status read on private repos too — both would let
// this proxy surface private state. `public_repo` is explicitly public-only and
// safe. A fine-grained token sends no scopes here (empty header) and is treated
// as safe: its access is constrained at creation, not advertised in this header.
func githubScopesGrantPrivateRead(header string) bool {
	for _, s := range strings.Split(header, ",") {
		s = strings.TrimSpace(s)
		if s == "repo" || strings.HasPrefix(s, "repo:") {
			return true
		}
	}
	return false
}

// status resolves a ref, serving from cache when it can.
//
// Never returns an error: every failure mode is a githubStatus with
// state "unknown" and a reason. Unknowns are cached too — that is what keeps a
// rate-limited or repeatedly-404ing board from spending its whole budget
// rediscovering the same "no".
func (c *githubClient) status(ctx context.Context, ref githubRef) githubStatus {
	key := ref.cacheKey()
	if hit, ok := c.cache.get(key); ok {
		return hit
	}
	out := c.fetch(ctx, ref)
	// An OPEN pr is the one ref worth a second call: its state ("open") is not
	// the question anyone actually has — "are the checks green?" is. Merged and
	// closed PRs are settled history and get no extra request.
	if ref.Kind == refPR && out.State == "open" && out.headSHA != "" {
		if checks, ok := c.combinedStatus(ctx, ref.Owner, ref.Repo, out.headSHA); ok {
			out.Checks = checks.Checks
			if checks.Checks == "fail" {
				// A red PR is the one thing on this board worth escalating: the
				// state carries it so the chip can go rose without the UI having
				// to know about `checks`.
				out.State = "failure"
			}
		}
	}
	c.cache.put(key, out.githubStatus)
	return out.githubStatus
}

// fetchResult is githubStatus plus the head sha, which the PR path needs for
// its follow-up call and no caller outside this file ever sees.
type fetchResult struct {
	githubStatus
	headSHA string
}

func unknownStatus(ref githubRef, reason string) fetchResult {
	return fetchResult{githubStatus: githubStatus{
		Kind: string(ref.Kind), State: "unknown", URL: ref.URL, Reason: reason,
	}}
}

func (c *githubClient) fetch(ctx context.Context, ref githubRef) fetchResult {
	body, err := c.get(ctx, ref.endpoint())
	if err != nil {
		return unknownStatus(ref, reasonFor(err))
	}
	switch ref.Kind {
	case refPR:
		return normalizePR(ref, body)
	case refCommit:
		return normalizeCommitStatus(ref, body)
	default:
		return normalizeBranch(ref, body)
	}
}

// combinedStatus is the shared "did CI pass for this sha" read.
func (c *githubClient) combinedStatus(ctx context.Context, owner, repo, sha string) (githubStatus, bool) {
	body, err := c.get(ctx, fmt.Sprintf("/repos/%s/%s/commits/%s/status",
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(sha)))
	if err != nil {
		return githubStatus{}, false
	}
	res := normalizeCommitStatus(githubRef{Kind: refCommit, Owner: owner, Repo: repo, Ref: sha}, body)
	return res.githubStatus, true
}

// githubHTTPError carries the upstream status code so reasonFor can tell a
// missing ref from a spent rate limit.
type githubHTTPError struct{ code int }

func (e *githubHTTPError) Error() string { return "github responded " + strconv.Itoa(e.code) }

func reasonFor(err error) string {
	var he *githubHTTPError
	if errors.As(err, &he) {
		switch {
		case he.code == http.StatusNotFound:
			return "not_found"
		case he.code == http.StatusForbidden || he.code == http.StatusTooManyRequests:
			// GitHub answers 403 (classic) or 429 for an exhausted limit; both
			// mean "ask again later", which is a different sentence from "gone".
			return "rate_limited"
		}
	}
	return "unavailable"
}

// get performs the ONLY kind of request this file makes: a GET to a path we
// built, on the configured base (api.github.com in production, an httptest
// server in the tests — nothing here ever calls the real GitHub from a test).
func (c *githubClient) get(ctx context.Context, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	// GitHub rejects requests with no User-Agent.
	req.Header.Set("User-Agent", "tandem-canvas")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		return nil, &githubHTTPError{code: res.StatusCode}
	}
	return io.ReadAll(io.LimitReader(res.Body, githubMaxBody))
}

// ── Normalizers ──────────────────────────────────────────────────────────────
// Each takes raw GitHub JSON and returns the compact shape. Kept as free
// functions so the fixtures in the tests exercise exactly what production runs.

func normalizePR(ref githubRef, body []byte) fetchResult {
	var pr struct {
		Title  string `json:"title"`
		State  string `json:"state"`
		Draft  bool   `json:"draft"`
		Merged bool   `json:"merged"`
		Head   struct {
			SHA string `json:"sha"`
		} `json:"head"`
	}
	if err := json.Unmarshal(body, &pr); err != nil {
		return unknownStatus(ref, "unavailable")
	}
	out := fetchResult{githubStatus: githubStatus{
		Kind: string(refPR), URL: ref.URL, Title: strings.TrimSpace(pr.Title),
	}, headSHA: pr.Head.SHA}
	switch {
	case pr.Merged:
		out.State = "merged"
	case pr.State == "closed":
		out.State = "closed"
	case pr.Draft:
		// Draft outranks open: a draft PR is explicitly not asking to be merged,
		// and saying "open" would overstate how done the work is.
		out.State = "draft"
	default:
		out.State = "open"
	}
	return out
}

func normalizeCommitStatus(ref githubRef, body []byte) fetchResult {
	var st struct {
		State      string `json:"state"`
		TotalCount int    `json:"total_count"`
		SHA        string `json:"sha"`
	}
	if err := json.Unmarshal(body, &st); err != nil {
		return unknownStatus(ref, "unavailable")
	}
	out := fetchResult{githubStatus: githubStatus{Kind: string(refCommit), URL: ref.URL}, headSHA: st.SHA}
	switch {
	case st.TotalCount == 0:
		// The commit exists (GitHub answered 200) but nothing reports on it. That
		// is "fine, no CI here" — NOT pending, which GitHub's own `state` says in
		// this case and which would leave an amber dot spinning forever.
		out.State = "ok"
	case st.State == "success":
		out.State, out.Checks = "ok", "pass"
	case st.State == "failure" || st.State == "error":
		out.State, out.Checks = "failure", "fail"
	case st.State == "pending":
		out.State, out.Checks = "pending", "pending"
	default:
		out.State = "unknown"
		out.Reason = "unavailable"
	}
	return out
}

func normalizeBranch(ref githubRef, body []byte) fetchResult {
	var br struct {
		Name   string `json:"name"`
		Commit struct {
			SHA    string `json:"sha"`
			Commit struct {
				Message string `json:"message"`
			} `json:"commit"`
		} `json:"commit"`
	}
	if err := json.Unmarshal(body, &br); err != nil {
		return unknownStatus(ref, "unavailable")
	}
	name := br.Name
	if name == "" {
		name = ref.Ref
	}
	// A branch has no verdict of its own — it exists or it doesn't. "ok" is the
	// honest reading of a 200, and the title carries the one thing worth knowing:
	// what is on the tip.
	return fetchResult{githubStatus: githubStatus{
		Kind:  string(refBranch),
		State: "ok",
		URL:   ref.URL,
		Title: commitSubject(br.Commit.Commit.Message),
	}, headSHA: br.Commit.SHA}
}

// firstLine is a commit subject: the first line, trimmed and bounded.
func commitSubject(msg string) string {
	line := strings.TrimSpace(strings.SplitN(msg, "\n", 2)[0])
	if len(line) > 120 {
		line = strings.TrimSpace(line[:120]) + "…"
	}
	return line
}

// ── Cache ────────────────────────────────────────────────────────────────────

// ttlCache is a tiny in-memory TTL map. `now` is injected so the tests can move
// time instead of sleeping, and so expiry is asserted rather than hoped for.
type ttlCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	max     int
	now     func() time.Time
	entries map[string]ttlEntry
}

type ttlEntry struct {
	value   githubStatus
	expires time.Time
}

func newTTLCache(ttl time.Duration, max int, now func() time.Time) *ttlCache {
	return &ttlCache{ttl: ttl, max: max, now: now, entries: map[string]ttlEntry{}}
}

func (c *ttlCache) get(key string) (githubStatus, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok {
		return githubStatus{}, false
	}
	if !c.now().Before(e.expires) {
		delete(c.entries, key)
		return githubStatus{}, false
	}
	return e.value, true
}

func (c *ttlCache) put(key string, v githubStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= c.max {
		c.evictLocked()
	}
	c.entries[key] = ttlEntry{value: v, expires: c.now().Add(c.ttl)}
}

// evictLocked drops everything expired, and if that freed nothing, the entry
// closest to expiring. No LRU bookkeeping: with one uniform TTL the soonest
// expiry IS the oldest write, and the cap exists to bound memory rather than to
// maximise hit rate.
func (c *ttlCache) evictLocked() {
	now := c.now()
	var oldestKey string
	var oldest time.Time
	for k, e := range c.entries {
		if !now.Before(e.expires) {
			delete(c.entries, k)
			continue
		}
		if oldestKey == "" || e.expires.Before(oldest) {
			oldestKey, oldest = k, e.expires
		}
	}
	if len(c.entries) >= c.max && oldestKey != "" {
		delete(c.entries, oldestKey)
	}
}
