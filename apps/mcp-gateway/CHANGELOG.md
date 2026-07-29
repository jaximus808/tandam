# Changelog — @jaximus/tandem-mcp

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
