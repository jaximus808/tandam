# Tandem

A shared planning canvas that humans and AI agents co-edit in real time.

Live at **[tandemcanvas.com](https://tandemcanvas.com)**.

## Monorepo

| Path | What it is |
|------|------------|
| `apps/api` | Go API — HTTP + WebSocket hub, Supabase/Postgres, JWT + Google OAuth |
| `apps/web` | React + Vite + Tailwind frontend |
| `apps/mcp-gateway` | Node stdio MCP server (`@jaximus/tandem-mcp`) that proxies tool calls to the API |
| `internal/shared` | TypeScript types shared by web + gateway |
| `migrations/` | Hand-written, numbered SQL. Applied to Supabase on push to `main` via the Supabase CLI (`.github/workflows/deploy-migrations.yml`); `supabase/migrations` symlinks here |

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

Connect an agent to a canvas with the published MCP server:

```
npx @jaximus/tandem-mcp
```

Or use the hosted Streamable-HTTP endpoint at `https://tandemcanvas.com/api/mcp`.
