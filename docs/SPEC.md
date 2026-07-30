# Tandem MVP Spec — The Coordination Plane

**Status:** Ratified 2026-07-28 (5-round adversarial review; charter ratified by both agents).
**Ship target:** everything below in one week; public post after the weekend.
**Stack ruling:** current stack (Go API + Supabase + WS hub + React + Node MCP gateway). No distributed-systems work until real users demand it — but every op gets measured now so we know when that day comes.

---

## 1. Charter

**Tandem — the coordination plane for agent fleets that span machines and models.**
One hosted queue, live context, and a human approval gate, wherever your agents run.

**Who it's for — two jointly load-bearing drivers:**

1. **Compute topology** *(gap validated, demand gated)* — fleets on sandbox-per-task cloud infra or spanning local + cloud + CI have **no shared filesystem by design**; and the human gate is always a second machine (your phone is not the fleet's box). File-based coordination (PLAN.md, worktrees, Anthropic's machine-local task lists — falsifier-confirmed disconnected from cloud sessions) is structurally unavailable here.
2. **Vendor freedom** *(reachable, demand unproven)* — mixed Claude + Codex + Grok fleets. Universal MCP-client support (incl. Grok Build's zero-reconfig Claude-Code-MCP compat) makes every such agent reachable today. Demand test: the Tesla lunch test.

**Why now:** the vacant slice is exactly *hosted + execution-decoupled + cross-machine + vendor-neutral*. Anthropic's task lists are machine-local files; Bloop/Vibe Kanban commercial is dead (demand proven, venture economics disproven); Terragon dead; Grok Build ships 8-way parallelism with zero coordination surface. Clock assumption: 0–6 months before Anthropic ships Claude-only task sync.

**The sentence that survived five rounds untouched:** agents that don't share a filesystem need a queue that lives somewhere — and nobody sells them one.

## 2. Out of scope (permanent-until-gate)

- **Launching/running agents.** Launchable-FROM every launcher (webhook → your runner), never the launcher.
- **Orgs / RBAC / accounts.** A team is a canvas. Share-code-per-canvas is the v1 team model.
- **Protocol invention.** Ride MCP + AGENTS.md; document (don't implement) the A2A mapping.
- **New canvas surfaces.** Frozen. Docs/sheets remain as agent-output containers only.
- **Monetization.** Not now.
- **Free-floating agent inbox.** Settled: state, not messaging. Handoffs go in task result/notes. Threaded comments on tasks only if a real user asks twice (founder counts as at most one of the two asks).
- **Self-host/OSS distribution** — deferred decision, not rejection. The enterprise model-freedom segment needs it someday; revisit at gate.
- **Distributed systems / horizontal scale.** Post-launch, gated on users. Current stack + numbers first.

## 3. Known limit (named on purpose)

The human approval gate is the fleet's serialization point — fine at 8 agents, the ceiling at 64. Policy-based supervision (risk-tiered auto-approve, batch/sampling review) is reserved future in-scope. Nothing built before the gates resolve.

---

## 4. Feature specs

### F1 — Canvas Briefing / `context_get`
- One designated briefing document per canvas (`briefing_doc_id` on canvas, or `is_briefing` flag).
- New intent tool + API endpoint `context_get(taskId?)` returns in ONE call: briefing doc + approved-queue summary + (if taskId) hydrated task bundle (existing linkedIds hydration) + freshness annotations.
- Output is markdown structured in **AGENTS.md-shaped sections** so any agent trained on the standard parses it natively.
- Works for repo-less agents (a marketing agent has no repo; it has a tool call).

### F2 — AGENTS.md bridge
- **Import:** paste/URL a repo's AGENTS.md into the canvas briefing (v1: manual import path; file-sync later).
- **Export:** the `context_get` formatter (above) — Tandem serves live state in AGENTS.md clothing. We never invent a rival format.

### F3 — Freshness metadata
- Migration: `verified_at timestamptz`, `stale_after_seconds int` (nullable) on documents, notes, roadmap items.
- Staleness derivation (pure function, table-driven tests): `fresh` / `aging` (>50% of window) / `stale` (past window or never verified beyond default).
- `context_get` annotates and orders by freshness. Web UI shows badges + a stale-review affordance.
- **Honest claim only:** Tandem makes rot *visible and cheap to reconcile*. It does not prevent rot. Marketing must never say otherwise.

### F4 — State-not-prose *(built; positioning only)*
Typed task lifecycle, atomic claims (typed already-claimed error), claimant identity, TTL recovery. Zero new code.

### F5 — Self-healing staleness
- Claim TTL expiry already exists → surface expiries as events in the activity feed (+ `task.claim_expired` webhook).
- Inbound status API (below) updates state with no agent in the loop.

### F6 — Delta briefing *(deferred, 60-day)*
`context_get(since: <session marker>)` — returns only changes since last connect. Depends on F1–F3.

### Intent facade (14 tools) + `npx tandem init`
- The facade **replaces** the 80-tool CRUD surface as the **default** connector manifest. Full CRUD moves behind an opt-in flag (`TANDEM_FULL_TOOLS=1`, or `tandem-mcp --full-tools`). Fourteen tools on top of eighty is tool ninety-four — the default surface IS the facade.
- Shipped set (`apps/mcp-gateway/src/facade.ts`): `canvas_connect` (kept; also mints identity via `role`), `agent_register`, `context_get`, `queue_next`, `task_find`, `task_get`, `task_claim`, `task_progress`, `task_complete`, `task_propose`, `task_amend`, `epic_propose`, `doc_write` (agent output container), `board_status`. This planned at ~10; `agent_register` and `epic_propose` were added during E2/E9, `task_amend` in TDM-117 and `task_find` in TDM-95, so **14 is the number** — it is what `manifest.test.ts` asserts and what the docs must say.
- `npx tandem init` (bin in `@jaximus/tandem-mcp`): create canvas → register MCP config → print share code → emit CLAUDE.md/AGENTS.md snippet.
- **Acceptance test:** an agent completes a real job in ≤5 tool calls with no usage manual (the founder's friction log is the test).

### Webhooks (outbound) + inbound status API
- **Outbound v1 — three events only:** `task.approved` (dispatch trigger), `task.completed`, `task.claim_expired`.
- Payload: `{event_id (uuid, idempotency), type, timestamp, canvas_id, task: {id, title, body, state, claimant, linkedIds}, attempt}`.
- **Linear-shape delivery:** per-webhook signing secret; `Tandem-Signature: hmac-sha256(raw body)` + `Tandem-Timestamp` (60s replay window; docs mandate timing-safe compare); 5s timeout; 3 retries w/ backoff (1m/10m/1h); visible dead-letter list on the canvas.
- **Registration v1:** one webhook per canvas (URL + secret + event filter), **configured in the web UI by a human only. There is NO MCP tool to set webhooks — non-negotiable** (prompt-injected agents must not exfiltrate the queue).
- **Inbound status API:** `POST /api/canvas/{code}/tasks/{taskId}/status`, canvas-scoped bearer token, body `{state: started|progress|completed|failed, summary, links[]}`. A GitHub Action or Modal function is a first-class fleet member — no MCP client, no polling. Thin HTTP skin over existing task_start/task_complete store paths; async broadcast pushes live.

### GitHub ground truth *(fenced)*
v1 = task completion carries commit/PR/branch references; board displays live status (merged/open/red). **Read-only. No GitHub write path. No sync engine.** Priority below webhooks.

### Provenance v1 (gate integrity)
- Authorship on queue items: `authored_by` (human | agent:<id> | anonymous), stamped server-side from the auth context, never client-supplied.
- **Content mutation is covered by the gate:** editing an approved task's title/body reverts it to `proposed` (re-approval required) + an audit entry. An agent must not be able to change what the human approved.
- Agent-writable config prohibited (webhooks, briefing designation = human/UI only).
- UI: provenance chips on tasks; re-approval flow.

---

## 5. Observability & performance (NON-NEGOTIABLE FOR MVP)

Agent processes push enormous op rates; if Tandem is slow it gets dropped. We need **numbers to work on and tests to run** from day one.

### Metrics (in-process, current stack — no new infra)
- API middleware: per-route + per-intent-op latency histograms (in-memory sliding window), p50/p95/p99.
- Counters: `claims_total`, `claim_conflicts_total` (already-claimed errors — the contention signal), `ttl_expiries_total`, `webhook_deliveries{ok|failed}`, `status_api_posts`, `ws_clients`, `broadcast_fanout_ms` histogram.
- **`GET /api/metrics`** returns the JSON summary (per-op p50/p95/p99 + counters + uptime). Optional Prometheus text format later.
- Gateway: per-tool-call latency logging (extends MCP_TRACE) + session summary line.

### Performance targets (assert in benchmarks; publish baseline numbers)
| Op | Target (server-side p95) |
|---|---|
| task_claim | < 100 ms |
| queue_next / task_get | < 150 ms |
| context_get | < 250 ms |
| inbound status POST | < 100 ms |
| WS broadcast fan-out (50 clients) | < 200 ms |
| sustained mixed load | 100 task-ops/sec, zero double-claims |

### Benchmark suite
Extend `apps/api/cmd/loadtest` (reconcile.go already fails on double-claims) into scenario benchmarks: 8 / 64 / 256 concurrent agents; mixed op profiles; asserts the targets above + the zero-double-claim invariant; emits a machine-readable results file so baselines are diffable run-over-run. Go `testing.B` benches for the hot store paths (claim, queue list, staleness derivation).

---

## 6. Ship plan (this week)

| Epic | Contents | Order |
|---|---|---|
| **E1 · Live context & freshness** | freshness+briefing migration · store fields + staleness fn + tests · `context_get` endpoint + AGENTS.md formatter · UI badges | 1 |
| **E2 · Intent facade & init** | facade as default manifest (CRUD opt-in) · `npx tandem init` · ≤5-call acceptance run | 1 (parallel) |
| **E3 · Webhooks & status API** | webhook tables migration · delivery worker (HMAC/retries/dead-letter) · 3 events wired · inbound status API + canvas token · UI config + dead-letter list | 2 |
| **E4 · Provenance & gate integrity** | authored_by · content-mutation re-approval + audit · UI chips | 2 |
| **E5 · Observability & perf** | metrics middleware + /api/metrics · gateway per-tool latency · benchmark scenarios + baseline numbers published | runs alongside everything |
| **E6 · GitHub ground truth (fenced v1)** | completion refs + live PR status display (read-only) | 3, if week allows |

**Post-weekend:** cross-machine demo filmed (local + cloud draining one queue, phone approval) → launch post. Then: cross-vendor Referee Demo (Claude+Codex) → Grok variant + Tesla lunch test.

**Division of labour:** code + builds + tests in this repo (all three packages must build, Go tests green). Jaxon: apply migrations, deploy, runtime QA, git.

## 7. Gates (unchanged)

1. **Transfer test** — queue driven against a second, unrelated repo for two weeks. Run first; costs nothing.
2. **One external supervisor** — returns in three separate weeks for three distinct jobs. Mandatory. Self-produced demos never count as hits.
3. **Zero hits in 90 days → pre-committed mothball** (personal tool, zero feature investment).

*War room (full 5-round debate record): https://claude.ai/code/artifact/5dc7cea9-481e-4fa9-80ef-a9ac864ae17d*
