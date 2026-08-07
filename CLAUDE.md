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

The tool names below are the **default MCP surface** — the 18-tool intent facade
(`FACADE_NAMES` in `apps/mcp-gateway/src/facade.ts`): `canvas_connect`,
`canvas_create`, `agent_register`, `context_get`, `queue_next`, `queue_wait`,
`task_find`, `task_get`, `task_claim`, `task_progress`, `task_complete`,
`task_propose`, `task_amend`, `task_review`, `epic_propose`, `doc_write`,
`doc_read`, `board_status`. The old ~80-tool
`canvas_*` CRUD surface is still callable but is only *advertised* behind
`TANDEM_FULL_TOOLS=1`, so write against these names.

Sessions start from the task queue, NOT a full canvas read:

1. `canvas_connect` with code `TEGLQFXR`, `role: "executor"`, and a `name`
   (once per session — one call connects **and** registers you). Keep the
   `session` handle it returns and pass it as `session` on **every** later
   Tandem call; the hosted connection can reset between calls.
2. `queue_next` — the approved, ready-to-work queue, and the entry point for
   work. Don't go hunting for it by reading the canvas: `context_get` is the
   cheap one-call briefing (identity, document tabs, per-kind counts, queue
   state) if you need to orient first. Comes back empty but work is expected?
   `queue_wait` is the same read that *waits* — see below.
3. `task_get` on the task you'll work on — it returns the task plus its linked
   roadmap items / notes hydrated, which is all the context you need.
   **`id` takes a ticket ref, not just a uuid:** told "take on TDM-21", pass
   `TDM-21` (or `tdm-21` / `#21` / `21`) straight to `task_get`, `task_claim`,
   `task_progress`, `task_complete`. No lookup call, no board read. A ref that
   names nothing here answers 404 `task_not_found`, not "invalid id". Given a
   NAME instead of a ref ("the constraints task"), `task_find` matches it by
   title — also not a board read.
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
   When the batch drains and more approvals are expected, `queue_wait` rather
   than ending your turn.

The full recipes: `docs/ORCHESTRATION.md` — the live session that waits on
`queue_wait` (§0) and the webhook-triggered relaunch (§1–4) — and the
`tandem-watch` skill in `.claude/skills/tandem-watch/` (in-session watch loop).

When asked to plan work rather than execute it, use `epic_propose`: it creates the
named container **and** its tasks in the same call (pass them via `tasks`), so
Jaxon approves once instead of task by task. One task per unit of work, concise
body, heavy context linked via `linkedIds` (`task_get` hydrates those for whoever
picks it up). Add more tasks to an existing batch later with `task_propose` and
that `epicId`. Everything lands as `proposed` for human approval in the web UI —
never try to approve your own work; epic approval is the human's on every canvas.

**Which asks become a plan, and which you just do.** "Plan work rather than
execute it" is not usually stated; it arrives as a lazy prompt. The test is the
ticket contract itself: **could you write the ticket — name the surface it
touches, state a done condition someone else could check, one sitting of work —
out of what the human actually said?**

- **No → `epic_propose` FIRST, before you write a line of code.** *"Fix auth, the
  email service, and messaging"* names three **areas** and zero surfaces: to
  start, you would have to invent the surfaces, the scope and the done
  conditions. Those invented calls are precisely what the plan gate exists to
  show the human. Same for one area that is vague (*"make onboarding not suck"*)
  or one ask plainly larger than a sitting. Reading eleven ticket titles costs
  twenty seconds; reading eleven wrong diffs costs an afternoon.
- **Yes, for every part of the ask → just do the work.** *"Fix the bell
  overlapping the code chip"* already names its surface and its done condition;
  an epic there buys the human an approval click for work they approved by
  asking, and a gate that fires on everything is a gate people switch off. It is
  about how **specified** the ask is, not how many parts it has: three specified
  one-sitting changes are three tasks, not an epic — and `epic_propose` refuses a
  one-ticket epic outright, because that is a task.

Propose the **whole** batch in one `epic_propose` — don't start on "the easy one"
while the rest waits — then **tell the human it is waiting on them** and
`queue_wait` on the returned `epicId`. The propose answer hands you a paste-ready
`tellHuman` line (what is waiting, the ticket range, the board URL); relay it in
chat before you park, because a gate nobody was told about is just a stall. If a ticket
comes back, `task_get` answers with a `review` block carrying the decider's
reason verbatim: a **rejection** is a correction to the *plan* (`task_amend` the
neighbours it also condemns), a **bounce** is the brief for the next attempt at
that same ticket. A rejection is not a dead end and does not leave you waiting:
it **wakes `queue_wait`** as `status: "rejected"` with the reason attached, and
you answer it on the same ticket — `task_amend` it with the fix plus a `note`
saying what changed, which sends it back to `proposed` for the human with the
original reason and your note on its audit trail. Never file a fresh copy
instead; it arrives with no memory of the rejection and lands the same way. A
resubmit is not an approval — tell the human it is back, then `queue_wait`.

None of this is a fifth mode: it is the default `epic` policy's shape, where one
human approval per batch releases every ticket under it. The owner picks the
policy (next paragraph) — you only pick whether there is a plan worth reviewing.
The one that changes the answer is `auto`: no gate at all, so proposing there is
record-keeping and the direct path is the norm. Worked examples and the policy
table: `docs/ORCHESTRATION.md` §6.

**The one exception — `approval_policy: 'peer'`, off by default.** A canvas is on
exactly one of **four** approval policies (`strict | epic | auto | peer`,
migrations 0033 + 0041), and only the OWNER sets it: `strict` lands every
agent-proposed task `proposed`; `epic` (the default) births a task approved when
its epic is already approved; `auto` births everything approved; `peer` is the
review loop's policy — nothing is born approved, the epic cascade is **off**, and
each task is gated by a **reviewer agent** instead of by Jaxon.

**`task_review` is the reviewer's one verb, with two outcomes** (TDM-145/154/156):

- `outcome: "pass"` on a still-`proposed` task approves it into the ready queue.
- `outcome: "changes_requested"` on a `done` task sends it **back**, with a
  REQUIRED `reason`. The task leaves `done`, loses its claim and its now-stale
  `result`, and returns to the ready queue as `approved` with your reason stored
  verbatim on its audit trail — so whoever takes it from `queue_next` reads why
  without asking you. Don't then claim it yourself: reviewing a task and redoing
  it is one pair of eyes wearing two hats.

Both doors are enforced server-side from provenance the caller cannot forge — the
gateway does not re-implement the check — so you cannot pass your own proposal
(`peer_self_approval`) or bounce your own completion (`rework_self_review`).
Refusals come back as **data** (`reviewed:false`, a stable `refusal` code, a
`_next`), not as errors.

**What the loop deliberately does NOT do**, and none of these are TODOs:

1. **Killing work stays human.** A reviewer can pass a proposal or bounce
   finished work — and has no move that *ends* another agent's task. Both of its
   moves are reversible with one human click; rejection is not, so `reject` stays
   with the person whose project it is. Saying no to a *proposal* means leaving
   it alone and reporting why, not pressing anything.
2. **No self-review, ever.** Approve compares you to the stored proposer; rework
   compares you to the recorded completer. Unknown either side fails **closed** —
   "we couldn't tell" resolves to "a human decides", not to "allowed".
3. **The model is self-asserted.** A canvas can additionally require the reviewer
   to be running a *different model* (`requireCrossModelReview`, off by default),
   but `model` is whatever the agent said on `canvas_connect`. It raises the cost
   of accidental same-model review; it does not stop a client that misreports.
   It is an honesty rail, not a guarantee, and must never be described as one.

Epics, bulk approval and born-approved stay human-only on `peer` too. This canvas
(`TEGLQFXR`) is **not** on `peer` unless Jaxon says so, so assume the human gate.
And a reviewer that passes everything is just a slower `auto`: read the work.
Full recipe, including the four-policy table and every refusal code:
`docs/ORCHESTRATION.md` §5. (The old name `task_approve` is still *routed* for
sessions that learned it, but it is no longer advertised and only does the `pass`
half — write `task_review`.)

**After proposing: TELL the human, then LISTEN for the approval.** The loop is
**propose → tell → wait**, and the middle beat is not optional — nobody can
approve a gate they were never told is open, and an agent silently parked on
`queue_wait` is indistinguishable from an agent that has hung.

1. **Tell them in chat, now.** `epic_propose` / `task_propose` answer with a
   `tellHuman` line — what is waiting, the ticket range, the board URL — written
   to be relayed as-is. Say it before you make another tool call.
2. **Then `queue_wait`** (optionally with the `epicId`). Don't end your turn and
   don't poll on an interval; it returns the moment work is approved, and a
   `status: "timeout"` answer means nothing yet, not an error, so call it again.
   The first timeout carries a `_tell_human` reminder: if you skipped step 1,
   that is your cue to do it now and keep waiting. It is the backstop, not the
   substitute.
3. **On `ready`** you get the tasks with their `handoff` blocks: work them, or
   dispatch one subagent per task. Jaxon approving on the board **is** the go
   signal; he shouldn't have to prompt you a second time — and he shouldn't have
   to guess that you were waiting on him in the first place.

Also keep the canvas current as you make meaningful progress (finish a feature,
fix a notable bug, change direction) — as you go, not just at the end. Roadmap
item editing isn't on the default surface, so leave the context as a markdown
note with `doc_write` (it creates the `document` tab if the name is new), and use
`task_complete`'s `result` for task outcomes. `board_status` is the cheap "where
does this project stand" read — counts by state, what's in flight and who holds
it, epics and their approval state. Treat the canvas as the source of truth for
"where the project is." Also note any friction you hit using the tools — that
feedback is itself valuable.

**Docs live on the canvas, not the repo.** Product and strategy writing — the
Thesis, Strategy, Pivot Strategy (Jul 2026), launch drafts, QA verdicts — lives
as document tabs on `TEGLQFXR`. Asked to read "the thesis" (or any strategy
doc), fetch it from the canvas; asked to write or update one, `doc_write` it to
the right tab (a new `document` name creates the tab) instead of adding markdown
under `docs/`. Repo `docs/` stays for code-adjacent material (ORCHESTRATION.md,
DESIGN.md, specs). Reading one back is **`doc_read`**, the read side of
`doc_write`: pass `document` — the tab's NAME (case-insensitive, the same one you
gave `doc_write`) or its id — and you get that tab's notes in board order, each
with its markdown and its `noteId`. `context_get` lists the tabs if you don't
know the name; an unknown name comes back naming the ones that do exist. Keep the
`noteId` of anything you intend to revise, because `doc_write` without it appends
a second copy instead of updating. The read is scoped server-side, so reading one
tab never drags the rest of the canvas along — there is no reason to reach past
the facade at the raw API with a hand-built token.

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
When a `task_complete` result or its `links` points at a commit, build the URL
from the REAL remote — `git remote get-url origin` (this repo is
`github.com/jaximus808/tandam`) — never guess the owner/repo from the npm scope,
product name, or folder, or the board's live GitHub resolver 404s the link.
Scope the commit to your ticket's files only — never sweep in other sessions'
uncommitted work. Everything else about git stays Jaxon's: do NOT push, branch,
or open PRs unless he explicitly asks. Non-ticket work stays uncommitted unless
he says otherwise.
