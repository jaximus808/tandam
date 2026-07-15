# Tandem — project guide for Claude

Tandem is a shared planning canvas that humans and AI agents co-edit in real time.
Monorepo:

- `apps/api` — Go API (HTTP + WebSocket hub + Supabase/Postgres). Issues canvas JWTs
  and (new) Google-OAuth user sessions.
- `apps/web` — React + Vite + Tailwind frontend.
- `apps/mcp-gateway` — Node stdio MCP server (`@jaximus/tandem-mcp`) that proxies tool
  calls to the API.
- `internal/shared` — TypeScript types shared by web + gateway.
- `supabase/migrations/` — hand-written, numbered SQL. Applied manually to Supabase.

Live at https://tandemcanvas.com. Deploy = push to `main` (GitHub Actions → GCP).

## Work from the canvas task queue

The living roadmap for THIS project is itself a Tandem canvas: **code `TEGLQFXR`**
("tandem planning"). Dogfooding — we plan Tandem in Tandem.

Sessions start from the task queue, NOT a full state read:

1. `canvas_connect` with code `TEGLQFXR` (once per session).
2. `canvas_task_list` with `state: "approved"` — the ready-to-work queue. This is
   the cheap entry point; do **not** open with `canvas_state_read` (it returns the
   entire canvas and is huge). Reserve `canvas_state_read` for when you genuinely
   need the whole board.
3. `canvas_task_get` on the task you'll work on — it returns the task plus its
   linked roadmap items / notes hydrated, which is all the context you need.
4. `canvas_task_start` to claim it (so parallel sessions skip it), do the work,
   then `canvas_task_complete` with a short result summary (what was done, where —
   commit / PR / files). The result shows in the web Tasks panel.

When asked to plan work rather than execute it, draft tasks with `canvas_task_add`
(one per unit of work, concise body, heavy context linked via `linkedIds`) — they
land as `proposed` for human approval in the web UI.

Also keep the roadmap in sync as you make meaningful progress (finish a feature,
fix a notable bug, change direction): move roadmap items between `todo` /
`in_progress` / `done` (`canvas_roadmap_item_update`), add new goals
(`canvas_roadmap_item_add`), or add a note for context — as you go, not just at
the end. Treat the canvas as the source of truth for "where the project is."
Also note any friction you hit using the tools — that feedback is itself valuable.

## Build / verify

- API: `cd apps/api && go build ./... && go test ./...`
- Web: `cd apps/web && pnpm build`
- Gateway: `cd apps/mcp-gateway && pnpm build`

Env: see `apps/api/.env.example`. Never commit secrets — `GOOGLE_CLIENT_ID` is public,
the rest (`SUPABASE_KEY`, `JWT_SECRET`) are not.

## Division of labour (important)

Your job stops at the code: **make the changes, then build all three packages
and run the Go tests to prove it compiles and passes.** That's the whole
deliverable. Jaxon handles everything runtime — starting the server, applying
migrations to Supabase, rebuilding the local container, and manual QA in the
browser.

So: **do not** spend effort (or tokens) working out how to run the server,
rebuild the `tandem-local` docker image, point the MCP at localhost, or drive a
browser to verify UI. When a change needs a migration, write the numbered SQL in
`supabase/migrations/` and just tell him to apply it — don't try to run it yourself.
Report what you changed and what's left for him to do, and stop there.
