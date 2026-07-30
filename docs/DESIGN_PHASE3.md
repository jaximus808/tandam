# AgentCanvas — Design Doc (Phase 3)

> Picks up after Phase 2. This doc is the handoff for the next iteration: removing the forced-map experience, adding a Connect modal, and turning the map into a data-driven, server-served preset system. Decisions already made are encoded here so the implementer doesn't relitigate them.

---

## What we're building

Phase 2 left the app in a state where opening a canvas drops the user straight into a hardcoded Tokyo-centered OpenStreetMap. That's wrong on three counts:

1. The canvas is supposed to be a flexible surface — agents and users decide what goes on it. Forcing "map" as the entry experience presumes the use case.
2. There's no in-app guidance for connecting Claude to the canvas. The 8-char code is buried in a header dropdown.
3. The map itself is hardcoded — coordinates and tile URL are baked into `MapMode.tsx`. Swapping in a US map or a Japan map requires a code change.

**Phase 3 fixes all three:**

- New **Welcome mode** as the first-class default for new canvases. It shows templates ("Map of US", "World map", "Tokyo trip", "Trip itinerary", "Blank doc") and example prompts the user can copy and send to Claude.
- A **Connect modal** that pops automatically the first time a browser opens a given canvas, displays the canvas code + paste-ready MCP env, and dismisses on "I'm connected". After dismissal, a top-right **Connect** button reopens it.
- A **dynamic map system**: maps are described by JSON preset files served by the Go API. `MapMode` renders whatever preset the canvas points at via `canvases.map_id`. Agents can swap maps with a new MCP tool `canvas_map_set`.

**Non-goals for Phase 3:**
- Templates do not seed data (no pre-dropped pins). They just set mode + map.
- Per-user state. The connect-modal dismissal is browser-local; everything else is canvas-global.
- New entity types or modes beyond `welcome`.
- Editing presets from the UI. Presets are ops-managed JSON for now.

---

## Decisions already made

These were settled before this doc was written. Don't reopen them without a strong reason.

| Decision | Choice |
|---|---|
| Where does `welcome` live? | Stored mode on the canvas (default for new canvases), not a frontend-only empty state. Reason: a canvas is shared; if one client picks a template, every connected client must transition together. |
| Do templates seed data (pins/events/notes)? | **No.** Templates set mode + (if map) `mapId`. Content comes from the user prompting Claude. Keeps templates as code-only configuration. |
| Where do map presets live? | **API-served from day one.** JSON files under `apps/api/assets/maps/`, loaded into memory at server start, exposed via `GET /api/maps` and `GET /api/maps/{id}`. |
| Replace or keep the existing share dropdown? | **Replace.** The header dropdown at `apps/web/src/App.tsx` lines ~103-129 gets removed. The Connect modal is the single source of truth for canvas code + sharing instructions. |
| Connect-modal dismissal scope | Per-browser per-canvas-code, via `localStorage` key `tandem.connected.<CODE>`. Different teammates each see it once. |
| Default map when `map_id` is null | `"world"`. Resolved at render time, not stored. |

---

## Architecture changes from Phase 2

No services move. The work is:

- **Postgres**: one migration (new mode value, new column).
- **Go API** (`apps/api`): a new endpoint group for maps, plus a new op/handler for setting the map on a canvas, plus accepting `welcome` as a valid mode.
- **Shared types** (`internal/shared`): new mode, new field on `CanvasMeta`, new WS op.
- **Web** (`apps/web`): new `WelcomeMode`, new `ConnectModal`, refactor of `MapMode` to consume a server-resolved map definition, removal of the header share dropdown.
- **MCP Gateway** (`apps/mcp-gateway`): one new tool, `canvas_map_set`.

---

## 1. Data model & migration

### Migration

Create `migrations/0002_welcome_and_map_id.sql`:

```sql
-- Allow 'welcome' as a canvas mode, and store which map preset is loaded.

ALTER TABLE canvases DROP CONSTRAINT canvases_mode_check;
ALTER TABLE canvases
  ADD CONSTRAINT canvases_mode_check
  CHECK (mode IN ('welcome', 'map', 'itinerary', 'docs'));

ALTER TABLE canvases ALTER COLUMN mode SET DEFAULT 'welcome';

ALTER TABLE canvases ADD COLUMN map_id TEXT;
```

Existing canvases keep whatever mode they had (most will be `'map'`). Their `map_id` stays `NULL` and resolves to `"world"` at render time. No data backfill required.

### Shared types

In `internal/shared/src/index.ts`:

- `export type CanvasMode = "welcome" | "map" | "itinerary" | "docs";`
- Add `mapId?: string;` to `CanvasMeta`.
- Add to `WSClientMessage`:
  ```ts
  | { op: "map.set"; mapId: string }
  ```

### Go store

In `apps/api/internal/store/`:

- Wherever the mode CHECK is mirrored in Go (search for `"itinerary"`/`"docs"` literals), add `"welcome"`.
- Add a `MapID *string` field to whatever struct represents a canvas row, marshaled as `"mapId,omitempty"`.
- Add `SetMapID(ctx, canvasID uuid.UUID, mapID string) (newVersion int, err error)`.
- Include `map_id` in the `SELECT` used by `GetCanvasState` and `GetCanvasByCode`.

---

## 2. Map preset system (the "map API layer")

### Preset files

Create `apps/api/assets/maps/` and add one JSON file per preset. Initial set:

- `world.json`
- `us.json`
- `tokyo.json`
- `japan.json`

Schema (kept open-ended so future presets can layer GeoJSON without a schema change):

```json
{
  "id": "us",
  "name": "United States",
  "description": "Continental US with state-level context",
  "center": [39.5, -98.35],
  "zoom": 4,
  "minZoom": 3,
  "maxZoom": 12,
  "bounds": [[24.5, -125.0], [49.5, -66.5]],
  "layers": [
    {
      "kind": "tile",
      "url": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      "attribution": "© OpenStreetMap contributors"
    }
  ]
}
```

`world.json`:
```json
{
  "id": "world",
  "name": "World",
  "description": "Global view",
  "center": [20, 0],
  "zoom": 2,
  "layers": [
    {
      "kind": "tile",
      "url": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      "attribution": "© OpenStreetMap contributors"
    }
  ]
}
```

`tokyo.json`:
```json
{
  "id": "tokyo",
  "name": "Tokyo",
  "description": "Greater Tokyo area",
  "center": [35.6762, 139.6503],
  "zoom": 12,
  "layers": [
    {
      "kind": "tile",
      "url": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      "attribution": "© OpenStreetMap contributors"
    }
  ]
}
```

`japan.json`:
```json
{
  "id": "japan",
  "name": "Japan",
  "description": "All of Japan",
  "center": [36.5, 138.0],
  "zoom": 5,
  "layers": [
    {
      "kind": "tile",
      "url": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      "attribution": "© OpenStreetMap contributors"
    }
  ]
}
```

The `layers[].kind` discriminator is the extensibility point. v1 only handles `"tile"`. A future `"geojson"` (with `url` + `style`) can be added without changing the API.

### Loading presets in Go

New package `apps/api/internal/maps/`:

- `Registry` struct holding `map[string]MapDefinition` and an ordered slice for listing.
- `LoadFromDir(path string) (*Registry, error)` walks the directory, decodes each JSON file, validates `id` matches filename minus extension, panics on duplicate ids.
- `(r *Registry) List() []MapSummary` — returns `{id, name, description}` only, to keep `/api/maps` lightweight.
- `(r *Registry) Get(id string) (MapDefinition, bool)` — full definition.

Wire it up in `cmd/server/main.go`: `mapsRegistry, err := maps.LoadFromDir("./assets/maps")`. Path comes from a new env var `MAPS_DIR` (default `./assets/maps`) so the same binary works in different deployments.

Note on Go embedding: prefer `go:embed` for the assets so the binary is self-contained. The `LoadFromDir` form is for the dev loop; ship with `embed.FS`.

### HTTP endpoints

In `apps/api/internal/api/`:

- `GET /api/maps` → `{ maps: [{id, name, description}, ...] }`. Public, no auth.
- `GET /api/maps/{id}` → full `MapDefinition`. 404 if unknown. Public, no auth.

Add a new handler file `maps_handler.go` and register routes in `routes.go`.

### Setting the map on a canvas

Two surfaces:

1. **WS op** (browsers + agent → API): `{ op: "map.set", mapId }`. Handle in the WS message switch; reject if `mapId` isn't in the registry.
2. **REST** for the MCP gateway: `POST /api/canvas/map` with `{ "mapId": "us" }`, JWT-authenticated like the existing mode endpoint.

Both paths call `store.SetMapID` then `broadcastState`.

### MCP gateway

In `apps/mcp-gateway/src/`, add a new tool:

```ts
{
  name: "canvas_map_set",
  description: "Switch the base map for the canvas. mapId must be one of the registered presets (call canvas_state_read or fetch /api/maps to enumerate).",
  inputSchema: {
    type: "object",
    properties: { mapId: { type: "string" } },
    required: ["mapId"],
  },
}
```

Implementation: `POST /api/canvas/map` with the JWT, return `{ ok: true, mapId }`.

Update the tool list exported from `mcp-gateway`'s tool registry. Update `canvas_state_read`'s response shape if it returns canvas meta (it should now include `mapId`).

### Frontend map resolver

New module `apps/web/src/lib/maps.ts`:

```ts
export type MapLayer =
  | { kind: "tile"; url: string; attribution: string; minZoom?: number; maxZoom?: number }
  | { kind: "geojson"; url: string; style?: Record<string, unknown> };

export type MapDefinition = {
  id: string;
  name: string;
  description?: string;
  center: [number, number];
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  bounds?: [[number, number], [number, number]];
  layers: MapLayer[];
};

const cache = new Map<string, Promise<MapDefinition>>();

export function resolveMap(id: string): Promise<MapDefinition> {
  const cached = cache.get(id);
  if (cached) return cached;
  const p = fetch(`/api/maps/${encodeURIComponent(id)}`).then(r => {
    if (!r.ok) throw new Error(`map ${id} not found`);
    return r.json() as Promise<MapDefinition>;
  });
  cache.set(id, p);
  return p;
}

export function listMaps(): Promise<{ id: string; name: string; description?: string }[]> {
  return fetch("/api/maps").then(r => r.json()).then(j => j.maps);
}
```

Plus a small hook `useMapDefinition(id)` that wraps `resolveMap` and returns `{ map, loading, error }`.

### `MapMode` refactor

`apps/web/src/modes/MapMode.tsx` currently hardcodes the center at line 41-47 and the OSM tile URL at line 58-62. Replace with:

```tsx
const { map, loading, error } = useMapDefinition(mapId ?? "world");

if (loading) return <MapSkeleton />;
if (error || !map) return <MapError onRetry={...} />;

const center = pins.length > 0
  ? averagePinCenter(pins)
  : map.center;
const zoom = pins.length > 0 ? 13 : map.zoom;

return (
  <MapContainer center={center} zoom={zoom} minZoom={map.minZoom} maxZoom={map.maxZoom} bounds={map.bounds}>
    {map.layers.map(layerToLeaflet)}
    {pins.map(...)}
  </MapContainer>
);
```

`layerToLeaflet` is a switch on `layer.kind` rendering `<TileLayer>` for `"tile"` and (future) a GeoJSON layer for `"geojson"`.

`MapMode`'s props gain `mapId: string | undefined` passed down from `App.tsx` (sourced from `canvas.mapId`).

---

## 3. Welcome mode + templates

### `WelcomeMode.tsx`

New file `apps/web/src/modes/WelcomeMode.tsx`. Layout, top to bottom:

1. **Hero**: "Welcome to Tandem Canvas" + one-line subhead ("Pick a starting point, or just start prompting").
2. **Template grid**: 2-3 columns of cards. Each card has icon, name, one-line description, and is clickable.
3. **Example prompts** section: "Try asking Claude…" with 4-5 prompt strings, each with a copy button.
4. **Footer hint**: "You can change modes anytime from the top bar."

Template cards (initial set, in this order):
- **Map of the US** → `mode.set "map"` + `map.set "us"`
- **World map** → `mode.set "map"` + `map.set "world"`
- **Tokyo trip** → `mode.set "map"` + `map.set "tokyo"`
- **Japan** → `mode.set "map"` + `map.set "japan"`
- **Trip itinerary** → `mode.set "itinerary"`
- **Blank doc** → `mode.set "docs"`

Example prompts (these are first-draft, tune later):
- "Drop a pin at every Apple Store in San Francisco."
- "Plan a 5-day Tokyo trip with pins for each stop and an itinerary."
- "Make a packing checklist for a week of hiking."
- "Add notes summarizing the key sights in each pin."
- "Switch to a map of Japan and add the top 10 tourist spots."

### Templates registry

New file `apps/web/src/lib/templates.ts`:

```ts
import { sendOp } from "./ws";

export type Template = {
  id: string;
  name: string;
  description: string;
  icon?: string; // emoji or icon name
  apply: () => void;
};

export const TEMPLATES: Template[] = [
  {
    id: "map-us",
    name: "Map of the US",
    description: "Continental United States",
    apply: () => { sendOp({ op: "map.set", mapId: "us" }); sendOp({ op: "mode.set", mode: "map" }); },
  },
  {
    id: "map-world",
    name: "World map",
    description: "Global view",
    apply: () => { sendOp({ op: "map.set", mapId: "world" }); sendOp({ op: "mode.set", mode: "map" }); },
  },
  {
    id: "map-tokyo",
    name: "Tokyo trip",
    description: "Greater Tokyo area",
    apply: () => { sendOp({ op: "map.set", mapId: "tokyo" }); sendOp({ op: "mode.set", mode: "map" }); },
  },
  {
    id: "map-japan",
    name: "Japan",
    description: "All of Japan",
    apply: () => { sendOp({ op: "map.set", mapId: "japan" }); sendOp({ op: "mode.set", mode: "map" }); },
  },
  {
    id: "itinerary",
    name: "Trip itinerary",
    description: "Day-by-day schedule",
    apply: () => sendOp({ op: "mode.set", mode: "itinerary" }),
  },
  {
    id: "docs",
    name: "Blank doc",
    description: "Free-form notes",
    apply: () => sendOp({ op: "mode.set", mode: "docs" }),
  },
];
```

Order matters: `map.set` is sent before `mode.set` so the map is set by the time the user lands on map mode (avoids a flash of the default `world` map for a tick).

### App.tsx wiring

In `apps/web/src/App.tsx`:

- Render `<WelcomeMode />` when `canvasState.mode === "welcome"`.
- While in welcome mode, hide the mode tabs in the header (the tabs at lines ~135-150). They reappear once the user picks a template.
- Pass `mapId={canvas.mapId}` down to `MapMode`.

---

## 4. Connect modal + header refactor

### `ConnectModal.tsx`

New file `apps/web/src/components/ConnectModal.tsx`. Centered modal over a dimmed backdrop. Contents, top to bottom:

1. **Title**: "Connect Claude to this canvas"
2. **Canvas code** displayed large and monospaced, with a copy button right next to it.
3. **Paste-ready snippet**: the env block users add to their MCP config:
   ```
   CANVAS_CODE=<code>
   API_URL=<current API base URL>
   ```
   With a single "Copy snippet" button.
4. **Step list** (short): "1. Paste the snippet into your MCP gateway env. 2. Restart Claude Code. 3. Click 'I'm connected' below."
5. **Primary CTA**: `[ I'm connected ]` button. On click: write `localStorage.setItem("tandem.connected." + code, "1")` and close.
6. **Footer link**: "← Switch canvas" which calls the existing `handleJoin("")` flow.

Props: `code: string; onClose: () => void;`.

The current share dropdown in `App.tsx` lines ~103-129 — delete it. Replace the header layout:

- **Left of header**: canvas name + code (non-clickable label, or a quiet button that opens the Connect modal — pick the latter; it's discoverable).
- **Right of header**: a `[ Connect ]` button that opens the modal.

On canvas load (first `useEffect` that fires once `canvas` is set), check `localStorage.getItem("tandem.connected." + canvas.code)`. If null, set `connectOpen = true`.

---

## 5. File-by-file change list

> The next Claude Code instance can use this as a checklist.

### New files

- `migrations/0002_welcome_and_map_id.sql`
- `apps/api/assets/maps/world.json`
- `apps/api/assets/maps/us.json`
- `apps/api/assets/maps/tokyo.json`
- `apps/api/assets/maps/japan.json`
- `apps/api/internal/maps/registry.go`
- `apps/api/internal/maps/registry_test.go` *(table-driven test: load fixture dir, assert ids/list/get)*
- `apps/api/internal/api/maps_handler.go`
- `apps/web/src/lib/maps.ts`
- `apps/web/src/lib/templates.ts`
- `apps/web/src/modes/WelcomeMode.tsx`
- `apps/web/src/components/ConnectModal.tsx`

### Modified files

- `internal/shared/src/index.ts` — add `welcome` to `CanvasMode`, add `mapId` to `CanvasMeta`, add `map.set` to `WSClientMessage`.
- `apps/api/internal/store/store.go` (and `supabase.go` if that's where queries live) — accept `welcome`, `SELECT map_id`, add `SetMapID`.
- `apps/api/internal/api/routes.go` — register `/api/maps`, `/api/maps/{id}`, `POST /api/canvas/map`.
- `apps/api/internal/api/canvas_handler.go` — new `SetMapHandler` mirroring `SetMode`.
- `apps/api/internal/api/ws_handler.go` — handle `map.set` op.
- `apps/api/cmd/server/main.go` — load maps registry, pass into handler.
- `apps/web/src/App.tsx` — render `WelcomeMode` branch, drop share dropdown, add Connect button + auto-open logic, pass `mapId` to `MapMode`.
- `apps/web/src/modes/MapMode.tsx` — consume `useMapDefinition`, drop hardcoded center/tile URL.
- `apps/mcp-gateway/src/tools.ts` (or wherever tools are registered) — add `canvas_map_set`.

---

## 6. Build order

Implement in this order so each step is testable in isolation.

1. **Migration + shared types.** Apply the SQL, regenerate/update TS types, add `welcome` to Go validation. Commit.
2. **Map registry + endpoints.** JSON files, `internal/maps` package, `/api/maps` routes. Hit `curl localhost:8080/api/maps` to verify. Commit.
3. **`map.set` op end-to-end.** WS handler, REST handler, store method, broadcast. Verify with a direct WS message or hand-rolled fetch. Commit.
4. **`MapMode` refactor.** Replace hardcoded values with `useMapDefinition`. Verify by manually setting `map_id` in the DB and reloading. Commit.
5. **`WelcomeMode` + templates.** Hook into `App.tsx`. Verify new-canvas flow lands on Welcome. Commit.
6. **`ConnectModal` + header refactor.** Remove share dropdown. Verify first-open behavior and `localStorage` gate. Commit.
7. **MCP `canvas_map_set` tool.** Add to gateway. Verify by prompting Claude to switch maps in a connected session. Commit.

Each step keeps the app in a runnable state. Don't bundle them.

---

## 7. Testing

- **Migration**: apply against a fresh DB and against a copy of a pre-Phase-3 DB. Confirm existing canvases keep their mode.
- **Map registry**: unit test in `internal/maps` covering load, list, get-missing, duplicate-id rejection.
- **`map.set` op**: integration test that opens a WS, sends `map.set`, expects a state broadcast with the new `mapId`.
- **`/api/maps`**: smoke test via `curl`.
- **Welcome flow**: manually create a new canvas, confirm it opens in Welcome, pick each template, confirm the mode/map update propagates to a second browser tab.
- **Connect modal**: clear `localStorage`, open a canvas, confirm modal opens. Click "I'm connected", reload, confirm it stays closed. Click the Connect button, confirm it reopens.
- **MCP**: in a connected Claude Code session, ask "switch the map to Japan" — confirm the browser updates.

---

## 8. Things explicitly out of scope

If you find yourself implementing any of these, stop and confirm:

- Per-user state (favorites, recent templates, etc.). Not now.
- Template editing / custom templates. Not now.
- Map presets stored in the DB. Files on disk + `embed.FS` is the v1 storage.
- Custom tile providers requiring API keys (Mapbox, Maptiler). Stick to OSM for now.
- A general "canvas settings" UI. The Connect modal is the only modal Phase 3 adds.
- Refactoring the existing mode tabs into something else. They stay as-is, just hidden during Welcome.

---

## 9. Improvements worth considering (post-MVP within Phase 3)

These are extensions to the Phase 3 scope that fit naturally. Decide per-item whether to roll them in or push to Phase 4.

### 9a. Template "from agent" prompts

Each template card could have a "Start with Claude" subaction that, in addition to setting mode/map, pre-fills a suggested first prompt to copy. E.g., the US map template's prompt is "Add pins for the 10 largest US cities with a one-line note for each." Cheap to add: extend the `Template` type with an optional `suggestedPrompt: string` and render it under the card.

### 9b. Recent maps / quick switcher

Once `canvas_map_set` exists, a small dropdown next to the Connect button could let users switch maps without going back through Welcome. Implementation: a `<MapPicker>` component that calls `listMaps()` and sends `map.set` on selection. Only visible in map mode.

### 9c. GeoJSON overlay layer kind

The `layers[].kind` discriminator is in place specifically for this. A `"geojson"` layer with a URL pointing at a static file (e.g., US state borders) would let presets render context geometry. Implementation: extend `layerToLeaflet` to fetch and render via `<GeoJSON>` from `react-leaflet`. Add a `us-states.geojson` asset.

### 9d. Per-canvas welcome content

If a canvas was created via deep link from a website ("plan my Tokyo trip"), the welcome screen could show a relevant subset of templates. Implementation: add a `?template=` URL param honored by `Landing.tsx` that auto-applies a template on canvas creation.

### 9e. MCP "list templates" tool

Currently agents can switch maps but don't know what templates exist. A `canvas_template_list` MCP tool plus `canvas_template_apply` would let the user prompt "set this up as a Tokyo trip" and have Claude do it. Implementation: expose templates from the API as well (move `templates.ts` content to JSON files in `apps/api/assets/templates/` and mirror the maps endpoint pattern).

### 9f. Modal-on-empty improvements

When the user enters map mode with zero pins, the current "Ask Claude to add locations to get started" overlay (`MapMode.tsx` lines ~107-113) could become a richer empty state: show the current map preset name, a "switch map" link, and a copy-prompt button. Low effort, high polish.

### 9g. Header copy of code

Even with the Connect modal, having the code visible (and click-to-copy) in the header is useful for users who've dismissed the modal but want to share quickly. Keep this as a small label/button at the top-left.

### 9h. Persist welcome-dismissal differently

The current plan: Welcome is a mode and disappears when a template is picked. An alternative: keep a "Welcome" tab available even after picking, so users can revisit templates. Tradeoff: clutters the tab bar. Recommend not doing this in Phase 3; revisit if users ask for it.

### 9i. Validation on `mapId` writes

The Go API should reject `map.set` with an unknown `mapId` (400). The store should treat `map_id` as an opaque string; the API layer enforces it against the registry. Already in plan above but worth flagging — easy to miss.

### 9j. Telemetry / observability

Not in scope, but worth a TODO: log which templates get picked, which maps get used, and how often the Connect modal is dismissed vs. re-opened. Useful before deciding what to build in Phase 4.

### 9k. Mobile layout for Welcome

The template grid should collapse cleanly on narrow viewports. The Connect modal should fit on a phone screen. Both are cheap to get right at build time, expensive to retrofit.

### 9l. Tile attribution honor

Currently `MapMode` hardcodes the OSM attribution string in the JSX. After the refactor, attribution comes from the preset's layer config. Make sure the resulting `<TileLayer attribution={...} />` actually receives it — easy to drop on the floor during refactor.

### 9m. Auto-leave Welcome on first agent write

**Problem**: a user lands on Welcome, prompts Claude "drop a pin at Shibuya Crossing", Claude creates the pin via MCP, but the user still sees Welcome (because the pin doesn't change the mode). The pin lands invisibly until the user manually picks a template.

**Fix**: in the Go API, on any `pin.*` / `event.*` / `note.*` write to a canvas whose mode is `welcome`, transition the mode in the same transaction:
- `pin.*` → `mode = 'map'` (and set `map_id = 'world'` if NULL)
- `event.*` → `mode = 'itinerary'`
- `note.*` → `mode = 'docs'`

Implement as a small helper in the store layer that runs before the write commits. Idempotent (no-op if mode isn't `welcome`).

Recommendation: include this in Phase 3 v1, not as a post-MVP add. Without it, the first-time experience is broken whenever an agent writes before the user picks a template.

### 9n. Template ops should be atomic

The drafted `templates.ts` sends two `sendOp` calls back-to-back: `map.set` then `mode.set`. They're delivered in order on the same socket, but each goes through its own broadcast cycle, so there's a brief window where the canvas is in `mode='map'` with the OLD `map_id`. `MapMode` mounts during that window and renders the previous (or default) map for a tick before re-rendering.

**Fix**: add a server-side `template.apply` op that takes both `mode` and optional `mapId` and writes them in one transaction + one broadcast. Frontend `templates.apply` becomes a single `sendOp({ op: "template.apply", mode, mapId })`.

Tradeoff: adds one more op to the protocol. Worth it for the smooth transition.

### 9o. `sendOp` silently drops when WS is closed

`apps/web/src/lib/ws.ts` lines 67-71: `sendOp` no-ops if the socket isn't open. A user clicking a Welcome template card during a reconnect would get nothing — no error, no retry. With the new Welcome flow this becomes a visible failure mode (the screen just doesn't change).

**Fix options**:
- Queue ops while the socket is `CONNECTING`, flush on `open`.
- Surface a small toast / banner when `socket.readyState !== OPEN` and an op is attempted.

Recommend queue-on-connecting in Phase 3 (5 lines of code) and a separate toast UX in Phase 4.

### 9p. Replace `prompt()` in Landing with a real form

`apps/web/src/pages/Landing.tsx` line 13 uses `window.prompt()` for the canvas name. While we're touching the entry experience, swap it for an inline form field. Trivial.

### 9q. Modal accessibility

`ConnectModal` needs: focus trap, ESC-to-close, `aria-modal`, return focus to the trigger on close. Cheap to get right in v1; expensive to retrofit. If `@radix-ui/react-dialog` is already a dep, use it; otherwise hand-roll the four behaviors.

### 9r. Existing-canvas migration story

The migration in §1 doesn't backfill `map_id` on existing `mode='map'` canvases. They resolve to `"world"` at render time, which may surprise users whose canvas was previously Tokyo-centered (the hardcoded default in Phase 2's `MapMode`).

**Option A**: Backfill: `UPDATE canvases SET map_id = 'tokyo' WHERE mode = 'map' AND map_id IS NULL;`. Matches old behavior exactly.

**Option B**: Leave NULL → `"world"`. Cleaner, but old canvases reload looking different.

Recommend **A** if there are any live canvases worth preserving, otherwise **B**. The implementer should check before deciding.

### 9s. URL representation of welcome state

`/c/CODE` already encodes the canvas. Welcome is just whatever mode the canvas is in, so no URL change needed. But consider supporting `/c/CODE?template=map-us` as a deep link that auto-applies a template on first connect — useful for marketing links and embedded CTAs.

### 9t. MCP `canvas_state_read` must include `mapId`

The new `mapId` field on `CanvasMeta` needs to flow through the MCP gateway's `canvas_state_read` response, otherwise agents have no way to know what map is loaded. Mostly a "don't forget to update the response shape" reminder, but easy to miss in the Go → TS handoff.

### 9u. Header layout under squeeze

The header currently holds: canvas name + code, mode tabs (3 buttons), version label. Phase 3 adds: Connect button. Phase 4 might add: map switcher. On narrow screens this is already tight.

Recommend: in this pass, move version label into the Connect modal footer (it's debug info, doesn't need to be permanent header real estate). Frees room and is a one-line change.

### 9v. Consistent empty states across modes

Phase 3 introduces Welcome as the canonical starting point. Other modes' empty states ([MapMode.tsx:107-113](apps/web/src/modes/MapMode.tsx#L107-L113), [DocsMode.tsx:40-46](apps/web/src/modes/DocsMode.tsx#L40-L46), and itinerary's equivalent) currently just say "ask Claude to add some". They should:

- Mention the current mode/map (e.g., "This is a US map with no pins yet").
- Offer a "Back to templates" link that sends `mode.set "welcome"`.
- Show 1-2 mode-specific example prompts (subset of Welcome's example prompts).

Implementation: a shared `<EmptyState mode="map" mapName="..." onResetToWelcome={...} />` component. ~30 lines, reused across all three modes.

### 9w. Map preset thumbnails

Welcome template cards look much better with a tiny visual preview of the map. Two options:

- **Static thumbnails**: ship a 256×128 PNG per preset in `apps/api/assets/maps/thumbs/`. Reference via `thumbnail: "/api/maps/thumbs/us.png"` in the JSON. Cheap, predictable.
- **Live mini-map**: render an actual Leaflet map at low zoom inside the card. Looks great but heavy (each card = a Leaflet instance).

Recommend static thumbnails for v1. The PNGs can be generated by visiting each preset once and screenshotting.

### 9x. `canvas_map_list` MCP tool

Counterpart to `canvas_map_set`. Returns `[{id, name, description}, ...]` so agents can answer "what maps are available?" without the user guessing IDs. One-line wrapper around `GET /api/maps` in the gateway. Add it to Phase 3.

### 9y. Tile provider rate limits / CSP

OSM's tile servers have a usage policy. For a small app this is fine, but worth noting:
- Production should use a paid tile provider (Mapbox, Maptiler, Stadia) or self-host. Preset JSON schema supports this — only the `url` and `attribution` change.
- The Go server's CSP (if any) and the browser's connect-src need to allow whatever tile host the preset references. Currently the app has no CSP; if one is added later, preset URLs must be allow-listed.

Worth a TODO in the deploy doc; no code change needed in Phase 3.

### 9z. Code-split Leaflet

`react-leaflet` + `leaflet` is ~150KB minified. With Welcome as the default landing, most first-load users won't immediately need it. Lazy-load `MapMode` via `React.lazy(() => import("./modes/MapMode"))` so the bundle splits.

Same for `ItineraryMode` and `DocsMode` once we're at it. Welcome is the only mode that ships in the initial chunk.

### 9aa. Error boundary around mode renderers

Each mode is a self-contained component. If one crashes (e.g., a future GeoJSON layer references a malformed file), it shouldn't take down the whole canvas UI. Wrap mode renderers in an error boundary that shows "Something went wrong rendering this mode" + "Back to templates" link.

### 9ab. README and screenshots

The top-level `README.md` (and likely the Phase 2 design doc) mention the Tokyo default. Update both. Also: update screenshots if any.

### 9ac. Recent canvases on Landing

Browser-local list of canvases the user has opened (codes + names + last-opened-at), shown on the Landing page above the "join existing" form. Speeds up returning to a canvas without remembering the code. Pure frontend; localStorage. Optional but a nice touch.

### 9ad. Welcome "start over" affordance

Once a user has picked a template, getting back to Welcome currently requires URL manipulation or "Switch canvas" (which sends them to Landing). Add a small "← Templates" or "Start over" link inside each mode's header (or in the Connect modal footer) that sends `mode.set "welcome"`. Confirms with the user first — picking a new template doesn't destroy existing data, but they should be told that explicitly.

### 9ae. Mode-switch confirmation when data exists

Currently clicking another mode tab is instant and free. Once Welcome exists, the inverse situation is also worth handling: user has 10 pins on a US map, clicks "Welcome", momentarily their map disappears (replaced by template grid). Data is safe — pins persist server-side — but the UX implies "I'm starting over". Either:
- Show a confirm: "Pick a new template? Your pins will stay; they'll reappear when you return to map mode."
- Don't show the Welcome tab in the tab bar at all (Phase 3 plan); keep Welcome access in the "Start over" link only.

Recommend the latter — simpler and matches the "Welcome = first run" framing.

### 9af. Telemetry hooks (no provider, just hooks)

Even without picking an analytics provider yet, add a thin `track(event, props)` function and fire it on:
- `template.picked` `{ templateId }`
- `map.changed` `{ from, to, source: "user" | "agent" }`
- `connect.modal.opened` `{ auto: true | false }`
- `connect.modal.dismissed`
- `welcome.example_prompt.copied` `{ prompt }`

For v1 the function logs to console. Plugging in PostHog/Mixpanel/etc. later is a one-file change. Adding the call sites later is a multi-file slog — do it now.

### 9ag. Backward compatibility for old MCP gateways

A user with a stale MCP gateway binary (no `canvas_map_set` tool) will still work with a Phase 3 API. They just can't switch maps from Claude — the user can switch maps from the browser. The reverse — old API, new gateway — would fail on `POST /api/canvas/map` with 404. Acceptable; document in release notes.

### 9ah. The `template.apply` op spec

Promoted from §9n. Concrete shape:

```ts
| { op: "template.apply"; templateId: string; mode: CanvasMode; mapId?: string }
```

Server-side handler:
- Validate `mode` is in the allowed set.
- If `mapId` provided, validate it exists in the registry.
- In a single store transaction: update `canvases.mode` and `canvases.map_id`. Increment `version`.
- Broadcast once.

Why include `templateId`? For server-side logging/telemetry. Server doesn't need to *understand* templates (they're a client concept) — just records which one was picked.

### 9ai. Concurrent template picks

Two browsers in the same canvas pick different templates at the same instant. Last write wins (Postgres handles this); both browsers receive the same final state via broadcast; no inconsistency. No special handling needed, just verify in testing.

### 9aj. `Landing` UX when API is down

Currently `Landing.handleCreate` calls `fetch("/api/canvases", ...)` and on failure shows the error as a string. Fine for dev, ugly in production. While touching Landing for §9p, also: distinguish 4xx (validation) vs 5xx (server) vs network errors, show appropriate messaging.

### 9ak. Map preset metadata for grouping

`MapDefinition` can grow optional fields without breaking anything:
- `tags: string[]` — e.g. `["city", "japan"]`
- `category: string` — e.g. `"city" | "country" | "region" | "world"`

Useful when there are 20+ presets and the Welcome grid needs filtering or sectioning. Defer the UI; add the schema fields now so presets are forward-compatible.

### 9al. Pin coordinates outside preset bounds

Nothing prevents an agent from creating a pin at (0, 0) on a Tokyo-zoomed map. Leaflet handles this gracefully (renders off-screen), but the pin is effectively invisible. Options:
- No-op for v1. Document as a known limitation.
- API rejects writes outside `bounds` if preset has them. Probably too strict — agents might be slightly off.
- Browser shows a "1 pin off-screen — zoom out to see all" indicator when pins exist outside the current view.

Recommend option 3 as a polish item, defer to Phase 4.

### 9am. WS reconnect during a mode change

User picks "US Map" → `template.apply` op sent → WS disconnects mid-send → reconnect → user is still on Welcome locally because the broadcast was never received. The retry logic in `ws.ts:58-60` reconnects but doesn't replay the failed op.

Combined with §9o (queue on connecting), this gets cleaner: ops sent during disconnect are queued in memory, flushed on reconnect. But: if the page is reloaded before reconnect, the op is lost. Acceptable for a template pick (user clicks again). Document.

### 9an. `canvas_state_read` schema versioning

The MCP gateway's `canvas_state_read` tool returns a JSON shape that Claude has been trained to interpret. Adding `mapId` to the canvas meta is additive (safe), but if we ever need to remove or rename a field, we'll need a version field. Recommend adding `schemaVersion: "1.1"` to the response in Phase 3 even though no consumer reads it yet — gives us a hook for the future.

### 9ao. OpenAPI / Swagger for new endpoints

If the project doesn't already have an OpenAPI spec, this is a fine time to start one — just for the maps endpoints and the new canvas-map endpoint. Lives in `apps/api/openapi.yaml`. Makes it trivial to generate typed clients later.

If the project already has docs in another form (e.g., a hand-written `API.md`), update that instead.

### 9ap. Map preset hot-reload in dev

Restarting the Go server every time a preset JSON changes is annoying. In dev mode (env `DEV=true`), `LoadFromDir` could re-read on each request. Trivial: check the env var in the handler, bypass the in-memory cache. Don't ship this to prod.

### 9aq. Verifying example prompts actually work

The Welcome screen lists example prompts that suggest Claude can do things ("Plan a 5-day Tokyo trip with pins for each stop and an itinerary"). If the MCP tools can't actually do those things, the prompts are misleading.

Before shipping, walk through each example prompt manually with a connected Claude Code session. Adjust the prompts so each one is genuinely achievable with the current tool set.

### 9ar. Mobile responsive Welcome + Connect modal

The template grid: at >768px, 3 columns. 480-768px, 2 columns. <480px, single column. Connect modal: at <480px, full-screen sheet instead of centered modal. Both are pure Tailwind class additions; do them in v1.

### 9as. Stop emojis in the codebase if user prefers

The existing `DocsMode.tsx` has emoji in JSX (`📍`, `🗓`). The original `App.tsx` uses `▾` and `✕`. If the user/project style is to avoid emojis going forward, the Welcome and Connect components should use SVG icons (e.g., Lucide React) instead. Mention in the PR; don't unilaterally rewrite existing files.

---

## 10. Open questions for the next Claude

These weren't decided in the planning conversation. The implementer should pick one and note their choice in the PR.

- **MCP gateway: should `canvas_map_set` also set mode to `map` implicitly?** Pro: matches user intent ("show me the US map" → they expect to see a map). Con: explicit-is-better. Recommendation: yes, set mode implicitly. If you do, document it in the tool description.
- **What's the API_URL value shown in the Connect modal snippet?** It needs to be the public-facing URL the user will hit, not the in-browser origin necessarily (those might match in production but not in dev). Either expose it via a `GET /api/config` endpoint or inject at build time via `import.meta.env.VITE_PUBLIC_API_URL`.
- **Should the Welcome mode be reachable after a template is picked?** Phase 3 says no. If we ever want yes, add a "Start over" link in the header that sends `mode.set "welcome"`. Decision deferred.
- **Default `mapId` storage**: should we store `"world"` on creation, or leave NULL and resolve at render? Plan says NULL + resolve. If the agent reads canvas state and sees `mapId: null`, it might be confused — consider storing `"world"` explicitly on canvas creation if `mode` defaults to anything map-related. Since the default mode is now `welcome`, leaving NULL is fine.

---

## 11. Done criteria

Phase 3 ships when:

- [ ] Migration applied, existing canvases still load.
- [ ] New canvases land in Welcome mode by default.
- [ ] All six initial templates work end-to-end (mode + map propagates to a second browser, no flash of stale map).
- [ ] An agent writing a pin/event/note to a `welcome` canvas auto-transitions the mode (§9m).
- [ ] `GET /api/maps` returns the four initial presets; `GET /api/maps/{id}` returns full definitions; unknown id returns 404.
- [ ] `MapMode` renders any registered preset; no hardcoded coordinates or tile URLs remain in `MapMode.tsx`.
- [ ] Connect modal auto-opens on first canvas open per browser; "I'm connected" persists dismissal; Connect button reopens it; ESC and click-outside close it; focus is trapped.
- [ ] Header share dropdown removed; version label moved to Connect modal footer.
- [ ] MCP `canvas_map_set` works against a live canvas from a connected Claude Code session.
- [ ] `canvas_state_read` includes `mapId` in canvas meta.
- [ ] `sendOp` queues ops while WS is connecting (no silent drops).
- [ ] Landing-page `prompt()` replaced with an inline form.
- [ ] No regression: itinerary and docs modes still render correctly.

---

## 12. Anti-scope: things NOT to do while you're in here

The temptation while touching this code will be to "clean up" adjacent things. Resist these specifically:

- Don't refactor the WS protocol shape beyond adding the new ops. The existing `state` broadcast pattern stays.
- Don't replace `react-leaflet` with anything else. Map preset abstraction is the layer; the renderer underneath is fine.
- Don't add a database table for templates. They're code in `apps/web/src/lib/templates.ts`. (Promoting to API is §9e, deferred.)
- Don't change the canvas-code format (8 chars, A-Z0-9). It's stable across phases.
- Don't add user accounts or auth on the browser side. Phase 3 still uses canvas-code-as-bearer-of-access.
- Don't reorganize `apps/api/internal/api/` files. Add new ones; leave existing handlers in place.
- Don't change the JWT shape used by the MCP gateway. Same JWT, new endpoint behind it.

---

## 13. Reference code skeletons

These are starting points, not finished code. Adapt to the actual surrounding style.

### 13a. Go: `internal/maps/registry.go`

```go
package maps

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
)

type Layer struct {
	Kind        string                 `json:"kind"`
	URL         string                 `json:"url,omitempty"`
	Attribution string                 `json:"attribution,omitempty"`
	MinZoom     *int                   `json:"minZoom,omitempty"`
	MaxZoom     *int                   `json:"maxZoom,omitempty"`
	Style       map[string]interface{} `json:"style,omitempty"`
}

type Definition struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description,omitempty"`
	Center      [2]float64 `json:"center"`
	Zoom        int        `json:"zoom"`
	MinZoom     *int       `json:"minZoom,omitempty"`
	MaxZoom     *int       `json:"maxZoom,omitempty"`
	Bounds      *[2][2]float64 `json:"bounds,omitempty"`
	Layers      []Layer    `json:"layers"`
	Thumbnail   string     `json:"thumbnail,omitempty"`
	Tags        []string   `json:"tags,omitempty"`
	Category    string     `json:"category,omitempty"`
}

type Summary struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Thumbnail   string   `json:"thumbnail,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	Category    string   `json:"category,omitempty"`
}

type Registry struct {
	mu    sync.RWMutex
	byID  map[string]Definition
	order []string
}

func (r *Registry) Get(id string) (Definition, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	d, ok := r.byID[id]
	return d, ok
}

func (r *Registry) Has(id string) bool {
	_, ok := r.Get(id)
	return ok
}

func (r *Registry) List() []Summary {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Summary, 0, len(r.order))
	for _, id := range r.order {
		d := r.byID[id]
		out = append(out, Summary{
			ID: d.ID, Name: d.Name, Description: d.Description,
			Thumbnail: d.Thumbnail, Tags: d.Tags, Category: d.Category,
		})
	}
	return out
}

//go:embed assets/*.json
var embedded embed.FS

func LoadEmbedded() (*Registry, error) {
	return loadFromFS(embedded, "assets")
}

func LoadFromDir(dir string) (*Registry, error) {
	return loadFromFS(nil, dir)
}

func loadFromFS(efs fs.FS, dir string) (*Registry, error) {
	r := &Registry{byID: map[string]Definition{}}
	var entries []fs.DirEntry
	var err error
	if efs != nil {
		entries, err = fs.ReadDir(efs, dir)
	} else {
		entries, err = readDirOS(dir)
	}
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		var data []byte
		if efs != nil {
			data, err = fs.ReadFile(efs, filepath.Join(dir, e.Name()))
		} else {
			data, err = readFileOS(filepath.Join(dir, e.Name()))
		}
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", e.Name(), err)
		}
		var def Definition
		if err := json.Unmarshal(data, &def); err != nil {
			return nil, fmt.Errorf("decode %s: %w", e.Name(), err)
		}
		expectedID := strings.TrimSuffix(e.Name(), ".json")
		if def.ID != expectedID {
			return nil, fmt.Errorf("%s: id %q must match filename", e.Name(), def.ID)
		}
		if _, dup := r.byID[def.ID]; dup {
			return nil, fmt.Errorf("duplicate map id: %s", def.ID)
		}
		if len(def.Layers) == 0 {
			return nil, fmt.Errorf("%s: at least one layer required", def.ID)
		}
		r.byID[def.ID] = def
		r.order = append(r.order, def.ID)
	}
	if len(r.order) == 0 {
		return nil, errors.New("no map presets loaded")
	}
	return r, nil
}
```

(`readDirOS` / `readFileOS` are tiny shims around `os.ReadDir` / `os.ReadFile`. Inline them or use `os.DirFS` to reuse the `fs.FS` path.)

### 13b. Go: `internal/api/maps_handler.go`

```go
package api

import (
	"net/http"

	"github.com/agentcanvas/api/internal/maps"
	"github.com/go-chi/chi/v5"
)

type MapsHandler struct {
	reg *maps.Registry
}

func NewMapsHandler(r *maps.Registry) *MapsHandler {
	return &MapsHandler{reg: r}
}

func (h *MapsHandler) List(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"maps": h.reg.List()})
}

func (h *MapsHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	def, ok := h.reg.Get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "map not found")
		return
	}
	writeJSON(w, http.StatusOK, def)
}
```

### 13c. Go: handler for `POST /api/canvas/map`

Mirror of `SetMode` at [canvas_handler.go:67](apps/api/internal/api/canvas_handler.go#L67):

```go
func (h *Handler) SetMap(w http.ResponseWriter, r *http.Request) {
	var body struct{ MapID string `json:"mapId"` }
	if err := decode(r, &body); err != nil || body.MapID == "" {
		writeError(w, http.StatusBadRequest, "mapId is required")
		return
	}
	if !h.maps.Has(body.MapID) {
		writeError(w, http.StatusBadRequest, "unknown mapId")
		return
	}
	canvasID := CanvasIDFromCtx(r.Context())
	if _, err := h.store.SetMapID(r.Context(), canvasID, body.MapID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}
```

`Handler` gains a `maps *maps.Registry` field; constructor updated accordingly.

### 13d. Go: WS handler additions

In `ws_handler.go`'s op switch, add cases for `map.set` and `template.apply`:

```go
case "map.set":
    var p struct{ MapID string `json:"mapId"` }
    if err := json.Unmarshal(raw, &p); err != nil || p.MapID == "" {
        sendErr("invalid map.set"); return
    }
    if !h.maps.Has(p.MapID) {
        sendErr("unknown mapId"); return
    }
    if _, err := h.store.SetMapID(ctx, canvasID, p.MapID); err != nil {
        sendErr(err.Error()); return
    }
    broadcastState(ctx, h.store, h.hub, canvasID)

case "template.apply":
    var p struct {
        TemplateID string `json:"templateId"`
        Mode       string `json:"mode"`
        MapID      string `json:"mapId,omitempty"`
    }
    if err := json.Unmarshal(raw, &p); err != nil { sendErr("invalid template.apply"); return }
    if !isValidMode(p.Mode) { sendErr("invalid mode"); return }
    if p.MapID != "" && !h.maps.Has(p.MapID) { sendErr("unknown mapId"); return }
    if err := h.store.ApplyTemplate(ctx, canvasID, p.Mode, p.MapID); err != nil {
        sendErr(err.Error()); return
    }
    broadcastState(ctx, h.store, h.hub, canvasID)
```

`store.ApplyTemplate` is a small new method: update both columns and bump version in one transaction.

### 13e. TypeScript: `useMapDefinition` hook

```ts
import { useEffect, useState } from "react";
import { resolveMap, type MapDefinition } from "./maps";

export function useMapDefinition(id: string) {
  const [state, setState] = useState<{ map?: MapDefinition; error?: Error; loading: boolean }>({
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    resolveMap(id)
      .then(map => { if (!cancelled) setState({ map, loading: false }); })
      .catch(error => { if (!cancelled) setState({ error, loading: false }); });
    return () => { cancelled = true; };
  }, [id]);

  return state;
}
```

### 13f. TypeScript: queued `sendOp`

Replace the body of `sendOp` in `apps/web/src/lib/ws.ts`:

```ts
const queue: WSClientMessage[] = [];

export function sendOp(op: WSClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(op));
    return;
  }
  queue.push(op);
}

// Inside connect(), socket.onopen:
socket.onopen = () => {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  while (queue.length && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(queue.shift()!));
  }
};
```

Optional: cap queue length (e.g. 50) and drop the oldest with a console warning if hit.

### 13g. TypeScript: `ConnectModal.tsx` skeleton

```tsx
import { useEffect, useRef } from "react";

interface Props {
  code: string;
  apiUrl: string;
  onClose: () => void;
  onSwitchCanvas: () => void;
}

export default function ConnectModal({ code, apiUrl, onClose, onSwitchCanvas }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function dismiss() {
    localStorage.setItem(`tandem.connected.${code}`, "1");
    onClose();
  }

  const snippet = `CANVAS_CODE=${code}\nAPI_URL=${apiUrl}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
        className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6 outline-none"
      >
        <h2 id="connect-title" className="text-lg font-semibold text-gray-900">
          Connect Claude to this canvas
        </h2>
        {/* big code, copy button, env snippet, steps list, primary CTA, footer */}
        <button onClick={dismiss} className="...">I'm connected</button>
        <button onClick={onSwitchCanvas} className="...">← Switch canvas</button>
      </div>
    </div>
  );
}
```

`apiUrl` comes from `import.meta.env.VITE_PUBLIC_API_URL ?? window.location.origin` (see §10).

### 13h. JSON: example template manifest (if §9e ever gets built)

For when templates move server-side. Schema sketch only — do NOT build this in Phase 3.

```json
{
  "id": "tokyo-trip",
  "name": "Tokyo trip",
  "description": "Greater Tokyo area",
  "mode": "map",
  "mapId": "tokyo",
  "suggestedPrompt": "Plan a 5-day Tokyo trip with pins for each stop."
}
```

---

## 14. Operations & deployment

### 14a. Environment variables added in Phase 3

| Name | Where | Default | Purpose |
|---|---|---|---|
| `MAPS_DIR` | Go API | `./assets/maps` | Path to preset JSON files (dev only; production uses embed) |
| `DEV` | Go API | `false` | Enables preset hot-reload (§9ap) |
| `VITE_PUBLIC_API_URL` | Web build | `window.location.origin` | URL shown in Connect modal snippet |

Document in the project README env section.

### 14b. Build pipeline updates

- Go: `go build` must include the `assets/maps/*.json` files. The `//go:embed` directive in `internal/maps/registry.go` handles this; verify the relative path resolves correctly from where the package lives.
- Web: no new build steps. Vite picks up the new modules automatically.
- MCP gateway: rebuild after adding `canvas_map_set` / `canvas_map_list` tools; bump version in `package.json`.

### 14c. Migration application

The migration in §1 is the only DB change. Apply via the project's existing migration tool (Supabase CLI or whatever's wired up). Verify on a staging copy first.

### 14d. Rollback plan

- The migration is forward-only (adding nullable column + relaxing CHECK constraint). To roll back: `ALTER TABLE canvases DROP COLUMN map_id;` and re-tighten the CHECK to exclude `welcome` (after first updating any rows with `mode='welcome'` to `mode='map'`).
- Code rollback: revert the API binary; old binary doesn't know about `welcome` mode but won't crash on it — it'll fail validation on a state read if it's strict. Test before relying on this.

### 14e. Monitoring

Add log lines for:
- Map registry load: `"loaded N map presets: [ids...]"`
- Unknown `mapId` rejections: warn-level
- Template applies (with `templateId`)
- Mode transitions (especially welcome → other)

If structured logging is in use (zap, slog, zerolog), use fields not string formatting.

### 14f. Local dev workflow

After this PR, a fresh checkout should:
1. Apply migrations.
2. `make dev` (or whatever) starts API + web + MCP gateway.
3. Open `localhost:5173` → Landing → Create canvas.
4. Expect: Welcome screen + Connect modal auto-open.

Update any onboarding docs / `CONTRIBUTING.md` if they describe the old flow.

---

## 15. PR / commit shape

The whole change is too big for one PR. Recommended split:

1. **Migration + shared types + Go store** — DB change, types flow, no UX change yet. Apps still work as before because `welcome` mode is allowed but no canvas uses it.
2. **Map registry + endpoints** — `/api/maps`, embedded presets, no frontend yet.
3. **`MapMode` refactor** — consume `useMapDefinition`. Default to `"world"` when `mapId` is null. Visible change: existing canvases show world map instead of Tokyo (or backfilled to `tokyo` per §9r).
4. **WelcomeMode + template ops + auto-mode-on-write** — new default for new canvases. Existing canvases unaffected.
5. **ConnectModal + header refactor** — UX-only.
6. **MCP gateway: `canvas_map_set` + `canvas_map_list`** — agent-facing.
7. **Polish**: example prompts, telemetry hooks, empty states, thumbnails.

Each PR independently shippable. PR titles should reference this doc's section numbers for grep-ability later.

---

## 16. Glossary

- **Canvas**: a shared session, identified by 8-char code.
- **Mode**: which view a canvas is in. Phase 3 adds `welcome`.
- **Map preset / preset / `mapId`**: a JSON-described configuration for the map view (center, zoom, layers). Identified by short string ID.
- **Template**: a frontend-only bundle of "set mode to X and map to Y". Picked by the user from the Welcome screen.
- **Welcome mode**: the canvas mode shown when no template has been picked. Renders the template grid + example prompts.
- **Connect modal**: the dialog that shows the canvas code and how to wire it into Claude's MCP gateway. Auto-opens on first visit per browser.
