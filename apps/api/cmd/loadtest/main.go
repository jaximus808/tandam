// Command loadtest is Tandem's benchmark suite for the task queue: the thing
// that turns "the coordination plane is fast and never double-assigns work"
// from a claim into a measurement.
//
// It runs concurrent-agent scenarios — 8, 64 and 256 simulated fleet members —
// against a live API. Each agent authenticates once and then loops a realistic
// op mix: queue reads, task reads, one-call context reads, CONTENDED atomic
// claims (the queue is deliberately kept shallower than the fleet, so agents
// race), status-API progress posts (the CI surface) and completions. Afterwards
// the tool proves, from both the client's record and the server's final state,
// that no task was ever claimed or completed by two agents.
//
// Usage:
//
//	# the standard baseline (8 then 64 agents), writing cmd/loadtest/baselines/
//	go run ./cmd/loadtest -api http://localhost:7891
//
//	# add the 256-agent stress point (gated on the previous scenario running clean)
//	go run ./cmd/loadtest -api http://localhost:7891 -scenarios all
//
//	# one custom shape
//	go run ./cmd/loadtest -api http://localhost:7891 -scenarios custom \
//	    -agents 32 -queue-depth 24 -rounds 4 -ops 12
//
// See README.md in this directory for the full story: what each scenario does,
// how to read the results file, and why the client-side and server-side numbers
// differ.
//
// SAFETY. Every run creates its OWN scratch canvas per scenario, named
// "loadtest-tdm44-<scenario>-<run>", seeds only tasks carrying that run's title
// prefix, and only ever claims tasks with that prefix — so pointing it at a
// shared server cannot make it touch anyone's real work. It deletes its seeds on
// the way out; the scratch canvases themselves are anonymous creates that the
// API will not let the tool delete, so their codes are printed and written into
// the results file as a cleanup list.
package main

import (
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func main() {
	var (
		apiURL      = flag.String("api", "", "base URL of the Tandem API (required), e.g. http://localhost:7891")
		scenarioSet = flag.String("scenarios", "agents-8,agents-64",
			`scenarios to run: comma-separated names, "all" (8/64/256), or "custom" with -agents/-queue-depth/-rounds/-ops`)
		out     = flag.String("out", "", "results file path (default: <baselines dir>/baseline-<timestamp>.json)")
		jsonOut = flag.Bool("json", false, "also print the results JSON on stdout")
		keep    = flag.Bool("keep", false, "skip cleanup (leave seeded tasks on the scratch canvases)")
		code    = flag.String("code", "", "run against this EXISTING canvas instead of creating scratch ones (use a THROWAWAY canvas)")
		seed    = flag.Int64("seed", 1, "RNG seed for the op mix — same seed, same sequence of choices")
		strict  = flag.Bool("strict", false, "exit non-zero when ANY assertion fails (default: only a broken invariant or a fatal error does)")

		agents     = flag.Int("agents", 32, "custom scenario: concurrent agent sessions")
		queueDepth = flag.Int("queue-depth", 24, "custom scenario: approved tasks kept in the queue per round (keep it below -agents to force claim contention)")
		rounds     = flag.Int("rounds", 4, "custom scenario: how many times the queue is topped up and re-drained")
		opsPer     = flag.Int("ops", 12, "custom scenario: ops per agent per round")

		maxErrorRate   = flag.Float64("max-error-rate", 0.10, "abort a scenario when the error rate exceeds this")
		latencyCeiling = flag.Duration("latency-ceiling", 10*time.Second, "abort a scenario when any op's p95 exceeds this")
		gateErrorRate  = flag.Float64("gate-error-rate", 0.01, "a scenario is skipped unless the previous one finished under this error rate")
		force          = flag.Bool("force", false, "run every requested scenario even if the previous one did not finish clean")
		timeout        = flag.Duration("timeout", 30*time.Second, "per-request HTTP timeout")
	)
	flag.Parse()

	if *apiURL == "" {
		fmt.Fprintln(os.Stderr, "loadtest: -api is required (e.g. -api http://localhost:7891)")
		flag.Usage()
		os.Exit(2)
	}

	scenarios, err := resolveScenarios(*scenarioSet, Scenario{
		Name: "custom", Agents: *agents, QueueDepth: *queueDepth, Rounds: *rounds,
		OpsPerAgentRound: *opsPer, MaxProgressPerTask: 2, Mix: fleetMix,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "loadtest: %v\n", err)
		os.Exit(2)
	}

	cfg := newRunConfig(*apiURL, *code, *seed, *keep, *maxErrorRate, *latencyCeiling, *timeout)
	results, fatal := runSuite(cfg, scenarios, *gateErrorRate, *force)

	outPath := *out
	if outPath == "" {
		outPath = filepath.Join(defaultBaselineDir(), fmt.Sprintf("baseline-%s.json", time.Now().UTC().Format("20060102-150405")))
	}
	if err := writeResults(outPath, results); err != nil {
		fmt.Fprintf(os.Stderr, "loadtest: writing results: %v\n", err)
	} else {
		logf("results written to %s", outPath)
	}
	printHuman(results)
	if *jsonOut {
		b, _ := os.ReadFile(outPath)
		os.Stdout.Write(b)
	}

	if fatal != nil {
		fmt.Fprintf(os.Stderr, "\nloadtest: %v\n", fatal)
		os.Exit(1)
	}
	for _, sc := range results.Scenarios {
		if !sc.Skipped && !sc.Invariant.DoubleClaimFree {
			fmt.Fprintln(os.Stderr, "")
			fmt.Fprintln(os.Stderr, "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!")
			fmt.Fprintln(os.Stderr, "!!! DOUBLE-CLAIM DETECTED — the atomic-claim promise is BROKEN !!!")
			fmt.Fprintln(os.Stderr, "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!")
			os.Exit(1)
		}
	}
	if *strict && results.Summary.Failed > 0 {
		fmt.Fprintf(os.Stderr, "\nloadtest: %d assertion(s) failed (-strict)\n", results.Summary.Failed)
		os.Exit(1)
	}
}

// logf writes human progress to stderr so -json keeps stdout clean.
func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

// ── Run configuration ─────────────────────────────────────────────────────────

type runConfig struct {
	base           string
	code           string // non-empty: reuse this canvas instead of creating scratch ones
	runID          string
	seed           int64
	keep           bool
	maxErrorRate   float64
	latencyCeiling time.Duration
	transport      *http.Transport
	timeout        time.Duration
}

func newRunConfig(api, code string, seed int64, keep bool, maxErrorRate float64, ceiling, timeout time.Duration) runConfig {
	// ONE shared transport across every simulated agent, with a connection pool
	// big enough for the largest scenario. Go's default MaxIdleConnsPerHost is 2:
	// leave it there and 256 agents spend the benchmark opening and closing
	// sockets, and the tool ends up measuring connection setup instead of the
	// server. Real fleet members hold their own long-lived connections, so a
	// generous pool is also the more faithful simulation.
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxIdleConns = 512
	tr.MaxIdleConnsPerHost = 512
	tr.MaxConnsPerHost = 0
	tr.IdleConnTimeout = 90 * time.Second
	return runConfig{
		base:           strings.TrimRight(api, "/"),
		code:           code,
		runID:          randomHex(4),
		seed:           seed,
		keep:           keep,
		maxErrorRate:   maxErrorRate,
		latencyCeiling: ceiling,
		transport:      tr,
		timeout:        timeout,
	}
}

func (cfg runConfig) newClient(agent string) *client {
	return &client{
		base:  cfg.base,
		agent: agent,
		http:  &http.Client{Transport: cfg.transport, Timeout: cfg.timeout},
	}
}

func (cfg runConfig) scrapeClient() *http.Client {
	return &http.Client{Transport: cfg.transport, Timeout: scrapeTimeout}
}

// ── Suite orchestration ───────────────────────────────────────────────────────

// runSuite runs the scenarios in order, applying the escalation gate: a scenario
// only starts if the previous one finished clean. That gate is the whole reason
// the 256-agent point is safe to have in the default set at all — it runs
// against shared infrastructure, and "stop escalating when the smaller shape
// already showed errors" is the difference between a benchmark and an outage.
func runSuite(cfg runConfig, scenarios []Scenario, gateErrorRate float64, force bool) (Results, error) {
	started := time.Now().UTC()
	rev, dirty := gitProvenance(".")
	res := Results{
		Schema:  resultsSchema,
		Targets: charterTargets(),
		Run: RunInfo{
			RunID:     cfg.runID,
			StartedAt: started,
			API:       cfg.base,
			GitRev:    rev,
			GitDirty:  dirty,
			GoVersion: runtime.Version(),
			GOOS:      runtime.GOOS,
			GOARCH:    runtime.GOARCH,
			NumCPU:    runtime.NumCPU(),
			Seed:      cfg.seed,
		},
	}

	var fatal error
	var prev *ScenarioResult
	for _, sc := range scenarios {
		if prev != nil && !force {
			if reason := gateReason(*prev, gateErrorRate); reason != "" {
				logf("SKIPPING %s: %s", sc.Name, reason)
				skipped := ScenarioResult{Name: sc.Name, Params: sc, Skipped: true, SkipReason: reason}
				res.Scenarios = append(res.Scenarios, skipped)
				res.Run.Notes = append(res.Run.Notes, fmt.Sprintf("%s was skipped: %s", sc.Name, reason))
				prev = &res.Scenarios[len(res.Scenarios)-1]
				continue
			}
		}
		logf("\n── scenario %s: %d agents · queue depth %d · %d rounds × %d ops (≈%d ops) ──",
			sc.Name, sc.Agents, sc.QueueDepth, sc.Rounds, sc.OpsPerAgentRound, sc.PlannedOps())

		rec := newRecorder()
		sr, err := runScenario(sc, cfg, rec)
		if err != nil {
			fatal = fmt.Errorf("scenario %s: %w", sc.Name, err)
			sr.Name = sc.Name
			sr.Params = sc
			sr.Aborted = true
			sr.AbortReason = joinNotes(sr.AbortReason, err.Error())
		}
		sr.Assertions = evaluate(res.Targets, sr)
		sr.Summary = summarize(sr.Assertions)
		res.Summary = res.Summary.add(sr.Summary)
		if sr.Canvas.Code != "" {
			sr.Canvas.Scenario = sc.Name
			res.ScratchCanvases = append(res.ScratchCanvases, sr.Canvas)
		}
		for op, st := range sr.Ops {
			if st.Unavailable {
				res.Run.Notes = append(res.Run.Notes,
					fmt.Sprintf("%s: op %q could not be measured — %s", sc.Name, op, st.Note))
			}
		}
		if !sr.Server.CountersAvailable && sr.Server.Available {
			res.Run.Notes = append(res.Run.Notes,
				fmt.Sprintf("%s: %s", sc.Name, sr.ClaimCrossCheck.Note))
		}
		res.Scenarios = append(res.Scenarios, sr)
		prev = &res.Scenarios[len(res.Scenarios)-1]
		if fatal != nil {
			break
		}
	}
	res.Run.FinishedAt = time.Now().UTC()
	res.Run.Notes = dedupe(res.Run.Notes)
	return res, fatal
}

// gateReason returns why the NEXT scenario must not start, or "".
func gateReason(prev ScenarioResult, gateErrorRate float64) string {
	if prev.Skipped {
		return fmt.Sprintf("the previous scenario (%s) was itself skipped", prev.Name)
	}
	if prev.Aborted {
		return fmt.Sprintf("the previous scenario (%s) aborted: %s", prev.Name, prev.AbortReason)
	}
	if r := prev.errorRate(); r > gateErrorRate {
		return fmt.Sprintf("the previous scenario (%s) finished with a %.2f%% error rate, above the %.2f%% gate — escalating concurrency against a struggling backend would only make the numbers worse",
			prev.Name, 100*r, 100*gateErrorRate)
	}
	return ""
}

// resolveScenarios turns the -scenarios flag into a scenario list.
func resolveScenarios(spec string, custom Scenario) ([]Scenario, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return nil, fmt.Errorf("-scenarios must not be empty")
	}
	if spec == "all" {
		return builtinScenarios(), nil
	}
	var out []Scenario
	for _, name := range strings.Split(spec, ",") {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if name == "custom" {
			if custom.Agents < 1 || custom.Rounds < 1 || custom.OpsPerAgentRound < 1 || custom.QueueDepth < 1 {
				return nil, fmt.Errorf("custom scenario needs -agents, -queue-depth, -rounds and -ops all >= 1")
			}
			out = append(out, custom)
			continue
		}
		sc, ok := scenarioByName(name)
		if !ok {
			return nil, fmt.Errorf("unknown scenario %q (known: agents-8, agents-64, agents-256, custom, all)", name)
		}
		out = append(out, sc)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("-scenarios named nothing runnable")
	}
	return out, nil
}

// defaultBaselineDir puts baselines next to the source when run the usual way
// (`go run ./cmd/loadtest` from apps/api), and in ./baselines otherwise.
func defaultBaselineDir() string {
	if fi, err := os.Stat(filepath.Join("cmd", "loadtest")); err == nil && fi.IsDir() {
		return filepath.Join("cmd", "loadtest", "baselines")
	}
	return "baselines"
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := in[:0]
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
