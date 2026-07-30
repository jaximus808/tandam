# Dev workflows

Three ways to run the app, fastest first.

## 1. Mock mode — frontend only, no backend (fastest UI iteration)

Pure frontend with a hardcoded canvas fixture. No Docker, no Supabase, no API. Hot-reloads on every save.

```bash
pnpm dev:mock
```

- Opens http://localhost:5173, auto-routes to the mock canvas (`/c/MOCKCNV1`).
- Fixture includes 3 pins, 2 events, and 2 notes (one with a big markdown table) so you can immediately test rendering and editing.
- All ops (`pin.add`, `note.update`, `mode.set`, etc.) apply to in-memory state — refreshing resets to the fixture.
- Map presets (`world`, `us`, `tokyo`, `japan`) bundled into the bundle so `/api/maps` isn't called.

Use for: testing layout, markdown rendering, mode switching, the docs editor, anything that's pure UI.

Limitations: no image uploads (the `/api/images` endpoint isn't mocked), no MCP gateway, refresh wipes changes.

## 2. HMR against the dockerized backend (real data, fast iteration)

Backend in Docker, frontend in Vite. Vite proxies `/api`, `/canvas-images`, and `/ws` to the API on `localhost:7891`. Both halves hot-reload — the API on rebuild, the web instantly.

```bash
# Terminal 1 — backend (rebuild + run detached)
pnpm dev:api          # equivalent to ./scripts/rebuild.sh -d

# Terminal 2 — frontend
pnpm dev:web
```

Or fire both with one command:

```bash
pnpm dev:full         # backend up -d, then web dev in the foreground
```

Open http://localhost:5173. Real Supabase canvases, real WS sync, instant frontend reload on save.

Use for: testing anything that touches the database, MCP integration, real multiplayer sync.

After editing Go code: re-run `pnpm dev:api` (the script will rebuild the image).

## 3. Full Docker (production-like)

The image bundles the web build, served by the Go server at `/*`. No HMR, but exactly what you'd ship.

```bash
./scripts/rebuild.sh
```

Open http://localhost:7891.

Use for: smoke-testing the actual image before deploy, or running the full stack offline.

---

## Cheat sheet

| Goal | Command | URL |
|---|---|---|
| UI work, no backend | `pnpm dev:mock` | http://localhost:5173 |
| UI work, real DB | `pnpm dev:api` then `pnpm dev:web` | http://localhost:5173 |
| End-to-end | `./scripts/rebuild.sh` | http://localhost:7891 |
| Backend logs | `./scripts/rebuild.sh logs -f` | — |
| Stop everything | `./scripts/rebuild.sh down` | — |

## The mock fixture

Edit `apps/web/src/lib/mockFixture.ts` to change what `dev:mock` shows. The fixture is plain TypeScript — add pins, change the markdown body of notes, etc., and Vite HMR will reload immediately.

If you add a feature that needs new fixture data, drop it in there with a comment so the next person knows what it's exercising.
