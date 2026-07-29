# @jaximus/tandem-mcp

MCP server for [Tandem](https://github.com/jaximus808/tandam) — the shared state layer for teams running parallel agent sessions: a durable task queue any session can claim from without colliding, with a live board humans watch in the browser.

This is a standard [Model Context Protocol](https://modelcontextprotocol.io) stdio server. It is **not Claude-specific**. Any MCP-aware client — Claude Code, Cursor, Windsurf, Codex CLI, the OpenAI Agents SDK, or a custom orchestrator — can spawn this gateway, connect to a canvas by code, and read or write the same canvas a human is looking at in their browser.

## What it does

When you connect, you bind the MCP session to one canvas. From then on, every tool call operates on that canvas, and every write is broadcast over WebSocket to every browser and every other agent subscribed to the same canvas code.

The core loop is the **task queue**: one session proposes work as tasks (grouped into epics), a human approves it once in the web UI, and any number of parallel sessions pull the approved queue, claim tasks atomically (exactly one winner per task — losers are told who won and move on), and complete them with results. Every task carries a per-canvas ticket ID (`TDM-7`) for commit messages, and every claim shows the claimant's name on the live board.

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
```

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
| `task_complete`  | Finish with a `result` (include commit hashes), or `status: "failed"` + `error`.                             |
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

agent: task_complete { "id": "…", "result": "Rate limiter added — commit a1b2c3d", "session": "…" }
```

The human watches the board move in the browser — cards flip to *executing* with the claimant's name, results land as tasks complete — in real time, no refresh.

## Multi-agent

Any number of sessions connect to the same canvas and pull the same queue; claims are atomic, so each task has exactly one winner. For orchestrated swarms, the orchestrator registers as role `planner` and threads its returned `agentId` into each subagent's spawn prompt; each subagent registers as role `executor` with `parentAgentId` set to that id, so the board shows the swarm grouped under its orchestrator.

The canvas is the shared blackboard. Hand-offs happen through canvas state, not a shared prompt — so you can mix vendors (Claude, GPT, local) without rewriting the orchestration.

## License

MIT © Jaxon Parker
