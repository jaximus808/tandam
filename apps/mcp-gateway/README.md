# @tandem/mcp-gateway

MCP server for [Tandem](https://github.com/jaximus808/tandam) — a shared canvas you and AI agents edit together in real time.

This is a standard [Model Context Protocol](https://modelcontextprotocol.io) stdio server. It is **not Claude-specific**. Any MCP-aware client — Claude Code, Cursor, Windsurf, Codex CLI, the OpenAI Agents SDK, or a custom orchestrator — can spawn this gateway, connect to a canvas by code, and read or write the same canvas a human is looking at in their browser.

## What it does

When you connect, you bind the MCP session to one canvas. From then on, every tool call (`canvas.pin.add`, `canvas.event.add`, `canvas.note.add`, …) operates on that canvas. Writes are broadcast over WebSocket to every browser and every other agent subscribed to the same canvas code.

## Install

### npx (recommended)

No install. Drop this into your MCP client config:

```json
{
  "mcpServers": {
    "tandem": {
      "command": "npx",
      "args": ["-y", "@tandem/mcp-gateway"]
    }
  }
}
```

This connects to the hosted backend at `https://tandemcanvas.com` out of the box — no `API_URL` needed. To point at a local or self-hosted instance, add `"env": { "API_URL": "http://localhost:7891" }`.

### Global install

```bash
npm install -g @tandem/mcp-gateway
# then in MCP config:
#   "command": "tandem-mcp"
```

### From source

```bash
git clone https://github.com/jaximus808/tandam.git
cd tandam
pnpm install
pnpm --filter mcp-gateway build
# point your client at apps/mcp-gateway/dist/index.js
```

## Configuration

| Env var   | Default                    | Purpose                                                          |
| --------- | -------------------------- | ---------------------------------------------------------------- |
| `API_URL` | `https://tandemcanvas.com` | Tandem HTTP API base URL. Only set this to override the default. |

## Tools

| Tool                              | Purpose                                                         |
| --------------------------------- | --------------------------------------------------------------- |
| `canvas.connect`                  | Bind the session to a canvas by 8-char code. Required first.    |
| `canvas.state.read`               | Snapshot of pins, events, notes, mode, and pending edits.       |
| `canvas.mode.set`                 | Switch view: `welcome` / `map` / `itinerary` / `docs`.          |
| `canvas.map.list`                 | List base-map presets.                                          |
| `canvas.map.set`                  | Pick a base map. Also switches into map mode.                   |
| `canvas.pin.{add,update,delete}`  | Manage location pins.                                           |
| `canvas.event.{add,update,delete}`| Manage timed events. Optionally link to a pin.                  |
| `canvas.note.{add,update,delete}` | Manage markdown notes. Optionally attach to a pin or event.     |
| `canvas.pending_edits.read`       | Read scoped edit requests posted from the browser.              |
| `canvas.pending_edits.complete`   | Mark a scoped edit as done.                                     |

Full schemas are returned by the MCP `tools/list` request, or visible in [`src/tools.ts`](https://github.com/jaximus808/tandam/blob/main/apps/mcp-gateway/src/tools.ts).

## Example session

```text
agent: canvas.connect { "code": "TOKYO7X3K" }
  → { connected: true, canvasName: "Tokyo trip" }

agent: canvas.pin.add {
  pinType: "marker", lat: 35.66, lng: 139.7,
  label: "Shibuya Crossing", body: "Best at sunset."
}
  → { id: "pin_abc123", ... }

agent: canvas.event.add {
  title: "Shibuya at sunset", start: "2026-06-04T18:00:00Z",
  pinId: "pin_abc123"
}
```

The user sees the pin drop and the event appear on their itinerary in real time, no refresh.

## Multi-agent

Multiple agents can connect to the same canvas at the same time. A common pattern:

1. **Scout agent** — searches the web, drops candidate pins.
2. **Planner agent** — reads `canvas.state.read`, emits day-by-day events linked to pins.
3. **Reporter agent** — walks final state, writes a markdown summary via `canvas.note.add`.

The canvas is the shared blackboard. Hand-offs happen through canvas state, not a shared prompt — so you can mix vendors (Claude, GPT, local) without rewriting the orchestration.

## License

MIT © Jaxon Parker
