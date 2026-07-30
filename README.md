# Tandem

Tandem is the shared state layer for teams running parallel agent sessions — a better way for agents to manage what they're all up to, without hacky TODO markdown files.

Intent lives in the repo; state lives in Tandem. The spec stays in git, and the churn — task claims, statuses, results — moves out of markdown into a durable shared queue that every session and every human can see live.

Live at **[tandemcanvas.com](https://tandemcanvas.com)**.

## How it works

1. The spec lives in your repo, like it always has.
2. An agent session proposes an epic and its tasks (`epic_propose`), which land as *proposed*.
3. You approve them once in the web UI — no per-step pinging after that.
4. N parallel sessions (Claude Code, Cursor, any MCP client) each pull the approved queue (`queue_next`), claim a task (`task_claim`) so the others skip it, and do the work.
5. Each finished task is completed with a result (`task_complete`) that says what was done and where — commit, PR, files — while you watch the board move in the browser.

## Quickstart

Zero to parallel sessions in ~5 minutes. Everything below is copy-paste.

### 1. Create a canvas

Go to [tandemcanvas.com](https://tandemcanvas.com) and create a canvas. Grab its 8-character code — you'll see it on the canvas (it's also in the URL). Examples below use `AB3XK9QZ`; substitute yours.

### 2. Register the MCP server (Claude Code)

```bash
claude mcp add tandem -- npx -y @jaximus/tandem-mcp
```

That's it. The package defaults to the hosted backend at `https://tandemcanvas.com` — no env vars, no account, no token needed for public canvases. Verify:

```bash
claude mcp list
# tandem: npx -y @jaximus/tandem-mcp - ✓ Connected
```

On claude.ai or Cursor, add the hosted Streamable-HTTP endpoint instead: `https://tandemcanvas.com/api/mcp`.

(Later, for private canvases: mint a token under **Access tokens** at [tandemcanvas.com/me](https://tandemcanvas.com/me) and re-add with `claude mcp add tandem --env TANDEM_TOKEN=tdm_pat_… -- npx -y @jaximus/tandem-mcp`. Not needed for the quickstart.)

### 3. Teach your sessions the loop

Paste this into your repo's `CLAUDE.md` (replace `AB3XK9QZ` with your canvas code):

````markdown
## Tandem task queue

The shared work queue for this repo is Tandem canvas `AB3XK9QZ`.

Every session:

1. `canvas_connect` with code `AB3XK9QZ` — once per session. Pass `role`
   ("executor" if you'll work tasks yourself, "planner" if you'll dispatch
   them to subagents) and a `name`. Keep the `session` handle it returns and
   pass it as `session` on every later Tandem call.
2. `queue_next` — the approved, ready-to-work queue. That is the entry point
   for work; don't go looking for it by reading the canvas. (`context_get`
   once if you need to orient on what this canvas is.)
3. Pick one task, `task_get` for its hydrated context (linked notes, roadmap
   items, its epic), then `task_claim` to claim it. The claim is atomic: if
   it returns `{ claimed: false, claimedBy }`, another session won — do NOT
   work on that task; go back to `queue_next` and take the next one.
4. Do the work. Every commit message for the task starts with its ticket
   ID, e.g. `TDM-7: add rate limiter`. On long work, `task_progress` with
   one line per meaningful step — it doubles as a heartbeat, so a task that
   runs past ~15 minutes doesn't become reclaimable underneath you.
5. `task_complete` with a `result` saying what was done and where — always
   include the commit hash(es) — plus `links` to the commit or PR.

Planning from a spec: when asked to decompose SPEC.md (or any spec file)
into work, use `epic_propose` — one epic per spec section, with that
section's tasks passed in the SAME call via `tasks`, so the human approves
once instead of task by task. In the epic body, record the spec file path,
the section heading, and the current commit SHA of the spec file. One human
approval of the epic approves its tasks (canvas approval policy `epic`, the
default); add more tasks to an existing epic later with `task_propose` and
that `epicId`. Before working a claimed task that belongs to an epic, diff
the spec section against the SHA recorded in the epic body: if the section
changed since the epic was planned, do not proceed — flag the task back
with `task_complete` using `status: "failed"` and an `error` noting the spec
drift, so the plan gets redone against the current spec.

If a task needs to deviate from the approved plan, don't silently do it —
propose the deviation with `task_propose` and `requiresApproval: true` so a
human gates it.

Dispatching subagents instead of working tasks yourself? Connect with
`role: "planner"` and paste each ready task's `handoff` block from
`queue_next` into one subagent per task — you dispatch, they claim. Never
claim a task you won't personally do, and never hand a subagent your
`session` handle; the canvas code is what travels.
````

### 4. Go parallel

Seed the queue: in one session, ask Claude to plan (`"read SPEC.md and propose the work on the Tandem canvas"`), then approve the epic once in the web UI — its tasks fan out to approved. Now open two terminals in the same repo:

```bash
# terminal 1 and terminal 2:
claude "work through the approved Tandem queue until it's empty"
```

Both sessions pull the same queue. Each claim has exactly one winner — the loser sees `{ claimed: false, claimedBy: "…" }` and moves to the next task. Watch the board at tandemcanvas.com: cards flip to *executing* with the claimant's name, every task carries its `TDM-n` ticket, and results (with commit hashes) land as tasks complete.

Want approving a task to *launch* the sessions instead of you starting them? Wire a webhook to a local listener — see [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md).

## Monorepo

| Path | What it is |
|------|------------|
| `apps/api` | Go API — HTTP + WebSocket hub, Supabase/Postgres, JWT + Google OAuth |
| `apps/web` | React + Vite + Tailwind frontend |
| `apps/mcp-gateway` | Node stdio MCP server (`@jaximus/tandem-mcp`) that proxies tool calls to the API |
| `internal/shared` | TypeScript types shared by web + gateway |
| `supabase/migrations/` | Hand-written, numbered SQL applied manually to Supabase |

## Develop

```bash
# API
cd apps/api && go build ./... && go test ./...

# Web
cd apps/web && pnpm build

# Gateway
cd apps/mcp-gateway && pnpm build
```

Copy `.env.example` to `.env` and fill in the values. `.env` is git-ignored — never commit secrets.

## Deploy

Push to `main`. GitHub Actions builds and deploys to GCP via Docker Compose.

## MCP

Connect an agent session to a canvas with the published MCP server:

```
npx @jaximus/tandem-mcp
```

Or use the hosted Streamable-HTTP endpoint at `https://tandemcanvas.com/api/mcp`. Vendor-neutral by design: anything that speaks MCP can join the same queue.

The default surface on both transports is the same **14-tool intent facade**, shaped like the work loop rather than the API: `canvas_connect`, `agent_register`, `context_get`, `queue_next`, `task_find`, `task_get`, `task_claim`, `task_progress`, `task_complete`, `task_propose`, `task_amend`, `epic_propose`, `doc_write`, `board_status`. The ~80-tool CRUD surface (maps, sheets, charts, forms, …) is additive and one opt-in away — `TANDEM_FULL_TOOLS=1` or `tandem-mcp --full-tools`. Nothing in the quickstart needs it. See [apps/mcp-gateway/README.md](apps/mcp-gateway/README.md#tools) for the per-tool reference.
