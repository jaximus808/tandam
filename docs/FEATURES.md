# What Tandem can do

The capability inventory: everything Tandem actually does, organised by pillar, with
the file that implements each line named inline so any claim can be checked.

**Rules this document is written under.**

- **Audited, not remembered.** Every entry was read out of the code on 2026-08-06
  (`apps/api`, `apps/web/src`, `apps/mcp-gateway/src`, `internal/shared/src`,
  `supabase/migrations/`). Nothing here is planned, in progress, or "basically
  done" — if it is not in the tree, it is not on this list.
- **Paths are repo-relative** and are the point of each line. A feature you cannot
  trace to a file does not belong here.
- **Honest limits are features too.** Where a guarantee is actually a convention,
  or a check fails open, this document says so — the source files say so, and a
  capability list that quietly upgrades those is worse than no list.

Related docs: `docs/ORCHESTRATION.md` (the recipes), `docs/CONTENTION.md` (the
claim model), `docs/SPEC.md` and `docs/DESIGN.md` (intent and visual system),
`CLAUDE.md` (how agents are expected to work the board).

---

## 1. The task queue and the board

The execution primitive is an `actions` row — one table serving `navigate`, `task`
and `epic` types (`supabase/migrations/0013_add_actions_agents.sql`).

**States.** `proposed | approved | rejected | executing | done | failed`
(`internal/shared/src/index.ts`, `ActionState`). The legal transitions are
`proposed → approved|rejected`, `approved → executing`, `executing → done|failed`;
`failed → approved` exists only as a human re-queue, never as an agent move
(`apps/api/internal/api/action_handler.go`).

- **Tasks and epics.** An epic is a named batch that tasks point back into via
  `payload.epicId`; epics are never claimed or executed
  (`internal/shared/src/index.ts`, `EpicPayload`). Creating an epic and its tasks
  in one call is `epic_propose` (`apps/mcp-gateway/src/facade.ts`).
- **Ticket ids (`TDM-n`).** A per-canvas integer counter (`canvases.next_ticket`,
  `actions.ticket`) allocated by the atomic `reserve_task_tickets` RPC, which hands
  back `n` consecutive numbers in one round trip so a batch insert cannot collide
  (`supabase/migrations/0034_ticket_ids.sql`, `apps/api/internal/api/ticket.go`).
  Only the integer is stored; `TDM-` is a render prefix.
- **A ticket ref works anywhere an id does.** `TDM-21`, `tdm-21`, `#21` and `21`
  all resolve; a uuid is a no-store fast path; an unknown well-formed ref answers
  404 `task_not_found` rather than "invalid id"
  (`apps/api/internal/api/ticket_ref.go`).
- **The ready queue is FIFO.** `state=approved & type=task & assignee=agent`
  ordered by `created_at` ascending. There is no priority field. `assignee=agent`
  also matches rows predating the field (`apps/api/internal/store/supabase.go`,
  `apps/api/internal/api/action_handler.go`).

### Claims, leases and contention

- **Claiming is one atomic conditional UPDATE** (`… SET state='executing' WHERE
  state='approved' AND type='task'`), so of two racing claimers exactly one gets a
  row back; the loser is re-read to say *why* it lost
  (`apps/api/internal/store/supabase.go`; the columns come from
  `supabase/migrations/0032_atomic_claiming.sql`).
- **The lease is 15 minutes** (`store.DefaultClaimTTL`, mirrored in
  `apps/api/internal/config/config.go`), overridable with `CLAIM_TTL_MINUTES`;
  `0` disables expiry entirely.
- **Expiry is lazy — nothing sweeps.** A lapsed lease looks live in the database
  until a rival asks for the task, at which point a second atomic UPDATE
  predicated on `claimed_at < cutoff` rebinds it
  (`apps/api/internal/store/supabase.go`; the design note is
  `apps/api/internal/api/action_handler.go`).
- **Heartbeats extend the lease, holder-only, in SQL.** `task_progress` restamps
  `claimed_at` but deliberately does *not* move `payload.claim.at`, so "working for
  X minutes" stays honest (`apps/api/internal/store/store.go`,
  `apps/api/internal/api/fleet_handler.go`).
- **Generation fencing.** Each fresh lease mints a per-task counter (+1, never
  reset) stored under the server-owned payload key `claim` as
  `{generation, holder, at}`. Presenting a superseded generation on a later write
  is refused (`apps/api/internal/store/claim_fence.go`).
- **One fence decision, every write path.** `fenceTaskWrite` is called by complete,
  fail, progress, payload PATCH, `/move`, `/release`, `/requeue` and `DELETE`, and
  answers one shape: HTTP 409 `{error, fenced:true, reason, holder, claimedBy,
  claimGeneration, message}` with reasons `claimed_by_other` and
  `stale_claim_generation` (`apps/api/internal/api/claim_fence.go` — the audit
  table at the top of that file lists every path and what fences it).
- **The contention trail is recorded on the task**, capped at 20 events with
  identical repeats coalesced into a `count`
  (`apps/api/internal/store/contention.go`), and read back by the board as two
  strictly separated kinds: RACED (a claim lost at the door) vs FENCED (a write
  refused because the lease was superseded) — `apps/web/src/lib/contention.ts`.
- **Refusals are counted.** `fenced_writes`, `claims`, `claim_conflicts` and
  `ttl_expiries` are live counters (`apps/api/internal/metrics/metrics.go`).
- **The tap-out contract.** Every losing path from the gateway carries
  `{tapOut: true, reason, holder?, taskId, next: "queue_next", attempts}` — one
  boolean to branch on instead of prose — and a per-process ledger refuses a second
  attempt at a task you already lost without even racing
  (`apps/mcp-gateway/src/tapout.ts`).

**Honest limit:** the fence engages only when a caller asserts a claim identity (an
agent name in the body, or the `X-Tandem-Agent` header the gateway sets). A browser
and an agent present identical canvas JWTs, so the human board keeps its escape
hatch on purpose. A holder of `""` or the generic `"agent"` is not an exclusive
identity and blocks nobody (`apps/api/internal/api/claim_fence.go`,
`docs/CONTENTION.md`).

### Board reads

- **`GET /api/canvas/queue/wait`** — a genuine server-side long poll: default 25s,
  clamped 1–60s, answering `ready | timeout | rejected` (all HTTP 200). Waiters are
  an in-process registry woken by `signalQueueReady` / `signalQueueRejected`; there
  is no DB polling. Caps: 64 waiters per canvas, 512 process-wide, over-cap → 429
  `too_many_waiters` with `Retry-After: 5` (`apps/api/internal/api/queue_wait.go`).
- **Epic rollup** `GET /api/canvas/epics` — counts, activity window, drained flag,
  summary, and the `returned[]` list of bounced tickets. All derived at read time;
  no table, no migration. Compact by default, `?full=1` for per-ticket lines
  (`apps/api/internal/api/epic_rollup.go`).
- **Epic summary** is the one persisted half: `payload.summary` (max 2000 runes)
  with server-owned `summaryBy`/`summaryAt`. It is not a content field, so writing
  it to an approved epic does not revert the epic
  (`apps/api/internal/api/epic_summary.go`).
- **Cheap state read** `GET /api/canvas/state` returns a per-kind count summary by
  default (up to 200 names per kind); `?fields=` projects specific kinds and
  `?full=true` is the back-compat escape hatch
  (`apps/api/internal/api/state_read.go`).
- **Inbound CI status API** `POST /api/canvas/{code}/tasks/{id}/status` lets a build
  system move a ticket with its own vocabulary (`started | progress | completed |
  failed`), defaulting the claimant to `"external"` rather than the generic
  `"agent"` (`apps/api/internal/api/task_status_handler.go`).

### Ticket quality

Five non-blocking warning codes — `no_surface_named`, `no_done_condition`,
`may_exceed_one_sitting`, `context_not_linked`, `context_duplicated` — with a
declared scope (`ticket` vs `batch`) so a single-ticket read only runs the rules it
can honestly answer (`internal/shared/src/ticketQuality.ts`). The rules live in
TypeScript on purpose: the gateway must evaluate locally *before* any write, and
the board must evaluate on text a human is editing in place. The Go API's whole
contribution is the `epic.hasLinkedContext` boolean on task reads
(`apps/api/internal/api/action_handler.go`).

---

## 2. Approval gates: the four policies

One canvas is on exactly one policy, set by the **owner only** via
`PATCH /api/canvases/{code}/approval-policy`
(`apps/api/internal/api/access_handler.go`). The column arrived with three values
in `supabase/migrations/0033_approval_policy.sql` and was widened to four in
`supabase/migrations/0041_peer_approval_policy.sql`.

| Policy | An agent-proposed task is born… | Epic cascade? | Who may approve |
|---|---|---|---|
| `strict` | `proposed` | No | Human |
| `epic` (DB default) | `approved` if its epic is already approved, else `proposed` | Yes | Human |
| `auto` | `approved` | n/a | n/a |
| `peer` | `proposed`, always | **No** — off on purpose | Human, or a *different* registered agent |

- **Birth-time enforcement** is `policyApproval(policy, payload, epicApproved)`:
  `auto` stamps `approved_by = "policy:auto"`, `epic` stamps `"policy:epic"`
  (`apps/api/internal/api/action_handler.go`).
- **`requiresApproval: true` in a task payload lands it `proposed` under every
  policy, `auto` included** — the agent's own "I deviated, look at this" flag
  (`apps/api/internal/api/action_handler.go`,
  `internal/shared/src/index.ts`).
- **An unreadable policy falls back to `strict`** — fail closed, keep the human
  gate (`apps/api/internal/api/action_handler.go`).
- **Born-approved via `state:"approved"` is human-only**, independent of policy, on
  both single and batch propose (`callerIsHuman`, same file).
- **`approvedBy` is always server-derived** from the auth context. There is no
  `approvedBy` or `authoredBy` body field anywhere in the API
  (`apps/api/internal/api/provenance.go`).
- **The epic cascade** batch-approves an epic's proposed tasks, stamped
  `policy:epic`, and runs detached after the response, idempotent so an approve
  retry repairs a failed cascade. It is off for `strict` **and** `peer`
  (`apps/api/internal/api/peer_approval.go`,
  `apps/api/internal/api/action_handler.go`).
- **Reject stays human-only on every policy**, and bulk approve stays human-only
  because the single conditional UPDATE cannot see per-row authorship
  (`apps/api/internal/api/action_handler.go`).

### The content gate

Approval is bound to the content it approved (`apps/api/internal/store/content_gate.go`):

- Content is **`title` + `body` only**.
- Editing a `proposed`/`rejected` task is allowed and audited.
- Editing an `approved`/`executing` task **reverts it to `proposed`**, clears the
  claim and `approved_by`, and audits `reverted: true`.
- Editing a `done`/`failed` task is refused (`ErrContentLocked`), including via the
  side door of a combined state+content PATCH, which answers 409 `content_locked`
  (`apps/api/internal/api/action_handler.go`).
- Non-content payload writes (`progress[]`, `links[]`, `assignee`, `linkedIds`,
  `epicId`) are always silent. `payload.audit[]` is server-owned, capped at 20
  entries with 80-char excerpts.

### Human and owner moves

Three separate move matrices, none of which can reach `approved` except by
rewinding:

- **Board human moves** — approved→Start, executing→[Mark done, Mark failed,
  Release], failed→Re-queue, done→Reopen, rejected→Re-propose; `proposed` has no
  moves at all, because approve/reject is its only exit
  (`apps/api/internal/api/task_move.go`, `apps/web/src/lib/taskMoves.ts`).
- **Owner gate moves** — a separate endpoint with a separate table, everything
  landing in `proposed` (`apps/api/internal/api/task_owner_move.go`,
  `apps/web/src/lib/ownerMoves.ts`).
- **Epic moves** — approved→proposed, done→[proposed, rejected], rejected→proposed
  (`apps/api/internal/api/epic_move.go`).

**Author resubmit** `POST /api/canvas/actions/{id}/resubmit` moves a rejected
ticket back to `proposed`, gated on the caller's provenance matching the row's
`authored_by`, and deliberately fires no webhook and signals no queue-ready
(`apps/api/internal/api/task_resubmit.go`).

**Gate metrics** `GET /api/canvas/gate` derive a pre-work intervention rate
(rejections + amendments-before-build) from action state and `payload.audit[]`, per
canvas and per epic, all-time and windowed — and ship their own caveat text in the
same response, explicitly not a target (`apps/api/internal/api/gate_metrics.go`).

---

## 3. Peer review

Only live under `approval_policy = 'peer'`. One agent verb with two outcomes
(`task_review` on the MCP surface, `apps/mcp-gateway/src/facade.ts`).

- **`outcome: "pass"`** approves a still-`proposed` task that a *different* agent
  proposed. Both identities are server-derived — the approver from the request's
  auth context, the proposer from the stored `authored_by`
  (`apps/api/internal/api/peer_approval.go`).
- **`outcome: "changes_requested"`** (`POST /api/canvas/actions/{id}/rework`) sends
  `done` work back to `approved` with a **required** reason, stored verbatim on the
  audit trail. The pair compared is (reviewer, completer-from-`claimed_by`)
  (`apps/api/internal/api/peer_approval.go`).

**Refusals are data, not errors** — a stable code plus a `_next`, surfaced by the
gateway as `reviewed: false` (`apps/mcp-gateway/src/facade.ts`). The full set
implemented server-side (`apps/api/internal/api/peer_approval.go`):

| Code | Cause |
|---|---|
| `human_approval_only` / `rework_policy_required` | Canvas is not on `peer` |
| `peer_identity_required` / `rework_identity_required` | No agent identity on the request |
| `peer_agent_unregistered` / `rework_agent_unregistered` | Identity is not on this canvas's roster |
| `peer_self_approval` | You proposed this task |
| `rework_self_review` | You completed this task |
| `peer_epic_human_only` / `rework_task_only` | Target is an epic |
| `peer_proposer_unknown` / `rework_completer_unknown` | Provenance missing — **fails closed** |
| `rework_not_finished` | Task is not `done` |
| `rework_reason_required` | Empty reason (refused by both the gateway and the server) |
| `peer_same_model` / `rework_same_model` | Cross-model review is on and the models match |

**Cross-model review** (`requireCrossModelReview`, default false,
`supabase/migrations/0042_cross_model_review.sql`) gates both halves and is inert
on any policy but `peer`. Model ids are normalised for case, whitespace, a provider
prefix (`anthropic/`, `openai/`, …) and a bracketed variant suffix (`[1m]`); there
is no family inference (`apps/api/internal/api/peer_approval.go`).

**Two honest limits, stated in the code and repeated here because they matter:**

1. `agents.model` is **self-asserted** — `canvas_connect` takes a `model` argument
   and stores it verbatim. The flag raises the cost of *accidental* same-model
   review; it cannot stop a client that misreports. It is an honesty rail, not a
   guarantee (`apps/api/internal/api/peer_approval.go`, which ships a
   `crossModelHonestyRail` sentence on every such refusal).
2. Cross-model comparison **fails open** when either model is unrecorded, so an
   unknown model cannot brick review on a live canvas — the deliberate opposite
   posture from the proposer/completer checks, which fail closed.

**What the loop deliberately does not do:** a reviewer can pass a proposal or
bounce finished work, and has no move that *ends* another agent's task. Rejection,
epics, bulk approval and born-approved stay human-only on `peer` too
(`apps/api/internal/api/action_handler.go`,
`apps/api/internal/api/peer_approval.go`).

**Deprecation shim:** the old `task_approve` name is still routed but no longer
advertised, and only ever did the `pass` half (`apps/mcp-gateway/src/facade.ts`,
`FACADE_LEGACY_NAMES`).

---

## 4. Orchestration: handoffs, waiting, webhooks

### Handoffs and fan-out

`queue_next` attaches a paste-ready `handoff` block to every ready task —
`{canvasCode, taskId, ticketId, title, parentAgentId, steps[]}` — so an
orchestrator dispatches one subagent per task without composing a brief
(`apps/mcp-gateway/src/facade.ts`, documented in `docs/ORCHESTRATION.md`). The
handoff carries the 8-character canvas **code**, never the caller's `session`
handle: a worker running on the planner's handle claims *as the planner* and the
fleet tree collapses. `queue_next` also returns a `_dispatch` line saying so in
prose, and a task marked `lostByYou: true` carries no handoff at all.

**Agent identity.** `canvas_connect` connects and registers in one call
(`role: planner | executor`, `name`, `model`, `parentAgentId`), upserting on
`(canvas_id, name)` so re-registering returns the same `agentId`
(`apps/api/internal/api/action_handler.go`;
`supabase/migrations/0036_agents_unique_name.sql`). The parent link is structural,
stamped at registration (`supabase/migrations/0035_agent_parent.sql`). A bad
`parentAgentId` never fails the connect — the gateway retries without it and
reports `agent.problem` as data.

### Waiting

`queue_wait` is the in-session answer: one call that parks on the server and
returns the instant work passes the gate, or `timeout` (not an error), or
`rejected` carrying the decider's reason verbatim. `ready` wins when both land in
the same window (`apps/api/internal/api/queue_wait.go`,
`apps/mcp-gateway/src/facade.ts`). Waiting also shows on the board: a timeout keeps
the identity "waiting" for a 10-second grace and pushes a `fleet.waiting` WS ping
(`apps/api/internal/api/queue_wait.go`). The in-session recipe is the
`tandem-watch` skill (`.claude/skills/tandem-watch/SKILL.md`).

### Webhooks

Five event types, all `task.*` — there are no `epic.*` events
(`apps/api/internal/webhooks/emit.go`, `apps/api/internal/store/webhooks.go`):

| Event | Fires when | Added by |
|---|---|---|
| `task.approved` | A task enters the ready queue by any approval path | `supabase/migrations/0038_webhooks.sql` |
| `task.completed` | A task reaches `done` **or** `failed` — there is no `task.failed` | 0038 |
| `task.claim_expired` | A lapsed claim was taken over by another agent | 0038 |
| `task.returned` | Finished work went back to the queue (`done → approved`) | `supabase/migrations/0043_webhook_task_returned.sql` |
| `task.rejected` | A proposed task was rejected at the human gate, reason attached | `supabase/migrations/0044_webhook_task_rejected.sql` |

**Deliberately silent:** claiming, DELETE, payload-only edits, release
(`executing → approved`), requeue (`failed → approved`), and self-takeover of your
own expired claim (`apps/api/internal/api/task_events.go`).

- **Signing:** HMAC-SHA256 over `<unix_seconds> "." <raw body bytes>`, lowercase
  hex, split across `Tandem-Signature` (bare hex, no `t=`/`v1=` syntax),
  `Tandem-Timestamp`, `Tandem-Delivery-Id` (stable across retries → the dedupe key)
  and `Tandem-Event`. Replay window 60s, constant-time compare
  (`apps/api/internal/webhooks/sign.go`; the receiver half is
  `apps/mcp-gateway/src/listen/verify.ts`).
- **Delivery:** 5s per attempt, retries at 1m / 10m / 1h, 4 attempts total, then
  dead-lettered. Non-retryable failures (bad URL, blocked target, 4xx, redirect)
  dead-letter immediately (`apps/api/internal/webhooks/worker.go`). Worker defaults:
  poll 5s, batch 20, concurrency 4, 5m lease, 1m reap.
- **SSRF guard** runs in the dialer's `Control` hook — post-DNS, pre-connect, so
  DNS rebinding is caught — blocking loopback, RFC1918, fc00::/7, link-local
  (including 169.254.169.254), CGNAT, unspecified and multicast. Redirects are never
  followed (`apps/api/internal/webhooks/sender.go`).
- **`TANDEM_WEBHOOKS_ALLOW_PRIVATE`** disables that guard for local development.
  Strict opt-in — only exactly `"1"` or `"true"`, so a typo fails closed — and the
  server logs a warning at startup (`apps/api/internal/config/config.go`,
  `apps/api/cmd/server/main.go`).
- **Config is human-only by construction:** the routes sit in the cookie-only
  `RequireUser` group *and* call `requireCanvasOwner`, so a canvas JWT, PAT or
  OAuth token all fail. There is no MCP tool for any of it — an agent must not be
  able to point the canvas at an endpoint it controls
  (`apps/api/internal/api/webhook_handler.go`).
- **`WEBHOOKS_ENABLED=false`** nils the emitter and makes every emit a no-op
  (`apps/api/internal/api/routes.go`, `apps/api/cmd/server/main.go`).

### `tandem-mcp listen`

A local HTTP receiver that turns an approval into a process
(`apps/mcp-gateway/src/listen/`):

- `POST /webhook` on `127.0.0.1` only (port default 8787); the tunnel is the only
  way in (`apps/mcp-gateway/src/listen/server.ts`,
  `apps/mcp-gateway/src/listen/args.ts`).
- Flags: `--exec` (required, run via the shell), `--port`, `--secret` (or
  `$TANDEM_WEBHOOK_SECRET`), `--events` (default `task.approved`), `--debounce`
  (default 5000ms). An unknown flag is a usage error, not a silent no-op.
- **Debounce + single-flight** (`apps/mcp-gateway/src/listen/trigger.ts`): a
  trailing-edge window folds an epic-approval burst into one trigger, and only ever
  one child process runs — events landing mid-run merge into a single pending batch
  rather than forking a second orchestrator or being dropped.
- **Dedupe on `Tandem-Delivery-Id`** (`apps/mcp-gateway/src/listen/dedupe.ts`).
- Injects `TANDEM_EVENT`, `TANDEM_CANVAS_CODE`, `TANDEM_CANVAS_ID` and
  `TANDEM_TICKETS` into the exec'd command
  (`apps/mcp-gateway/src/listen/server.ts`).

---

## 5. Document tabs and context

- **A canvas is a bag of named documents** — `map | notes | itinerary | roadmap |
  sheet | chart | folder` — each owning its children through a `document_id` FK
  (`supabase/migrations/0024_add_documents.sql`). Folders came with 0025, where the
  parent link is `ON DELETE SET NULL` on purpose: deleting a folder returns its
  children to the root instead of destroying them
  (`supabase/migrations/0025_document_folders.sql`,
  `apps/web/src/components/DocumentExplorer.tsx`).
- **`doc_write` / `doc_read`** are the agent's write and read halves: `document`
  names a tab and **creates it if the name is new**; `noteId` rewrites an existing
  note instead of appending a second copy; the read is scoped server-side to one
  tab and paginates by note cursor + byte offset (`apps/mcp-gateway/src/facade.ts`,
  `apps/api/internal/api/document_notes.go`).
- **Live markdown editing, no edit/read toggle.** An unfocused note renders
  markdown; clicking in turns the same box into editable source at that caret.
  Autosave debounces at 500ms plus flush on blur and unmount; remote pushes are
  adopted only while unfocused so a remote edit never yanks text from under the
  caret (`apps/web/src/modes/DocsMode.tsx`, with the markdown↔HTML bridge in
  `apps/web/src/lib/paste.ts`).
- **Outline titles are derived, never stored** — first heading, else first
  non-empty line, else "Untitled" (`apps/web/src/lib/docOutline.ts`).
- **Tab state is per-viewer and never broadcast**: open/closed sets, active tab and
  follow tab live in local storage per canvas (`apps/web/src/lib/tabState.ts`,
  `apps/web/src/components/DocumentTabs.tsx`).

### Context and freshness

- **`context_get` / `GET /api/canvas/context`** returns one AGENTS.md-shaped
  markdown briefing plus a JSON envelope: canvas identity, the briefing doc and its
  notes, the approved queue (compact, never full bodies), epics, and — with
  `?taskId=` — that one task hydrated with its linked notes and roadmap items. The
  fetch is waved and parallel with a 250ms p95 budget
  (`apps/api/internal/api/context_handler.go`,
  `apps/api/internal/api/context_bundle.go`).
- **Freshness is derived, never stored.** Only `verified_at` and
  `stale_after_seconds` are persisted, on notes, roadmap items and documents
  (`supabase/migrations/0037_context_freshness.sql`). The read-time derivation is
  `fresh | aging | stale | unknown`, where **`unknown` (never verified) is
  explicitly not the same as stale** (`apps/api/internal/store/freshness.go`,
  mirrored for the UI in `apps/web/src/lib/freshness.ts`).
- **`verified_at` is not `updated_at`.** Vouching is a separate act from editing —
  a body-only patch never re-certifies content nobody re-read
  (`apps/api/internal/store/store.go`; the UI keeps them apart in
  `apps/web/src/components/Freshness.tsx`, `VerifyControl`).
- **The briefing document.** At most one per canvas (`canvases.briefing_doc_id`,
  migration 0037). `POST /api/canvas/briefing/import` pastes text or fetches one URL
  and creates + writes + designates in a single idempotent call
  (`apps/api/internal/api/briefing_handler.go`,
  `apps/web/src/components/ImportBriefingModal.tsx`). It is a one-shot copy — there
  is no file watcher, and the modal says so.
- **Stale context is shown, never filtered** — a stale note stays in the bundle
  with a visible `[stale — verified 21d ago]` annotation, judged against a single
  pinned `now` (`apps/api/internal/api/context_bundle.go`).
- **Review feedback** is one `review` block derived at read time — outcome
  `rejected` (from `actions.error`) or `rework` (from `payload.audit[]`) with the
  reason verbatim — surfaced on `task_get`, on the epic rollup as `returned[]`, and
  in `context_get?taskId=`; deliberately *not* on `queue_next`
  (`apps/api/internal/api/review_feedback.go`, `internal/shared/src/index.ts`).

---

## 6. Provenance and receipts

- **`authored_by` is server-decided, in exactly three shapes**
  (`supabase/migrations/0039_authored_by.sql`,
  `apps/api/internal/api/provenance.go`):
  - `human` — the request carried a valid Google session. **Unforgeable**: a caller
    cannot claim it without a real signed session.
  - `agent:<identity>` — asserted via the `X-Tandem-Agent` header the gateway
    sends. The `<identity>` is client-asserted; what the server owns is the
    **classification** — an agent can never emit a bare `human`.
  - `anonymous` — a valid canvas token with no user session and no agent identity.
  - `NULL` means unknown (predates provenance) and is deliberately not backfilled;
    the UI renders nothing for it (`apps/web/src/lib/provenance.ts`).
- **Approval provenance shares the vocabulary**: `human`, `agent:<name>` (a peer
  pass), `policy:epic`, `policy:auto` — so a reader can tell a cascade from a
  decision (`apps/api/internal/api/action_handler.go`,
  `apps/web/src/lib/provenance.ts`, `parseApproval`).
- **Completion evidence.** `task_complete` appends `links[]` (commit / PR / branch
  URLs) — appended, never replaced (`internal/shared/src/index.ts`, `TaskPayload`).
- **GitHub links resolve live.** `GET /api/canvas/github/status` maps one evidence
  link to merged / open / closed / draft / checks-ok / failure / pending / unknown.
  Structurally read-only: the route is GET-only (pinned by a test that walks the
  router) and every outbound URL is *constructed server-side* from a parsed
  owner/repo/ref against `api.github.com`, so the caller's URL is never
  dereferenced. 60s cache, 512 entries, 6s timeout, 1 MiB body cap.
  `GH_STATUS_TOKEN` lifts the 60-req/hour-per-IP ceiling but is vetted at startup
  and dropped if it is private-capable; rate-limited degrades to
  `{state:"unknown"}` rather than erroring (`apps/api/internal/api/github_status.go`).
  The board's chip renders **nothing at all** for `unknown` — absence of a claim,
  not a claim of absence (`apps/web/src/components/TaskLinks.tsx`,
  `apps/web/src/lib/githubStatus.ts`).
- **The audit trail** on each task distinguishes content edits that cost an
  approval from human state moves, and carries reviewer bounces
  (`apps/web/src/lib/taskAudit.ts` over the server-owned `payload.audit`).
- **Progress log.** Every `task_progress` heartbeat is an append-only entry
  (`{at, agent, note, percent}`), bounded server-side and rendered as a log on the
  ticket page (`internal/shared/src/index.ts`,
  `apps/web/src/components/TicketView.tsx`).
- **Activity feed** `GET /api/canvas/activity` is derived from action row
  timestamps and provenance columns — no events table, lossy by documented design;
  the precise stream is the WebSocket one (`apps/api/internal/api/fleet_handler.go`,
  `apps/web/src/lib/useActivityFeed.ts`).

---

## 7. The web workspace

`apps/web` is React + Vite + Tailwind. Routing is hand-rolled `pushState` +
`popstate` — no router library (`apps/web/src/App.tsx`).

**Pages.** `/` Landing (`apps/web/src/pages/Landing.tsx`), `/mcp` install docs
(`apps/web/src/pages/MCPSupport.tsx`), `/about`
(`apps/web/src/pages/About.tsx`), `/why-tandem`
(`apps/web/src/pages/WhyTandem.tsx`), `/dashboard`
(`apps/web/src/pages/MyCanvases.tsx`), `/me`
(`apps/web/src/pages/UserSettings.tsx`), `/oauth/authorize`
(`apps/web/src/pages/OAuthConsent.tsx`), `/stats`
(`apps/web/src/pages/StatsPage.tsx`), `/metrics`
(`apps/web/src/pages/MetricsPage.tsx`). A canvas is `/c/CODE`, and
`/c/CODE/ticket/TDM-n` is a deep-linkable ticket page that renders above the
canvas-loaded gate so a cold link shows a skeleton rather than a splash
(`apps/web/src/components/TicketView.tsx`).

**Three surfaces** in the left rail — Board, Documents, Summary — with Settings as
a toggle rather than a surface (`apps/web/src/components/WorkspaceNav.tsx`,
`apps/web/src/lib/sidebar.ts`).

### Board

`apps/web/src/components/TaskBoard.tsx`

- **Five columns:** Proposed · Ready (approved) · Working (executing) · Done ·
  Closed (failed + rejected share one lane).
- **Epics are a navigation lens, not cards** — a left timeline with state chip,
  n/m progress, drain time, and inline approve/reject on proposed epics. Scope
  persists per canvas; aged-out epics collapse into a Done bucket
  (`apps/web/src/lib/epicLifecycle.ts`).
- **No drag-and-drop for state**, on purpose: a state change is a decision, not a
  gesture, and has to be as available to a keyboard as to a mouse. (Drag exists
  elsewhere — doc tabs, docs/roadmap/sheet reordering.)
- **Bulk triage** with an id-set selection that survives live WebSocket pushes:
  click, shift-click range, cmd-click toggle, arrow/shift-arrow stepping, and a
  tap-to-select mode for touch. One shared reject reason, asked once, with an undo.
  Approve uses the real batch endpoint; reject is one request per ticket so each
  carries its own reason.
- **Search reaches past the current scope.** A ticket ref is an address that wins
  outright; otherwise a ranked ladder (ticket > title substring > title words >
  body) *identical to the gateway's `task_find`*, with out-of-scope hits reported
  rather than silently omitted.
- **Card flight** — a FLIP animation that clones a moving card into a fixed ghost
  on `<body>` (each column is its own scroller, so an in-place transform would clip
  at exactly the boundary being crossed), 620ms flight plus a 2.4s landing glow,
  skipped under `prefers-reduced-motion` (`apps/web/src/lib/useCardFlight.ts`).
- **A proposed epic renders as a plan to review** — plan digest, the plan's own
  ticket order, and per-ticket quality lines from the same
  `@agentcanvas/shared/ticket-quality` implementation the gateway runs at propose
  time (`apps/web/src/components/ProposedEpicReview.tsx`).
- **Lease chips** derive `live | slipping | stale` from a mirrored 15-minute TTL,
  keeping "last heard from" and "lapses at" as separate facts
  (`apps/web/src/lib/lease.ts`).
- **One six-hue state table** shared by every chip in the app
  (`apps/web/src/lib/stateChips.ts`).

### Summary surface

Three derived sections, zero fetches
(`apps/web/src/components/SummaryPanel.tsx`): `EpicTimeline` (only epics that have
stopped moving), `CompletionStats` (done %, per-state breakdown, per-epic bars),
and `StaleTasksSection` — which is deliberately **a ranking, not a threshold**: the
10 oldest still-open tasks, never a "stale" judgement, because time-in-state is not
stored (`apps/web/src/lib/oldestOpen.ts`, `apps/web/src/lib/summaryDerive.ts`).

### Fleet view

`apps/web/src/components/FleetView.tsx`, roster from
`apps/web/src/lib/useFleetRoster.ts` (`GET /api/canvas/agents`).

- Two tabs in one panel: **Fleet** (roster) and **Feed** (activity).
- **Parent nesting** from `parentAgentId`, recursing to depth 4; unparented agents
  render flat.
- **Active vs dormant**: the API returns every identity that ever registered; only
  agents holding a claim or online-and-recent are shown, the rest fold behind a
  disclosure.
- **Vendor identity is read off the declared model, never guessed** — claude /
  codex / openai / gemini / the raw model string / `agent` (registered, no model) /
  **`external`** (holds work but never registered, dashed border).
- **`WaitingLine`** shows an agent parked on `queue_wait` — live presence from the
  in-process registry, never stored and not assertable by a client
  (`apps/api/internal/api/fleet_handler.go`).
- Fleet and board derive **one identical lease from one function**.
- Roster freshness comes from WebSocket lifecycle pings rather than polling, with a
  monotonic request id so a slow earlier response cannot overwrite a newer one.

**Presence and follow.** `AgentPresence` (header cluster, "editing {Mode}",
most-recent-claimant chip), `AgentCursor` (one halo over the union of a batch's
target rects, driven by a single always-on rAF writing transforms straight to the
DOM), `AgentToasts`. Following is per-canvas, device-local, and works signed out
(`apps/web/src/lib/followAgents.ts`); moves are coalesced one-at-a-time and
buffered while you are typing (`apps/web/src/lib/useFollowMoves.ts`,
`apps/web/src/lib/useFocusGuard.ts` — busy is drawn at *focus*, not at the
keyboard). Two follow styles, `cinematic` and `minimal`, device-local **and**
account-synced via `users.agent_follow_style`
(`supabase/migrations/0031_user_agent_follow_style.sql`,
`apps/web/src/lib/followStyle.ts`).

### Realtime

One module-level socket with version-gated state application, a bounded outbound
queue, and a 6-attempt reconnect budget (`apps/web/src/lib/ws.ts`).
`ConnectionStatus` is hidden while connected and is the only visible signal that a
push-only board has gone stale (`apps/web/src/components/ConnectionStatus.tsx`).
`NotificationBell` rings and badges on new activity even while muted — muting
silences popups, never the log or the badge
(`apps/web/src/lib/useAgentNotifications.ts`). A mock backend
(`VITE_MOCK=1`, `apps/web/src/lib/mockWS.ts`) runs the whole UI with no server.

### Theming

- `light | dark | system` (default system), key `tandem.theme`, toggling `.dark` on
  `<html>` and dispatching a same-tab event so every mounted toggle agrees;
  re-applies on OS theme change while set to system
  (`apps/web/src/lib/theme.ts`, `apps/web/src/components/ThemeToggle.tsx`).
- No-flash boot: an inline script reads the same key before first paint
  (`apps/web/index.html`).
- Tokens are RGB channels on `:root` / `:root.dark` — paper, surface, ink, accent,
  agent — mapped through Tailwind with `<alpha-value>` so `border-ink/10` flips
  automatically (`apps/web/src/index.css`, `apps/web/tailwind.config.js`,
  `darkMode: "class"`).
- Per-mode hues are **content only**, never chrome and never agent activity
  (`apps/web/src/lib/modeTheme.ts`).
- **The `theme-light` lock is gone.** No such class exists in `apps/web` today; the
  dark bands on the landing page use explicit dark grounds instead. One deliberate
  exception remains: MapMode's raster tiles stay light, though its toolbar, sidebar
  and popups follow the theme (`apps/web/src/App.tsx`, `apps/web/src/index.css`).

### Mobile

- A `sm:hidden` drawer that is purely additive — it passes the **same**
  `DocumentExplorer` / `SettingsPanel` components as desktop, not mobile copies,
  and shares `sidebarView` so the choice is continuous across breakpoints
  (`apps/web/src/components/MobileNavDrawer.tsx`).
- A badged bottom-right FAB, hidden while a board overlay is open so it cannot
  steal taps from overlay CTAs (`apps/web/src/App.tsx`).
- A floating-slot system with safe-area insets, a 48px FAB (over the 44px floor), a
  board bottom reserve so the last card stays tappable, and a
  `prefers-reduced-motion` opt-out on sheet animation (`apps/web/src/index.css`).
- Resizable side panel with drag-to-close and a reopen edge strip; width is a
  global preference while view and open/closed are per-canvas
  (`apps/web/src/components/SidePanel.tsx`, `apps/web/src/lib/sidebarState.ts`,
  which expires on a sliding window so a board left for hours opens clean).
- Board mobile specifics: a single-lane column switcher, a filter sheet under `md`,
  and a mobile-first type ladder (`apps/web/src/lib/boardScale.ts`).

### Other canvas modes

`welcome | map | itinerary | docs | roadmap | sheets | charts`
(`internal/shared/src/index.ts`, `CanvasMode`):

- **Welcome** — the zero-open-tabs start page: copyable starter prompts, a create
  strip, recent canvases (`apps/web/src/modes/WelcomeMode.tsx`,
  `apps/web/src/lib/starterPrompts.ts`).
- **Roadmap** — nestable goals with `todo | in_progress | done | blocked`, drag
  sort/nest, epic and task creation straight from a goal, freshness chips
  (`apps/web/src/modes/RoadmapMode.tsx`,
  `supabase/migrations/0005_add_roadmap_items.sql`).
- **Map** — Leaflet pins, travel-mode polylines, day clustering, event↔pin
  cross-refs, server-side map presets embedded at build time
  (`apps/web/src/modes/MapMode.tsx`, `apps/api/internal/maps/registry.go`).
- **Itinerary** — timed events with per-event IANA timezones, travel segments and a
  live cost total (`apps/web/src/modes/ItineraryMode.tsx`,
  `apps/web/src/lib/itineraryTime.ts`, migrations 0006/0010/0011/0016).
- **Sheets** — text/number/date/checkbox columns, row reordering, clipboard grid
  paste (`apps/web/src/modes/SheetsMode.tsx`, `apps/web/src/lib/paste.ts`,
  `supabase/migrations/0007_add_sheets.sql`).
- **Charts** — bar/line/area/pie over a source sheet, hand-rolled SVG; there is no
  charting library anywhere in the app (`apps/web/src/modes/ChartsMode.tsx`,
  `supabase/migrations/0012_add_charts.sql`).
- **Forms** — an authoring intent compiled against live canvas state and stored only
  if it validates, plus a stateless scaffold that derives a draft form from an
  existing sheet; submissions are idempotent by submission id
  (`apps/api/internal/forms/`, `supabase/migrations/0019_add_forms.sql`).

---

## 8. Auth, access and sessions

- **Canvas codes** are 8 characters over a 32-char ambiguity-free alphabet
  (no `0`/`O`/`1`/`I`/`L`), crypto/rand, ~40 bits
  (`apps/api/internal/store/supabase.go`).
- **Canvas JWT** — HS256 carrying `canvas_id` and the resolved `role`, TTL 24h by
  default (`JWT_TOKEN_TTL`) (`apps/api/internal/auth/jwt.go`).
- **Visibility and access** — `visibility ∈ public|private`, `publicRole ∈
  read|write`, plus per-user `canvas_access` rows. Resolution order is owner →
  explicit access row → public role → none
  (`supabase/migrations/0021_canvas_visibility_access.sql`,
  `apps/api/internal/api/middleware.go`). Role changes apply live over the socket
  without a reconnect, and a revoked viewer's socket is closed
  (`apps/api/internal/api/broadcast.go`).
- **Claim tokens** — `clm_` + 32 hex, single-use, no expiry, surfaced only on the
  create response. The **code is the view capability; the token is the own
  capability**, so sharing a link can never leak ownership. Claiming is one atomic
  `UPDATE … WHERE owner_user_id IS NULL`, so the first claimer wins
  (`supabase/migrations/0020_canvas_claim_token.sql`,
  `apps/api/internal/store/supabase.go`).
- **Google OAuth sign-in** — ID token validated against Google's rotating keys with
  audience `GOOGLE_CLIENT_ID`; the session is a separate JWT in an httpOnly cookie.
  Sign-in is optional: an empty client id disables it and the header degrades
  cleanly (`apps/api/internal/auth/google.go`,
  `apps/web/src/components/AccountMenu.tsx`).
- **Personal access tokens** — `tdm_pat_` + 64 hex, only the SHA-256 hash stored,
  plaintext shown exactly once, revocation is a row delete. Least-privilege by
  construction: role is still resolved per canvas
  (`supabase/migrations/0027_personal_access_tokens.sql`,
  `apps/api/internal/api/token_handler.go`,
  `apps/web/src/components/AccessTokensSection.tsx`).
- **A full OAuth 2.1 authorization server** for the hosted connector: RFC 8414 +
  RFC 9728 metadata, RFC 7591 dynamic client registration (public clients, PKCE
  S256), authorization code + refresh rotation, RFC 8707 resource indicators. TTLs:
  code 5m, access 1h, refresh 30d (`supabase/migrations/0029_oauth_server.sql`,
  `apps/api/internal/api/oauth_handler.go`). The consent screen is
  `apps/web/src/pages/OAuthConsent.tsx`; users revoke connected apps from
  `apps/web/src/components/ConnectedAppsSection.tsx`.
- **Credential resolution order** on any request: session cookie → PAT (prefix-gated
  so non-PAT bearers skip the DB lookup) → OAuth access token
  (`apps/api/internal/api/middleware.go`). `RequireLiveGrant` kills a canvas JWT
  mid-session when its issuing OAuth connection is revoked.
- **`POST /api/mcp/auth`** exchanges a canvas code for a role-baked canvas token; a
  dead OAuth bearer on a private canvas answers **401 `invalid_token`** (not 403) so
  the hosted connector re-runs OAuth instead of clinging to a stale token
  (`apps/api/internal/api/mcp_handler.go`).
- **The MCP `session` handle** is the model-carried re-binding for hosted
  connectors whose transport session drops across idle gaps: `canvas_connect`
  returns it and every later call takes it back
  (`apps/mcp-gateway/src/facade.ts`, `apps/mcp-gateway/src/http.ts`).
- **Notifications** — an account-level inbox, currently one kind (`canvas_shared`),
  newest 50 with an unread count
  (`supabase/migrations/0022_notifications.sql`,
  `apps/api/internal/api/notification_handler.go`).
- **Account preferences** — default canvas visibility (migration 0026), default
  public role (0028, deliberately defaulting to `read` where the canvas column
  defaults to `write`), follow style (0031). Account deletion is type-to-confirm
  (`apps/web/src/components/DeleteAccountModal.tsx`).

**Schema-wide posture:** no table uses RLS. The Go layer's `ResolveCanvasRole` is
the sole authorization point and Supabase is reached with the service key
(`apps/api/internal/api/middleware.go`, and the note carried through the migration
files).

---

## 9. The MCP surface

Published as `@jaximus/tandem-mcp` with two transports: a stdio CLI
(`apps/mcp-gateway/src/index.ts`) and a hosted Streamable-HTTP sidecar at
`https://tandemcanvas.com/api/mcp` (`apps/mcp-gateway/src/http.ts`), which gives
each MCP session its own Gateway and canvas binding.

**The default manifest is the 18-tool intent facade** — `FACADE_NAMES` in
`apps/mcp-gateway/src/facade.ts`:

| Tool | What it does |
|---|---|
| `canvas_connect` | Bind to a canvas by code **and** register your identity (`role`, `name`, `model`, `parentAgentId`) in one call; returns `agentId`, the board `url`, and the `session` handle |
| `canvas_create` | Start a new canvas from a session with no code |
| `agent_register` | Re-register — fix a rejected parent, record the model you are really running, switch role |
| `context_get` | The one-call briefing: identity, mode, document tabs, per-kind counts, queue state |
| `queue_next` | The ready, approved queue, each task carrying a paste-ready `handoff` |
| `queue_wait` | The same read that **waits** — parks server-side and returns the instant work is approved (or `rejected`, or `timeout`) |
| `task_find` | Resolve a task by name when you only have a description |
| `task_get` | One task with its linked notes/roadmap items hydrated, plus `review` and `quality` blocks |
| `task_claim` | Atomic claim; `claimed:false` carries the tap-out block |
| `task_progress` | One line per step — and the heartbeat that extends your lease |
| `task_complete` | Finish with a `result`, `links`, optional `status:"failed"`/`error`, optional `epicSummary` |
| `task_propose` | Propose one ticket (lands `proposed` under the human gate) |
| `task_amend` | Answer a rejection on the same ticket with a `note`, sending it back to `proposed` |
| `task_review` | The reviewer's verb: `pass` or `changes_requested` (peer canvases only) |
| `epic_propose` | The named container **and** its tickets in one call, so a human approves once |
| `doc_write` | Write a markdown note to a document tab, creating the tab if the name is new |
| `doc_read` | Read one tab back, scoped server-side, paginated |
| `board_status` | The orchestrator's report: counts by state, epics and their summaries, every in-flight task with holder, hold time, last progress note and `staleClaim` |

- **All 18 are advertised by default.** The `~80-tool` CRUD surface (81 tool
  definitions in `apps/mcp-gateway/src/tools.ts` — maps, pins, events, notes,
  roadmap items, sheets, columns, rows, charts, forms, documents, each with a batch
  variant) is still callable but only advertised behind `TANDEM_FULL_TOOLS=1` or
  `--full-tools`, because the CRUD manifest costs a large slice of the context
  window. When opted in the manifest is **additive**, facade first
  (`apps/mcp-gateway/src/server.ts`).
- **Server instructions ship with the manifest** — the executor loop, the approval
  gate, the peer exception and the orchestrator rule are in
  `SERVER_INSTRUCTIONS` (`apps/mcp-gateway/src/server.ts`), so a client reads them
  before its first call.
- **A pinned canvas code rewrites the `canvas_connect` description.**
  `tandem-mcp init` writes `TANDEM_CANVAS_CODE` into a project-scoped `.mcp.json`,
  and the manifest then says *this project's canvas is `XXXXXXXX`* — the model reads
  the manifest, not the process env (`apps/mcp-gateway/src/server.ts`,
  `apps/mcp-gateway/src/init.ts`).
- **`tandem-mcp init`** goes from nothing to a connected canvas in one command:
  creates the canvas, merges (never clobbers) `.mcp.json`, prints the code and board
  URL, and prints — or with `--write` appends — an AGENTS.md/CLAUDE.md snippet
  teaching the queue-first workflow. Re-running is a no-op; `--force` makes a fresh
  canvas (`apps/mcp-gateway/src/init.ts`).
- **`tandem-mcp listen`** is the webhook receiver described in §4
  (`apps/mcp-gateway/src/listen/`).
- **Per-call tracing** via `MCP_TRACE` — duration, the API time inside it, ok/error
  (`apps/mcp-gateway/src/trace.ts`).
- **Legacy dotted names** (`canvas.connect`) normalise to the underscore form
  (`apps/mcp-gateway/src/server.ts`).

---

## 10. Operations

- **`GET /api/metrics`** — in-memory only, a 1024-sample ring dual-bounded by a
  5-minute window. Keys are chi **route patterns**, never concrete ids, and every
  counter is a process-wide scalar, which is why the endpoint is open
  (`apps/api/internal/metrics/metrics.go`).
- **Persisted history** — a collector scrapes the registry on a timer into
  `metrics_snapshots` (default 60s, `METRICS_SNAPSHOT_INTERVAL_SECONDS`; 30-day
  retention, `METRICS_RETENTION_DAYS`), plus `loadtest_runs` at one row per
  (run, scenario) (`supabase/migrations/0040_metrics_history.sql`,
  `apps/api/internal/metrics/collector.go`). There is deliberately **no
  `canvas_id`** on the snapshot table.
- **`/metrics` operator console** — window selector, hand-rolled SVG charts for
  latency p95, broadcast fan-out, throughput, queue contention and connected
  clients, plus CSV/JSON export. Counters render as per-minute rates and delta
  series are **split at restart boundaries**, since every counter is cumulative
  since boot (`apps/web/src/pages/MetricsPage.tsx`). Access is an env allowlist,
  `METRICS_OWNER_EMAILS`, which 404s the whole subtree when unset — deliberately not
  a DB role, because Tandem has no admin model
  (`apps/api/internal/api/metrics_history.go`).
- **Public stats** `GET /api/stats` → `/stats` (canvases, users, recurring users,
  recurring %) (`apps/web/src/pages/StatsPage.tsx`).
- **Load-test harness** — `apps/api/cmd/loadtest` runs agent-concurrency scenarios,
  asserts `claim_p95_ms` / `queue_p95_ms`, and publishes baselines to the history
  endpoint. Aborted and skipped runs are stored rather than dropped, because "the
  256-agent point could not complete" is itself the finding
  (`supabase/migrations/0040_metrics_history.sql`).
- **Exports** — `GET /api/canvas/sheets/{id}/export` (sheet data) and
  `GET /api/canvas/{code}/itinerary.ics`, which doubles as a calendar subscription
  URL and still enforces private-canvas visibility despite being addressed by code
  (`apps/api/internal/api/itinerary_export.go`).
- **Canvas copy** — an atomic deep-copy RPC that regenerates ids and remaps internal
  references, preserving sheet **column** ids so row data and chart refs stay valid;
  runtime rows (actions, agents, pending edits) are deliberately not copied
  (`supabase/migrations/0018_copy_canvas_rpc.sql`).
- **Migrations are hand-written, numbered, and applied manually.** From 0037 onward
  every file is written to be re-runnable (`IF NOT EXISTS`, `DROP … IF EXISTS`).
  Nothing in CI applies them (`supabase/migrations/`).
- **Build and verify:** `cd apps/api && go build ./... && go test ./...`;
  `cd apps/web && pnpm build`; `cd apps/mcp-gateway && pnpm build`.
- **Environment:** `apps/api/.env.example` is the list —
  `SUPABASE_URL`, `SUPABASE_KEY`, `JWT_SECRET`, `PORT`, `WEB_DIST_PATH`,
  `IMAGE_DIR`, `GOOGLE_CLIENT_ID`, `COOKIE_SECURE`, `JWT_TOKEN_TTL`,
  `CLAIM_TTL_MINUTES`, `WEBHOOKS_ENABLED`, `TANDEM_WEBHOOKS_ALLOW_PRIVATE`,
  `GH_STATUS_TOKEN`, `METRICS_SNAPSHOT_INTERVAL_SECONDS`, `METRICS_RETENTION_DAYS`,
  `METRICS_OWNER_EMAILS` (`apps/api/internal/config/config.go`).

---

## Known gaps between surfaces

Recorded here rather than quietly rounded up, because a capability list is only
useful if it is also accurate about the edges.

- **The webhooks modal has friendly labels for only three of the five events.**
  `EVENT_LABELS` covers `task.approved`, `task.completed` and `task.claim_expired`;
  the checkbox list itself is driven by the API's `knownEvents`, so `task.returned`
  and `task.rejected` do render — with no sentence under them
  (`apps/web/src/lib/webhooks.ts`, `apps/web/src/components/WebhooksModal.tsx`).
- **Existing webhook configs were never backfilled** onto `task.returned` /
  `task.rejected`. A row's `events` array is what its owner chose, so an older
  webhook has to tick the new boxes; configs created since get all five by default
  (`supabase/migrations/0043_webhook_task_returned.sql`,
  `supabase/migrations/0044_webhook_task_rejected.sql`).
- **`docs/ORCHESTRATION.md` still says "17-tool intent facade."** The code says 18
  (`canvas_create` joined the set) — `FACADE_NAMES` in
  `apps/mcp-gateway/src/facade.ts` is the authority.
- **The web `lease.ts` mirrors the 15-minute TTL as a constant.** Override
  `CLAIM_TTL_MINUTES` in a deployment and the board reads early or late; the
  ordering of live/slipping/stale stays right
  (`apps/web/src/lib/lease.ts`, `docs/CONTENTION.md`).
- **Migration 0038's comments describe a Stripe-style single signature header.**
  The shipped scheme splits signature and timestamp into two headers;
  `apps/api/internal/webhooks/sign.go` is the wire contract, and
  `apps/mcp-gateway/src/listen/verify.ts` says so explicitly.
- **Out-of-band work is invisible to every mechanism above.** Nothing about a claim
  stops an agent doing work without claiming it — which is how the same feature got
  implemented twice on 2026-07-29. The rule the incident leaves behind: if the work
  is happening, the board must say so before it starts (`docs/CONTENTION.md` §4).
