# QA — working-tree batch, 2026-07-29

Everything below is uncommitted. Four change sets, each mapped to its board item
on `TEGLQFXR`. Sections A and B are the ones with real UI/runtime surface; C and
D are one click each.

## A. Follow the fleet + card flight (the "board feels agentic" work)

No ticket — this is the live-board steer, web-only. New files:
`FollowControl.tsx`, `lib/followAgents.ts`, `lib/useCardFlight.ts`,
`lib/useFocusGuard.ts`, `lib/useFollowMoves.ts`; wired through `App.tsx`,
`TaskBoard.tsx`, `AgentCursor.tsx`, `index.css`.

What it is: a **camera** that follows the fleet. Agent activity pulls you to
where it happened — a doc edit opens that tab and pans to the batch; a task
transition switches you to the Board and **flies the card** between kanban lanes
(ghost-clone FLIP animation + terracotta landing ring) with a spotlight halo
naming the move ("Picked up TDM-7").

You need agent traffic to test: easiest is approving E9 (section D) and letting
a session work the queue, or any MCP session doing task claims/completes.

- [ ] **FollowControl** appears in the header beside the fleet readout; trigger
      reads "Following" / "Following N" / "Follow off" at a glance
- [ ] Popover lets you narrow to a subset of agents; prefs survive reload
      (localStorage, per canvas, works signed-out)
- [ ] Agent claims a task while you're on Documents → you're switched to Board,
      card **flies** from `ready` → `working` (not a teleport), lands with a
      swelling ring, cursor halo says "<agent> · Picked up TDM-n"
- [ ] Batch approve N tasks → **one** jump, not N (moves coalesce over ~400ms)
- [ ] **Your own** approve/move in the UI does NOT yank the camera (human actor
      is filtered)
- [ ] Type in any text field, have an agent move a card mid-typing → nothing
      moves; control shows paused state; ~1s after your last keystroke the
      newest buffered move plays ("N moves while you were typing")
- [ ] Scrolling does NOT drop you out of follow (the old complaint) — it only
      skips the auto-pan for that one gesture
- [ ] OS "reduce motion" on → no flight, card just lands with a steady ring
- [ ] Doc-edit follow still works: agent writes a note → that doc tab opens and
      pans; follow wins over your pinned tab, but never fires when you were
      already on the surface

## B. E8.1 `tandem-mcp listen` + SSRF gate (TDM-56, board: done)

Webhook receiver that turns task approval into a launched session. Gateway:
`src/listen/`, `test/listen.test.ts`, `src/index.ts` wiring. API: the
`TANDEM_WEBHOOKS_ALLOW_PRIVATE` local-dev escape hatch (`config.go`, `main.go`,
tests). Full recipe: `docs/ORCHESTRATION.md` (already committed).

- [ ] Local container env gets `TANDEM_WEBHOOKS_ALLOW_PRIVATE=1` (see
      `.env.example` — **never prod**; exact strings "1"/"true" only) and its
      startup log shows the `webhook SSRF guard disabled` WARNING
- [ ] `npx tandem-mcp listen --exec '<cmd>'` starts, prints its URL; configure
      that URL (`http://host.docker.internal:8787/webhook` from the container)
      + secret in the canvas webhook settings UI
- [ ] Approve a task → delivery arrives (HMAC verifies), listener execs the
      command with the task context
- [ ] Redeliver the same delivery id → deduped, command does NOT run twice
- [ ] Without the env flag, delivery to the private address is refused
      non-retryably (guard's production posture — worth seeing once)
- [ ] `/tandem-watch` skill (`.claude/skills/tandem-watch/`, TDM-57): in a CC
      session, say "watch the queue" → it connects, polls `queue_next` with
      backoff, dispatches a subagent per approved task

## C. `epic_propose` on the facade (no ticket — gap found proposing E9)

Gateway facade tool #11: propose an epic and optionally its tasks in one call;
`task_propose` now advertises `epicId`. 89/89 gateway tests pass. Already
**verified live** — it created the E9 epic on the board. Remaining human check:

- [ ] Gateway rebuilt + CC restarted → `epic_propose` shows in the tool list
      with the human-gate language in its description

## D. E9 · Claims at the edge — on the board awaiting YOUR approval

Epic `E9` with TDM-61…65 parented under it (contract note linked). Not code QA —
this is the approval gate working as designed:

- [ ] Tasks panel shows **E9 · Claims at the edge** as `proposed` with 5 tasks
- [ ] Approving the epic ONCE cascades: all five flip to `approved` (and if
      you're following, section A gives you the show)

---

# Phase 2 Testing Checklist (historical)

Work through these in order — each section depends on the previous one passing.

---

## 1. Supabase setup

- [ ] Create a new Supabase project at supabase.com
- [ ] Go to **Project Settings → API** and copy:
  - **Project URL** → `SUPABASE_URL` (e.g. `https://abcdef.supabase.co`)
  - **service_role** secret key → `SUPABASE_KEY` (use service_role, NOT anon)
- [ ] Run migrations — easiest via Supabase **SQL Editor** (paste each file in order):
  - `migrations/0001_initial_schema.sql`
  - `migrations/0002_add_canvas_indexes.sql`
  - `migrations/0003_add_rpc_helpers.sql`  ← required for version bumping
- [ ] Confirm in **Table Editor**: `canvases`, `pins`, `events`, `notes`, `pending_edits` all exist
- [ ] Confirm in **Database → Functions**: `bump_canvas_version` exists

---

## 2. Go API — local startup

- [ ] Copy the env file and fill it in:
  ```bash
  cp apps/api/.env.example apps/api/.env
  # Fill in SUPABASE_URL, SUPABASE_KEY, and JWT_SECRET
  # Generate JWT_SECRET: openssl rand -hex 32
  ```
- [ ] Start the API:
  ```bash
  cd apps/api
  export $(cat .env | xargs)
  /usr/local/go/bin/go run ./cmd/server
  ```
- [ ] Confirm it logs: `AgentCanvas API listening on :7891`
- [ ] Smoke test — create a canvas:
  ```bash
  curl -s -X POST http://localhost:7891/api/canvases \
    -H "Content-Type: application/json" \
    -d '{"name":"Test Canvas"}' | jq .
  ```
  Expected: `{ "id": "...", "code": "XXXXXXXX", "name": "Test Canvas", ... }`
- [ ] Save the returned `code` — you'll use it throughout

---

## 3. Web UI — basic flow

- [ ] Build and open the web app (served by the Go API):
  ```bash
  pnpm --filter web build
  open http://localhost:7891
  ```
- [ ] Landing page loads with "Create new canvas" and code input field
- [ ] Enter the code from step 2 → canvas loads (empty map)
- [ ] URL changes to `/c/XXXXXXXX`
- [ ] Open same URL in a second browser tab — both show the same empty canvas
- [ ] Switch modes (Map → Itinerary → Docs) in one tab, confirm the other tab updates

---

## 4. MCP Gateway — connect Claude

- [ ] Build the gateway:
  ```bash
  pnpm --filter mcp-gateway build
  ```
- [ ] Test the gateway manually (should auth and exit cleanly):
  ```bash
  CANVAS_CODE=XXXXXXXX API_URL=http://localhost:7891 \
    node apps/mcp-gateway/dist/index.js
  ```
  Expected stderr: `[agentcanvas] Connected to canvas "Test Canvas" (XXXXXXXX)`
- [ ] Add to your `.claude.json` MCP config (under the agentcanvas project entry):
  ```json
  "agentcanvas-p2": {
    "command": "node",
    "args": ["/Users/jaxon/coding-project/agentcanvas/apps/mcp-gateway/dist/index.js"],
    "env": {
      "CANVAS_CODE": "XXXXXXXX",
      "API_URL": "http://localhost:7891"
    }
  }
  ```
- [ ] Restart Claude Code — confirm MCP shows `agentcanvas-p2 · connected` with no "tools fetch failed"

---

## 5. Agent → canvas round-trip

Run these prompts in Claude Code and verify each in the browser:

- [ ] `canvas.state.read` — Claude sees `activeCanvasName`, empty pins/events/notes
- [ ] "Add a pin for Shinjuku Station in Tokyo" → pin appears on the map in the browser within 1–2 seconds
- [ ] "Add a ramen restaurant near Shinjuku" → second pin appears
- [ ] "Add a dinner event on June 1st at 7pm at the ramen restaurant" → event visible in Itinerary mode
- [ ] "Add a note with opening hours for the restaurant" → note visible in Docs mode

---

## 6. Browser → agent round-trip

- [ ] In the browser, drag one of the pins to a new location
- [ ] Ask Claude: "What coordinates is the Shinjuku pin at now?" — it should call `canvas.state.read` and report the dragged coordinates
- [ ] In the browser, click a note and type a scoped edit instruction ("make this shorter")
- [ ] Ask Claude: "process any pending canvas edits" — it should find and apply the pending edit

---

## 7. Multi-client sync

- [ ] Open the canvas URL in two browser tabs
- [ ] Add a pin via Claude → both tabs update simultaneously
- [ ] Drag a pin in tab 1 → tab 2 updates
- [ ] Open a second terminal, start a second Claude Code session with the same `CANVAS_CODE`
- [ ] From the second Claude instance, add an event → appears in both browser tabs and is visible to the first Claude instance on next `canvas.state.read`

---

## 8. Persistence

- [ ] Stop the Go API (`Ctrl+C`)
- [ ] Restart it: `DATABASE_URL=... JWT_SECRET=... go run ./cmd/server`
- [ ] Reload the browser — all pins, events, notes still there (loaded from Supabase)
- [ ] Restart Claude Code — `canvas.state.read` returns the same state

---

## Known gaps to fix before shipping

- [ ] Go binary needs a graceful shutdown handler (catch SIGTERM)
- [ ] JWT refresh: the 24h token will expire for long-running MCP sessions — gateway needs to retry auth on 401
- [ ] Image uploads untested end-to-end (local disk storage, per-canvas dir)
- [ ] `routes.go` imports `io/fs` but doesn't use it — remove to fix `go vet` warning if present
- [ ] No error shown in browser if canvas code is wrong (just hangs on "Connecting…") — add a 5s timeout and redirect to landing
