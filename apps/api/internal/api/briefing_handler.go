package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// TDM-30 (E1.4): importing a repo's AGENTS.md / CLAUDE.md as the canvas's
// briefing document.
//
// The briefing is the "read me first" GET /api/canvas/context renders on every
// agent connect (see context_handler.go). Before this file the only way to
// designate one was to write briefing_doc_id by hand — so the feature existed
// but nobody could reach it.
//
// v1 is deliberately MANUAL: paste the text, or hand us a URL we fetch once.
// There is no file watcher, no webhook, no repo checkout. A repo's AGENTS.md
// changes on a human's schedule, and the freshness columns (migration 0037)
// already make "this briefing was vouched for N days ago" visible — which is
// the honest version of sync, and costs no infrastructure. Re-importing is the
// refresh, and it is idempotent: same input, same canvas state.

const (
	// defaultBriefingDocName is the notes document an import creates (or reuses)
	// when the caller doesn't name one.
	defaultBriefingDocName = "Briefing"

	// briefingNoteAuthor marks the ONE note in a briefing document that the
	// importer owns. It is the idempotency key for re-import: on the second
	// import we replace the body of the note created_by "import" rather than
	// appending a second copy of the same file. Notes a human wrote in the same
	// document carry their own author and are never touched.
	briefingNoteAuthor = "import"

	// maxBriefingBytes caps a URL fetch. An AGENTS.md is prose measured in
	// kilobytes; a megabyte is already two orders of magnitude of headroom, and
	// the cap is what stops a hostile URL from streaming us a disk image.
	maxBriefingBytes = 1 << 20 // 1 MiB

	// briefingFetchTimeout bounds the whole fetch — DNS, connect, TLS, body.
	// This runs inside a user's HTTP request, so a slow origin must fail fast
	// rather than pin a request goroutine.
	briefingFetchTimeout = 5 * time.Second
)

// ── Handlers ─────────────────────────────────────────────────────────────────

// POST /api/canvas/briefing/import   (canvas JWT, write role)
//
//	{ "content": "...", "name": "Briefing", "sourceUrl": "https://…",
//	  "staleAfterSeconds": 1209600 }
//
// Body-or-URL: `content` wins; `sourceUrl` is fetched SERVER-side only when
// content is empty (the browser can't fetch raw.githubusercontent.com itself —
// CORS — and we wouldn't trust it to if it could).
//
// The write is three steps in one call, and the whole point is that a human
// never has to do them separately:
//  1. create — or reuse, by name — a notes document,
//  2. write the file into it as a single note (replacing the previous import),
//  3. designate that document as the canvas's briefing.
//
// VERIFICATION. The imported note (and the document) are stamped
// verified_at = now, because importing IS vouching: a human just looked at this
// file and said "this is our context". stale_after_seconds is left NULL unless
// the caller declares a shelf life — an undeclared shelf life reads as
// "verified, no expiry declared", not as "fresh forever" (see DeriveFreshness).
func (h *Handler) ImportBriefing(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	canvasID := CanvasIDFromCtx(ctx)

	var body struct {
		Content           string `json:"content"`
		Name              string `json:"name"`
		SourceURL         string `json:"sourceUrl"`
		StaleAfterSeconds *int   `json:"staleAfterSeconds"`
		CreatedBy         string `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.StaleAfterSeconds != nil && *body.StaleAfterSeconds <= 0 {
		writeError(w, http.StatusBadRequest, "staleAfterSeconds must be a positive number of seconds (omit it for no declared shelf life)")
		return
	}

	content := strings.TrimSpace(body.Content)
	sourceURL := strings.TrimSpace(body.SourceURL)
	if content == "" {
		if sourceURL == "" {
			writeError(w, http.StatusBadRequest, "provide content to import, or a sourceUrl to fetch")
			return
		}
		fetched, err := fetchBriefing(ctx, sourceURL)
		if err != nil {
			// Every fetch failure is a statement about the caller's URL (bad
			// scheme, private host, too big, not text, unreachable), so it's a
			// 400 they can act on rather than a 500 about our server.
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		content = strings.TrimSpace(fetched)
		if content == "" {
			writeError(w, http.StatusBadRequest, "fetched "+sourceURL+" but it was empty")
			return
		}
	}

	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = defaultBriefingDocName
	}
	createdBy := strings.TrimSpace(body.CreatedBy)
	if createdBy == "" {
		createdBy = "human"
	}

	// One clock for the whole import, so the document and its note can't be
	// verified a few milliseconds apart and render two different ages.
	now := time.Now().UTC()

	docs, err := h.store.ListDocuments(ctx, canvasID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	doc := findNotesDocByName(docs, name)
	createdDoc := doc == nil
	if createdDoc {
		doc = &store.Document{
			ID: uuid.New(), Kind: "document", Type: "notes", Name: name,
			SortOrder: nextDocSortOrder(docs), CreatedBy: createdBy,
			VerifiedAt: &now, StaleAfterSeconds: body.StaleAfterSeconds,
		}
		if _, err := h.store.CreateDocument(ctx, canvasID, doc); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	} else {
		if _, err := h.store.UpdateDocument(ctx, canvasID, doc.ID, store.DocumentPatch{
			FreshnessPatch: briefingFreshness(now, body.StaleAfterSeconds),
		}); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		// `doc` is the pre-patch row we listed; mirror the write so the response
		// describes the document as it now is rather than as it was.
		doc.VerifiedAt = &now
		doc.StaleAfterSeconds = body.StaleAfterSeconds
	}

	noteID, err := h.writeBriefingNote(ctx, canvasID, doc.ID, content, now, body.StaleAfterSeconds, createdDoc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if _, err := h.store.SetCanvasBriefingDoc(ctx, canvasID, &doc.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Same push every other canvas mutation sends: the store bumped the version,
	// this fans the new full state to connected boards so the imported document
	// appears (and the briefing badge moves) without a reload. Async for the
	// same reason as the other write handlers — the write is already durable.
	broadcastStateAsync(ctx, h.store, h.hub, canvasID)

	writeJSON(w, http.StatusOK, map[string]any{
		"document":        doc,
		"briefingDocId":   doc.ID,
		"noteId":          noteID,
		"createdDocument": createdDoc,
		"sourceUrl":       sourceURL,
		"bytes":           len(content),
	})
}

// PUT /api/canvas/briefing   (canvas JWT, write role)
//
//	{ "docId": "<uuid or document name>" }   designate
//	{ "docId": null }                        clear
//
// The minimal designation surface, split out from import so E1.5's "set as
// briefing" on an existing document is one call with no content involved. A ref
// may be a document id OR name, matching how every other document-addressing
// route in this API works.
func (h *Handler) SetBriefing(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	canvasID := CanvasIDFromCtx(ctx)

	var body struct {
		DocID *string `json:"docId"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Absent, null, or blank all mean "no briefing" — clearing is the only thing
	// a caller can ask for without naming a document, so it needs no sentinel.
	var docID *uuid.UUID
	if body.DocID != nil && strings.TrimSpace(*body.DocID) != "" {
		doc, err := h.resolveDocumentRef(ctx, canvasID, *body.DocID, "")
		if err != nil {
			// Resolve before writing: the FK would reject a bogus id anyway, but
			// a 404 naming the canvas's documents is a far better error than a
			// constraint violation surfaced as a 500.
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		docID = &doc.ID
	}

	if _, err := h.store.SetCanvasBriefingDoc(ctx, canvasID, docID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastStateAsync(ctx, h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": "true", "briefingDocId": docID})
}

// ── Import internals ─────────────────────────────────────────────────────────

// writeBriefingNote puts the imported content into the briefing document as its
// single import-owned note: replacing the previous import's body if there is
// one, creating it otherwise. Re-importing a file must not leave the document
// holding three near-identical copies of the same AGENTS.md — the briefing is
// read verbatim into every agent's context window, so duplication there is
// paid for on every connect.
//
// freshDoc short-circuits the lookup: a document we just created this request
// provably has no notes yet, so we skip a round trip to prove it.
func (h *Handler) writeBriefingNote(ctx context.Context, canvasID, docID uuid.UUID,
	content string, now time.Time, staleAfter *int, freshDoc bool) (uuid.UUID, error) {

	if !freshDoc {
		notes, err := h.store.ListNotesByDocument(ctx, canvasID, docID)
		if err != nil {
			return uuid.Nil, err
		}
		if prev := pickImportedNote(notes); prev != nil {
			if _, err := h.store.UpdateNote(ctx, canvasID, prev.ID, store.NotePatch{
				Body:           &content,
				FreshnessPatch: briefingFreshness(now, staleAfter),
			}); err != nil {
				return uuid.Nil, err
			}
			return prev.ID, nil
		}
	}

	n := &store.Note{
		ID: uuid.New(), Kind: "note", DocumentID: &docID,
		Body: content, ImageRefs: []string{}, CreatedBy: briefingNoteAuthor,
		VerifiedAt: &now, StaleAfterSeconds: staleAfter,
	}
	if _, err := h.store.CreateNote(ctx, canvasID, n); err != nil {
		return uuid.Nil, err
	}
	return n.ID, nil
}

// briefingFreshness is the freshness half of an import's update. VerifiedAt is
// always stamped (importing is vouching). An omitted shelf life CLEARS any
// previous one rather than leaving it — otherwise a shelf life set on the first
// import would silently outlive it, and re-importing the same file twice would
// produce two different canvas states.
func briefingFreshness(now time.Time, staleAfter *int) store.FreshnessPatch {
	f := store.FreshnessPatch{VerifiedAt: &now}
	if staleAfter != nil {
		f.StaleAfterSeconds = staleAfter
	} else {
		f.ClearStaleAfterSeconds = true
	}
	return f
}

// findNotesDocByName returns the notes document with this name (case-insensitive),
// preferring the lowest sortOrder if a canvas somehow has two. nil = none, and
// the caller creates one. Reuse is by name rather than by "whatever is currently
// designated" so that importing twice under one name is stable, and importing a
// second file under a different name is a deliberate, visible switch.
func findNotesDocByName(docs []*store.Document, name string) *store.Document {
	var best *store.Document
	for _, d := range docs {
		if d.Type != "notes" || !strings.EqualFold(strings.TrimSpace(d.Name), name) {
			continue
		}
		if best == nil || d.SortOrder < best.SortOrder {
			best = d
		}
	}
	return best
}

// pickImportedNote finds the note a previous import owns — the first (by sort
// order) note authored by the importer. Human-written notes in the same
// document are invisible here and survive a re-import untouched.
func pickImportedNote(notes []*store.Note) *store.Note {
	var best *store.Note
	for _, n := range notes {
		if n.CreatedBy != briefingNoteAuthor {
			continue
		}
		if best == nil || n.SortOrder < best.SortOrder {
			best = n
		}
	}
	return best
}

// ── URL fetch ────────────────────────────────────────────────────────────────

// briefingHTTPClient is the ONLY outbound client in the API, and it exists to
// dereference a URL a user typed — the textbook server-side request forgery
// shape. Everything below is the defence:
//
//   - https only, enforced on the original URL and again on every redirect;
//   - the dialer refuses to connect to a loopback / private / link-local /
//     CGNAT address, which is what actually stops the attack: a hostname check
//     alone is bypassed by any public DNS name that resolves to 169.254.169.254
//     (cloud metadata) or 10.x, and by DNS rebinding between check and connect;
//   - no proxy, ever — an env proxy would tunnel past the dialer check;
//   - short timeouts and no keep-alives, since we make exactly one request.
var briefingHTTPClient = &http.Client{
	Timeout: briefingFetchTimeout,
	Transport: &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout: 3 * time.Second,
			Control: blockPrivateAddr,
		}).DialContext,
		TLSHandshakeTimeout:   3 * time.Second,
		ResponseHeaderTimeout: 4 * time.Second,
		DisableKeepAlives:     true,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 4 {
			return errors.New("sourceUrl redirected too many times")
		}
		return validateBriefingTarget(req.URL)
	},
}

// blockPrivateAddr runs after DNS resolution and before the socket connects —
// the one place where the IP we are actually about to talk to is known. Wired
// into net.Dialer.Control, so it also covers every redirect hop.
func blockPrivateAddr(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("refusing to connect to %q", address)
	}
	ip := net.ParseIP(host)
	if isBlockedIP(ip) {
		return fmt.Errorf("refusing to fetch from %s — private and internal addresses are not allowed", host)
	}
	return nil
}

// isBlockedIP reports whether an address is off-limits for an import fetch.
// A nil/unparseable IP blocks: fail closed.
func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() {
		return true
	}
	// Ranges net's helpers don't classify but that still reach infrastructure:
	// 100.64/10 (CGNAT — Tailscale et al), 192.0.0/24 (IETF protocol
	// assignments), 198.18/15 (benchmarking).
	if v4 := ip.To4(); v4 != nil {
		switch {
		case v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127:
			return true
		case v4[0] == 192 && v4[1] == 0 && v4[2] == 0:
			return true
		case v4[0] == 198 && (v4[1] == 18 || v4[1] == 19):
			return true
		}
	}
	return false
}

// fetchBriefing GETs a briefing document over https and returns its text.
func fetchBriefing(ctx context.Context, raw string) (string, error) {
	target, err := normalizeBriefingURL(raw)
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(ctx, briefingFetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", fmt.Errorf("sourceUrl is not fetchable: %w", err)
	}
	req.Header.Set("Accept", "text/plain, text/markdown, text/*;q=0.8")
	req.Header.Set("User-Agent", "Tandem briefing import (+https://tandemcanvas.com)")

	resp, err := briefingHTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("could not fetch %s: %w", target, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s returned %s — check the URL is public and points at the raw file", target, resp.Status)
	}
	if ct := resp.Header.Get("Content-Type"); !briefingContentTypeOK(ct) {
		return "", fmt.Errorf("%s served %s — import expects a raw text file (AGENTS.md, CLAUDE.md, …)", target, ct)
	}
	// Trust the declared length only as a cheap early reject; the reader below
	// is the real cap, since Content-Length can lie or be absent entirely.
	if resp.ContentLength > maxBriefingBytes {
		return "", briefingTooLargeErr()
	}

	data, err := readCapped(resp.Body, maxBriefingBytes)
	if err != nil {
		return "", err
	}
	if !looksLikeText(data) {
		return "", fmt.Errorf("%s does not look like a text file (binary or invalid UTF-8)", target)
	}
	return string(data), nil
}

// readCapped reads at most max bytes and errors if the source had more, rather
// than silently importing a truncated briefing — half an AGENTS.md is worse
// than none, because it reads as complete.
func readCapped(r io.Reader, max int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		return nil, fmt.Errorf("could not read the document: %w", err)
	}
	if int64(len(data)) > max {
		return nil, briefingTooLargeErr()
	}
	return data, nil
}

func briefingTooLargeErr() error {
	return fmt.Errorf("document is larger than the %d KB import limit — paste the relevant part instead", maxBriefingBytes/1024)
}

// normalizeBriefingURL validates a user-supplied URL and rewrites the one form
// people actually paste (a GitHub file page) into the raw URL that serves text.
// Returns the URL to fetch.
func normalizeBriefingURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("sourceUrl is empty")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("sourceUrl is not a valid URL: %w", err)
	}
	u = rewriteGitHubBlobURL(u)
	if err := validateBriefingTarget(u); err != nil {
		return "", err
	}
	return u.String(), nil
}

// validateBriefingTarget is the per-hop check: https, a real host, and not an
// obviously-internal name. The authoritative block happens at dial time
// (blockPrivateAddr) — this catches the easy cases early and with a clearer
// message than a connect error.
func validateBriefingTarget(u *url.URL) error {
	if !strings.EqualFold(u.Scheme, "https") {
		return fmt.Errorf("sourceUrl must be https (got %q)", u.Scheme)
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return errors.New("sourceUrl has no host")
	}
	if blockedBriefingHost(host) {
		return fmt.Errorf("refusing to fetch from %s — private and internal addresses are not allowed", host)
	}
	return nil
}

// internalHostSuffixes are names that only ever resolve inside a network.
var internalHostSuffixes = []string{".localhost", ".local", ".internal", ".home.arpa"}

func blockedBriefingHost(host string) bool {
	host = strings.TrimSuffix(host, ".")
	if host == "localhost" {
		return true
	}
	for _, s := range internalHostSuffixes {
		if strings.HasSuffix(host, s) {
			return true
		}
	}
	// A bare IP in the URL is judged on the spot; a name is judged at dial time.
	if ip := net.ParseIP(host); ip != nil {
		return isBlockedIP(ip)
	}
	return false
}

// rewriteGitHubBlobURL turns the URL a human copies out of the browser
//
//	https://github.com/{owner}/{repo}/blob/{ref}/{path…}
//
// into the one that actually serves the file's bytes
//
//	https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path…}
//
// Nobody navigates to a raw URL to read a file, so without this every first
// attempt at "import our AGENTS.md" would fetch a page of HTML and get rejected
// as not-text. Any other URL is returned unchanged. Query and fragment are
// dropped: GitHub's viewer params (?plain=1, #L20) mean nothing to raw.
func rewriteGitHubBlobURL(u *url.URL) *url.URL {
	host := strings.ToLower(u.Hostname())
	if host != "github.com" && host != "www.github.com" {
		return u
	}
	// [owner, repo, "blob"|"raw", ref, path…] — dropping "blob"/"raw" and
	// keeping everything else in order is the whole transformation.
	parts := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")
	if len(parts) < 5 || (parts[2] != "blob" && parts[2] != "raw") {
		return u
	}
	for _, p := range parts[:5] {
		if p == "" {
			return u
		}
	}
	out := *u
	out.Host = "raw.githubusercontent.com"
	out.Path = "/" + strings.Join(append(parts[:2:2], parts[3:]...), "/")
	out.RawQuery = ""
	out.Fragment = ""
	out.User = nil
	return &out
}

// briefingContentTypeOK gates on what the origin says it served. An absent
// Content-Type passes (plenty of static hosts omit it); the UTF-8 check on the
// body is the real backstop.
func briefingContentTypeOK(ct string) bool {
	ct = strings.ToLower(strings.TrimSpace(ct))
	if ct == "" {
		return true
	}
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}
	return strings.HasPrefix(ct, "text/") || ct == "application/json" || ct == "application/markdown"
}

// looksLikeText rejects anything that isn't valid UTF-8 or contains a NUL —
// the cheap, format-agnostic "is this a text file" test.
func looksLikeText(b []byte) bool {
	return utf8.Valid(b) && !bytes.Contains(b, []byte{0})
}
