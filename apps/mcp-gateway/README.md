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

| Env var        | Default                    | Purpose                                                                                                                                             |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_URL`      | `https://tandemcanvas.com` | Tandem HTTP API base URL. Only set this to override the default.                                                                                    |
| `TANDEM_TOKEN` | _(unset)_                  | Personal access token — lets the agent act as **you** on your private and shared canvases. Mint one at `/me`. Without it, only public canvases work. |

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

The task-queue core:

| Tool                              | Purpose                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `canvas_connect`                  | Bind the session to a canvas by 8-char code. Required first.                                |
| `canvas_create`                   | Create a new canvas and bind to it in one step.                                             |
| `agent_register`                  | Register this session's identity (name, role; `parentAgentId` groups a swarm's executors under their orchestrator). Returns an updated `session` handle — pass it on every later call. |
| `canvas_epic_add`                 | Propose a named batch of tasks approved as one unit. Human approves once; tasks under it fan out to approved. |
| `canvas_task_add` / `_add_batch`  | Propose tasks (land as `proposed`; born approved under an already-approved epic).           |
| `canvas_task_list`                | The queue, compact: pass `state: "approved"` for ready-to-work tasks.                       |
| `canvas_task_get`                 | One task with its linked context hydrated — all a session needs to start.                   |
| `canvas_task_start`               | Atomic claim (`approved` → `executing`). Losers get `{ claimed: false, claimedBy }`.        |
| `canvas_task_complete`            | Finish with a `result` (include commit hashes), or `status: "failed"` + `error`.            |

Plus the full canvas surface — documents, notes, roadmap items, sheets, charts, forms, map pins, timed events — each with `add` / `update` / `delete` and `_batch` variants, and `canvas_state_read` for a summary snapshot. Full schemas are returned by the MCP `tools/list` request, or visible in [`src/tools.ts`](https://github.com/jaximus808/tandam/blob/main/apps/mcp-gateway/src/tools.ts).

## Example session

```text
agent: canvas_connect { "code": "AB3XK9QZ" }
  → { connected: true, canvasName: "acme-api", url: "https://tandemcanvas.com/c/AB3XK9QZ" }

agent: agent_register { "role": "executor", "name": "exec-1" }
  → { agentId: "…", session: "…" }        # use the returned session handle from here on

agent: canvas_task_list { "state": "approved" }
  → [{ id: "…", ticketId: "TDM-7", title: "Add rate limiter", state: "approved" }, …]

agent: canvas_task_start { "id": "…" }
  → { claimed: true, action: { ticketId: "TDM-7", … } }
    # another session got { claimed: false, claimedBy: "exec-1" } and took the next task

  …work happens; commits start with "TDM-7: …"…

agent: canvas_task_complete { "id": "…", "result": "Rate limiter added — commit a1b2c3d" }
```

The human watches the board move in the browser — cards flip to *executing* with the claimant's name, results land as tasks complete — in real time, no refresh.

## Multi-agent

Any number of sessions connect to the same canvas and pull the same queue; claims are atomic, so each task has exactly one winner. For orchestrated swarms, the orchestrator registers as role `planner` and threads its returned `agentId` into each subagent's spawn prompt; each subagent registers as role `executor` with `parentAgentId` set to that id, so the board shows the swarm grouped under its orchestrator.

The canvas is the shared blackboard. Hand-offs happen through canvas state, not a shared prompt — so you can mix vendors (Claude, GPT, local) without rewriting the orchestration.

## License

MIT © Jaxon Parker
