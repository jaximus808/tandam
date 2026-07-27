package api

import (
	"os"
	"strings"
	"testing"
)

// The previous implementation matched the home <title> by its exact marketing
// copy, so it broke — silently, serving /mcp and /about as byte-identical
// duplicates of the landing page — every time that copy changed. These tests run
// the rewrite against the real index.html so that failure mode is loud.
// Both the source head and the built one, since Vite reformats as it copies and
// the server reads dist/.
var indexHTMLPaths = []string{
	"../../../web/index.html",
	"../../../web/dist/index.html",
}

func TestBuildRouteVariantsRewritesRealIndex(t *testing.T) {
	ran := 0
	for _, p := range indexHTMLPaths {
		base, err := os.ReadFile(p)
		if err != nil {
			continue // dist/ only exists after a web build
		}
		ran++
		t.Run(p, func(t *testing.T) { assertVariants(t, base) })
	}
	if ran == 0 {
		t.Skip("no index.html readable from the api module")
	}
}

func assertVariants(t *testing.T, base []byte) {
	t.Helper()
	variants := buildRouteVariants(base)

	for _, path := range []string{"/mcp", "/about"} {
		html, ok := variants[path]
		if !ok {
			t.Fatalf("no variant built for %s", path)
		}
		got := string(html)

		// Self-referencing canonical + og:url, or Google folds the page into "/".
		if !strings.Contains(got, `<link rel="canonical" href="https://tandemcanvas.com`+path+`" />`) {
			t.Errorf("%s: canonical not rewritten", path)
		}
		if !strings.Contains(got, `<meta property="og:url" content="https://tandemcanvas.com`+path+`" />`) {
			t.Errorf("%s: og:url not rewritten", path)
		}
		if strings.Contains(got, `href="https://tandemcanvas.com/" />`) {
			t.Errorf("%s: apex canonical still present", path)
		}

		// Title and description must actually differ from the landing page's.
		title := titleRe.Find([]byte(got))
		if title == nil {
			t.Fatalf("%s: no <title> in variant", path)
		}
		if string(title) == string(titleRe.Find(base)) {
			t.Errorf("%s: title unchanged from home (%s) — the rewrite silently no-oped", path, title)
		}
		desc := descRe.Find([]byte(got))
		if desc == nil {
			t.Fatalf("%s: no meta description in variant", path)
		}
		if string(desc) == string(descRe.Find(base)) {
			t.Errorf("%s: description unchanged from home — the rewrite silently no-oped", path)
		}
		// Exactly one of each survives the replace.
		if n := len(titleRe.FindAll([]byte(got), -1)); n != 1 {
			t.Errorf("%s: expected 1 <title>, got %d", path, n)
		}
		if n := len(descRe.FindAll([]byte(got), -1)); n != 1 {
			t.Errorf("%s: expected 1 meta description, got %d", path, n)
		}
	}
}

func TestBuildRouteVariantsEmptyBase(t *testing.T) {
	if got := buildRouteVariants(nil); got != nil {
		t.Errorf("expected nil variants for empty base, got %d", len(got))
	}
}
