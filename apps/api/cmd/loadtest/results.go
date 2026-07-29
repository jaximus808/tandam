package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// resultsSchema versions the results file. Two baselines are only comparable if
// they carry the same schema string; bump it when a field's MEANING changes, not
// when a field is added.
const resultsSchema = "tandem.loadtest.v1"

// Results is the whole machine-readable output: one file per run, holding every
// scenario, both views of every number, and the assertion table.
//
// SHAPED FOR DIFFING. Field order is fixed by struct declaration order, map keys
// are sorted by encoding/json, latencies are rounded to 3 decimals, and every
// volatile value (timestamps, git rev, scratch canvas codes) is confined to the
// `run` block and each scenario's `canvas` block. Two runs of the same scenario
// set therefore diff on the numbers that changed and nothing else.
type Results struct {
	Schema    string           `json:"schema"`
	Run       RunInfo          `json:"run"`
	Targets   []Target         `json:"targets"`
	Scenarios []ScenarioResult `json:"scenarios"`
	Summary   AssertionSummary `json:"summary"`
	// ScratchCanvases repeats every scratch canvas this run created, in one
	// place, because they cannot be deleted by the tool: DELETE /api/canvases is
	// owner-only and these are anonymous creates. This list is the cleanup TODO.
	ScratchCanvases []ScratchCanvas `json:"scratch_canvases"`
}

// RunInfo is the provenance of one baseline.
type RunInfo struct {
	RunID      string    `json:"run_id"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	API        string    `json:"api"`
	GitRev     string    `json:"git_rev"`
	GitDirty   bool      `json:"git_dirty"`
	GoVersion  string    `json:"go_version"`
	GOOS       string    `json:"goos"`
	GOARCH     string    `json:"goarch"`
	NumCPU     int       `json:"num_cpu"`
	Seed       int64     `json:"seed"`
	// Notes carries anything a reader needs in order not to misread the numbers
	// (a missing endpoint, an aborted scenario, a gate that skipped a scenario).
	Notes []string `json:"notes,omitempty"`
}

// ScratchCanvas identifies one throwaway canvas the run created.
type ScratchCanvas struct {
	Code         string `json:"code"`
	ID           string `json:"id"`
	Name         string `json:"name"`
	Scenario     string `json:"scenario,omitempty"`
	SeedsDeleted int    `json:"seeds_deleted"`
	CleanupError string `json:"cleanup_error,omitempty"`
}

// ScenarioResult is one concurrency point's complete record.
type ScenarioResult struct {
	Name       string   `json:"name"`
	Params     Scenario `json:"params"`
	Skipped    bool     `json:"skipped,omitempty"`
	SkipReason string   `json:"skip_reason,omitempty"`

	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	// WallSeconds covers the whole scenario including seeding and cleanup;
	// MeasuredSeconds covers only the windows in which agents were running ops,
	// and is what throughput is computed over.
	WallSeconds     float64 `json:"wall_seconds"`
	MeasuredSeconds float64 `json:"measured_seconds"`
	LiveAgents      int     `json:"live_agents"`
	RoundsRun       int     `json:"rounds_run"`
	TasksSeeded     int     `json:"tasks_seeded"`
	TaskOpsPerSec   float64 `json:"task_ops_per_sec"`

	Ops    map[string]OpStat `json:"ops"`
	Errors []ErrSample       `json:"errors,omitempty"`

	Server          ServerView       `json:"server"`
	Invariant       InvariantResult  `json:"invariant"`
	ClaimCrossCheck ClaimCrossCheck  `json:"claim_cross_check"`
	Assertions      []Assertion      `json:"assertions"`
	Summary         AssertionSummary `json:"assertion_summary"`

	Aborted     bool          `json:"aborted,omitempty"`
	AbortReason string        `json:"abort_reason,omitempty"`
	TaskPrefix  string        `json:"task_prefix,omitempty"`
	Canvas      ScratchCanvas `json:"canvas"`
}

// errorRate is the share of this scenario's calls that failed — the number the
// 256-agent gate is decided on.
func (r ScenarioResult) errorRate() float64 {
	ok, errs := 0, 0
	for _, st := range r.Ops {
		ok += st.Count
		errs += st.Errors
	}
	if ok+errs == 0 {
		return 0
	}
	return float64(errs) / float64(ok+errs)
}

// ── Writing ───────────────────────────────────────────────────────────────────

func writeResults(path string, res Results) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(res, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	return os.WriteFile(path, b, 0o644)
}

// gitProvenance records which tree produced a baseline. Read-only git, and a
// failure is not fatal — a baseline taken outside a checkout is still a
// baseline, it just says so.
func gitProvenance(dir string) (rev string, dirty bool) {
	run := func(args ...string) (string, bool) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.Output()
		if err != nil {
			return "", false
		}
		return strings.TrimSpace(string(out)), true
	}
	rev, ok := run("rev-parse", "HEAD")
	if !ok {
		return "unknown", false
	}
	status, ok := run("status", "--porcelain")
	return rev, ok && status != ""
}

// ── Human-readable report ─────────────────────────────────────────────────────

func printHuman(res Results) {
	fmt.Printf("\ntandem benchmark suite — %s\n", res.Run.API)
	fmt.Printf("  git %s%s · go %s · %s/%s · %d CPU\n",
		shortRev(res.Run.GitRev), dirtyMark(res.Run.GitDirty),
		res.Run.GoVersion, res.Run.GOOS, res.Run.GOARCH, res.Run.NumCPU)

	for _, sc := range res.Scenarios {
		fmt.Printf("\n── %s ─ %d agents · queue depth %d · %d rounds ──\n",
			sc.Name, sc.Params.Agents, sc.Params.QueueDepth, sc.Params.Rounds)
		if sc.Skipped {
			fmt.Printf("  SKIPPED: %s\n", sc.SkipReason)
			continue
		}
		if sc.Aborted {
			fmt.Printf("  ABORTED: %s\n", sc.AbortReason)
		}
		fmt.Printf("  %d tasks seeded · %.1fs measured · %.1f task-ops/sec · error rate %.2f%%\n",
			sc.TasksSeeded, sc.MeasuredSeconds, sc.TaskOpsPerSec, 100*sc.errorRate())

		fmt.Printf("  %-16s %8s %8s %8s %8s %7s %7s   %8s\n",
			"op", "p50", "p95", "p99", "max", "count", "errors", "srv p95")
		for _, op := range append([]string{opConnect}, append(append([]string{}, taskOps...), opSeedBatch)...) {
			st, ok := sc.Ops[op]
			if !ok {
				continue
			}
			srv := "—"
			if p95, has := sc.Server.serverP95(op); has {
				srv = fmt.Sprintf("%.1f", p95)
			}
			flag := ""
			if st.Unavailable {
				flag = "  [endpoint not on this build]"
			}
			fmt.Printf("  %-16s %8.1f %8.1f %8.1f %8.1f %7d %7d   %8s%s\n",
				op, st.P50MS, st.P95MS, st.P99MS, st.MaxMS, st.Count, st.Errors, srv, flag)
		}

		fmt.Printf("  invariant: double-claim-free=%v · %d claims won · %d completed · %d done / %d approved / %d executing\n",
			sc.Invariant.DoubleClaimFree, sc.Invariant.ClaimWins, sc.Invariant.Completions,
			sc.Invariant.TasksDone, sc.Invariant.TasksApproved, sc.Invariant.TasksExecuting)
		for _, dc := range sc.Invariant.DoubleClaims {
			fmt.Printf("    !! DOUBLE-%s task %s by %s\n", strings.ToUpper(dc.Kind), dc.TaskID, strings.Join(dc.Agents, " AND "))
		}
		for _, v := range sc.Invariant.Violations {
			fmt.Printf("    violation: %s\n", v)
		}
		cc := sc.ClaimCrossCheck
		if cc.Available {
			fmt.Printf("  claim cross-check: client wins %d vs server claims %+d (%v) · client conflicts %d vs server %+d (%v)\n",
				cc.ClientClaimWins, cc.ServerClaimsDelta, cc.ClaimsAgree,
				cc.ClientConflicts, cc.ServerConflictsDelta, cc.ConflictsAgree)
		} else {
			fmt.Printf("  claim cross-check: unavailable — %s\n", cc.Note)
		}

		fmt.Printf("  assertions (limit / observed):\n")
		for _, a := range sc.Assertions {
			mark := map[string]string{statusPass: "PASS", statusFail: "FAIL", statusSkipped: "skip"}[a.Status]
			fmt.Printf("    [%s] %-18s %-8s %8.1f %-7s vs %.0f%s\n",
				mark, a.Target, a.Source, a.Observed, a.Unit, a.Limit, noteSuffix(a))
		}
	}

	fmt.Printf("\n  totals: %d passed · %d FAILED · %d skipped\n",
		res.Summary.Passed, res.Summary.Failed, res.Summary.Skipped)
	if len(res.ScratchCanvases) > 0 {
		codes := make([]string, 0, len(res.ScratchCanvases))
		for _, c := range res.ScratchCanvases {
			codes = append(codes, c.Code)
		}
		sort.Strings(codes)
		fmt.Printf("  scratch canvases to delete: %s\n", strings.Join(codes, " "))
	}
	for _, n := range res.Run.Notes {
		fmt.Printf("  note: %s\n", n)
	}
}

func noteSuffix(a Assertion) string {
	if a.Status == statusSkipped && a.Note != "" {
		return "  (" + a.Note + ")"
	}
	return ""
}

func shortRev(rev string) string {
	if len(rev) > 8 {
		return rev[:8]
	}
	return rev
}

func dirtyMark(dirty bool) string {
	if dirty {
		return "-dirty"
	}
	return ""
}
