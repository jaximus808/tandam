# Tandem

Tandem is the shared state layer for teams running parallel agent sessions — a better way for agents to manage what they're all up to, without hacky TODO markdown files.

Intent lives in the repo; state lives in Tandem. The spec stays in git, and the churn — task claims, statuses, results — moves out of markdown into a durable shared queue that every session and every human can see live.

Live at **[tandemcanvas.com](https://tandemcanvas.com)**.

## How it works

1. The spec lives in your repo, like it always has.
2. An agent session proposes an epic as tasks (`canvas_task_add`), which land as *proposed*.
3. You approve them once in the web UI — no per-step pinging after that.
4. N parallel sessions (Claude Code, Cursor, any MCP client) each pull the approved queue (`canvas_task_list`), claim a task (`canvas_task_start`) so the others skip it, and do the work.
5. Each finished task is completed with a result (`canvas_task_complete`) that says what was done and where — commit, PR, files — while you watch the board move in the browser.

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

1. `canvas_connect` with code `AB3XK9QZ` (once per session).
2. `canvas_task_list` with `state: "approved"` — the ready-to-work queue.
   Do not open with `canvas_state_read`; it pulls the entire canvas.
3. Pick a task, `canvas_task_get` for its hydrated context, then
   `canvas_task_start` to claim it. The claim is atomic: if it returns
   `{ claimed: false, claimedBy }`, another session won — do NOT work on
   that task; go back to the list and take the next one.
4. Do the work. Every commit message for the task starts with its ticket
   ID, e.g. `TDM-7: add rate limiter`.
5. `canvas_task_complete` with a `result` saying what was done and where —
   always include the commit hash(es).

Planning from a spec: when asked to decompose SPEC.md (or any spec file)
into work, propose one epic per spec section with `canvas_epic_add`, then
that section's tasks with `canvas_task_add` passing the epic's id as
`epicId`. In the epic body, record the spec file path, the section heading,
and the current commit SHA of the spec file. One human approval of the epic
approves its tasks (canvas approval policy `epic`, the default). Before
working a claimed task that belongs to an epic, diff the spec section
against the SHA recorded in the epic body: if the section changed since the
epic was planned, do not proceed — flag the task back with
`canvas_task_complete` using `status: "failed"` and an `error` noting the
spec drift, so the plan gets redone against the current spec.

If a task needs to deviate from the approved plan, don't silently do it —
propose the deviation as a new task with `requiresApproval: true` so a
human gates it.
````

### 4. Go parallel

Seed the queue: in one session, ask Claude to plan (`"read SPEC.md and propose the work on the Tandem canvas"`), then approve the epic once in the web UI — its tasks fan out to approved. Now open two terminals in the same repo:

```bash
# terminal 1 and terminal 2:
claude "work through the approved Tandem queue until it's empty"
```

Both sessions pull the same queue. Each claim has exactly one winner — the loser sees `{ claimed: false, claimedBy: "…" }` and moves to the next task. Watch the board at tandemcanvas.com: cards flip to *executing* with the claimant's name, every task carries its `TDM-n` ticket, and results (with commit hashes) land as tasks complete.

## Monorepo

| Path | What it is |
|------|------------|
| `apps/api` | Go API — HTTP + WebSocket hub, Supabase/Postgres, JWT + Google OAuth |
| `apps/web` | React + Vite + Tailwind frontend |
| `apps/mcp-gateway` | Node stdio MCP server (`@jaximus/tandem-mcp`) that proxies tool calls to the API |
| `internal/shared` | TypeScript types shared by web + gateway |
| `migrations/` | Hand-written, numbered SQL applied manually to Supabase |

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
