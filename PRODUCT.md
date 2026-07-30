# Tandem — Product truth

One line: **the shared state layer for teams running parallel agent sessions** — a durable
task queue every session claims from without colliding, approval granted once per epic,
a live board of who's doing what, and every task traceable to a commit. The spec stays
in git; the coordination churn moves out of TODO.md into Tandem.

## Mechanism (what only this product proves)
Atomic task claiming over MCP: two sessions race `task_claim`, exactly one wins,
the loser is told who beat it and takes the next task. Epics gate batches with ONE human
approval (`policy:epic` provenance). Tickets (TDM-n) tie tasks to commits both directions.

## Audience & scene
Developers already running 2–5 parallel Claude Code / Cursor / any-MCP sessions,
coordinating through markdown files that collide. They live in Linear, Vercel, Stripe,
GitHub. Desk, dev machine, long sessions, frequently dark rooms. They are allergic to
"AI-generated" aesthetics and judge tools by craft in the first five seconds.

## Surfaces
- Landing (Persuade): tandemcanvas.com — hero demo, villain, how-it-works, dogfood proof,
  receipts, quickstart, FAQ.
- App (Operate): canvas workspace — Board (epic navigator + scoped kanban), Tasks sidebar,
  document tabs/modes (roadmap, docs, sheets, charts, map, itinerary), agent presence,
  dialogs (share, launcher), dashboard.

## Brand commitments (durable)
- Truth-first marketing: no fabricated logos, metrics, testimonials. The live public board
  (TEGLQFXR) is the social proof.
- The demo centerpiece is the claim rejection ("already claimed by session-A").
- Design bar (user-pinned, 2026-07-28): **category canon played straight — clean,
  professional, easy to use; the craft level of Linear / Stripe / Vercel.** The previous
  cream + display-serif + terracotta world was read as "AI slop" by testers and is
  retired as anti-reference.
- JetBrains Mono for code/tickets/terminal content is earned by the product and stays.

## Constraints
- Monorepo: Go API (+ Supabase), React/Vite/Tailwind web, Node MCP gateway. Numbered SQL
  migrations, applied manually by Jaxon. No new heavy frontend deps without cause.
- Web must build with `pnpm build` (tsc strict + vite). Dark mode is first-class.
- Jaxon owns git/runtime; agents stop at code + green builds.
