package main

import (
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ── Scenario definition ───────────────────────────────────────────────────────

// OpMix is the per-scenario op profile: relative weights for what an agent
// session does next. Two phases, because a real agent's choices depend on
// whether it is currently holding work:
//
//	idle    (no task held) → queue_list | task_get | context_get | task_claim
//	holding (task held)    → status_post | task_complete | task_get
//
// Weights are relative within a phase; they do not have to sum to anything.
type OpMix struct {
	QueueList  int `json:"queue_list"`
	TaskGet    int `json:"task_get"`
	ContextGet int `json:"context_get"`
	Claim      int `json:"task_claim"`
	StatusPost int `json:"status_post"`
	Complete   int `json:"task_complete"`
}

// Scenario is one benchmark run's parameters. Everything here lands in the
// results file so a number can always be traced back to the load that produced
// it.
type Scenario struct {
	Name   string `json:"name"`
	Agents int    `json:"agents"`
	// QueueDepth is how many approved tasks the harness keeps in the queue at the
	// start of each round. It is deliberately LESS than Agents: the charter's
	// claim guarantee only means anything under contention, so every round starts
	// with more agents than there is work, and agents race for the head of the
	// same queue.
	QueueDepth int `json:"queue_depth"`
	// Rounds is how many times the queue is topped back up and re-drained. Rounds
	// (rather than one huge seed) keep the agents-exceed-tasks property true for
	// the whole run while still producing enough claim/complete samples for a
	// meaningful p95.
	Rounds int `json:"rounds"`
	// OpsPerAgentRound bounds the run: total agent ops ≈ Agents × Rounds ×
	// OpsPerAgentRound. Bounded by op count, never by wall time — this runs
	// against shared infrastructure and must not be open-ended.
	OpsPerAgentRound int `json:"ops_per_agent_round"`
	// MaxProgressPerTask forces a completion after this many status posts on one
	// held task, so no agent can sit on a claim forever.
	MaxProgressPerTask int    `json:"max_progress_per_task"`
	Mix                OpMix  `json:"mix"`
	Note               string `json:"note,omitempty"`
}

// PlannedOps is the op budget this scenario will spend (excluding the
// end-of-round completion drain, which is bounded by claims won).
func (s Scenario) PlannedOps() int { return s.Agents * s.Rounds * s.OpsPerAgentRound }

// fleetMix is the shared op profile: an agent that mostly works the queue, reads
// a task before taking it, pulls the connect bundle now and then, and reports
// progress while it holds work.
var fleetMix = OpMix{
	QueueList: 25, TaskGet: 20, ContextGet: 15, Claim: 40,
	StatusPost: 50, Complete: 40,
}

// builtinScenarios are the charter's three concurrency points. Op budgets shrink
// as agent count grows so total load stays in the same few-thousand-op band —
// the point of the suite is how the system behaves at 8 vs 64 vs 256 concurrent
// sessions, not how much total traffic each can generate.
func builtinScenarios() []Scenario {
	return []Scenario{
		{
			Name: "agents-8", Agents: 8, QueueDepth: 6, Rounds: 10, OpsPerAgentRound: 20,
			MaxProgressPerTask: 2, Mix: fleetMix,
			Note: "small fleet — the shape a single developer's parallel sessions make",
		},
		{
			Name: "agents-64", Agents: 64, QueueDepth: 48, Rounds: 5, OpsPerAgentRound: 10,
			MaxProgressPerTask: 2, Mix: fleetMix,
			Note: "the charter's working target — a fleet spanning machines and models",
		},
		{
			Name: "agents-256", Agents: 256, QueueDepth: 192, Rounds: 3, OpsPerAgentRound: 6,
			MaxProgressPerTask: 1, Mix: fleetMix,
			Note: "stress point — gated on agents-64 finishing clean",
		},
	}
}

func scenarioByName(name string) (Scenario, bool) {
	for _, s := range builtinScenarios() {
		if s.Name == name {
			return s, true
		}
	}
	return Scenario{}, false
}

// ── Weighted op choice (pure — unit tested) ───────────────────────────────────

type weightedOp struct {
	op     string
	weight int
}

func (m OpMix) idleChoices() []weightedOp {
	return []weightedOp{
		{opQueueList, m.QueueList},
		{opTaskGet, m.TaskGet},
		{opContextGet, m.ContextGet},
		{opClaim, m.Claim},
	}
}

func (m OpMix) holdingChoices() []weightedOp {
	return []weightedOp{
		{opStatusPost, m.StatusPost},
		{opComplete, m.Complete},
		{opTaskGet, m.TaskGet},
	}
}

// pickWeighted selects an op from weighted choices given r ∈ [0,1). Returns ""
// when every weight is zero or negative, which the caller treats as "no
// preference" rather than crashing a benchmark over a bad mix.
func pickWeighted(choices []weightedOp, r float64) string {
	total := 0
	for _, c := range choices {
		if c.weight > 0 {
			total += c.weight
		}
	}
	if total == 0 {
		return ""
	}
	if r < 0 {
		r = 0
	}
	if r >= 1 {
		r = 0.999999
	}
	threshold := r * float64(total)
	acc := 0.0
	for _, c := range choices {
		if c.weight <= 0 {
			continue
		}
		acc += float64(c.weight)
		if threshold < acc {
			return c.op
		}
	}
	// Float drift only; the last positive-weight choice is the honest answer.
	for i := len(choices) - 1; i >= 0; i-- {
		if choices[i].weight > 0 {
			return choices[i].op
		}
	}
	return ""
}

// ── Abort guard ───────────────────────────────────────────────────────────────

// guard is the "don't hammer shared infrastructure into the ground" watchdog.
// It runs beside the agents and flips an abort flag they check between ops.
//
// The latency ceiling is deliberately ABSOLUTE (and generous) rather than a
// multiple of the charter targets: this suite is expected to run in setups where
// the targets are missed by design (an API on localhost talking to a Supabase in
// another region pays a WAN round trip per store call), and a guard tuned to the
// targets would abort every such run before it produced a single number. What we
// are actually protecting against is a system falling over — errors and seconds-
// long responses — not a system that is merely slower than we want.
type guard struct {
	maxErrorRate float64
	minOpsBefore int
	ceiling      time.Duration
	rec          *recorder

	aborted atomic.Bool
	reason  atomic.Value // string
	stop    chan struct{}
	done    chan struct{}
}

func newGuard(rec *recorder, maxErrorRate float64, ceiling time.Duration) *guard {
	return &guard{
		maxErrorRate: maxErrorRate,
		minOpsBefore: 50,
		ceiling:      ceiling,
		rec:          rec,
		stop:         make(chan struct{}),
		done:         make(chan struct{}),
	}
}

func (g *guard) start() {
	go func() {
		defer close(g.done)
		t := time.NewTicker(500 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-g.stop:
				return
			case <-t.C:
				g.check()
			}
		}
	}()
}

func (g *guard) check() {
	if g.aborted.Load() {
		return
	}
	ok := g.rec.successCount(taskOps...)
	errs := g.rec.errorCount()
	total := ok + errs
	if total >= g.minOpsBefore && float64(errs)/float64(total) > g.maxErrorRate {
		g.trip(fmt.Sprintf("error rate %.1f%% over %d ops exceeds the %.1f%% abort threshold",
			100*float64(errs)/float64(total), total, 100*g.maxErrorRate))
		return
	}
	for op, st := range g.rec.snapshot() {
		if st.Count >= 20 && st.P95MS > durMS(g.ceiling) {
			g.trip(fmt.Sprintf("%s p95 %.0fms exceeds the %.0fms absolute ceiling — backing off shared infrastructure",
				op, st.P95MS, durMS(g.ceiling)))
			return
		}
	}
}

func (g *guard) trip(reason string) {
	if g.aborted.CompareAndSwap(false, true) {
		g.reason.Store(reason)
	}
}

func (g *guard) tripped() bool { return g.aborted.Load() }

func (g *guard) why() string {
	if s, ok := g.reason.Load().(string); ok {
		return s
	}
	return ""
}

func (g *guard) close() {
	close(g.stop)
	<-g.done
}

// ── The agent session ─────────────────────────────────────────────────────────

// agentSession is one simulated fleet member: one client, one token, one
// identity, alive for the whole scenario (connect/auth once, then a loop).
// Its `claimed` and `completed` slices are this session's client-side evidence
// for the invariant check.
type agentSession struct {
	c        *client
	rng      *rand.Rand
	held     string
	progress int

	// cache is the agent's last queue listing, filtered to this run's seeds. An
	// agent claims the HEAD of its cache, which is why claims contend: every
	// session that listed recently is looking at the same head.
	cache []listedTask

	claimed   []string
	completed []string
}

// runRound spends this round's op budget, then completes whatever the session
// still holds so the round ends with no orphaned claims.
func (a *agentSession) runRound(sc Scenario, code, prefix string, seeded []string, rec *recorder, g *guard) {
	for i := 0; i < sc.OpsPerAgentRound; i++ {
		if g.tripped() {
			break
		}
		a.step(sc, code, prefix, seeded, rec)
	}
	a.drainHeld(rec)
}

// step performs exactly one HTTP op, chosen from the mix for the session's
// current phase. Failures are recorded and swallowed — a benchmark reports an
// error rate, it does not stop at the first 500.
func (a *agentSession) step(sc Scenario, code, prefix string, seeded []string, rec *recorder) {
	if a.held != "" {
		a.holdingStep(sc, code, rec)
		return
	}
	a.idleStep(prefix, seeded, sc, rec)
}

func (a *agentSession) idleStep(prefix string, seeded []string, sc Scenario, rec *recorder) {
	op := pickWeighted(sc.Mix.idleChoices(), a.rng.Float64())
	// An op whose endpoint this build doesn't serve is substituted rather than
	// re-attempted, so one missing feature doesn't hollow out the whole run.
	if op == opContextGet && rec.isUnavailable(opContextGet) {
		op = opQueueList
	}
	if op == opClaim && len(a.cache) == 0 {
		op = opQueueList // nothing to claim; go look at the queue (still one op)
	}

	switch op {
	case opQueueList:
		listed, dur, err := a.c.listQueue()
		if err != nil {
			rec.fail(opQueueList, a.c.agent, err)
			return
		}
		rec.observe(opQueueList, dur)
		a.cache = a.cache[:0]
		for _, t := range listed {
			// ONLY ever claim this run's seeds — a stray real approved task on the
			// canvas must never be picked up by a benchmark.
			if strings.HasPrefix(t.Title, prefix) {
				a.cache = append(a.cache, t)
			}
		}
	case opTaskGet:
		id := a.someTask(seeded)
		if id == "" {
			return
		}
		dur, err := a.c.getTask(id)
		if err != nil {
			rec.fail(opTaskGet, a.c.agent, err)
			return
		}
		rec.observe(opTaskGet, dur)
	case opContextGet:
		id := a.someTask(seeded)
		dur, err := a.c.getContext(id)
		if err != nil {
			if errors.Is(err, errUnavailable) {
				rec.markUnavailable(opContextGet, "GET /api/canvas/context is not served by this build")
				return
			}
			rec.fail(opContextGet, a.c.agent, err)
			return
		}
		rec.observe(opContextGet, dur)
	case opClaim:
		target := a.cache[0]
		a.cache = a.cache[1:]
		outcome, dur, err := a.c.claim(target.ID)
		if err != nil {
			rec.fail(opClaim, a.c.agent, err)
			return
		}
		switch outcome {
		case claimWon:
			rec.observe(opClaim, dur)
			a.held = target.ID
			a.progress = 0
			a.claimed = append(a.claimed, target.ID)
		case claimLost:
			rec.observe(opClaimConflict, dur)
		case claimStale:
			rec.observe(opClaimStale, dur)
		}
	}
}

func (a *agentSession) holdingStep(sc Scenario, code string, rec *recorder) {
	op := pickWeighted(sc.Mix.holdingChoices(), a.rng.Float64())
	if op == opStatusPost && (a.progress >= sc.MaxProgressPerTask || rec.isUnavailable(opStatusPost)) {
		op = opComplete
	}
	switch op {
	case opStatusPost:
		dur, err := a.c.reportStatus(code, a.held, "progress", "loadtest progress from "+a.c.agent)
		if err != nil {
			if errors.Is(err, errUnavailable) {
				rec.markUnavailable(opStatusPost, "POST /api/canvas/{code}/tasks/{id}/status is not served by this build")
				return
			}
			rec.fail(opStatusPost, a.c.agent, err)
			return
		}
		rec.observe(opStatusPost, dur)
		a.progress++
	case opTaskGet:
		dur, err := a.c.getTask(a.held)
		if err != nil {
			rec.fail(opTaskGet, a.c.agent, err)
			return
		}
		rec.observe(opTaskGet, dur)
	default: // opComplete, and anything a zero-weight mix leaves unresolved
		a.completeHeld(rec)
	}
}

// drainHeld finishes any task still held at the end of a round. Without it a
// scenario could end with tasks stuck executing, and "every task was completed
// by exactly one agent" would fail for a reason that has nothing to do with the
// claim guarantee it is meant to test.
func (a *agentSession) drainHeld(rec *recorder) {
	if a.held == "" {
		return
	}
	a.completeHeld(rec)
}

func (a *agentSession) completeHeld(rec *recorder) {
	id := a.held
	done, dur, err := a.c.complete(id, "loadtest "+a.c.agent)
	if err != nil {
		rec.fail(opComplete, a.c.agent, err)
		a.held = "" // don't spin on a task we can't finish
		return
	}
	if done {
		rec.observe(opComplete, dur)
		a.completed = append(a.completed, id)
	}
	// A 409 means the claim was taken away mid-run: the win is dropped rather
	// than recorded, because for reconciliation purposes the task is no longer
	// ours.
	a.held = ""
	a.progress = 0
}

// someTask returns a task id for a read op: the head of this session's cached
// listing if it has one, otherwise a random seeded task.
func (a *agentSession) someTask(seeded []string) string {
	if len(a.cache) > 0 {
		return a.cache[a.rng.Intn(len(a.cache))].ID
	}
	if len(seeded) == 0 {
		return ""
	}
	return seeded[a.rng.Intn(len(seeded))]
}

// ── Scenario execution ────────────────────────────────────────────────────────

// runScenario executes one scenario end to end: scratch canvas, agent connects,
// rounds of seeded-and-drained queue, metrics scrape, invariant check, cleanup.
func runScenario(sc Scenario, cfg runConfig, rec *recorder) (ScenarioResult, error) {
	res := ScenarioResult{Name: sc.Name, Params: sc, StartedAt: time.Now().UTC()}

	coord := cfg.newClient("loadtest-coordinator")

	// A fresh scratch canvas per scenario is the default and the safe path: the
	// tool can then only ever see tasks it made. -code exists for pointing a run
	// at a specific throwaway board, and is still title-prefix-scoped.
	canvasCode := cfg.code
	if canvasCode == "" {
		canvas, err := coord.createCanvas(fmt.Sprintf("loadtest-tdm44-%s-%s", sc.Name, cfg.runID))
		if err != nil {
			return res, fmt.Errorf("creating scratch canvas: %w", err)
		}
		canvasCode = canvas.Code
		res.Canvas = ScratchCanvas{Code: canvas.Code, ID: canvas.ID, Name: canvas.Name}
		logf("  scratch canvas %s (%s)", canvas.Code, canvas.Name)
	} else {
		res.Canvas = ScratchCanvas{Code: canvasCode, Name: "(pre-existing canvas passed with -code)"}
		logf("  using pre-existing canvas %s", canvasCode)
	}
	if _, err := coord.connect(canvasCode); err != nil {
		return res, fmt.Errorf("coordinator auth: %w", err)
	}

	prefix := fmt.Sprintf("loadtest-%s-%s-", cfg.runID, sc.Name)
	res.TaskPrefix = prefix

	// ── Connect every agent once, in parallel (the fleet waking up). ──────────
	sessions := make([]*agentSession, sc.Agents)
	connectErrs := make([]error, sc.Agents)
	var wg sync.WaitGroup
	for i := 0; i < sc.Agents; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			name := fmt.Sprintf("lt-%s-a%03d", sc.Name, i)
			c := cfg.newClient(name)
			dur, err := c.connect(canvasCode)
			if err != nil {
				connectErrs[i] = err
				rec.fail(opConnect, name, err)
				return
			}
			rec.observe(opConnect, dur)
			sessions[i] = &agentSession{
				c:   c,
				rng: rand.New(rand.NewSource(int64(cfg.seed) + int64(i)*7919)),
			}
		}(i)
	}
	wg.Wait()
	live := sessions[:0]
	for _, s := range sessions {
		if s != nil {
			live = append(live, s)
		}
	}
	if len(live) == 0 {
		return res, fmt.Errorf("no agent could authenticate (first error: %v)", firstErr(connectErrs))
	}
	if len(live) < sc.Agents {
		logf("  WARNING: %d/%d agents failed to authenticate", sc.Agents-len(live), sc.Agents)
	}
	res.LiveAgents = len(live)

	g := newGuard(rec, cfg.maxErrorRate, cfg.latencyCeiling)
	g.start()
	defer g.close()

	// Server-side view, opening reading. Scraped AFTER the connects so the
	// claim-counter delta covers the measured window and nothing else.
	before := scrapeMetrics(cfg.base, cfg.scrapeClient())

	// ── Rounds ────────────────────────────────────────────────────────────────
	var seeded []string
	var measured time.Duration
	for round := 0; round < sc.Rounds && !g.tripped(); round++ {
		need, err := topUpNeeded(coord, prefix, sc.QueueDepth)
		if err != nil {
			return res, fmt.Errorf("round %d queue check: %w", round+1, err)
		}
		if need > 0 {
			ids, err := coord.seedTasks(prefix, len(seeded), need, rec)
			seeded = append(seeded, ids...)
			if err != nil {
				return res, fmt.Errorf("round %d seeding: %w", round+1, err)
			}
		}
		logf("  round %d/%d — queue topped to %d, %d agents racing", round+1, sc.Rounds, sc.QueueDepth, len(live))

		snapshotSeeded := append([]string(nil), seeded...)
		t0 := time.Now()
		var rwg sync.WaitGroup
		for _, s := range live {
			rwg.Add(1)
			go func(s *agentSession) {
				defer rwg.Done()
				s.runRound(sc, canvasCode, prefix, snapshotSeeded, rec, g)
			}(s)
		}
		rwg.Wait()
		measured += time.Since(t0)
		res.RoundsRun++
	}

	res.FinishedAt = time.Now().UTC()
	res.WallSeconds = round3(res.FinishedAt.Sub(res.StartedAt).Seconds())
	res.MeasuredSeconds = round3(measured.Seconds())
	res.TasksSeeded = len(seeded)
	if g.tripped() {
		res.Aborted = true
		res.AbortReason = g.why()
		logf("  ABORTED: %s", res.AbortReason)
	}

	res.Ops = rec.snapshot()
	res.Errors = rec.errSamples()
	if measured > 0 {
		res.TaskOpsPerSec = round3(float64(countTaskOps(res.Ops)) / measured.Seconds())
	}

	// ── Server-side view, closing reading. Taken BEFORE the verification read
	// and the cleanup below, both of which would otherwise land in the server's
	// route metrics and quietly change the numbers being reported. ───────────
	res.Server = buildServerView(before, scrapeMetrics(cfg.base, cfg.scrapeClient()))

	// ── Invariant evidence ────────────────────────────────────────────────────
	states, stateErr := coord.finalStates(prefix)
	if stateErr != nil {
		return res, fmt.Errorf("reading final task states: %w", stateErr)
	}
	claimedBy := map[string][]string{}
	completedBy := map[string][]string{}
	for _, s := range live {
		claimedBy[s.c.agent] = s.claimed
		completedBy[s.c.agent] = s.completed
	}
	res.Invariant = checkInvariant(seeded, claimedBy, completedBy, states, res.Ops)
	res.ClaimCrossCheck = crossCheckClaims(res.Invariant, res.Server, res.Ops)

	// ── Cleanup: delete this run's seeds. The scratch CANVAS itself cannot be
	// deleted by an anonymous caller (DELETE /api/canvases/{code} is owner-only),
	// so its code is recorded in the results file for a human to remove. ──────
	if cfg.keep {
		logf("  -keep: leaving %d seeded tasks on %s", len(seeded), canvasCode)
	} else if err := coord.deleteTasks(seeded); err != nil {
		logf("  cleanup WARNING: %v (seeds may remain on %s)", err, canvasCode)
		res.Canvas.CleanupError = err.Error()
	} else {
		res.Canvas.SeedsDeleted = len(seeded)
	}
	return res, nil
}

// topUpNeeded counts this run's still-approved tasks and returns how many more
// are needed to bring the queue back to depth.
func topUpNeeded(coord *client, prefix string, depth int) (int, error) {
	listed, _, err := coord.listQueue()
	if err != nil {
		return 0, err
	}
	have := 0
	for _, t := range listed {
		if strings.HasPrefix(t.Title, prefix) {
			have++
		}
	}
	if have >= depth {
		return 0, nil
	}
	return depth - have, nil
}

func countTaskOps(ops map[string]OpStat) int {
	n := 0
	for _, op := range taskOps {
		n += ops[op].Count
	}
	return n
}

func firstErr(errs []error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

func round3(f float64) float64 {
	return float64(int64(f*1000+0.5)) / 1000
}
