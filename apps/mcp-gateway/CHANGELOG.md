# Changelog — @jaximus/tandem-mcp

## Unreleased

### `doc_read` — read a document tab back without leaving the facade (TDM-179/180)

- **New `doc_read`** on the default surface: `doc_write`'s twin. `document` is the
  tab's NAME (case-insensitive, the one you gave `doc_write`) or its id, and you
  get that tab's notes in board order, each with its markdown and its `noteId`.
  `context_get` lists the tabs; an unknown name comes back naming the ones that
  exist rather than erroring blind.
- **It retires the workaround.** Reading canvas-hosted docs used to mean decoding
  the `session` handle for its token and hand-building a whole-canvas read against
  the raw API, then filtering by `documentId` client-side. That recipe is gone from
  the docs: the read is now scoped server-side (`GET
  /api/canvas/documents/{ref}/notes`, TDM-179), so one tab never drags the rest of
  the canvas along.
- Keep the `noteId` of anything you'll revise — `doc_write` without it appends a
  second note instead of updating the one you just read.
- The default manifest is now **17 tools**.

### `queue_wait` — wait for approval instead of ending your turn (TDM-149)

- **New `queue_wait`** on the default surface: ONE call that returns the moment
  approved work exists. An MCP agent has no sleep and no blocking call, so "poll
  the queue on a backing-off interval" is an instruction it cannot follow — it
  ends its turn instead, and the human has to prompt it a second time to notice
  an approval that already landed. The waiting now happens on the server (the
  API's `GET /api/canvas/queue/wait`), and this is the call that reaches it.
- **Answers on `status`, always 200-shaped:** `ready` (approved tasks, each
  already carrying the same paste-ready `handoff` block `queue_next` attaches, so
  the next step is claim or dispatch with nothing to compose), or `timeout`
  (nothing yet — stated plainly as *not* an error, with "call again" as the
  instruction, because a timeout that reads like a failure trains agents out of
  the one tool that keeps them alive).
- **Degrades instead of throwing.** Against an API older than the gateway it
  answers `status: "unsupported"`; against a canvas at its waiter cap,
  `status: "busy"`. Both read the queue for you first, so the answer still
  carries any work that was already there.
- `timeoutSeconds` defaults to 25, clamped 1–60 client-side; `epicId` narrows the
  wait to one batch (e.g. the epic you just proposed). The request's client
  deadline is derived from the wait, so a long wait can no longer be aborted by
  the shared 15s request budget.
- `epic_propose` and the server instructions now point at `queue_wait` rather
  than at interval polling. The default manifest is now **16 tools**.

### `task_find`, and a board read you can report from (TDM-95)

- **New `task_find`** on the default surface: find a task by NAME when you have
  no id ("the constraints task"). Matching is substring-then-all-words over
  titles, then bodies, with `matchedIn` saying which rule fired; `state` /
  `assignee` / `limit` narrow it. It returns only the matches, so turning a
  description into an id no longer costs a full board read. A ticket ref
  ("TDM-21", "#21") is resolved directly instead of searched — and an unknown one
  comes back as zero matches, not an error.
- **`board_status` in-flight rows are report lines**, not just names: each
  carries `ticketId`, the holder, `claimAgeMinutes`, the last progress note
  (`lastProgress`), and `staleClaim: true` once nothing has been reported for
  longer than the claim lease (~15 min), plus a `_staleClaims` summary. An
  orchestrator can now say where every worker stands from one read instead of
  `task_get`-ing each executing task.
- Requires nothing new from the API. The default manifest is now **14 tools**.

### `task_progress` is a heartbeat that extends your claim (TDM-67)

- `task_progress` now reports through the inbound status endpoint
  (`POST /api/canvas/{code}/tasks/{id}/status` with `state: "progress"`) under
  the caller's claimant identity, instead of client-side editing the task
  payload. Each report **refreshes the claim lease** server-side, so a worker
  that heartbeats through an hour of real work no longer has its ~15-minute
  claim expire and the task reclaimed underneath it.
- The "is this task mine?" check moves from this process to the server. A
  non-holder's report is rejected and comes back as **data** —
  `{ recorded: false, reason: "claimed_by_other", claimedBy, message }` (or
  `reason: "not_executing"` with the current `state`) — never a thrown error
  mid-work.
- Success now reflects what the server actually stored: `entries` counts the
  task's real progress log, and `claimedAt` / `leaseExtended` show the refreshed
  lease. `percent` is folded into the reported line, since the stored entry is
  `{at, agent, note}`.

### `canvas_connect` registers you too — one call (TDM-61)

- `canvas_connect` accepts `role` ('planner' | 'executor'), `name`, `model` and
  `parentAgentId`. With `role` present it ALSO registers the agent, and returns
  `agentId` plus a `session` handle **already carrying that identity** — so the
  very next `task_claim` runs under the registered name. A subagent handed only
  the canvas code can now come up under its planner in one call, which is what
  makes the fleet tree form; a separate registration call was a step it could
  (and did) skip.
- A `parentAgentId` the canvas rejects no longer kills the session: the
  registration is retried **unparented** and the problem comes back as data on
  `agent.problem`. Working unparented beats not working.
- `agent_register` is now on the DEFAULT (facade) surface — 12 tools instead of
  11 — for re-registration after connect: fixing a bad parent id, recording the
  model, switching role.

### `task_complete` carries evidence links (TDM-45)

- `task_complete` / `canvas_task_complete` accept `links: string[]` — the GitHub
  commit, pull request, and branch URLs the work produced. They ride the same
  PATCH as the completion (no extra round trip) and the API appends them to the
  task additively, exactly as the inbound status API's `links[]` does for a CI
  curl.
- The board resolves GitHub links live (merged / open / checks failing) through
  a read-only server-side proxy, so a human reads what HAPPENED rather than only
  the agent's summary of it. Non-GitHub URLs are kept as plain links.

### `MCP_TRACE` — per-tool-call latency and a session summary (TDM-43)

- **One stderr line per tool call**: tool name, total handler duration, the API
  time inside it, how many HTTP requests it made, and ok/error. `MCP_TRACE=1`
  for human-readable `key=value` lines, `MCP_TRACE=json` for one JSON object per
  line (scrapeable). Never stdout — that's the MCP wire.
- **Session summary on exit** (SIGINT / SIGTERM / stdin close): total calls and
  errors, session length, total API time vs handler overhead, and per-tool
  total/avg/max for the top 5 tools by total time. Prefixed
  `[tandem-mcp] summary` so the block greps out of an interleaved log.
- API time is attributed at `Gateway.safeFetch`, the single choke point every
  request goes through, via an `AsyncLocalStorage` accumulator — so a call's
  round-trips are counted even when tool dispatch overlaps.
- **Free when off**: no accumulators, no clock reads and no signal handlers are
  installed unless tracing is enabled. `TANDEM_MCP_TIMING` remains as an alias
  for `MCP_TRACE=1` (its old `[timing] <tool> <ms>ms` line is now the richer
  `[tandem-mcp] call …` line).
- The sidecar's existing `MCP_TRACE` per-request routing trace is unchanged (on
  by default, off with `MCP_TRACE=0`), and now also accepts `off`/`false`/`no`.

### `init` — one command from nothing to a connected canvas (TDM-33)

- **`npx @jaximus/tandem-mcp init`** creates a canvas, registers the MCP server
  in the project's `.mcp.json`, prints the share code + board URL (+ the
  private claim link for a canvas it just created), and prints an
  `AGENTS.md`/`CLAUDE.md` snippet that teaches the queue-first loop in the
  facade's vocabulary. `--write` appends the snippet; `--name`, `--code`,
  `--force`, `--dir` for the rest.
- **The `.mcp.json` write is a merge, never a clobber**: other MCP servers and
  unknown top-level keys survive verbatim, and an existing `tandem` entry keeps
  its own `command`/`args`/`env` (a local-dev entry pointing at `node
  dist/index.js` isn't overwritten) — only the canvas code is authoritative.
- **Re-running is a no-op**: if `.mcp.json` already pins a canvas code, `init`
  reprints it, touches neither disk nor network, and exits `0`. `--force`
  creates a fresh canvas; `--code` repoints at an existing one.
- New env var **`TANDEM_CANVAS_CODE`** (what `init` writes): named inside the
  `canvas_connect` tool description so the agent knows which canvas the project
  belongs to without the human repeating the code, and used as the default when
  `canvas_connect` is called without one.
- `tandem` is now a bin alias for `tandem-mcp`, so a global install gets
  `tandem init`. (`npx tandem` still resolves to an unrelated npm package — use
  the scoped name with npx.)
- No change to the default behaviour: no args (or any flag) still starts the
  stdio MCP server; `init` is the only subcommand.

### Intent facade replaces CRUD as the default manifest (TDM-32)

- **The default surface is now 10 tools**, shaped like the work loop instead
  of the API: `canvas_connect`, `context_get`, `queue_next`, `task_get`,
  `task_claim`, `task_progress`, `task_complete`, `task_propose`, `doc_write`,
  `board_status`. The ~80-tool CRUD manifest cost a large slice of a session's
  context window before it did anything, and left the model to invent the
  workflow; the facade encodes it — connect → queue_next → task_get →
  task_claim → work → task_complete.
- **The full CRUD surface is one opt-in away**: `TANDEM_FULL_TOOLS=1` (or
  `tandem-mcp --full-tools`) advertises it *alongside* the facade. The flag
  only controls what's **advertised** — every CRUD tool stays callable by name
  either way, so existing prompts and older clients don't break.
- New composed behaviour, not just renames: `context_get` returns a canvas
  briefing in one call (identity + tabs + counts + queue state, never the full
  board); `doc_write` creates the notes tab you name if it doesn't exist yet;
  `board_status` answers "where does this stand" without a canvas read;
  `task_progress` records mid-flight progress on the task itself, so
  `task_get` returns it.
- No webhook tool exists in any manifest, and none may be added — an
  agent-facing tool that configures outbound HTTP turns attacker-influenced
  canvas content into a data-exfiltration channel. Webhooks are configured by a
  human in the web UI only. Pinned by a test.

## 2.3.0 — 2026-07-28

The pivot release: Tandem is the shared state layer for parallel agent
sessions, and the gateway's core surface is now a durable task queue.
(2.2.1 was an interim patch publish of an early cut of this surface; 2.3.0
is the properly versioned release — new tools = minor bump.)

Everything user-visible since 2.2.0 (2026-07-17):

### Task queue & epics

- **Epics + approve-once fan-out** — `canvas_epic_add` proposes a named batch
  of tasks approved as ONE unit. Canvas approval policy `strict | epic | auto`
  (default `epic`): tasks added under an already-approved epic are born
  approved; tasks added while the epic is proposed are batch-approved the
  moment the human approves the epic.
- **Per-canvas ticket IDs** — every task gets a `TDM-n` ticket, returned as
  `ticketId` from `canvas_task_add` / `canvas_task_start`, for commit
  messages and chat. Results should include commit hashes (the tools now say
  so).
- **Atomic claiming with attribution** — `canvas_task_start` claims are
  atomic; the loser gets `{ claimed: false, claimedBy }` and moves on. The
  claimant's name shows on the board; humans can release a stuck claim from
  the web UI. `canvas_task_complete` must present the same identity that
  claimed (`agentName`), and supports `status: "failed"` + `error`.
- `canvas_task_list` returns a compact queue (ticketId, state, claimedBy,
  epicId/epicState) — no bodies; `canvas_task_get` hydrates one task's
  linked context.

### Agent identity & swarms

- **Session-handle identity** — `agent_register` returns an UPDATED `session`
  handle carrying the agent's identity; passing it on every call keeps
  claims/completions attributed even when the hosted MCP connection resets
  between calls.
- **Swarm registration** — `agent_register` takes `parentAgentId`, so an
  orchestrator (role `planner`) can thread its agentId into subagents (role
  `executor`) and the web presence view nests the swarm under it. Registering
  the same name upserts (refreshes) the same agent instead of duplicating;
  claims create presence.

### Everything else

- Repositioned package copy: shared state layer / task queue for parallel
  agent sessions (package description + README, including a task-queue tool
  table and example session).
- Batch tools: per-type `*_update_batch` and `*_delete_batch` across pins,
  events, notes, documents, roadmap items, sheets, charts, forms — one write
  and one live update instead of a round trip per item; tool descriptions
  steer bulk edits to them.
- Gateway proxy: request timeouts, latency logging, and per-tool timing.
- `mcpName` field (`io.github.jaximus808/tandem-mcp`) in package.json, so this
  npm publish doubles as the ownership proof for the official MCP registry
  (registry.modelcontextprotocol.io) — no separate republish needed.
- MCP behaviour annotations (`readOnlyHint` etc.) on every tool so clients
  such as the claude.ai connector can auto-approve reads instead of prompting
  per call.

## 2.2.1 — 2026-07-28

Interim publish of an early cut of the 2.3.0 surface above. Superseded by
2.3.0.

## 2.2.0 — 2026-07-17

- Documents, sheets, charts, forms tool surface; `*_add_batch` tools; UI
  sync improvements.

## 2.0.x — 2026-05/06

- Initial public releases: stdio MCP gateway with canvas connect, pins,
  events, notes, roadmap, pending edits.
