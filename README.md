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
