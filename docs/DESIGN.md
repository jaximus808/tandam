# AgentCanvas — Design Doc (Phase 1)

> This doc is the handoff to a fresh Claude Code instance (or human) who will build Phase 1. It encodes decisions already made so you don't relitigate them. Where something is left open, it's marked **Open**.

---

## What we're building

A collaborative planning workspace where AI agents (Claude Code instances) and humans co-edit a shared canvas. The canvas adapts to the kind of plan:

- **Map** — for spatial planning (trip scouting, venue picking)
- **Itinerary** — for time-based planning (trip days, event schedules)
- **Docs** — for scrappy unstructured research with markdown + images (e.g. "things to migrate to my new Mac")

Phase 1 is **single-user, local-only**. Multiplayer is Phase 2.

## Why it exists

When you plan with Claude in a chat, the chat *is* the artifact. Every clarification appends. You can't edit one part without regenerating the whole thing or appending corrections. Context decays for both human and agent. This is a known pain point in every "AI assistant" UX that isn't artifact-oriented.

AgentCanvas inverts the relationship: **the canvas is the artifact, chat is just one input channel.** The user can also edit the canvas directly, or trigger AI edits scoped to a single entity. Nothing regenerates the whole document to fix one part.

This is the same insight that makes Cursor better than ChatGPT for code, Notion AI better than ChatGPT for docs, and claude.ai Artifacts better than plain Claude for one-off documents. AgentCanvas takes that further: multi-block (Pin/Event/Note), persistent (survives session), eventually multi-user.

## Phase 1 scope

**In:**
- MCP server that also hosts a local HTTP + WebSocket server
- Three modes: Map, Itinerary, Docs
- Three entities: Pin, Event, Note
- Direct manipulation (drag pins, edit notes, reorder events) from the browser
- Inline scoped AI edits (click an entity → free-prompt → only that entity changes)
- State sync — user edits propagate back so Claude sees them on next interaction
- Local JSON file persistence

**Out (deferred):**
- Multi-user / sharing / auth / hosted backend (Phase 2)
- Block composition / multiple modes on one page (Phase 3)
- Rich text in notes — markdown only
- Conflict resolution beyond last-write-wins
- Tests beyond one smoke test per entity

---

## Architecture

```
┌──────────────────┐  stdio  ┌────────────────────────────────┐
│  Claude Code     │ ◄─────► │  agentcanvas MCP server        │
│  (terminal)      │         │  - MCP tool handlers           │
└──────────────────┘         │  - Canvas state (in memory)    │
                             │  - JSON persistence            │
                             │  - HTTP server (frontend+API)  │
                             │  - WebSocket (live sync)       │
                             └────┬───────────────────────────┘
                                  │ http + ws on :7891
                                  ▼
                             ┌──────────────┐
                             │  Browser     │
                             │  Web app     │
                             └──────────────┘
```

**One process.** MCP stdio + HTTP + WS all hosted by the same Node process. State lives in memory, persisted to disk on every mutation.

**Port:** fixed at `7891`. Fail loud on collision — do not auto-pick. Users should be able to bookmark `http://localhost:7891`.

---

## Entity model

```ts
type EntityId = string; // stable UUID (v4 is fine)

interface Pin {
  id: EntityId;
  kind: "pin";
  pinType: "marker" | "annotation";
  lat: number;
  lng: number;
  label?: string;
  body?: string;       // for annotation type
  color?: string;
  createdBy: "agent" | "user";
  updatedAt: number;   // epoch ms
}

interface Event {
  id: EntityId;
  kind: "event";
  title: string;
  start: string;       // ISO 8601 datetime
  end?: string;
  pinId?: EntityId;    // optional ref to a Pin
  createdBy: "agent" | "user";
  updatedAt: number;
}

interface Note {
  id: EntityId;
  kind: "note";
  body: string;        // markdown
  imageRefs: string[]; // filenames under ./canvas-data/images/
  parentId?: EntityId; // optional ref to a Pin or Event
  createdBy: "agent" | "user";
  updatedAt: number;
}

interface CanvasState {
  version: number;     // monotonic, incremented on every mutation
  mode: "map" | "itinerary" | "docs";
  pins:   Record<EntityId, Pin>;
  events: Record<EntityId, Event>;
  notes:  Record<EntityId, Note>;
}
```

**Non-negotiable:** entities are addressed by stable ID. Claude operates on IDs, not by re-describing entities. This is what makes direct manipulation and agent edits coherent — without it, "the second pin" is ambiguous after the user reorders things.

**Note attachments are single-parent and flat.** No sub-notes, no multi-parent. Keep it simple.

---

## Modes (views over the same entities)

Same entity set, three lenses. Mode is per-canvas; switching mode doesn't lose data.

- **Map** — Pins rendered on Leaflet + OpenStreetMap. `pinType: "marker"` is a normal marker; `"annotation"` is a callout/label. Events that have a `pinId` show a number badge on the referenced pin. Clicking a pin opens a side panel listing Notes whose `parentId` matches.
- **Itinerary** — Events grouped by day (from `start`), sorted by start time. Pin refs render as inline chips. Notes whose `parentId` matches an event render inline beneath it.
- **Docs** — Flat list of Notes. Notes with a `parentId` show the parent as a chip linking to the relevant view. Markdown rendered. Images displayed inline.

Mode is changed via UI (dropdown/tabs in the corner) and also via the `canvas.mode.set` tool.

---

## MCP tools

```
canvas.state.read()
  → returns full CanvasState snapshot
  Used by Claude at start of any canvas-related turn to see current state
  (including user edits made directly in the UI since last interaction).

canvas.mode.set(mode: "map" | "itinerary" | "docs")
  → returns CanvasState

canvas.pin.add({ pinType, lat, lng, label?, body?, color? })
  → returns { id, state }
canvas.pin.update(id, partial)
  → returns { id, state }
canvas.pin.delete(id)
  → returns { state }

canvas.event.add({ title, start, end?, pinId? })
canvas.event.update(id, partial)
canvas.event.delete(id)

canvas.note.add({ body, parentId?, imageRefs? })
canvas.note.update(id, partial)
canvas.note.delete(id)

canvas.pending_edits.read()
  → returns array of pending scoped edits requested via the browser UI
  See "Inline AI edits" below.

canvas.pending_edits.complete(editId)
  → marks a pending edit as done
```

**Every mutating tool returns the full updated state.** Slightly wasteful payload-wise, but eliminates a whole class of "Claude doesn't realize state changed" bugs. Fine for Phase 1.

**Tool descriptions** (the strings the MCP exposes) should instruct the agent to call `canvas.state.read()` at the start of any canvas turn. The MCP server `instructions` field should also include this guidance so it ends up in the agent's context automatically.

---

## Direct manipulation (browser → server)

The browser pushes mutations over WebSocket using the same shape as MCP ops:

```json
{ "op": "pin.update",  "id": "...", "partial": { "lat": 35.66, "lng": 139.7 } }
{ "op": "note.update", "id": "...", "partial": { "body": "..." } }
{ "op": "event.delete", "id": "..." }
{ "op": "mode.set", "mode": "itinerary" }
```

Server applies them, bumps `state.version`, persists to disk, and broadcasts the new state to all connected clients. Phase 1 has only one client, but **build the broadcast path now** so Phase 2 multiplayer doesn't require restructuring.

After a user edit, the next time Claude calls `canvas.state.read()` (or any tool), it sees the updated state. That's the round-trip.

---

## Inline scoped AI edits

The killer UX. User clicks a Note (or Pin label, or Event title) in the browser → an input appears scoped to that entity → user types e.g. "make this shorter" or "add 3 alternatives" → only that entity updates.

**Phase 1 implementation: pending-edit queue.** Don't host an LLM call inside the canvas server. Instead:

1. Browser sends `{ op: "scoped_edit_request", entityId, instruction }` over WS.
2. Server appends to a `pendingEdits` list with a fresh `editId`.
3. Server broadcasts state including pending edits so the browser shows a "queued" indicator on the entity.
4. The user's Claude Code session sees the pending edit on its next `canvas.state.read()` (or by calling `canvas.pending_edits.read()` directly).
5. Claude reads the target entity, applies the instruction (e.g. shortens the note body), calls the right `update` tool, then calls `canvas.pending_edits.complete(editId)`.
6. UI removes the "queued" indicator.

The user might need to prompt "process pending canvas edits" the first few times. That's a known wart — acceptable for Phase 1.

**Alternative (builder's call):** the canvas server makes its own Anthropic API call for scoped edits using `ANTHROPIC_API_KEY` from env. Cleaner UX (instant), but adds an API dependency and a second LLM consumer. If you go this route, still expose `canvas.pending_edits.read/complete` so the queue mechanism exists for power users / future flexibility.

**Decision criterion:** if the queue approach feels awkward after you've wired the WS path, switch to direct API. Document the choice in a `NOTES.md`.

---

## State sync — the critical property

The whole point of the project: when the user edits the canvas (direct manipulation or via processed inline AI edit), those changes must be visible to any Claude Code instance the next time it interacts.

Mechanism:
1. All mutations bump `state.version`.
2. `canvas.state.read()` returns the full current state including `version`.
3. Every mutating tool also returns the full state.
4. Agent is instructed (via MCP `instructions` field and tool descriptions) to call `canvas.state.read()` at the start of any canvas-related conversation turn.

Suggest including in the README a snippet users can paste into their project `CLAUDE.md`:

> When working with AgentCanvas, call `canvas.state.read()` at the start of any turn that touches the canvas, so you see any edits the user (or another agent) made directly since you last looked.

---

## Persistence

- State serialized to `./canvas-data/state.json` on every mutation (debounced ~50ms is fine).
- Images stored as files in `./canvas-data/images/<uuid>.<ext>`. `Note.imageRefs` holds filenames, not full paths.
- On server start: load `state.json` if present; else initialize empty state with `mode: "map"`.

Single-canvas-per-directory in Phase 1. Multi-canvas, naming, listing — Phase 2.

`canvas-data/` should be gitignored by default.

---

## Tech stack

- **Language:** TypeScript (Node 20+)
- **MCP SDK:** `@modelcontextprotocol/sdk` (official)
- **HTTP + WS:** `fastify` + `@fastify/websocket` (or plain `ws` if you prefer)
- **Frontend:** Vite + React + TypeScript
- **Map:** Leaflet + OpenStreetMap tiles (no API key required)
- **Markdown:** `react-markdown`
- **Itinerary view:** plain React + Tailwind, no special timeline lib for Phase 1
- **Styling:** Tailwind (fast, no design system needed)
- **Storage:** plain JSON file, no DB
- **Package manager:** pnpm

Frontend served as static assets from the same Node process in production. In dev, run Vite dev server on a separate port proxying API + WS to the Node process.

---

## Suggested repo layout

```
agentcanvas/
  DESIGN.md             ← this file
  README.md             ← short "how to run" (write last)
  .gitignore            ← include canvas-data/
  package.json
  pnpm-workspace.yaml
  server/
    src/
      mcp.ts            ← MCP tool definitions + handlers
      http.ts           ← Fastify routes (serve frontend, image upload)
      ws.ts             ← WebSocket handler (direct manipulation, broadcasts)
      state.ts          ← in-memory state + load/save
      entities.ts       ← Pin/Event/Note types + factory helpers
      index.ts          ← entry point — starts MCP + HTTP + WS
    package.json
    tsconfig.json
  web/
    src/
      App.tsx           ← shell with mode tabs, side panel
      modes/
        MapMode.tsx
        ItineraryMode.tsx
        DocsMode.tsx
      lib/
        ws.ts           ← WS client, dispatches ops, applies snapshots
        api.ts          ← REST calls (image upload)
        scopedEdit.tsx  ← inline AI edit UI (the "/" or click-to-edit affordance)
      types.ts          ← shared types (mirror server/entities.ts)
    index.html
    vite.config.ts
    tailwind.config.ts
    package.json
  canvas-data/          ← gitignored runtime data, created on first run
    state.json
    images/
```

You may share types between `server/` and `web/` via a tiny `shared/` package, or just duplicate the type file. Duplication is fine for Phase 1.

---

## MCP installation (for end user)

After build, user adds to their `.mcp.json` (or Claude Code's settings):

```json
{
  "mcpServers": {
    "agentcanvas": {
      "command": "node",
      "args": ["/absolute/path/to/agentcanvas/server/dist/index.js"]
    }
  }
}
```

On startup the server logs `Canvas open at http://localhost:7891`. Optionally auto-open with `open` on macOS / `xdg-open` on Linux on the first tool call of a session (gated by an env var so it's not annoying in tests).

---

## What you (the builder) should NOT do

- Don't add multi-user, auth, sharing, or hosted backend.
- Don't add a database. JSON file is correct for Phase 1.
- Don't add Mapbox or any provider requiring an API key — Leaflet + OSM.
- Don't build a rich text editor. Markdown textarea + preview is correct.
- Don't add a block-composition model. One mode at a time per canvas.
- Don't make tools have side effects on other entities (e.g. `pin.add` should not create a Note). Each tool does one thing.
- Don't add automated tests beyond a smoke test per entity type. Phase 1 is exploratory.
- Don't paint yourself into a single-client corner. Even though Phase 1 only has one browser, **broadcast** every state change as if there were many.

---

## Open questions left to the builder

1. **Inline AI edits implementation** — queue (Claude processes) vs direct Anthropic API (server processes). Pick whichever feels less awkward once you've got the WS path working. Document the choice in `NOTES.md`.
2. **Empty-state UX** — when the canvas has zero entities, show a "tell Claude what to plan" prompt? Or just a blank map? Lean simple.
3. **Image upload** — drag-and-drop into a Note → POST to `/api/images` → server stores under `canvas-data/images/` and returns filename. Reasonable max size (~5MB), reject anything bigger.
4. **Auto-open browser on first tool call** — yes/no, env-gated.

---

## Future phases (do not build — just don't preclude them)

- **Phase 2:** Host the server, generate shareable links (`agentcanvas.app/c/abc123`), multiple humans/agents on one canvas, presence indicators, last-write-wins conflict handling.
- **Phase 3:** Block composition — multiple modes coexisting on one page, Notion-style. Templates ("Trip Planner" = map + itinerary + docs side by side).

The Phase 1 design choice that most protects Phase 2 is **WS broadcasts to all connected clients** even when there's only one. Phase 3 mostly requires reorganizing the frontend; the entity model already supports it.

---

## Definition of done — Phase 1

A user can do this end-to-end:

1. Install AgentCanvas as an MCP server, start Claude Code, see the canvas URL in startup output.
2. Ask Claude: *"plan a 3-day trip to Tokyo"*. Claude creates Pins (hotel, restaurants, sights), Events (Tuesday dinner at X), Notes (reservation info).
3. Open `http://localhost:7891` in browser. Map mode shows pins. Click a pin → side panel shows attached notes.
4. Drag a pin to a new location. Switch to itinerary mode and back. Pin is in the new location.
5. Re-prompt Claude: *"the hotel moved to Shinjuku — adjust the walking routes."* Claude calls `canvas.state.read()`, sees the new lat/lng (because you dragged it), updates events accordingly.
6. Switch to docs mode. Click a Note. Type "make this shorter" in the scoped-edit input. Note shortens (after Claude processes the pending edit, or instantly if you went with direct API).
7. Drag a screenshot file onto a Note. Image renders inline.
8. Quit Claude Code. Restart. State and images still there. Browser reconnects and shows everything.

If all 8 work, Phase 1 is done. Ship it.
