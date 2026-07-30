# Tandem × ANDR — v1 implementation plan

This is the concrete, file-level build plan for [v1.md](v1.md). It turns the
"execution primitive" design into the exact changes this monorepo needs, in the
order they should land. The companion [v1.md](v1.md) holds the *why*; this holds
the *how*.

## The one loop we're building

```
planner.propose ──► canvas: Action{proposed}
                          │
              human (browser) Approve/Reject
                          ▼
                 canvas: Action{approved}
                          │
              executor poll picks it up
                          ▼
        Action{executing} ──► Nav2 drives ──► pin.update (position) on a timer
                          ▼
              Action{done | failed}  ──► (failed → planner re-proposes)
```

Everything moves through canvas state. No agent ever talks to another agent.

## Architecture mapping (where each piece lives)

| v1.md concept | This repo | New/changed |
|---|---|---|
| `Action` entity | `apps/api` Go store + Postgres | **new** table `actions`, store CRUD, handlers, routes |
| `Agent` entity | `apps/api` Go store + Postgres | **new** table `agents`, register + list |
| MCP tools | `apps/mcp-gateway/src/tools.ts` | **new** `agent.register`, `canvas.action.*` |
| Shared types | `internal/shared/src/index.ts` | **new** `Action`, `Agent`, state + WS additions |
| Human approval UI | `apps/web` MapMode | **new** action overlay + Approve/Reject (see step 3) |
| Executor (ANDR) | **separate ANDR repo** | MCP client; out of this repo |
| Planner | **separate / hosted** | MCP client; out of this repo |

## Data model

### `agents` (provenance / identity)
```sql
id           uuid pk
canvas_id    uuid -> canvases (cascade)
name         text
role         text  check (planner | executor)
model        text  null
status       text  check (online | offline)  default online
created_at   timestamptz
last_seen_at timestamptz
```

### `actions` (the execution primitive)
```sql
id             uuid pk
canvas_id      uuid -> canvases (cascade)
type           text  default 'navigate'          -- v1 only value
state          text  check (proposed|approved|rejected|executing|done|failed)
payload        jsonb default '{}'                 -- { goalLabel?, goal?{lat,lng}, waypoints?[] }
proposed_by    text  default 'agent'              -- agent id (provenance)
approved_by    text  null                         -- who approved
result         text  null                         -- success summary
error          text  null                         -- failure detail
linked_pin_ids jsonb default '[]'                 -- pins this action references
created_at     timestamptz
updated_at     timestamptz  (touch trigger)
```

`payload` and `linked_pin_ids` are JSONB, mirroring how `charts.y_columns` and
`sheet_rows.data` are already handled (raw-message in, `json.Marshal` on write).

### State machine (enforced in the handler layer)
```
proposed  → approved | rejected
approved  → executing
executing → done | failed
```
Transitions outside this set are rejected with `400`. v1 trusts the hard-coded
roles for *who* may transition (planner proposes, human approves, executor
runs); per-identity enforcement is a v1.5 hardening item.

## MCP surface (gateway)

New tools, matching v1.md §4. The gateway session gains an optional
`agentId`, set by `agent.register` and used as `proposedBy` on propose.

| Tool | HTTP | Notes |
|---|---|---|
| `agent.register` | `POST /api/canvas/agents` | `{name, role, model?}` → `{agentId}`; stored on session |
| `canvas.action.propose` | `POST /api/canvas/actions` | `proposedBy` = session agentId or `"agent"` |
| `canvas.action.list` | `GET /api/canvas/actions?state=` | optional state filter |
| `canvas.action.read` | `GET /api/canvas/actions/{id}` | executor polls this |
| `canvas.action.approve` | `POST /api/canvas/actions/{id}/approve` | `proposed → approved` |
| `canvas.action.reject` | `POST /api/canvas/actions/{id}/reject` | `proposed → rejected`, `reason` → `error` |
| `canvas.action.update_state` | `PATCH /api/canvas/actions/{id}` | executor: `executing|done|failed` + result/error |

`canvas.state.read` additionally returns `actions` and `agents`. Robot position
updates reuse the existing `canvas.pin.update`.

This stays inside the documented MCP surface policy (canvas ops + execution);
`actions` *are* the execution category that policy reserved.

## Build sequence

1. **Backend + MCP (this PR).** Migration 0013, Go store/handlers/routes,
   shared types, gateway tools. Fully buildable + testable here. ← *implemented now*
2. **UI (next).** Render `proposed`/`executing` actions on MapMode with an
   Approve/Reject control; draw `payload.waypoints` as a route and the executor
   position pin. Wire approve/reject to the new endpoints over WS/HTTP.
3. **Executor (ANDR repo).** LangGraph MCP client: `agent.register({role:"executor"})`,
   poll `canvas.action.list({state:"approved"})`, hand `payload.goal/waypoints` to
   Nav2, set `executing`, stream position via `canvas.pin.update`, report `done|failed`.
4. **Planner (cloud / hosted).** MCP client: `agent.register({role:"planner"})`,
   resolve goal → `canvas.action.propose`, watch outcomes, re-propose on `failed`.
   May collapse into ANDR's brain for the first demo (per v1.md).
5. **Demo.** One mission end-to-end, filmed.

## Out of scope (unchanged from v1.md)

Agent-to-agent messaging, websocket push telemetry (v1 polls), >2 agents,
action types beyond `navigate`, path-level approval, broadening every entity's
`createdBy` to agent ids (actions carry their own `proposed_by`/`approved_by`;
broadening the rest is deferred).

## Verify
- API: `cd apps/api && go build ./... && go test ./...`
- Shared: `cd internal/shared && pnpm build`
- Gateway: `cd apps/mcp-gateway && pnpm build`
- Web: `cd apps/web && pnpm build`
- Migration 0013 applied manually to Supabase (per repo convention).
