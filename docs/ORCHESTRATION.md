# Approval-triggered orchestration

Human approval is the gate. Everything here is about one question: **how does an
orchestrator find out the moment you open it?**

There are two answers, and which one you want depends on whether an agent is
already running. **A live session waits with `queue_wait` (§0). Nothing running
waits with a webhook (§1 onward).** Neither one polls.

For the webhook path: you approve tasks on the board, Tandem POSTs a signed
`task.approved` to a listener on your machine, the listener runs one command, and
that command is a Claude orchestrator that pulls the queue and fans the work out
to subagents — it dispatches; each subagent claims its own task.

That is the whole loop: **approve → webhook → exec → fleet.** Nothing polls, and
Tandem never launches an agent itself — it hands your runner a signed nudge and
gets out of the way (SPEC.md §2: *launchable-FROM every launcher, never the
launcher*).

```
  board (tandemcanvas.com)          your machine
  ────────────────────────          ────────────
  you click Approve
        │
        └─ task.approved ──► tunnel ──► tandem-mcp listen :8787
                                              │
                                              └─ exec: claude -p "…orchestrator…"
                                                        │
                                                        ├─ subagent → TDM-61
                                                        ├─ subagent → TDM-62
                                                        └─ subagent → TDM-63
                                                              │
                                                        task_complete ──► board
```

Before you write the orchestrator prompt, read **[CONTENTION.md](CONTENTION.md)** —
the claim lifecycle, the tap-out contract every loser follows, and why dispatching
work that was never ticketed causes double implementation.

Upstream of all of it: **§6** is how work gets onto the board in the first place —
which asks an agent should turn into a proposed epic, and which it should just go
and do.

---

## 0. If an agent is already running, it waits: `queue_wait`

The webhook exists to **start** an orchestrator. When one is already alive — you
are in a session with it right now, it just proposed an epic, it just drained a
batch — there is nothing to start. It should stay where it is and wait, and that
is one call:

```
queue_wait  { timeoutSeconds: 60, epicId?: "<the epic you just proposed>" }
```

The wait happens **on the server** (`GET /api/canvas/queue/wait`,
`apps/api/internal/api/queue_wait.go`): the call parks and returns the instant a
task passes the approval gate. Answers come back on `status`:

| `status` | Means | Do |
|---|---|---|
| `ready` | Approved tasks, each already carrying the same paste-ready `handoff` block `queue_next` attaches | Claim one (alone) or dispatch one subagent per task |
| `timeout` | Nothing was approved inside the window. **Not an error** | Call `queue_wait` again |
| `busy` | This canvas is at its waiter cap. The call read the queue for you first | Treat it as `queue_next`, then call again |
| `unsupported` | The API is older than the endpoint. It read the queue for you first | Treat it as `queue_next` |

Default wait is 25s, clamped 1–60. The tool is annotated read-only, so connectors
can auto-approve it.

**Say this to an agent, not "poll on a backing-off interval":**

> Don't end your turn and don't poll on an interval — call `queue_wait`
> (optionally with the `epicId`); it returns the moment work is approved, and a
> `status: "timeout"` answer means nothing yet, not an error, so call it again.

That phrasing is deliberate. The instruction it replaced asked an agent to sleep
between polls, which an MCP session cannot do: on 2026-07-31 an orchestrator was
told to poll, agreed, and then ended its turn — a human had to prompt it a second
time to notice an approval that had already landed. It was not a wording failure;
it was an instruction with no mechanism under it. Now there is one, so name the
call.

**Which path do I want?**

| | Live session (`queue_wait`) | Webhook (`tandem-mcp listen`) |
|---|---|---|
| Precondition | An agent is already running | Nothing is running |
| Latency to start | Instant — it is already there | One process launch |
| Setup | None. It is on the default tool surface | Tunnel + signing secret + a listener process (§1–3) |
| Good for | You are at the keyboard approving as you go; an agent that just proposed work and must not end its turn | You approve from your phone at 2am; you want work to start without a session open |
| Ends when | The agent stops waiting, or you interrupt | You stop the listener |

They compose: run the listener so approvals can start an orchestrator cold, and
have live orchestrators use `queue_wait` so they never hand the wait back to you.
The in-session version of the whole loop is the `tandem-watch` skill in
`.claude/skills/tandem-watch/`.

---

## 1. Create the webhook (web UI only)

Open your canvas, then **Settings** (gear in the nav) **→ Webhooks → Add an
endpoint**. You must be signed in as the canvas **owner**; nobody else sees the
control, and the API refuses them anyway.

Fill in:

| Field | Value |
|---|---|
| URL | your tunnel's public URL + `/webhook` (see §2) |
| Name | anything — `laptop orchestrator` |
| Send when | check **`task.approved`** |

Save. A one-time callout shows the signing secret — `whsec_` followed by 64 hex
chars. **Copy it now.** It is never shown again; after that the UI only shows the
last four characters so you can tell two endpoints apart. If you lose it, use
**Rotate** and re-copy — deliveries switch to the new secret immediately.

Limit: 5 endpoints per canvas.

### Why there is no MCP tool for this

Webhook config is human-set in the browser, by design, and this is
non-negotiable (SPEC.md §4). An agent that could write a webhook URL could be
prompt-injected into pointing your task queue — titles, bodies, results, ticket
IDs — at an attacker's server, and you would never see it happen. The same rule
covers briefing designation. **Agent-writable config is a data-exfiltration
primitive; the gate is the browser.**

---

## 2. Topology: prod cannot reach your laptop

`tandemcanvas.com` runs on GCP. Your listener is on `127.0.0.1:8787` behind
whatever NAT your coffee shop has. There is no route. **You need a tunnel.** This
is the step people skip and then wonder why nothing fires.

### cloudflared (one command, no account needed for a quick tunnel)

```bash
# terminal 1 — the tunnel, pointed at the port the listener will bind
cloudflared tunnel --url http://127.0.0.1:8787
#   …
#   Your quick Tunnel has been created! Visit it at:
#   https://picked-mars-tone-brave.trycloudflare.com
```

Put `https://picked-mars-tone-brave.trycloudflare.com/webhook` in the UI's URL
field. Quick tunnels get a **new hostname every restart** — if you restart
`cloudflared`, update the URL in the UI or deliveries dead-letter. For a stable
hostname, use a named tunnel or `tailscale funnel 8787`.

### Local dev (`tandem-local` on :7891) — no tunnel needed

Against a local API you can skip the tunnel entirely: the container reaches the
listener on your host directly. Two steps.

**1. Start the local API with the SSRF guard off.**

```bash
TANDEM_WEBHOOKS_ALLOW_PRIVATE=1   # on the tandem-local container's environment
```

**2. Point the local canvas's webhook at the host.**

```
http://host.docker.internal:8787/webhook
```

(On a Linux bridge without `host.docker.internal`, use the gateway address —
`http://172.17.0.1:8787/webhook` — or run the container with
`--add-host=host.docker.internal:host-gateway`.)

Without step 1 this fails in a way worth recognising: the config saves fine (URL
validation is syntactic only — no DNS), then every delivery is refused at dial
time with `webhook target blocked` and dead-lettered **without retrying**. The
delivery worker's SSRF guard (`apps/api/internal/webhooks/sender.go`) rejects
loopback, RFC1918, link-local and CGNAT addresses in the dialer's `Control` hook,
after DNS resolution — and `host.docker.internal` resolves to a private address
(192.168.65.254 on Docker Desktop, 172.17.0.1 on a Linux bridge).

`TANDEM_WEBHOOKS_ALLOW_PRIVATE` is read in `apps/api/internal/config/config.go`
and passes `webhooks.WithAllowPrivateTargets(true)` to the worker's sender in
`cmd/server/main.go`. Only the exact values `1` and `true` enable it — anything
else (including `TRUE` and `yes`) leaves the guard on, so a typo fails closed. On
startup you get one line in the log:

```
WARNING: webhook SSRF guard disabled — private targets allowed (TANDEM_WEBHOOKS_ALLOW_PRIVATE)
```

> **Never set this in production.** With the guard off, anyone who can edit a
> canvas's webhook config can make the server connect to your internal network —
> including `169.254.169.254`, the cloud metadata endpoint. It is off by default
> and this env var is the *only* thing that can turn it on; keep it unset
> everywhere but your own machine.

Against **prod** (`tandemcanvas.com`) the guard is on and always will be, so a
tunnel is the only route to your laptop. See above.

---

## 3. Run the listener

```bash
export TANDEM_WEBHOOK_SECRET=whsec_…      # the value you copied in §1
export TANDEM_CANVAS_CODE=TEGLQFXR        # the canvas this listener serves

tandem-mcp listen --exec 'claude -p "You are the Tandem orchestrator for canvas $TANDEM_CANVAS_CODE.

You DISPATCH. You never claim a task, never complete one on a workers behalf, and never pass on
your session handle — the 8-character canvas code is what travels.

Work the approved queue end to end, then stop:
1. canvas_connect with code $TANDEM_CANVAS_CODE, role planner, name orchestrator, model your own
   model id. One call: it connects AND registers you. Keep the returned agentId and session handle.
2. queue_next. If it is empty, say so and exit — do not invent work.
3. For each ready task, spawn ONE subagent and no more, and paste that tasks handoff block from
   queue_next into it VERBATIM. The handoff already carries the canvas code, the task id, the
   ticket id, the title, your agentId as its parent, and the steps the worker follows: connect and
   register as an executor under you, claim ITS OWN task, task_get for the brief, task_progress on
   long work, task_complete with a result summary plus links to the commit or PR. Add repo context
   on top if you have it; do not rewrite the steps and do not claim anything yourself.
4. Independent tasks go out in parallel. Tasks that touch the same files go one at a time.
5. When the batch drains, call board_status and report what landed — done, failed, still
   executing. That is a READ, and it is enough on its own: every in-flight row carries the holder,
   how long they have held the claim, their last progress note, and staleClaim once nothing has
   been reported for longer than the lease. A task left executing is reported, not completed by
   you; its claim expires on its own.
6. Re-run queue_next, in case approvals landed while you worked. Stop when it comes back empty.

The tasks just approved are $TANDEM_TICKETS. A worker never works a task it did not claim, never
leaves a claimed task in executing, and nobody touches a task still in proposed."'
```

**Quoting matters.** The `--exec` value is in single quotes so *your* shell leaves
`$TANDEM_CANVAS_CODE` and `$TANDEM_TICKETS` alone; the listener runs the command
through a shell with those variables injected, so they expand *then*, per event.
Keep apostrophes out of the prompt or the quoting breaks.

The orchestrator needs the Tandem MCP server available in whatever directory you
run the listener from — `claude mcp add tandem -- npx -y @jaximus/tandem-mcp`.

### The handoff block

The prompt above stays short because it does not have to describe the worker's
job: `queue_next` attaches a ready-to-paste `handoff` to every task it returns.

```json
"handoff": {
  "canvasCode": "TESTCODE",
  "taskId": "task-aaa",
  "ticketId": "TDM-101",
  "title": "Wire the thing",
  "parentAgentId": "planner-77",
  "steps": [
    "canvas_connect with code \"TESTCODE\", role \"executor\", a name for yourself, and parentAgentId \"planner-77\" — one call, connects AND registers you under the planner that sent you.",
    "task_claim id \"task-aaa\" (TDM-101) — \"Wire the thing\". Claim it yourself; the planner deliberately did not claim it for you.",
    "If it comes back claimed:false, another session got there first — call queue_next and take a different ready task. Never work a task you did not claim.",
    "task_get id \"task-aaa\" for the full brief (linked notes and roadmap items), then do the work.",
    "task_progress on long work — one line per meaningful step, so the board shows movement instead of silence.",
    "task_complete with a result summary (what changed, which files) plus `links` to any commit or PR."
  ]
}
```

`ticketId` is omitted when the task has none. `parentAgentId` is `null` — with a
placeholder spelled out inside step 1 — when the caller of `queue_next` never
registered; reconnect with `role: "planner"` and call `queue_next` again so the
workers nest under you on the fleet view. `queue_next` also returns a `_dispatch`
line saying, in prose, the same thing the prompt says: dispatch, do not claim.

**Why the handoff exists, and why it carries the CODE and not the handle.** The
delegation contract is *an agent claims only what it will personally do; an
orchestrator dispatches, never claims, never completes on a worker's behalf, and
never transports its `session` handle*. That last clause is the one an
orchestrator improvising its own brief gets wrong: the handle is ~700 characters
of JWT plus identity, and a worker running on it claims **as the planner** — the
board then shows one agent doing everything and the fleet tree collapses. The
8-character canvas code is what travels; the worker connects with it and mints
its own identity under `parentAgentId`.

**What this buys, and what it does not.** Claims at the edge give you a truthful
`claimedBy`, failure isolation (one worker dying is one task `failed`, not a
batch), and an orchestrator whose context stays free for coordinating instead of
working. It does **not** buy fleet throughput: human approval is still the
serialization point, and the queue only moves as fast as somebody approves it.

### Flags

| Flag | Default | What it does |
|---|---|---|
| `--exec '<command>'` | *(required)* | The command to run when a matching event lands. Run **via the shell**, so it is a command line, not an argv |
| `--port <n>` | `8787` | Bind port, 1–65535. Always binds `127.0.0.1` — the tunnel is the only way in |
| `--secret <whsec_…>` | `$TANDEM_WEBHOOK_SECRET` | Signing secret. The flag wins over the env var; with neither, startup fails |
| `--events <csv>` | `task.approved` | Which event types trigger the exec. Others are acked `200` and ignored |
| `--debounce <ms>` | `5000` | Coalesce a burst of events into one trigger. `0` disables coalescing |
| `--help`, `-h` | — | Print the same contract this section describes |

Both `--flag value` and `--flag=value` work. An unknown flag is a usage error,
not a silent no-op — the listener refuses to start rather than run with a
misspelled `--debonuce` at its default.

The webhook path is `POST /webhook`. It is not configurable.

### Environment injected into the exec

On top of the listener's own environment:

| Variable | Contents |
|---|---|
| `TANDEM_EVENT` | The event type(s) that triggered this run — **distinct types, comma-joined**. In practice one type, since the default filter is `task.approved` alone |
| `TANDEM_CANVAS_CODE` | Canvas code for `canvas_connect`. See the resolution order below |
| `TANDEM_CANVAS_ID` | Canvas **UUID**, straight from the event payload's `canvas_id`. `""` if the payload had none |
| `TANDEM_TICKETS` | Comma-separated ticket ids in the burst, e.g. `TDM-61,TDM-62,TDM-63`. `""` when no event in the batch carried one |

`TANDEM_CANVAS_CODE` is resolved in this order, first non-empty wins:

1. the payload's `canvas_code`, **if the API ever sends one** — it does not today;
2. the listener's own `$TANDEM_CANVAS_CODE` (what `tandem-mcp init` writes into
   `.mcp.json`, and what you exported above);
3. `""`.

So in practice it comes from **the listener's environment**, not the webhook
body: the payload carries `canvas_id` (a UUID), and the board and MCP speak in
8-character codes. Set it, or the orchestrator prompt interpolates to nothing.
`TANDEM_CANVAS_ID` is exported alongside it so the identity that was actually in
the event is never thrown away — but no MCP tool takes it, so the code is the one
you interpolate.

Treat `TANDEM_TICKETS` as a hint about *why you woke up*, not as the work order.
The queue is the work order: another session may have claimed one of those
tickets in the seconds between the approval and your exec, and other tasks may
have been sitting approved already. Always start from `queue_next`.

### Debounce and single-flight

Approving an epic releases every task under it, and Tandem fans out **one
`task.approved` per task** — there is deliberately no batch event
(`apps/api/internal/api/task_events.go`). Approving a 12-task epic is 12
deliveries within a second or two.

Two mechanisms stop that from being 12 orchestrators:

- **Debounce** (`--debounce`, default 5s): **trailing edge** — every event
  restarts the timer, and the exec fires once the window goes quiet, carrying
  every ticket collected in it. So the bound is the gap *between* deliveries, not
  the length of the burst: 12 approvals spread over 30s still make one run as
  long as no two are more than 5s apart.
- **Single-flight**: exactly one exec runs at a time. Events that land mid-run do
  not queue up N runs — they coalesce into one follow-up trigger that fires when
  the current run exits. At most one batch is ever pending; nothing is dropped,
  nothing stacks.

So: 12 approvals → 1 orchestrator with 12 tickets. An approval that lands 40
minutes into a long run → exactly one more orchestrator, once the first finishes.

---

## 4. What fires when

| Event | Fires when | In `listen` by default? |
|---|---|---|
| `task.approved` | A task enters the ready-to-work queue by passing the approval gate — human approval, batch approval, the epic cascade, or a task born approved under the `auto`/`epic` policy. One event per task. | **Yes** |
| `task.completed` | A task reaches a terminal state. `task.state` is `done` **or** `failed` — there is no `task.failed` event, so branch on `state` and read `result` or `error`. | No |
| `task.claim_expired` | An agent's claim lapsed past its TTL and another agent took the task over. `expired_claim` names who went dark; `task.claimedBy` names who holds it now. | No |

`listen` filters to `task.approved` unless you pass `--events`. Subscribe the
webhook itself to more only if something consumes them — every extra event is a
delivery row and a wake-up.

**What deliberately fires nothing:** claiming a task, rejecting or deleting one,
retitling one, and re-queueing a released or failed task. That last one is on
purpose — re-queueing is not a *new approval*, and firing `task.approved` for it
would make a subscribed fleet re-run work it already picked up.

### Payload

```json
{
  "event_id":  "8f0a…",
  "type":      "task.approved",
  "timestamp": "2026-07-29T09:41:02.114Z",
  "canvas_id": "3c11…",
  "task": {
    "id": "9f1c…", "ticketId": "TDM-61", "title": "Wire the listener",
    "state": "approved", "epicId": "…", "assignee": "agent",
    "claimedBy": "…", "result": "…", "error": "…"
  }
}
```

The envelope is snake_case; `task` is camelCase, mirroring the canvas API's
action shape. There is no `attempt` field in the body — the payload is marshaled
once and re-sent byte-for-byte on every retry, because that identity is what the
HMAC covers. A retry is identifiable on the wire instead: `Tandem-Delivery-Id` is
stable across retries, `Tandem-Timestamp` is not.

### Headers and verification

| Header | Value |
|---|---|
| `Tandem-Signature` | Bare lowercase hex HMAC-SHA256 over `"<timestamp>.<raw body>"`. No prefix, no `v1=`, no comma syntax. |
| `Tandem-Timestamp` | Unix **seconds** the attempt was signed. Inside the signed string, so it cannot be rewritten in transit. |
| `Tandem-Delivery-Id` | Delivery row id. **Stable across retries** — dedupe on it. |
| `Tandem-Event` | The event type. |

Verify in this order: replay window (±60s), recompute the HMAC over the **raw
bytes** you received (never a re-serialized parse — key order will differ),
compare **timing-safe**, then dedupe on the delivery id. The reference
implementation and pseudocode live in `apps/api/internal/webhooks/sign.go`.
`tandem-mcp listen` does all of this for you; you only need it if you write your
own receiver.

Delivery budget: 5s per attempt, then retries at 1m / 10m / 1h, then the delivery
is dead-lettered and shows in the UI's failed list with a **Retry** button.
Redirects are never followed and are treated as permanent failures.

---

## 5. Peer review: an agent approves, and an agent says "not yet"

Everything above serializes on you clicking **Approve**. The `peer` approval
policy is the one way that gate opens without you — not by removing it, but by
letting a **second agent** stand in it, on both sides of the work: *before* it is
written (pass a plan into the ready queue) and *after* it is finished (send it
back with a reason).

**Be honest about when this is worth running.** It is not for the three things
you would just type into a session directly — direct instruction wins there, and
should. It is for the batch you kick off and walk away from: enough tickets that
you cannot hold them all, agents running where you are not, and a review you want
to happen at 2am rather than the next time you open the board.

### The four approval policies

One canvas, one policy, set by the **owner** only (`PATCH
/api/canvases/{code}/approval-policy`, body `{"approvalPolicy":"…"}`) — migrations
0033 (`strict|epic|auto`) and 0041 (`peer`). The board's ShareDialog sets it too.

| Policy | An agent-proposed task is born… | Does approving an epic cascade? | Who may approve a proposed task |
|---|---|---|---|
| `strict` | `proposed` | No — each task keeps its own gate | Human |
| `epic` (default) | `approved` if its epic is already approved, else `proposed` | Yes | Human |
| `auto` | `approved` | n/a | n/a — nothing waits |
| `peer` | `proposed`, always | **No** — deliberately off, see below | Human, **or a different agent** |

**The review loop requires `peer`.** Nothing defaults to it and no migration
moves a canvas onto it; on every other policy `task_review` answers
`reviewed:false` with `human_approval_only` (pass) or `rework_policy_required`
(changes_requested), and the human gate is exactly what it always was. Under
`peer` the epic cascade is switched off on purpose: a per-task reviewer gate that
one epic approval could walk around would be decoration.

A task that carries `requiresApproval: true` in its payload lands `proposed`
under *every* policy, `auto` included — that is how an agent flags its own
deviation and asks to be looked at.

### The loop, end to end

```
  proposer (planner)        reviewer (its own identity)          worker
  ──────────────────        ───────────────────────────          ──────
  epic_propose
        │
        └─ tasks land 'proposed'
                    │
                    ├─ task_get → reads the PLAN
                    │      │
                    │      ├─ task_review pass ────────► ready queue ─► task_claim
                    │      └─ or leaves it, and says why            │
                    │                                                work
                    │                                                │
                    │                                          task_complete → 'done'
                    │                                                │
                    └─ task_get → reads the WORK (result, commit) ◄──┘
                           │
                           ├─ satisfied? nothing to call — 'done' is terminal
                           └─ task_review changes_requested + reason
                                        │
                                        └─► back to 'approved', unclaimed, in the
                                            ready queue — reason on the audit trail
                                            ─► another task_claim, revised, done again
```

The two outcomes apply to two different states and never overlap: **`pass` is for
a plan you are letting through, `changes_requested` is for finished work you are
sending back.** Asking for changes on a task that is not `done` answers
`rework_not_finished` with the state it actually is in.

### `task_review`: the reviewer's one verb

| Argument | |
|---|---|
| `id` | Ticket ref (`TDM-21`, `#21`, `21`) or uuid. One task per call — there is no bulk review for agents, on purpose. |
| `outcome` | `pass` or `changes_requested`. There is no third answer. |
| `reason` | **Required** on `changes_requested` (max 8192 chars) — and it is the *only* thing the author gets, so name what is wrong and what fixed looks like. **Ignored** on `pass`: approval records who, not why. |

Underneath, `pass` is `POST /api/canvas/actions/{id}/approve` and
`changes_requested` is `POST /api/canvas/actions/{id}/rework` — two endpoints no
reviewer should have to know about, which is why they are one tool.

What the bounce actually does to the row: state `done` → `approved`, `claimed_by`
and `claimed_at` cleared (so the next `task_claim` is a clean race), `result` and
`error` cleared (a card back in Ready must not advertise the result of the run
being undone), `approved_by` **kept** — it already passed the gate once and is
not being re-approved. The audit entry appended to `payload.audit[]` carries the
reviewer (server-derived), `done → approved`, and your reason **verbatim and
un-truncated**.

Two consequences worth knowing:

- **A bounce wakes a parked `queue_wait`** (§0) — the task is genuinely back in
  the ready queue. It deliberately fires **no** `task.approved` webhook, because
  re-queueing is not a second approval and a subscribed fleet would re-run work
  it already picked up. So a webhook-launched orchestrator (§1–4) does *not* get
  relaunched by a bounce; a live one does.
- **The fleet feed's `reworked` verb is live-only.** It broadcasts the moment the
  bounce lands, but the historical activity derivation cannot reconstruct it
  afterwards — the rewind clears the very columns it would read. `payload.audit[]`
  is the durable record; the feed is the notification.

A signed-in **human** can call the rework endpoint too, and skips the gate below
(a person can already reopen from the board). The reason stays required either
way: the author's need for one does not depend on who pressed the button.

### The rule, and where it lives

The server owns it (`apps/api/internal/api/peer_approval.go`). The gateway calls
the endpoint and renders the answer; it does not re-implement the check, because
a rule enforced in the client is a rule a raw `curl` walks past.

Under `peer`, a **registered** agent may pass a **proposed task** a **different**
agent proposed, and may bounce a **done task** a **different** agent finished.
Both identities on both doors are derived server-side — the reviewer from the
request's provenance, the counterparty from the row itself (`authored_by` for a
pass, `claimed_by` for a bounce) — so neither can be asserted in a request body.
That body is the forgery vector earlier tickets closed, and review does not
reopen it.

Unknown counterparty **fails closed** on both doors: a task with no recorded
proposer (`peer_proposer_unknown`) or no attributable worker —
`claimed_by` empty or the generic `"agent"` — (`rework_completer_unknown`) cannot
prove non-self, so a human handles it.

What `peer` does **not** relax:

| Still human-only | Why |
|---|---|
| Approving an **epic** | One approval releases every task under it — far too large a blast radius for an agent. Under `peer` an epic approval also **stops cascading**: each task is approved on its own, which is the whole point. |
| **Rejecting** | Approval lets work through and you can move it back; rejection clears a peer's proposal out of the queue. The reviewer's "no" is the *bounce*, not the kill — see the non-goals below. A reviewer has no move that ENDS another agent's task, only ones that return it. |
| **Bulk approve** | One conditional UPDATE over many rows, which cannot enforce per-row authorship even in principle. |
| **Born-approved** | An agent still cannot create a task already approved, on any policy. |

### Cross-model review: a different agent is not enough (opt-in)

The `peer` rule asks for a different *agent*. Two agents on the same model are
arguably one reviewer wearing two name tags, so a canvas can additionally require
a different **model**:

```
PATCH /api/canvases/{code}/approval-policy
{ "approvalPolicy": "peer", "requireCrossModelReview": true }
```

Owner-only, **default off** (migration 0042), and inert on any policy but `peer`.
It rides the existing policy route as an optional field — omit it and the stored
value is left alone — and there is **no web UI toggle** for it yet: today it is
set with that PATCH. It covers **both** doors, with distinct codes so a client
can tell which closed: `peer_same_model` on a pass, `rework_same_model` on a
bounce. (A same-model "no" is as much theatre as a same-model "yes", and an
ungated bounce is a way for one agent to stall a rival's work indefinitely.)

Three limits, all deliberate, all of which belong in any description of it:

- **The model is self-asserted.** It is whatever the agent passed as `model` on
  `canvas_connect`, stored verbatim; nothing verifies it. This raises the cost of
  *accidental* same-model review — a fleet that is quietly all one model, which is
  the realistic failure — and does nothing about a client that misreports. The
  refusal message says so itself.
- **Matching is not family-aware.** Comparison normalises case, routing prefixes
  (`anthropic/`, `us.anthropic.`) and bracketed variant tags, so
  `claude-opus-5[1m]` and `claude-opus-5` are one model. It does **not** guess
  lineage: `claude-opus-4-8` reviewing `claude-opus-5` passes. It catches the same
  model spelled two ways, which is the accident it exists to catch.
- **An unrecorded model fails OPEN** (and is logged) — the opposite posture from
  the unknown-proposer and unknown-completer cases above, on purpose. `model` is
  optional on `canvas_connect` and most agents never sent one; failing closed
  would turn ticking a box into an outage on a live canvas. The non-self rule and
  the registered-agent floor still had to pass to get that far.

### The reviewer is a separate agent, not a subagent on your handle

Register the reviewer the same way any worker registers: its **own**
`canvas_connect` with `role: "executor"`, a name like `reviewer`, and — if the
canvas requires cross-model review — the `model` it is actually running. Give it
the canvas **code**, never the orchestrator's `session` handle: the handle carries
the orchestrator's identity, so a "reviewer" running on it *is* the proposer, and
the server correctly refuses with `peer_self_approval`. That refusal is the
contract working, not a bug to route around.

A reviewer prompt is short, because the judgement is the job:

```
You are the reviewer for canvas $TANDEM_CANVAS_CODE. You review other agents' work; you never
write code and you never claim tasks.

1. canvas_connect with code $TANDEM_CANVAS_CODE, role executor, name reviewer, and your model id.
   Keep the session handle and pass it on every call.
2. board_status — what is sitting in 'proposed' (plans waiting on you) and what has finished
   (the epic rollups list completed tickets).
3. PLANS. For each proposed task: task_get it and read it properly — is it the work that was
   actually asked for, is it scoped to one unit, does it say what done means, does it collide
   with a task already executing?
   task_review { id, outcome: "pass" } only the ones that hold up. Leave the rest alone and
   report, per task, what is wrong with it. Leaving a task unapproved is a normal outcome.
4. FINISHED WORK. For each done task you have not reviewed: task_get it, read the result and
   the commit it links, and judge whether it is correct, in scope, and actually finished.
   If it is not: task_review { id, outcome: "changes_requested", reason: "..." } where the
   reason names what is wrong AND what fixed looks like. That is all the author gets.
   If it is fine, say so in your report — 'done' is terminal and needs nothing from you.
5. Do NOT claim the task you bounced. You are the reviewer; expect it back and review the
   second attempt on its own merits.
6. You cannot review your own proposals or your own completions, you cannot approve epics,
   and you cannot reject or fail anything — those stay with the human. Report them instead.
```

### Not a rubber stamp

This is the part that decides whether `peer` is worth having. **A reviewer that
passes everything is indistinguishable from `approval_policy: auto`** — which
already exists, costs no tokens, and is simpler. The only reason to spend a
second agent on the gate is that it sometimes says *no*: wrong scope, no
acceptance criteria, duplicate of something already executing, a plan that
drifted from what was asked, a "done" whose commit does not do what the result
claims.

The opposite failure is just as real now that the reviewer can bounce. **A
reviewer that sends everything back is a stall**, and on a same-model fleet it is
a way for one agent to keep another's work in permanent revision. Bounce on
something the author can act on, not on taste.

So, when you run one: give it explicit criteria, keep it out of the work (a
reviewer that also implements is one pair of eyes wearing two hats), and read
both what it *declined* and what it *bounced* — a gate that never declines
anything is telling you to turn it off and set `auto`.

`approved_by` records which it was: `human`, `agent:<name>` for a peer approval,
`policy:auto` / `policy:epic` for the birth-time cascades. Bounces are in each
task's `payload.audit[]`, with the reviewer, the states and the verbatim reason.
That is how you audit the gate afterwards from the board alone.

### What this deliberately does not do

Three lines are load-bearing. They are design positions, not gaps waiting to be
filled, and relaxing any of them quietly changes what the gate means.

**1. Killing work stays human.** A reviewer's two moves — pass a plan, bounce
finished work — are both *reversible*: a human undoes either with one move from
the board. Rejection is not. It clears a peer's proposal out of the queue, and a
fleet that can dismiss its own tickets is a fleet whose board stops recording
what was asked for. So `reject` is human-only on `peer` too, and the reviewer has
**no move at all that ends another agent's task** — its "no" to a *proposal* is
not a button: **leave it alone and say why.** The unapproved task sitting on the
board with a reason next to it is the mechanism. (An executor can still report
its *own* claimed task as failed via `task_complete` — that is a worker
reporting an outcome, not a reviewer passing judgement on someone else.)

**2. A reviewer may never review its own work.** Enforced server-side on both
doors from identities the caller cannot assert — the proposer off the row's
`authored_by` for a pass, the completer off `claimed_by` for a bounce. When the
counterparty cannot be established the answer is *refuse*, not *allow*
(`peer_proposer_unknown`, `rework_completer_unknown`): "we couldn't tell" must
resolve to a human, or the rule is decorative on exactly the rows where it
matters. The honest limit, which has always applied to agent identity here: the
`agent:` prefix is server-stamped, the **name after it is client-asserted**. The
registered-agent floor means the name must at least be on this canvas's roster.
It stops an agent that says who it is from reviewing itself; it does not stop one
that lies about which agent it is. `human` remains the strong side of the gate
because no agent credential can produce it.

**3. The model is self-asserted, so cross-model review is an honesty rail — not
a guarantee.** `requireCrossModelReview` compares two strings the agents supplied
themselves. Its job is to catch the realistic failure (a fleet that is quietly
all one model, reviewing itself with extra steps), and it is worth having for
that. It is not a security control, it cannot be one, and it must never be
described as one — a client that misreports its model walks straight past it, and
so does a different checkpoint of the same family, which the matcher does not
even try to detect.

### Refusals

`task_review` answers refusals as **data**, not errors — `reviewed:false` with a
stable `refusal` code, the server's `message`, and a `_next` written for the case
you hit. Read `_next`; it covers codes newer than this table.

Both outcomes:

| `refusal` | Means |
|---|---|
| `human_approval_only` | This canvas is not on `peer` (pass). Nothing to do but ask the human. |
| `rework_policy_required` | This canvas is not on `peer` (changes_requested). A human reopens finished work from the board. |
| `peer_identity_required` / `rework_identity_required` | The session has no agent identity at all (an anonymous canvas token). Connect through the gateway. |
| `peer_agent_unregistered` / `rework_agent_unregistered` | Your identity is not on this canvas's roster — register and retry under that name. |
| `peer_same_model` / `rework_same_model` | The canvas requires cross-model review and you report the same model as the author. Hand it to a reviewer on a different model. |

`outcome: "pass"`:

| `refusal` | Means |
|---|---|
| `peer_self_approval` | You proposed this task. A different agent (or the human) must pass it. |
| `peer_epic_human_only` | It is an epic. Human-only everywhere. |
| `peer_proposer_unknown` | The task predates provenance, so non-self cannot be proven. Fails closed. |
| `not_reviewable` | The task is not `proposed` — nothing is waiting on your yes. If it is `done` and you want changes, call again with `changes_requested`. |

`outcome: "changes_requested"`:

| `refusal` | Means |
|---|---|
| `rework_not_finished` | The task is not `done`. Only finished work can be sent back; the answer carries the state it is actually in. |
| `rework_self_review` | You finished this task. Someone else reviews it. |
| `rework_task_only` | It is an epic. An epic is the batch, not the work. |
| `rework_completer_unknown` | No attributable worker on the row (`claimed_by` empty or the generic `"agent"`), so non-self cannot be proven. Fails closed — a human sends this one back. |
| `rework_reason_required` | Empty `reason`. The gateway stops this before the round trip; the server refuses it too. |

---

## 6. The plan gate: which asks become an epic, and which you just do

Everything above starts from tickets already being on the board. This is the step
before it, and it is the one an agent gets wrong in both directions: executing a
sprawling ask it should have planned, or ceremonially wrapping a one-line fix in
an epic nobody wanted to approve.

The pitch is that **the gate moves to before the code**. Every review tool on the
market intervenes at the diff — the agent builds the wrong thing, and you read
400 lines to find out it was the wrong thing. A plan intervenes earlier: eleven
ticket titles cost twenty seconds to read, eleven wrong diffs cost an afternoon.
That only pays if the routing is reliable, which is what this section is.

### The test

**Could you write the ticket — name the surface it touches, state a done
condition someone else could check, one sitting of work — out of what the human
actually said?**

That is deliberately the same contract `epic_propose` holds the tickets to (it
states it in the tool description and enforces the objective half). One rule,
used twice: it decides whether there is a plan to write, and then it decides
whether what you wrote is worth reviewing.

- **No, for any part of the ask → `epic_propose` FIRST**, before a line of code.
  You would be inventing the surfaces, the scope and the done conditions
  yourself, and those invented calls are exactly what the human is being shown.
- **Yes, for every part → do the work.** There is nothing to review: the human
  already made the calls when they asked. Wrapping it in an epic charges them an
  approval click for a decision they have already taken.

It turns on how **specified** the ask is, not how many parts it has.

| The ask | Route | Why |
|---|---|---|
| *"fix auth, the email service, and messaging"* | `epic_propose` | Three **areas**, zero surfaces. Each one is several tickets you would be writing on their behalf. |
| *"make onboarding not suck"* | `epic_propose` | One area, no surface, no done condition. A goal, not a change. |
| *"add rate limiting"* | `epic_propose` | Sounds like one thing; it is a limiter, a store, config, and a 429 path. Larger than a sitting. |
| *"fix the bell overlapping the code chip"* | just do it | Surface named, done condition obvious, one sitting. |
| *"add a `--quiet` flag to `tandem-mcp listen`, bump the version, update the README"* | just do all three | Three parts, all specified, all one sitting each. Three tasks, not an epic. |
| *"plan the dark-mode rollout"* / *"write an epic for X"* | `epic_propose` | Asked for a plan explicitly. |

### The boundary is as load-bearing as the trigger

State it out loud, because overreach is what makes a gate annoying enough to turn
off: **a single specific ask must not become an epic.** Three reasons it is a
rule and not a preference:

1. It costs the human an approval for work they authorised by asking for it.
2. It is slower than the thing it replaced, on the one case where direct
   instruction genuinely wins.
3. `epic_propose` **refuses a one-ticket epic** outright — an epic with a single
   task is a task, so the honest move is `task_propose` (with an `epicId` to file
   it under an existing batch), or nothing at all if you are about to do it now.

The general version, worth saying to anyone who asks why they would bother:
Tandem is not for the three things you would just type into a session. It starts
paying when the batch is bigger than you can hold, when agents run where you are
not, when two of them want the same ticket, or when you want to triage from a
phone. Claiming it wins at N=3 loses the argument for the case where it wins.

### What the policy has to do with it

Nothing you choose. The route is *whether there is a plan worth reviewing*; the
canvas's `approval_policy` is *who lets it through*, and only the owner sets it
(§5 has the full table). There is no fifth mode for this:

| Policy | What the route looks like there |
|---|---|
| `epic` (default) | **The pairing.** One human approval on the epic releases every ticket under it — which is what makes proposing a whole batch cheap enough to be the default answer to a vague ask. |
| `strict` | Same route, ticket-by-ticket gate. Propose the batch anyway; the human approves each. |
| `peer` | Same route, but nothing is born approved and the epic cascade is off — a reviewer agent passes each ticket on its own (§5). |
| `auto` | **The direct path.** Nothing waits, so proposing is record-keeping rather than review. Worth doing for a batch you want claimable and trackable; not worth it to gate a one-line fix that no longer gets gated anyway. |

### After you propose

Do not end the turn and do not poll. `queue_wait` with the returned `epicId`
returns the moment the batch is approved; `status: "timeout"` means nothing yet,
so call it again (§0).

Tickets come back, and that is the gate working. `task_get` answers with a
`review` block — `{ outcome, reason, by, at }`, the decider's words verbatim —
whichever produced it (TDM-161):

- **`rejected`** — a human killed it. Read it as a correction to the *plan*, not
  to the one ticket: it usually condemns neighbours too, so `task_amend` those
  while they are still `proposed`. Re-proposing the same ticket lands the same
  way.
- **`rework`** — finished work sent back (§5). The reason is the brief for the
  next attempt at that same ticket; it is back in the ready queue for a fresh
  claim, not a new ticket to file.

### The honest limit

Decomposition does not create thought. *"Fix auth"* can absolutely produce eleven
vague tickets, and this route does not stop that — what changes is that you can
**see** it is slop in twenty seconds instead of forty minutes. It is a slop
detector, not a slop preventer. `epic_propose`'s ticket-quality contract raises
the floor (a ticket with no real body, or one that just restates the epic's
title, is refused before anything is written, and softer smells come back as
non-blocking `warnings` to fix with `task_amend`) — but the floor is not
judgement, and the human reading eleven titles is still the point.

---

## 7. Troubleshooting

**401 from the listener** — the signature is missing, malformed, or does not
match, which in practice means the secret is wrong. The listener reads
`--secret`, falling back to `TANDEM_WEBHOOK_SECRET`; the flag wins, so an
exported env var will not override a stale flag. If you rotated the secret in the
UI, restart the listener with the new one. Check the delivery's response in
**Settings → Webhooks → the endpoint's delivery list**.

**400 from the listener** — that is the *timestamp*, not the secret:
`Tandem-Timestamp` missing, non-integral, or outside the ±60s replay window. A
400 with `timestamp outside 60s replay window` means the two clocks disagree —
fix the clock on whichever side drifted (a laptop resuming from sleep is the
usual culprit). The two codes are deliberately distinct: 400 is "this delivery is
stale or malformed", 401 is "this delivery is not from Tandem".

Everything past verification is acked `200` regardless of whether it ran —
duplicates (`ok (duplicate)`) and filtered-out event types (`ok (ignored)`)
included. A non-2xx there would only earn a pointless retry, so a green delivery
list does **not** by itself mean the exec fired; the listener's stderr does.

**Nothing fires at all** — almost always the URL in the UI. Confirm, in order:
the tunnel is still up (quick tunnels change hostname on restart); the URL in the
UI is the tunnel hostname with `/webhook` on the end; the endpoint is toggled
**on**; `task.approved` is checked in *Send when*. Then look at the delivery list
— an endpoint that is being tried and failing looks completely different from one
that was never called.

**`webhook target blocked` in the delivery list** — you pointed the API at a
private address (`localhost`, `127.0.0.1`, `192.168.x.x`, `host.docker.internal`).
The SSRF guard refused it, non-retryably. Against prod, use a tunnel; against
`tandem-local`, set `TANDEM_WEBHOOKS_ALLOW_PRIVATE=1` on the container. Both in
§2.

**Approving an epic ran the orchestrator N times** — it should not. 12 approvals
inside `--debounce` are one exec with 12 tickets, and single-flight prevents a
second exec while one is running. If you genuinely see N runs, the deliveries
arrived further apart than the debounce window — raise `--debounce`.

**The same task got worked twice** — not a double-fire. Tandem dedupes at both
ends: `UNIQUE(webhook_id, event_id)` means re-emitting the same source event
enqueues nothing, and a retry reuses its `Tandem-Delivery-Id` so the listener
drops it. What *does* happen is two orchestrators racing the same queue, which is
fine and expected — `task_claim` is atomic and exactly one wins. If work is
genuinely duplicated, an agent worked a task it did not successfully claim.

**Deliveries succeed but no work happens** — the exec ran and the orchestrator
found nothing. Usual causes: `TANDEM_CANVAS_CODE` is unset so the prompt
interpolated an empty code; the Tandem MCP server is not registered in the
directory the listener runs from; or the tasks are under a `proposed` epic, so
they are not actually in the ready queue. `board_status` answers the last one.

---

## Notes on the tool surface

Everything the prompt above uses is on the **default** manifest — the 16-tool
intent facade: `canvas_connect`, `agent_register`, `context_get`, `queue_next`,
`queue_wait`, `task_find`, `task_get`, `task_claim`, `task_progress`,
`task_complete`, `task_propose`, `task_amend`, `task_review`, `epic_propose`,
`doc_write`, `board_status`. No `TANDEM_FULL_TOOLS=1` needed; that env var opens
the full CRUD surface, which orchestration does not require.

`queue_wait` (§0) is `queue_next`'s waiting twin and needs no setup at all: it is
what a live orchestrator calls instead of ending its turn. The webhook-launched
orchestrator above deliberately does **not** use it — it drains the queue and
exits, because the listener is what wakes it next.

`task_review` is the reviewer's tool — both halves of the job, `outcome: "pass"`
and `outcome: "changes_requested"` — and it does nothing on a canvas that is not
on the `peer` approval policy (§5): it answers `reviewed:false` and says so.

It **replaced** `task_approve` on the manifest rather than joining it, so the
surface is still 16 tools. `task_approve` is still *routed* — a session running on
older instructions gets its approval instead of "unknown tool" — but it is no
longer advertised and only ever did the `pass` half, which is precisely the gap
§5 exists to close. Write `task_review`.

Registration is part of **`canvas_connect`**: pass `role` (plus `name`, `model`,
and `parentAgentId` if an orchestrator spawned you) and the one call connects and
registers, returning `agentId` and a `session` handle already carrying that
identity. `agent_register` is still on the facade for **re-**registration — fixing
a parent the canvas rejected, recording the model you are actually running, or
switching role.

A bad `parentAgentId` never fails the connect: the gateway retries the
registration without the parent and reports it as data — `agent.problem` on the
result, `agent.parentAgentId: null`. The worker comes up unparented and working,
rather than dead on its parent's id.

`role` is an enum of `planner | executor`. There is no `orchestrator` role: the
orchestrator connects as **`planner`** and its subagents as **`executor`** with
`parentAgentId` set to the planner's `agentId`. Give it `name: "orchestrator"` if
you want the word on the board.

Skipping registration still works — pass `agentName` on `task_claim` /
`task_complete` — but you lose the fleet-tree grouping, and `queue_next`'s
handoffs come back with a placeholder parent instead of your id.

For an in-session version of this loop — a Claude Code session that waits on
`queue_wait` (§0) instead of being relaunched by a webhook — see the
`tandem-watch` skill in `.claude/skills/tandem-watch/`.
