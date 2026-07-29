package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testClient(t *testing.T, h http.HandlerFunc) (*client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &client{base: srv.URL, agent: "lt-a000", http: &http.Client{Timeout: 5 * time.Second}}, srv
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// THE trap this tool exists not to fall into. Tandem's router serves the SPA for
// unknown paths, so an endpoint the build doesn't have answers 200 with HTML in
// a few milliseconds. Recorded naively that is the fastest PASS in the file.
func TestDoTreatsSPAFallbackAsUnavailable(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`<!doctype html><html><head><title>Tandem</title></head></html>`))
	})
	if _, err := c.getContext(""); !errors.Is(err, errUnavailable) {
		t.Fatalf("context_get against an SPA fallback returned %v, want errUnavailable", err)
	}
	if _, err := c.reportStatus("ABCD1234", "task-1", "progress", "note"); !errors.Is(err, errUnavailable) {
		t.Fatalf("status_post against an SPA fallback returned %v, want errUnavailable", err)
	}
}

// The same check must not misfire on a real JSON endpoint, including one that
// declares a charset.
func TestDoAcceptsJSONWithCharset(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"type":"context","markdown":"# board"}`))
	})
	if _, err := c.getContext("task-1"); err != nil {
		t.Fatalf("getContext = %v, want success", err)
	}
}

// A real 4xx/5xx from a real endpoint is an ERROR, not "unavailable" — the two
// mean different things in the results file and must not be conflated.
func TestDoDistinguishesRealErrorFromMissingEndpoint(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusInternalServerError, `{"error":"boom"}`)
	})
	_, err := c.getTask("task-1")
	if err == nil {
		t.Fatal("a 500 was treated as success")
	}
	if errors.Is(err, errUnavailable) {
		t.Fatal("a 500 from a route that EXISTS was reported as a missing endpoint")
	}
}

// The three outcomes of the atomic claim, which everything downstream depends on
// classifying correctly: won, lost to a rival, and stale (already left the queue).
func TestClaimOutcomes(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   claimOutcome
	}{
		{"won", http.StatusOK, `{"action":{"id":"t1","state":"executing"}}`, claimWon},
		{"lost", http.StatusConflict, `{"error":"already_claimed","claimedBy":"lt-a017"}`, claimLost},
		{"stale", http.StatusBadRequest, `{"error":"illegal state"}`, claimStale},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPatch {
					t.Errorf("method = %s, want PATCH", r.Method)
				}
				writeJSON(w, tc.status, tc.body)
			})
			got, dur, err := c.claim("t1")
			if err != nil {
				t.Fatalf("claim = %v", err)
			}
			if got != tc.want {
				t.Errorf("outcome = %v, want %v", got, tc.want)
			}
			if dur <= 0 {
				t.Error("claim returned a zero duration — nothing would be recorded")
			}
		})
	}
}

// A 409 that is NOT already_claimed is a surprise, and a benchmark that silently
// filed it as a lost race would under-report errors.
func TestClaimRejectsUnexpectedConflictBody(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusConflict, `{"error":"something_else"}`)
	})
	if _, _, err := c.claim("t1"); err == nil {
		t.Fatal("an unrecognised 409 was accepted as a normal lost race")
	}
}

// A 409 on complete means the claim was taken away mid-run. Not an error — the
// agent drops the win, which is exactly what keeps the invariant honest.
func TestCompleteConflictDropsTheWin(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusConflict, `{"error":"claimed_by_other","claimedBy":"lt-a099"}`)
	})
	done, _, err := c.complete("t1", "result")
	if err != nil {
		t.Fatalf("complete = %v, want the conflict handled as a defined outcome", err)
	}
	if done {
		t.Fatal("a 409'd completion was counted as a completion")
	}
}

func TestReportStatusPostsTheCISurface(t *testing.T) {
	var gotPath, gotBody string
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		buf := make([]byte, 512)
		n, _ := r.Body.Read(buf)
		gotBody = string(buf[:n])
		writeJSON(w, http.StatusOK, `{"action":{"id":"t1"}}`)
	})
	if _, err := c.reportStatus("ABCD1234", "t1", "progress", "halfway"); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/canvas/ABCD1234/tasks/t1/status" {
		t.Errorf("path = %s, want the canvas-code-addressed status URL", gotPath)
	}
	for _, want := range []string{`"state":"progress"`, `"agent":"lt-a000"`, `"summary":"halfway"`} {
		if !strings.Contains(gotBody, want) {
			t.Errorf("body %s missing %s", gotBody, want)
		}
	}
}

// The queue read is the contended one: every agent lists, every agent goes for
// the head. The listing must preserve server order and carry titles, because the
// title prefix is what keeps the benchmark off other people's tasks.
func TestListQueuePreservesOrderAndTitles(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.RawQuery; got != "type=task&state=approved" {
			t.Errorf("query = %q, want the approved-task queue", got)
		}
		writeJSON(w, http.StatusOK, `{"actions":[
			{"id":"t1","state":"approved","payload":{"title":"loadtest-abc-0"}},
			{"id":"t2","state":"approved","payload":{"title":"loadtest-abc-1"}},
			{"id":"t3","state":"approved","payload":{"title":"someone-elses-real-task"}}
		]}`)
	})
	listed, _, err := c.listQueue()
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 3 || listed[0].ID != "t1" || listed[2].Title != "someone-elses-real-task" {
		t.Fatalf("listing = %+v", listed)
	}
}

// finalStates is the server-side half of the invariant proof. It must return
// ONLY this run's tasks: a real task on the canvas that the benchmark never
// touched would otherwise show up as an unexplained state.
func TestFinalStatesFiltersToThisRunsPrefix(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, `{"actions":[
			{"id":"t1","state":"done","claimedBy":"lt-a001","payload":{"title":"loadtest-abc-0"}},
			{"id":"t2","state":"approved","payload":{"title":"loadtest-abc-1"}},
			{"id":"t3","state":"executing","claimedBy":"a-real-agent","payload":{"title":"ship the thing"}}
		]}`)
	})
	states, err := c.finalStates("loadtest-abc-")
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 2 {
		t.Fatalf("states = %+v, want only this run's two tasks", states)
	}
	if states["t1"].State != "done" || states["t1"].ClaimedBy != "lt-a001" {
		t.Errorf("t1 = %+v", states["t1"])
	}
	if states["t2"].ClaimedBy != "" {
		t.Errorf("a task with no claimant got one: %+v", states["t2"])
	}
	if _, leaked := states["t3"]; leaked {
		t.Error("a task outside this run's prefix leaked into the invariant evidence")
	}
}

func TestSeedTasksNumbersFromAnOffset(t *testing.T) {
	var titles []string
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 4096)
		n, _ := r.Body.Read(buf)
		titles = append(titles, string(buf[:n]))
		writeJSON(w, http.StatusCreated, `{"actions":[
			{"id":"t9","state":"approved"},{"id":"t10","state":"approved"}]}`)
	})
	ids, err := c.seedTasks("loadtest-abc-", 9, 2, newRecorder())
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("ids = %v", ids)
	}
	// The offset keeps titles unique across rounds, which matters because the
	// title is how a task is attributed to a run.
	if !strings.Contains(titles[0], "loadtest-abc-9") || !strings.Contains(titles[0], "loadtest-abc-10") {
		t.Errorf("seeded titles did not continue from the offset: %s", titles[0])
	}
}

// A seed that did not land approved would silently shrink the queue and make the
// contention weaker than the scenario claims.
func TestSeedTasksRejectsNonApprovedSeeds(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusCreated, `{"actions":[{"id":"t1","state":"proposed"}]}`)
	})
	if _, err := c.seedTasks("loadtest-abc-", 0, 1, newRecorder()); err == nil {
		t.Fatal("a seed that landed in 'proposed' was accepted")
	}
}

// ── /api/metrics scraping over the wire ───────────────────────────────────────

func TestScrapeMetricsHandlesMissingEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The SPA fallback again, this time for /api/metrics.
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<!doctype html><html></html>"))
	}))
	defer srv.Close()

	s := scrapeMetrics(srv.URL, srv.Client())
	if s.Available {
		t.Fatalf("HTML was accepted as a metrics response: %+v", s)
	}
	if s.Note == "" {
		t.Error("an unavailable scrape carried no explanation")
	}
}

func TestScrapeMetricsHandles404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()
	if s := scrapeMetrics(srv.URL, srv.Client()); s.Available || !strings.Contains(s.Note, "404") {
		t.Fatalf("scrape = %+v, want unavailable naming the 404", s)
	}
}

func TestScrapeMetricsParsesRealResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/metrics" {
			t.Errorf("path = %s", r.URL.Path)
		}
		writeJSON(w, http.StatusOK, currentMetricsBody)
	}))
	defer srv.Close()

	s := scrapeMetrics(srv.URL, srv.Client())
	if !s.Available || !s.CountersAvailable || s.ClaimConflicts != 1200 {
		t.Fatalf("scrape = %+v", s)
	}
}

func TestScrapeMetricsUnreachableServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // nothing listening now
	if s := scrapeMetrics(url, &http.Client{Timeout: time.Second}); s.Available {
		t.Fatal("a dead server produced an available scrape")
	}
}

func TestCreateCanvasRequiresACode(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusCreated, `{"id":"canvas-1","name":"loadtest-tdm44-x"}`)
	})
	if _, err := c.createCanvas("loadtest-tdm44-x"); err == nil {
		t.Fatal("a canvas with no code was accepted — every later call is addressed by code")
	}
}
