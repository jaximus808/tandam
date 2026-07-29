# `cmd/loadtest` — Tandem's task-queue benchmark suite

The tool that turns the charter's two claims — *the coordination plane is fast*
and *it never hands the same task to two agents* — into measurements.

It runs concurrent-agent scenarios against a live API. Each simulated agent
authenticates once and then loops a realistic op mix against a **contended**
queue, and afterwards the tool proves, from both the client's record and the
server's final state, that no task was claimed or completed by two agents.

```bash
cd apps/api

# the standard baseline: 8 agents, then 64
go run ./cmd/loadtest -api http://localhost:7891

# add the 256-agent stress point (gated on the previous scenario running clean)
go run ./cmd/loadtest -api http://localhost:7891 -scenarios all

# one custom shape
go run ./cmd/loadtest -api http://localhost:7891 -scenarios custom \
    -agents 32 -queue-depth 24 -rounds 4 -ops 12

go run ./cmd/loadtest -h        # every flag
```

Results land in `cmd/loadtest/baselines/baseline-<timestamp>.json`, and a
human-readable table goes to stdout.

---

## Safety — read this before pointing it at anything

The tool writes to a real API and, in the usual local setup, a real (shared)
database. It is built so that cannot go wrong, in four layers:

1. **Its own scratch canvas per scenario**, created at the start of the run and
   named `loadtest-tdm44-<scenario>-<runid>`. Nothing else is touched.
2. **A per-run task title prefix.** Agents only ever claim tasks whose title
   starts with `loadtest-<runid>-<scenario>-`. Even pointed at a busy canvas with
   `-code`, it cannot pick up somebody's real approved task.
3. **A bounded op budget.** `agents × rounds × ops-per-agent-round`, never a
   wall-clock duration. A scenario cannot run away.
4. **An abort guard** (see below) that stops a scenario when the backend starts
   erroring or answering in seconds.

It deletes its seeded tasks on the way out (`-keep` skips that). It **cannot**
delete the scratch canvases — `DELETE /api/canvases/{code}` is owner-only and
these are anonymous creates — so their codes are printed at the end of the run
and written into `scratch_canvases` in the results file. That list is the cleanup
TODO.

**Never point this at canvas `TEGLQFXR` (the project's own roadmap).** There is
no technical reason it would hurt it; there is also no reason to find out.

---

## The scenarios

| scenario | agents | queue depth | rounds | ops/agent/round | ≈ ops |
|---|---|---|---|---|---|
| `agents-8` | 8 | 6 | 10 | 20 | 1 600 |
| `agents-64` | 64 | 48 | 5 | 10 | 3 200 |
| `agents-256` | 256 | 192 | 3 | 6 | 4 608 |

**Queue depth is always below the agent count.** That is the whole design: a
claim benchmark whose queue is deeper than its fleet never makes two agents race,
and measures nothing about the guarantee it is supposed to be testing. Each round
tops the approved queue back up to `queue depth` and lets every agent loose on it
at once, so agents race for the head of the same list and losers get real
`409 already_claimed` responses.

Op budgets shrink as the agent count grows so every scenario stays in the same
few-thousand-op band. The point of the suite is the *shape* of the system at 8 vs
64 vs 256 concurrent sessions, not how much total traffic each can generate.

### The op mix

Each agent picks its next op from weights, in one of two phases:

| phase | ops (weight) |
|---|---|
| idle (holding nothing) | `task_claim` 40 · `queue_list` 25 · `task_get` 20 · `context_get` 15 |
| holding a task | `status_post` 50 · `task_complete` 40 · `task_get` 10 |

Which maps onto the API as:

| op | request | charter target (server-side p95) |
|---|---|---|
| `connect` | `POST /api/mcp/auth` (once per agent) | — |
| `queue_list` | `GET /api/canvas/actions?type=task&state=approved` | 150 ms |
| `task_get` | `GET /api/canvas/actions/{id}` | 150 ms |
| `context_get` | `GET /api/canvas/context` | 250 ms |
| `task_claim` | `PATCH /api/canvas/actions/{id}` → 200 | 100 ms |
| `claim_conflict` | same → 409 `already_claimed` | — (reported) |
| `claim_stale` | same → 400 (task already left `approved`) | — (reported) |
| `status_post` | `POST /api/canvas/{code}/tasks/{id}/status` (the CI surface) | 100 ms |
| `task_complete` | `PATCH /api/canvas/actions/{id}` → `done` | — (reported) |
| `seed_batch` | `POST /api/canvas/actions/batch` (harness, not fleet traffic) | — |

Plus two non-latency targets: **sustained 100 task-ops/sec** (every op in the
table above except `connect` and `seed_batch`, over the measured window) and
**zero double-claims**.

The mix is a scenario field, so a new profile is a struct literal in
`scenario.go` — for example a CI-shaped fleet with `Claim` and `StatusPost` high
and `ContextGet` at zero.

---

## Reading the results file

Schema `tandem.loadtest.v1`. Top level: `run` (provenance), `targets`,
`scenarios`, `summary`, `scratch_canvases`. Per scenario: `params` (everything
needed to reproduce the load), `ops`, `server`, `invariant`,
`claim_cross_check`, `assertions`.

Two runs of the same scenario set diff cleanly: field order is fixed, map keys
are sorted, latencies are rounded to 3 decimals, and everything volatile
(timestamps, git rev, canvas codes) is confined to `run` and each scenario's
`canvas`.

```bash
diff <(jq '.scenarios[].ops' baselines/baseline-A.json) \
     <(jq '.scenarios[].ops' baselines/baseline-B.json)
```

### Client-side vs server-side — why both

The charter's targets are **server-side**: time spent inside the handler. That is
what the server can be held to. This tool's own measurement is that plus the
local network stack, the Go client's connection pool, and whatever else the
load-generating machine is doing while running 256 goroutines.

So after each scenario the tool scrapes `GET /api/metrics` and reports the
server's own view next to its own, and evaluates **every latency target against
both**, labelled `client` and `server`.

Three honest caveats, all annotated in the file itself:

- **The claim target is measured against a shared route.** `task_claim`,
  `claim_conflict`, `claim_stale` and `task_complete` are all
  `PATCH /api/canvas/actions/{id}` — one route pattern, one metrics series. The
  server cannot report a claim-only p95, so the server-side claim assertion
  covers all four. (Fixing that means changing the server, not the benchmark.)
- **Server percentiles cover all traffic, not just this scenario.** They are
  windowed (`window_seconds`) on current builds and all-time on older ones;
  either way, other traffic to the same box is in there. `count_delta` per route
  says how much of it this scenario contributed.
- **Throughput is offered load, not capacity.** A scenario cannot exceed
  `agents ÷ mean-latency` ops/sec however fast the server is, so a small-fleet
  scenario can miss the 100 ops/sec target with the server nowhere near
  saturated. The assertion is still evaluated and still reported — the caveat is
  a note on the assertion, not an excuse that suppresses it.

### Endpoints the server does not have

Tandem's router falls through to the SPA for unknown paths, so a missing API
endpoint answers **200 with HTML in about 5 ms**. A benchmark that trusted the
status code would report `context_get p95 = 5ms` and PASS.

Every response is therefore checked for `Content-Type: application/json`. A
non-JSON answer marks that op **unavailable**, the agents stop issuing it, and
its targets are recorded as `skipped` with the reason — never as a pass. Same for
`/api/metrics` itself: an absent or non-JSON metrics endpoint yields
`server.available = false` and skipped server-side assertions.

If a whole op shows up unavailable, the server you pointed at is older than the
feature. Rebuild it and re-run.

---

## The invariant check

`reconcile.go`, and it is the reason this tool exists. Two independent bodies of
evidence, required to agree task by task:

- **client** — each agent's own record of which tasks it won the atomic claim on
  and which it drove to `done`;
- **server** — the final state and `claimedBy` of every seeded task, read back in
  one list after the load stops (one list, not a GET per task: a single
  consistent read, and it runs *after* the metrics scrape so it cannot distort
  the numbers being reported).

Neither alone is proof. The client alone would miss a server that handed one task
to two agents and let the second overwrite `claimedBy`; the server alone would
miss two agents both believing they own a task whose row shows only the last
writer.

The result separates two things that are easy to conflate:

- **`double_claim_free`** — *the* answer. Did any task get claimed or completed
  by more than one agent. A run with unrelated problems still gives an
  unambiguous verdict on the core promise.
- **`ok`** — additionally requires state consistency: nothing left `executing`,
  every `done` task attributable to exactly one agent, client and server agreeing
  on who that was, and the recorder's op counts matching the agents' own sets.

A double-claim exits the process non-zero with a very loud banner. Missed latency
targets do not (use `-strict` if you want any failed assertion to fail the
command).

### Cross-check against the server's counters

TDM-42 gave the server its own `claims` / `claim_conflicts` counters. The tool
scrapes them before and after each scenario and compares the deltas with what it
saw on the wire — two independent instruments measuring the same events:

- **exact agreement** — the good case.
- **server counted more** — expected on a shared dev box: a browser tab or
  another session touched a queue during the run.
- **server counted fewer** — a real divergence, and the file says so. Nothing
  innocent explains the server counting fewer claims than the benchmark received
  `200`s for.

Against a server with no counters block (a build predating TDM-42) the check is
recorded as unavailable, never as agreement.

---

## The abort guard and the escalation gate

Both exist because this suite is expected to run against shared infrastructure.

**The guard** watches a running scenario and aborts it when the error rate
exceeds `-max-error-rate` (default 10%, after at least 50 ops) or any op's p95
exceeds `-latency-ceiling` (default 10s). The ceiling is deliberately absolute
rather than a multiple of the charter targets: an API on localhost talking to a
database in another region misses those targets by construction, and a guard
tuned to them would abort every such run before it produced a single number. The
guard is there to catch a system falling over, not one that is merely slower than
we want.

**The gate** stops a scenario from starting if the previous one did not finish
clean — aborted, skipped, or above `-gate-error-rate` (default 1%). This is what
makes having 256 agents in the default `all` set safe: escalating concurrency
against a backend that already showed errors at 64 produces an outage, not a
data point. `-force` overrides it; the skip and its reason are recorded either
way.

---

## Flags

| flag | default | meaning |
|---|---|---|
| `-api` | *(required)* | base URL, e.g. `http://localhost:7891` |
| `-scenarios` | `agents-8,agents-64` | names, `all`, or `custom` |
| `-agents` `-queue-depth` `-rounds` `-ops` | 32 / 24 / 4 / 12 | shape of `custom` |
| `-out` | `cmd/loadtest/baselines/baseline-<ts>.json` | results path |
| `-json` | off | also print the results JSON on stdout |
| `-keep` | off | leave seeded tasks behind |
| `-code` | *(none)* | run against an existing (throwaway) canvas instead of creating scratch ones |
| `-seed` | 1 | RNG seed — same seed, same sequence of op choices |
| `-strict` | off | exit non-zero on any failed assertion, not only a broken invariant |
| `-max-error-rate` | 0.10 | guard: abort above this error rate |
| `-latency-ceiling` | 10s | guard: abort above this p95 |
| `-gate-error-rate` | 0.01 | gate: don't escalate past this error rate |
| `-force` | off | ignore the gate |
| `-timeout` | 30s | per-request HTTP timeout |

Exit codes: `0` fine (even with missed latency targets), `1` double-claim, fatal
error, or `-strict` with failures, `2` bad flags.
