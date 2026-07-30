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

The tool names below are the **default MCP surface** — the 12-tool intent facade
(`FACADE_NAMES` in `apps/mcp-gateway/src/facade.ts`): `canvas_connect`,
`agent_register`, `context_get`, `queue_next`, `task_get`, `task_claim`,
`task_progress`, `task_complete`, `task_propose`, `epic_propose`, `doc_write`,
`board_status`. The old ~80-tool `canvas_*` CRUD surface is still callable but is
only *advertised* behind `TANDEM_FULL_TOOLS=1`, so write against these names.

Sessions start from the task queue, NOT a full canvas read:

1. `canvas_connect` with code `TEGLQFXR`, `role: "executor"`, and a `name`
   (once per session — one call connects **and** registers you). Keep the
   `session` handle it returns and pass it as `session` on **every** later
   Tandem call; the hosted connection can reset between calls.
2. `queue_next` — the approved, ready-to-work queue, and the entry point for
   work. Don't go hunting for it by reading the canvas: `context_get` is the
   cheap one-call briefing (identity, document tabs, per-kind counts, queue
   state) if you need to orient first.
3. `task_get` on the task you'll work on — it returns the task plus its linked
   roadmap items / notes hydrated, which is all the context you need.
   **`id` takes a ticket ref, not just a uuid:** told "take on TDM-21", pass
   `TDM-21` (or `tdm-21` / `#21` / `21`) straight to `task_get`, `task_claim`,
   `task_progress`, `task_complete`. No lookup call, no board read.
4. `task_claim` to claim it (so parallel sessions skip it). The claim is
   **atomic and losing is normal**: `{ claimed: false, claimedBy }` means
   another session won — do NOT work it, go back to `queue_next`. On success
   you get the `ticketId` (e.g. `TDM-80`); put it in commit messages.
5. Do the work, reporting `task_progress` — one line per meaningful step. It
   doubles as a **heartbeat**, so work running past ~15 minutes doesn't become
   reclaimable underneath you.
6. `task_complete` with a short `result` (what was done, where — files, commit,
   PR) plus `links` to any commit / PR. The board resolves GitHub links live.
   Complete under the same identity you claimed with; leaving a task
   `executing` blocks the queue.

That is the **single-session** loop: you claim, you work, you complete. The rule
underneath it: **an agent claims only what it will personally do. An orchestrator
dispatches; it never claims, never completes on a worker's behalf, and never
transports its `session` handle.**

**Fan-out variant — dispatching means you do not claim.** If you are spawning
subagents to work the queue, you are the orchestrator, and steps 3–6 above are
*theirs*, not yours:

1. `canvas_connect` with `role: "planner"` and a name — one call connects and
   registers you; keep the returned `agentId` and `session`.
2. `queue_next` — the same ready queue as step 2 above. Each task comes back
   with a `handoff` block: the 8-char canvas **code**, the task id, ticket id,
   title, your `agentId` as parent, and the literal steps the worker follows.
3. Spawn **one subagent per ready task** and paste that task's `handoff` in
   **verbatim**. The worker connects with `role: "executor"` and
   `parentAgentId`, claims its own task, works, and completes under the identity
   it claimed with. On `claimed:false` it takes a different ready task.
4. You claim nothing and complete nothing. Never hand a subagent your `session`
   handle — the canvas **code** is what travels. To report, read `board_status`;
   a task still `executing` is something you report, not something you close.

The full recipes: `docs/ORCHESTRATION.md` (webhook-triggered) and the
`tandem-watch` skill in `.claude/skills/tandem-watch/` (in-session watch loop).

When asked to plan work rather than execute it, use `epic_propose`: it creates the
named container **and** its tasks in the same call (pass them via `tasks`), so
Jaxon approves once instead of task by task. One task per unit of work, concise
body, heavy context linked via `linkedIds` (`task_get` hydrates those for whoever
picks it up). Add more tasks to an existing batch later with `task_propose` and
that `epicId`. Everything lands as `proposed` for human approval in the web UI —
never try to approve your own work; the gateway refuses agent approval of epics.

**After proposing, LISTEN for the approval instead of ending your turn.** Unless
told otherwise, poll `queue_next` with the returned `epicId` on a backing-off
interval (start ~15s, double to a ~2min cap). The moment tasks come back
approved, work them — or, with subagents, dispatch one per task using the
`handoff` blocks. Jaxon approving on the board **is** the go signal; he shouldn't
have to prompt you a second time. (`epic_propose`'s own response says this too.)

Also keep the canvas current as you make meaningful progress (finish a feature,
fix a notable bug, change direction) — as you go, not just at the end. Roadmap
item editing isn't on the default surface, so leave the context as a markdown
note with `doc_write` (it creates the `document` tab if the name is new), and use
`task_complete`'s `result` for task outcomes. `board_status` is the cheap "where
does this project stand" read — counts by state, what's in flight and who holds
it, epics and their approval state. Treat the canvas as the source of truth for
"where the project is." Also note any friction you hit using the tools — that
feedback is itself valuable.

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

**Git: commit ticket work — one commit per ticket.** When your changes belong to
a ticket, commit them as `TDM-<n>: <short change summary>` right after builds/
tests pass and BEFORE `task_complete`, so the result can carry the commit hash.
Scope the commit to your ticket's files only — never sweep in other sessions'
uncommitted work. Everything else about git stays Jaxon's: do NOT push, branch,
or open PRs unless he explicitly asks. Non-ticket work stays uncommitted unless
he says otherwise.
