# Approval-triggered orchestration

You approve tasks on the board. Tandem POSTs a signed `task.approved` to a listener
on your machine. The listener runs one command. That command is a Claude
orchestrator that pulls the queue and fans the work out to subagents — it
dispatches; each subagent claims its own task.

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
   executing. That is a READ. A task left executing is reported, not completed by you; its claim
   expires on its own.
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

## 5. Troubleshooting

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

Everything the prompt above uses is on the **default** manifest — the 12-tool
intent facade: `canvas_connect`, `agent_register`, `context_get`, `queue_next`,
`task_get`, `task_claim`, `task_progress`, `task_complete`, `task_propose`,
`epic_propose`, `doc_write`, `board_status`. No `TANDEM_FULL_TOOLS=1` needed;
that env var opens the full CRUD surface, which orchestration does not require.

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

For an in-session version of this loop — a Claude Code session that idles waiting
for approvals instead of being relaunched by a webhook — see the
`tandem-watch` skill in `.claude/skills/tandem-watch/`.
