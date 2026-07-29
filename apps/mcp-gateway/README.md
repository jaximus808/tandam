# @jaximus/tandem-mcp

MCP server for [Tandem](https://github.com/jaximus808/tandam) — the shared state layer for teams running parallel agent sessions: a durable task queue any session can claim from without colliding, with a live board humans watch in the browser.

This is a standard [Model Context Protocol](https://modelcontextprotocol.io) stdio server. It is **not Claude-specific**. Any MCP-aware client — Claude Code, Cursor, Windsurf, Codex CLI, the OpenAI Agents SDK, or a custom orchestrator — can spawn this gateway, connect to a canvas by code, and read or write the same canvas a human is looking at in their browser.

## What it does

When you connect, you bind the MCP session to one canvas. From then on, every tool call operates on that canvas, and every write is broadcast over WebSocket to every browser and every other agent subscribed to the same canvas code.

The core loop is the **task queue**: one session proposes work as tasks (grouped into epics), a human approves it once in the web UI, and any number of parallel sessions pull the approved queue, claim tasks atomically (exactly one winner per task — losers are told who won and move on), and complete them with results. Every task carries a per-canvas ticket ID (`TDM-7`) for commit messages, and every claim shows the claimant's name on the live board.

## Quick start

From inside your project directory:

```bash
npx @jaximus/tandem-mcp init
```

One command takes you from nothing to a wired-up project. It:

1. creates a canvas (named after the folder, or `--name "My board"`),
2. merges a `tandem` entry into the project's `.mcp.json` — other MCP servers are left exactly as they were — pinning the canvas code as `TANDEM_CANVAS_CODE`,
3. prints the share code, the board URL, and (for a canvas it just created) the private claim link that makes it yours,
4. prints an `AGENTS.md` / `CLAUDE.md` snippet teaching agents the queue-first loop — `--write` appends it for you.

Then restart your agent CLI so it picks up the new server.

| Flag           | Effect                                                            |
| -------------- | ----------------------------------------------------------------- |
| `--name <name>` | Name for the new canvas. Default: the folder's name.              |
| `--code <CODE>` | Wire up an **existing** canvas instead of creating one.           |
| `--write`       | Append the queue snippet to `AGENTS.md` / `CLAUDE.md`.            |
| `--force`       | Create a new canvas even if this project is already wired.        |
| `--dir <path>`  | Project directory to configure. Default: cwd.                     |

**Re-running is safe.** If `.mcp.json` already points the `tandem` server at a canvas, `init` prints that code and URL, changes nothing, and exits `0`. Use `--force` to create a fresh canvas, or `--code` to repoint.

## Install

### npx (recommended)

No install. Drop this into your MCP client config:

```json
{
  "mcpServers": {
    "tandem": {
      "command": "npx",
      "args": ["-y", "@jaximus/tandem-mcp"]
    }
  }
}
```

This connects to the hosted backend at `https://tandemcanvas.com` out of the box — no `API_URL` needed. To point at a local or self-hosted instance, add `"env": { "API_URL": "http://localhost:7891" }`.

### Global install

```bash
npm install -g @jaximus/tandem-mcp
# then in MCP config:
#   "command": "tandem-mcp"
# and on the CLI, `tandem` is an alias for the same binary:
#   tandem init
```

(`npx tandem init` will **not** work — `tandem` is an unrelated package on npm. Use the scoped name with npx, or install globally for the short `tandem` command.)

### From source

```bash
git clone https://github.com/jaximus808/tandam.git
cd tandam
pnpm install
pnpm --filter @jaximus/tandem-mcp build
# point your client at apps/mcp-gateway/dist/index.js
```

## Configuration

| Env var             | Default                    | Purpose                                                                                                                                             |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_URL`           | `https://tandemcanvas.com` | Tandem HTTP API base URL. Only set this to override the default.                                                                                    |
| `TANDEM_TOKEN`      | _(unset)_                  | Personal access token — lets the agent act as **you** on your private and shared canvases. Mint one at `/me`. Without it, only public canvases work. |
| `TANDEM_FULL_TOOLS` | _(unset)_                  | Set to `1` to also advertise the full CRUD surface (maps, sheets, charts, forms, …) alongside the default 10-tool facade. Same as `--full-tools`.    |
| `TANDEM_CANVAS_CODE` | _(unset)_                 | This project's canvas code, written by `init`. Named in the `canvas_connect` tool description so the agent knows which canvas it belongs to, and used as the default when it calls `canvas_connect` without one. |
| `MCP_TRACE`         | _(unset)_                  | Per-tool-call timing on stderr, plus a session summary on exit. `1` for human-readable lines, `json` for one JSON object per line. See [Tracing](#tracing). |
| `REQUEST_TIMEOUT_MS` | `15000`                   | Per-request timeout for calls to the Tandem API.                                                                                                    |

To connect as yourself, mint a token under **Access tokens** at [tandemcanvas.com/me](https://tandemcanvas.com/me) and add it to your MCP client config:

```json
{
  "mcpServers": {
    "tandem": {
      "command": "npx",
      "args": ["-y", "@jaximus/tandem-mcp"],
      "env": { "TANDEM_TOKEN": "tdm_pat_…" }
    }
  }
}
```

## Tracing

When a session feels slow, `MCP_TRACE` answers *which tool, and was it us or the network*. Everything it emits goes to **stderr** — stdout carries the MCP protocol frames — so it is safe to leave on and read from your client's MCP log.

```json
{
  "mcpServers": {
    "tandem": {
      "command": "npx",
      "args": ["-y", "@jaximus/tandem-mcp"],
      "env": { "MCP_TRACE": "1" }
    }
  }
}
```

### `MCP_TRACE=1` — human-readable

One line per tool call, then a summary block when the session ends:

```text
[tandem-mcp] call tool=canvas_connect ms=312.4 api=298.1 api_calls=1 ok
[tandem-mcp] call tool=queue_next ms=141.7 api=132.9 api_calls=1 ok
[tandem-mcp] call tool=task_claim ms=96.2 api=88.0 api_calls=1 error
[tandem-mcp] summary session=94.2s calls=3 errors=1 handler=550.3ms api=519.0ms(94%) overhead=31.3ms http=3
[tandem-mcp] summary tool=canvas_connect calls=1 total=312.4ms avg=312.4ms max=312.4ms api=298.1ms errors=0
[tandem-mcp] summary tool=queue_next calls=1 total=141.7ms avg=141.7ms max=141.7ms api=132.9ms errors=0
[tandem-mcp] summary tool=task_claim calls=1 total=96.2ms avg=96.2ms max=96.2ms api=88.0ms errors=1
```

| Field       | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `ms`        | Total time inside the tool handler.                                                        |
| `api`       | Sum of the HTTP round-trips to the Tandem API made during that call.                       |
| `api_calls` | How many HTTP requests the call made — a `2` on a "single" operation is worth a look.      |
| `ok`/`error`| Whether the tool returned a result or an error payload.                                    |
| `overhead`  | (summary) `handler − api`: everything that wasn't waiting on the API.                      |
| `session`   | (summary) Wall-clock length of the whole session.                                          |

The summary shows the **top 5 tools by total time**; anything past that collapses into a `+N more tools` line. Every line is prefixed `[tandem-mcp] summary`, so `grep 'tandem-mcp. summary'` pulls the whole block out of an interleaved log.

### `MCP_TRACE=json` — machine-readable

Same fields, one JSON object per line, so the numbers can be scraped straight out of the log:

```text
{"t":"call","ts":"2026-07-29T05:25:47.373Z","tool":"canvas_connect","ms":312.4,"apiMs":298.1,"apiCalls":1,"overheadMs":14.3,"ok":true}
{"t":"call","ts":"2026-07-29T05:25:52.118Z","tool":"queue_next","ms":141.7,"apiMs":132.9,"apiCalls":1,"overheadMs":8.8,"ok":true}
{"t":"summary","sessionMs":94200,"calls":2,"errors":0,"handlerMs":454.1,"apiMs":431,"overheadMs":23.1,"apiPct":95,"apiCalls":2,"tools":[{"tool":"canvas_connect","calls":1,"errors":0,"totalMs":312.4,"avgMs":312.4,"maxMs":312.4,"apiMs":298.1,"apiCalls":1},{"tool":"queue_next","calls":1,"errors":0,"totalMs":141.7,"avgMs":141.7,"maxMs":141.7,"apiMs":132.9,"apiCalls":1}],"hiddenTools":0,"hiddenMs":0}
```

### Notes

- **Off by default, and free when off.** Unset (or `0` / `off` / `false`) allocates no timers, no accumulators and no clock reads, and installs no signal handlers. `TANDEM_MCP_TIMING` still works as an alias for `MCP_TRACE=1`.
- **`api` measures the round-trip**, request sent → response headers received (including the full wait on a timeout or a connection failure). Reading and parsing the JSON body happens in the handler, so it lands in `overhead`.
- **The summary prints on the way out**: `SIGINT`, `SIGTERM`, or the client closing stdin — the normal end of an MCP stdio session. A session that made no tool calls prints nothing.
- The hosted HTTP sidecar honours the same variable; it also keeps its own per-request routing trace, which is on by default there and silenced with `MCP_TRACE=0`.

## Tools

The default surface is a **10-tool intent facade** shaped like the work loop, not like the API:

| Tool             | Purpose                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `canvas_connect` | Bind the session to a canvas by 8-char code. Required first; returns the `session` handle and the share URL. |
| `context_get`    | The canvas briefing in one cheap call — identity, mode, document tabs, per-kind counts, queue state.        |
| `queue_next`     | The approved tasks ready to work, compact. The entry point for work.                                        |
| `task_get`       | One task with its linked context hydrated — all a session needs to start.                                   |
| `task_claim`     | Atomic claim (`approved` → `executing`). Losers get `{ claimed: false, claimedBy }` and move on.             |
| `task_progress`  | Mid-flight progress on a task you claimed; stored on the task, returned by `task_get`.                       |
| `task_complete`  | Finish with a `result` (include commit hashes) plus `links` (commit / PR / branch URLs), or `status: "failed"` + `error`. |
| `task_propose`   | Propose one task or a whole plan (`tasks: [...]`). Lands as `proposed` for human approval.                   |
| `doc_write`      | Leave context behind as a markdown note; names a tab and creates it if new.                                  |
| `board_status`   | Board-shaped overview — counts by state, in-flight claims, epics — without dumping the canvas.               |

The loop: `canvas_connect` → `queue_next` → `task_get` → `task_claim` → work (`task_progress`, `doc_write`) → `task_complete`.

Every tool but `canvas_connect` takes the `session` handle — pass it on every call, since the hosted connection can reset between calls.

### The full CRUD surface

Behind `TANDEM_FULL_TOOLS=1` (or `tandem-mcp --full-tools`) the gateway **also** advertises the ~80-tool CRUD surface — documents, notes, roadmap items, sheets, charts, forms, map pins, timed events, agent registration, epics — each with `add` / `update` / `delete` and `_batch` variants, plus `canvas_state_read`. It is additive: you get the facade *and* CRUD. Full schemas come back from the MCP `tools/list` request, or see [`src/tools.ts`](https://github.com/jaximus808/tandam/blob/main/apps/mcp-gateway/src/tools.ts).

Those tools stay **callable** either way — the flag decides what's *advertised*, so existing prompts that name `canvas_task_list` keep working against the default manifest.

## Example session

```text
agent: canvas_connect { "code": "AB3XK9QZ" }
  → { connected: true, canvasName: "acme-api", url: "https://tandemcanvas.com/c/AB3XK9QZ", session: "…" }

agent: queue_next { "session": "…" }
  → [{ id: "…", ticketId: "TDM-7", title: "Add rate limiter", state: "approved" }, …]

agent: task_get { "id": "…", "session": "…" }
  → { action: {…}, linked: [ …notes / roadmap items with the real brief… ] }

agent: task_claim { "id": "…", "session": "…" }
  → { claimed: true, action: { ticketId: "TDM-7", … } }
    # another session got { claimed: false, claimedBy: "exec-1" } and took the next task

  …work happens; commits start with "TDM-7: …"…

agent: task_complete { "id": "…", "result": "Rate limiter added — commit a1b2c3d",
                       "links": ["https://github.com/acme/api/pull/214"], "session": "…" }
```

The human watches the board move in the browser — cards flip to *executing* with the claimant's name, results land as tasks complete — in real time, no refresh. GitHub links passed to `task_complete` show a live status on the card (merged, open, checks failing), read straight from GitHub.

## Multi-agent

Any number of sessions connect to the same canvas and pull the same queue; claims are atomic, so each task has exactly one winner. For orchestrated swarms, the orchestrator registers as role `planner` and threads its returned `agentId` into each subagent's spawn prompt; each subagent registers as role `executor` with `parentAgentId` set to that id, so the board shows the swarm grouped under its orchestrator.

The canvas is the shared blackboard. Hand-offs happen through canvas state, not a shared prompt — so you can mix vendors (Claude, GPT, local) without rewriting the orchestration.

## License

MIT © Jaxon Parker
