# AgentCanvas — Design Doc (Phase 2)

> Picks up where Phase 1 left off. This doc is the handoff for building multi-user shared canvases. Decisions already made are encoded here so you don't relitigate them.

---

## What we're building

Shared canvas sessions — like Google Docs but for agent + human planning. Any number of Claude Code instances and browser clients can write to the same canvas simultaneously. A canvas is identified by a short human-readable code. No accounts required.

**Phase 1 recap (already done):**
- Single-user local MCP server in Node.js + React frontend
- Three modes (Map, Itinerary, Docs), three entities (Pin, Event, Note)
- Named canvas sessions, JSON file persistence

**Phase 2 adds:**
- Canvas creation via the web UI (generates a shareable code)
- Any Claude Code instance connects to a shared canvas via that code
- Multiple agents and browser clients see live state updates
- Postgres persistence (via Supabase) replaces local JSON
- Go API server for the backend; MCP Gateway stays Node

---

## Architecture

```
┌─────────────────────┐        stdio        ┌──────────────────────────────┐
│  Claude Code        │ ◄──────────────────► │  MCP Gateway (Node/TS)       │
│  (terminal)         │                      │  - MCP protocol (stdio)      │
└─────────────────────┘                      │  - Holds JWT in memory       │
                                             │  - Proxies tool calls → API  │
                                             └──────────────┬───────────────┘
                                                            │ HTTP + JWT
                                                            │
┌─────────────────────┐       HTTP/WS        ┌─────────────▼───────────────┐
│  Browser Clients    │ ◄──────────────────► │  Canvas API Server (Go)     │
│  (web app)          │                      │  - REST API                  │
└─────────────────────┘                      │  - WebSocket hub             │
                                             │  - JWT validation            │
                                             │  - Serves web app (static)   │
                                             └──────────────┬───────────────┘
                                                            │ Postgres
                                                            ▼
                                             ┌─────────────────────────────┐
                                             │  Supabase / Postgres        │
                                             │  (hosted)                   │
                                             └─────────────────────────────┘
```

**One API binary** for now. Internal packages are structured so `mcp-gateway`, `api`, and `ws` can each become separate binaries with only a `cmd/` entrypoint change — no logic moves.

---

## Services

### MCP Gateway (Node/TypeScript — `apps/mcp-gateway/`)

Existing Phase 1 MCP server, extended:

- Reads `CANVAS_CODE` and `API_URL` from env on startup
- Exchanges `CANVAS_CODE` for a JWT by calling `POST /api/mcp/auth`
- Stores JWT in memory for the lifetime of the stdio session
- All tool call handlers call the Go API over HTTP, attaching the JWT as `Authorization: Bearer <token>`
- **Claude never sees a canvas ID.** It's baked into the JWT on the gateway side.

MCP config example Claude Code users will add:
```json
{
  "mcpServers": {
    "agentcanvas": {
      "command": "node",
      "args": ["/path/to/agentcanvas/apps/mcp-gateway/dist/index.js"],
      "env": {
        "CANVAS_CODE": "TOKYO-7X3K",
        "API_URL": "https://api.agentcanvas.app"
      }
    }
  }
}
```

Canvas ID determinism: the code is in the process config, not Claude's context. It never drifts.

### Canvas API Server (Go — `apps/api/`)

Single deployable binary. Internal package boundaries are defined so splitting is a flag day, not a rewrite:

```
apps/api/
  cmd/
    server/
      main.go           ← wires everything together, starts HTTP server
  internal/
    canvas/             ← business logic (create, read, mutate entities)
      canvas.go
      entities.go
    api/                ← HTTP route handlers
      routes.go
      canvas_handler.go
      mcp_handler.go
      ws_handler.go
    ws/                 ← WebSocket hub (broadcast to all clients on a canvas)
      hub.go
      client.go
    store/              ← database layer (interfaces + Postgres impl)
      store.go
      postgres.go
    auth/               ← JWT issue + validate
      jwt.go
    config/
      config.go
```

**To split into separate binaries later:** add `cmd/mcp-gateway/` and `cmd/ws-hub/` entries and point each at the relevant `internal/` packages. No logic changes.

### Database (Supabase / Postgres — `migrations/`)

Supabase is used purely as hosted Postgres. We do not use Supabase real-time — the Go server owns the WebSocket layer. This avoids a dependency on Supabase's real-time tier and keeps the broadcast logic in our control.

---

## Canvas code + JWT auth flow

```
Browser creates canvas
  → POST /api/canvases { name }
  → API creates canvas row, generates 8-char code (e.g. TOKYO7X3K)
  → Returns { id, code, name }

Browser shares code with Claude user

Claude user adds MCP config with CANVAS_CODE=TOKYO7X3K

MCP Gateway boots
  → POST /api/mcp/auth { code: "TOKYO7X3K" }
  → API validates code, returns JWT:
      { canvas_id: "uuid", role: "editor", exp: +24h }
  → Gateway stores JWT in memory

Claude calls any canvas tool (e.g. canvas.pin.add)
  → Gateway calls POST /api/canvas/pins  
     Authorization: Bearer <jwt>
  → API validates JWT, extracts canvas_id
  → Writes to Postgres
  → Broadcasts new state to all WebSocket clients on that canvas
```

**JWT payload:**
```json
{
  "canvas_id": "uuid",
  "role": "editor",
  "iat": 1234567890,
  "exp": 1234654290
}
```

No user identity. Role is always `editor` in Phase 2. Phase 3 adds `viewer` codes.

**JWT is signed with a server secret (`JWT_SECRET` env var).** Short-lived (24h) — if a session needs longer, the gateway can refresh by re-presenting the canvas code.

---

## Data model (Postgres)

```sql
-- canvases
CREATE TABLE canvases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        CHAR(8) UNIQUE NOT NULL,        -- e.g. TOKYO7X3K
  name        TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'map',    -- map | itinerary | docs
  version     INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- pins
CREATE TABLE pins (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  pin_type    TEXT NOT NULL DEFAULT 'marker', -- marker | annotation
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  label       TEXT,
  body        TEXT,
  color       TEXT,
  created_by  TEXT NOT NULL DEFAULT 'agent', -- agent | user
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- events
CREATE TABLE events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ,
  pin_id      UUID REFERENCES pins(id) ON DELETE SET NULL,
  created_by  TEXT NOT NULL DEFAULT 'agent',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- notes
CREATE TABLE notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  body        TEXT NOT NULL DEFAULT '',
  image_refs  TEXT[] NOT NULL DEFAULT '{}',
  parent_id   UUID,                           -- refs pins.id or events.id
  parent_kind TEXT,                           -- 'pin' | 'event' | null
  created_by  TEXT NOT NULL DEFAULT 'agent',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`canvases.version` is a monotonic integer bumped on every mutation — the same versioning contract as Phase 1, now in the DB.

---

## SQL migrations

```
migrations/
  0001_initial_schema.sql
  0002_add_canvas_indexes.sql
  ...
```

Each file is idempotent and named with a monotonic prefix. Applied manually (or via a migration runner like `golang-migrate`) against the Supabase Postgres connection string. This folder is the source of truth for schema — no ORM-generated migrations.

---

## API routes

```
POST   /api/canvases                 create canvas, get back id + code
GET    /api/canvases/:code           fetch canvas state by code (for browser open)
GET    /api/canvases/:id/state       full state snapshot (pins, events, notes)

POST   /api/mcp/auth                 exchange canvas code → JWT

# All routes below require Authorization: Bearer <jwt>
POST   /api/canvas/mode              set mode
POST   /api/canvas/pins              add pin
PATCH  /api/canvas/pins/:id          update pin
DELETE /api/canvas/pins/:id          delete pin
POST   /api/canvas/events            add event
PATCH  /api/canvas/events/:id        update event
DELETE /api/canvas/events/:id        delete event
POST   /api/canvas/notes             add note
PATCH  /api/canvas/notes/:id         update note
DELETE /api/canvas/notes/:id         delete note
POST   /api/canvas/pending-edits     add pending edit (from browser UI)
DELETE /api/canvas/pending-edits/:id complete pending edit

POST   /api/images                   upload image, returns filename (jwt required)
GET    /canvas-data/:canvasId/images/:filename  serve image

GET    /ws                           WebSocket upgrade (canvas_id from JWT or ?code= for browser)
```

---

## WebSocket protocol

Same message shapes as Phase 1. The only addition is that the browser authenticates the WS connection by passing the canvas code as a query param: `ws://host/ws?code=TOKYO7X3K`. The server upgrades the connection and subscribes the client to that canvas's broadcast channel.

MCP Gateway does not open a WebSocket — it uses REST + JWT. The WS hub is purely browser → server.

```
Server → Browser (on any mutation):
{ type: "state", canvas: CanvasMeta, canvases: CanvasMeta[], state: CanvasState, pendingEdits: PendingEdit[] }

Browser → Server (direct manipulation):
{ op: "pin.update", id: "...", partial: { lat: ..., lng: ... } }
{ op: "scoped_edit_request", entityId: "...", instruction: "..." }
... (same op set as Phase 1)
```

---

## Repo layout after Phase 2

```
agentcanvas/
  DESIGN.md               ← Phase 1 (done)
  DESIGN_PHASE2.md        ← this file
  NOTES.md
  package.json            ← pnpm workspace root
  pnpm-workspace.yaml
  migrations/
    0001_initial_schema.sql
    0002_add_canvas_indexes.sql
  apps/
    mcp-gateway/          ← Node/TS, MCP protocol, JWT proxy
      src/
        index.ts          ← stdio MCP server
        gateway.ts        ← HTTP client to API, holds JWT
        tools/            ← one file per tool group
    api/                  ← Go binary
      cmd/server/main.go
      internal/
        canvas/
        api/
        ws/
        store/
        auth/
        config/
    web/                  ← existing React frontend (unchanged)
  internal/
    shared/               ← TypeScript types (web + mcp-gateway share)
```

---

## What the builder should NOT do

- No user accounts, login, or OAuth in Phase 2
- No Supabase real-time subscriptions — own the WebSocket layer in Go
- No splitting into microservices — one Go binary with clear internal packages
- No auto-generated migration files — hand-write SQL, version with numeric prefixes
- No canvas-level write permissions or viewer/editor split (Phase 3)
- The MCP Gateway must not generate its own canvas IDs — always get them from the API JWT

---

## Open questions left to the builder

1. **Canvas code generation** — 8 alphanumeric chars, uppercase, no ambiguous chars (0/O, 1/I/L). Generate randomly, retry on collision (rare).
2. **JWT refresh** — Gateway holds a 24h JWT. If a very long Claude session outlasts it, re-POST to `/api/mcp/auth` with the same code to get a new one. Code does not expire (Phase 2) — only the JWT does.
3. **Image storage** — Phase 1 uses local disk. Phase 2 should use Supabase Storage (S3-compatible) or any object store. The API serves a presigned URL or proxies the file. Keep `image_refs` as filenames/paths — the API knows where to serve them from.
4. **Canvas deletion** — No UI for it in Phase 2. Anyone with the code can read/write forever. Phase 3 adds ownership and expiry.

---

## Definition of done — Phase 2

1. User opens `agentcanvas.app`, clicks "New Canvas", gets a code like `TOKYO7X3K`.
2. Shares the code URL (`agentcanvas.app/c/TOKYO7X3K`) with a collaborator. Collaborator opens it and sees the live canvas.
3. User adds `CANVAS_CODE=TOKYO7X3K` to their MCP config, restarts Claude Code.
4. Claude calls `canvas.state.read()` — sees the canvas, no canvas ID in the call.
5. Claude calls `canvas.pin.add(...)` — pin appears in both browsers within ~500ms.
6. Collaborator drags a pin in the browser — Claude sees the new position on next `canvas.state.read()`.
7. Second Claude Code instance (different machine, same code) writes an event — both browsers and both Claude instances converge on the same state.
8. Server restarts — all canvas state is restored from Postgres. No data loss.
