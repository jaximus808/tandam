# Tandem — project guide for Claude

Tandem is a shared planning canvas that humans and AI agents co-edit in real time.
Monorepo:

- `apps/api` — Go API (HTTP + WebSocket hub + Supabase/Postgres). Issues canvas JWTs
  and (new) Google-OAuth user sessions.
- `apps/web` — React + Vite + Tailwind frontend.
- `apps/mcp-gateway` — Node stdio MCP server (`@jaximus/tandem-mcp`) that proxies tool
  calls to the API.
- `internal/shared` — TypeScript types shared by web + gateway.
- `migrations/` — hand-written, numbered SQL. Applied manually to Supabase.

Live at https://tandemcanvas.com. Deploy = push to `main` (GitHub Actions → GCP).

## Keep the project plan in sync with the Tandem canvas

The living roadmap for THIS project is itself a Tandem canvas: **code `PKMLR67T`**
("tandem planning"). Dogfooding — we plan Tandem in Tandem.

When you make meaningful progress (finish a feature, fix a notable bug, change
direction, start a new initiative), reflect it on that canvas using the `agentcanvas`
MCP tools — as you go, not just at the end:

1. `canvas_connect` with code `PKMLR67T` (once per session).
2. `canvas_state_read` to see the current roadmap / sheets / notes.
3. Update it to match reality: move roadmap items between `todo` / `in_progress` /
   `done` (`canvas_roadmap_item_update`), add new goals (`canvas_roadmap_item_add`),
   or add a note / sheet row for context.

Treat the canvas as the source of truth for "where the project is." Also note any
friction you hit using the tools — that feedback is itself valuable.

## Build / verify

- API: `cd apps/api && go build ./... && go test ./...`
- Web: `cd apps/web && pnpm build`
- Gateway: `cd apps/mcp-gateway && pnpm build`

Env: see `apps/api/.env.example`. Never commit secrets — `GOOGLE_CLIENT_ID` is public,
the rest (`SUPABASE_KEY`, `JWT_SECRET`) are not.
