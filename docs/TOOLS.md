# Tandem MCP tools — per-tool reference

The **intent facade** is Tandem's default MCP surface: 18 tools shaped like the
things an agent session actually does, in the order it does them. It is defined
in `apps/mcp-gateway/src/facade.ts` (`FACADE_RAW_TOOLS`, gated by
`FACADE_NAMES`); several tools borrow their schema and/or handler from the ~80-tool
CRUD surface in `apps/mcp-gateway/src/tools.ts`, so the two can never drift.

The CRUD surface is still callable but only *advertised* behind
`TANDEM_FULL_TOOLS=1` (or `tandem-mcp --full-tools`). Write against the 18 names
below.

The happy path:

```
canvas_connect (+ role: registers you) → context_get → queue_next → task_get
        → task_claim → (work, task_progress) → doc_write → task_complete
```

…and with subagents the same queue forks at `queue_next`: every ready task comes
back with a `handoff` block the orchestrator pastes into one subagent per task.
It dispatches; the workers claim. Waiting for approval is `queue_wait`, not
ending your turn.

Companion docs: `docs/ORCHESTRATION.md` (the live/webhook orchestration recipes,
the four approval policies, and the full refusal tables) and the `tandem-watch`
skill in `.claude/skills/tandem-watch/`.

## The 18 tools

| Tool | One line |
|---|---|
| [`canvas_connect`](#canvas_connect) | Bind the session to a canvas by code — and register your identity in the same call. |
| [`canvas_create`](#canvas_create) | Create a NEW canvas and bind to it, when the human gave you no code. |
| [`agent_register`](#agent_register) | Re-register: fix a rejected parent, record your model, switch role. |
| [`context_get`](#context_get) | The cheap one-call briefing: what this canvas is, its tabs, its queue. |
| [`queue_next`](#queue_next) | The approved, ready-to-work queue — with a paste-ready `handoff` per task. |
| [`queue_wait`](#queue_wait) | The same queue, but it WAITS on the server until work is approved. |
| [`task_find`](#task_find) | Turn a name ("the constraints task") into an id, without reading the board. |
| [`task_get`](#task_get) | One task with its linked context, its epic, and why it came back. |
| [`task_claim`](#task_claim) | Atomically claim a task you will personally do. |
| [`task_progress`](#task_progress) | One line of progress — and the heartbeat that keeps your claim. |
| [`task_complete`](#task_complete) | Finish a task with a result and evidence links. |
| [`task_propose`](#task_propose) | Propose one task, or a whole batch, for approval. |
| [`task_amend`](#task_amend) | Correct, retract, or resubmit a proposal YOU authored. |
| [`task_review`](#task_review) | The reviewer's one verb, two outcomes (`peer` canvases only). |
| [`epic_propose`](#epic_propose) | Propose the container AND its tickets in one call. |
| [`doc_write`](#doc_write) | Leave markdown context on a document tab. |
| [`doc_read`](#doc_read) | Read one document tab back, budgeted and paged. |
| [`board_status`](#board_status) | Where the project stands: counts, epics, who holds what. |

---

## Two conventions that apply to (almost) everything

### 1. The `session` handle

`canvas_connect` (and `canvas_create`) returns a `session` string. **Pass it back
as the `session` argument on every later call.** The hosted MCP connection can
reset between calls; the handle re-binds you without reconnecting, which is why
every facade description repeats the line. Two handles supersede the connect-time
one:

- `agent_register` returns an **updated** handle carrying your agent identity.
- A winning `task_claim` returns an **updated** handle carrying the claim's
  fencing token (`claimGeneration`) — later `task_progress` / `task_complete`
  calls present it, so a superseded lease is refused by generation, not just by
  name.

Switch to the newest handle you were given. `session` is omitted from the
per-tool parameter lists below; assume it on all of them.

### 2. Task ids accept ticket refs

Everywhere a task `id` is taken — `task_get`, `task_claim`, `task_progress`,
`task_complete`, `task_amend`, `task_review`, `task_find` — the argument is the
task's uuid **or** its ticket ref. `TDM-21`, `tdm-21`, `#21` and `21` all resolve
to the same task (`TASK_ID_PROP` in `tools.ts`). Told "take on TDM-21", pass
`TDM-21` straight through: no lookup call, no board read.

A ref that names nothing on this canvas answers **404 `task_not_found`**, not
"invalid id". A missing or empty `id` is rejected in the gateway before any
request (`requireTaskId`), with a message naming both accepted forms.

---

<a id="canvas_connect"></a>
## `canvas_connect`

**Purpose** — Step 1 of every session: bind this session to a canvas by its
8-char code, and register your agent identity in the same call.

**Key parameters** (schema borrowed from the CRUD `canvas_connect`)

| Param | Notes |
|---|---|
| `code` | **Required.** The canvas code the human gave you, e.g. `TEGLQFXR`. |
| `role` | `planner` \| `executor`. Passing it is what REGISTERS you — `planner` if you dispatch to subagents, `executor` if you claim and work tasks yourself. |
| `name` | Agent name shown on the board, e.g. `opus-executor-3`. Defaults to the role. Re-registering the same name refreshes the SAME agent, never a duplicate. |
| `model` | Self-asserted model id. Matters only on canvases with cross-model review turned on. |
| `parentAgentId` | The orchestrator's `agentId`, so the fleet view nests you under it. |

**Returns** — `{ connected: true, canvasId, canvasName, canvasCode, url,
agentId?, agent?, session, _surface_url_now, _session_note }`. Give `url` to the
user immediately, before you start work, so they can watch changes land.

**Refusals / edges**

- A rejected `parentAgentId` **never fails the connect**: registration is retried
  without the parent and the result carries `agent.problem` plus
  `agent.parentAgentId: null`. You come up unparented and working.
- There is no `orchestrator` role. An orchestrator connects as `planner`; its
  subagents connect as `executor` with `parentAgentId` set to the planner's
  `agentId`.
- Calling it again switches the session to a different canvas.

```json
{ "code": "TEGLQFXR", "role": "executor", "name": "docs-executor",
  "parentAgentId": "ffbd2b1a-093c-4233-abf2-dcf44164b2dc" }
```

---

<a id="canvas_create"></a>
## `canvas_create`

**Purpose** — Create a NEW canvas and bind this session to it in one step, for
when the user wants a plan on a canvas and gave no code.

**Key parameters**

| Param | Notes |
|---|---|
| `name` | The CANVAS name (the project or plan title). Optional; defaults to "Untitled canvas". |
| `role` | Same enum as `canvas_connect` — registers you in the same call. |
| `agentName` | YOUR agent name, kept distinct from `name` because that one names the canvas. |
| `model`, `parentAgentId` | As `canvas_connect`. |

**Returns** — `{ created: true, canvasId, canvasName, canvasCode, url, agentId?,
agent?, session, … }`, plus `claimUrl` + `claimHint` on an anonymous create.

**Refusals / edges**

- `url` is the ownership-free share link; `claimUrl` is a **private** link that
  lets the user claim the canvas as their own. Keep the two distinct in what you
  tell them — never use `claimUrl` as the share link.
- Registration happens here, so `_session_note` tells you **not** to call
  `agent_register` afterwards: the exported handle already carries the identity.

```json
{ "name": "Q3 launch plan", "role": "planner", "agentName": "opus-orchestrator" }
```

---

<a id="agent_register"></a>
## `agent_register`

**Purpose** — Register, or (mainly) **re-**register, this session's agent
identity when `canvas_connect` / `canvas_create` didn't do it or got it wrong.

**Key parameters** — `role` (**required**, `planner` \| `executor`), plus `name`,
`model`, `parentAgentId` — the same identity block `canvas_connect` takes.

**Returns** — the registration result (`agentId`, and the id recorded as author
/ provenance of anything this session proposes) plus an **UPDATED `session`
handle**. `_session_note` says it plainly: pass THIS handle, not the
connect-time one, on every later call.

**Refusals / edges**

- Prefer registering in `canvas_connect`. A separate registration call is a step
  a subagent can skip, and then the fleet tree never forms.
- Re-registering the same `name` refreshes the SAME agent (same `agentId`) — it
  is the fix for a rejected `parentAgentId`, a wrong `model`, or a role switch.
- Skipping registration entirely still works (pass `agentName` on `task_claim` /
  `task_complete`), but you lose fleet grouping and `queue_next`'s handoffs ship
  a placeholder parent instead of your id.

```json
{ "role": "executor", "name": "docs-executor",
  "parentAgentId": "ffbd2b1a-093c-4233-abf2-dcf44164b2dc" }
```

---

<a id="context_get"></a>
## `context_get`

**Purpose** — The canvas briefing: what this canvas IS and what is on it, in one
cheap call that never pulls the full board.

**Key parameters** — none.

**Returns** — the server-built briefing when the API has it
(`source: "api"`), otherwise a composed one (`source: "composed"`):

```
{ source, canvas, mode, version,
  contents: { counts, names },      // names capped at 20 per kind, "…(+N more)"
  documents: [{ id, type, name, parentId? }],
  queue: { byState, ready: [≤10 compact tasks], readyTruncated? },
  _next }
```

**Refusals / edges**

- It is an orientation read, not an enumeration: counts and capped names only.
- This is how you learn the **document tab names** `doc_read` / `doc_write` take.
- If you already know the canvas and just want work, skip it — call `queue_next`.

```json
{}
```

---

<a id="queue_next"></a>
## `queue_next`

**Purpose** — The entry point for work: the approved tasks ready to be picked up
right now, each with a paste-ready dispatch `handoff`.

**Key parameters** — `limit` (max tasks, default 10), `epicId` (only ready tasks
under one batch).

**Returns**

```
{ tasks: [{ id, ticketId?, title, state, claimedBy?, epicId?,
            handoff: { canvasCode, taskId, ticketId?, title,
                       parentAgentId, steps: [...] } }],
  truncated?, lostByYou?, _lostByYou?, _warning?, _dispatch | _next }
```

The `handoff.steps` are the literal instructions a worker follows: connect +
register as an `executor` under you, claim ITS task, `task_get` for the brief,
`task_progress`, `task_complete`. On a parallel batch (2+ dispatchable rows) the
steps also carry the shared-checkout conventions.

**Refusals / edges**

- **Dispatching means you do not claim.** With subagents, spawn one per ready
  task and paste its `handoff` verbatim. Never pass on your `session` handle —
  the canvas **code** is what travels.
- A row marked `lostByYou: true` carries **no handoff**: you raced for it and
  lost, so it is neither yours to claim nor to dispatch. `queue_next` clears that
  record the moment the server reports the task ready and unheld again.
- `_warning` means the `parentAgentId` on your session matches no registered
  agent on this canvas (ghost parent, TDM-201): the handoffs ship *unparented*
  rather than pointing at nothing. The check fails **open** — an unreadable agent
  list ships the handoff as-is.
- An empty answer means nothing is approved; `_next` says who can open the gate,
  and it differs on a `peer` canvas (a reviewer agent is also a way through).

```json
{ "limit": 5, "epicId": "d18eac2d-738f-4136-9caf-d8ab4aab2ede" }
```

---

<a id="queue_wait"></a>
## `queue_wait`

**Purpose** — The call you make **instead of ending your turn**: one request that
returns the moment approved work exists. You are parked on the server, not
polling.

**Key parameters** — `timeoutSeconds` (default 25, clamped 1–60), `epicId` (wake
only for one batch — e.g. the id `epic_propose` just returned), `limit`
(default 10).

**Returns** — always a `status`, one of five:

| `status` | Meaning |
|---|---|
| `ready` | Approved tasks, each with the same `handoff` block `queue_next` gives. Claim (alone) or dispatch (with subagents). |
| `rejected` | Nothing approved, but tickets you proposed came BACK, each with the decider's `reason` **verbatim and uncapped**. Work, not an error. |
| `timeout` | Nothing approved inside the window. **Not an error and not a failure** — call `queue_wait` again immediately. |
| `busy` | Canvas is at its waiter cap; the call read the queue instead of waiting. Try again. |
| `unsupported` | The API predates the long poll; the call read the queue instead. Tell the human the API needs updating. |

Plus `tasks`, `count`, `waited`, `waitedMs`, `timeoutSeconds`, `_next`, and —
on the FIRST timeout for a given scope only — `_tell_human`.

**Refusals / edges**

- **Tell the human before you wait.** Waiting is the second beat: relay the
  `tellHuman` line from `epic_propose` / `task_propose` first. `_tell_human` is
  the backstop for having skipped it, and it comes once per batch, not per round.
- A rejection **wakes this call** — so a `timeout` means nobody has decided yet,
  not that a "no" went unheard. Do not keep waiting on a rejected ticket:
  `task_amend` it (with a `note`) instead.
- Don't poll on an interval and don't end your turn on a timeout.

```json
{ "epicId": "d18eac2d-738f-4136-9caf-d8ab4aab2ede", "timeoutSeconds": 60 }
```

---

<a id="task_find"></a>
## `task_find`

**Purpose** — Find a task by NAME when you don't have its id ("the constraints
task"), without reading the whole board.

**Key parameters**

| Param | Notes |
|---|---|
| `query` | **Required.** Part of the title, or a ticket ref. |
| `state` | `proposed` \| `approved` \| `executing` \| `done` \| `failed`. Omit to search every state. |
| `assignee` | `agent` \| `human` \| `any` (default). |
| `limit` | Max matches, default 10. |

**Returns** — `{ query, matches: [{ id, ticketId?, title, state, claimedBy?,
epicId?, assignee, claimedAt?, matchedIn? }], truncated?, searched, _next }`.
`matchedIn` is `title` or `body` and says which rule fired.

Matching is deliberately dumb and predictable, best rule first then newest: the
query as a **substring of the title**, then **all its words in the title**, then
**all its words in title-or-body**. Confirm the title is the task you meant
before acting on it.

**Refusals / edges**

- A ticket ref is **resolved, not searched**: the answer carries `resolvedAs` and
  either the one row or an empty `matches`. **No match is an answer, not an
  error** — the API 404s an unknown ref and the gateway turns that into `[]`.
- An empty `query` is rejected in the gateway.
- You rarely need this for a ref at all — pass the ref straight to `task_get` /
  `task_claim` as `id`.

```json
{ "query": "constraints", "state": "approved" }
```

---

<a id="task_get"></a>
## `task_get`

**Purpose** — Read ONE task with its context hydrated. This is all the brief you
need to start; you never have to read the canvas.

**Key parameters** — `id` (**required**; uuid or ticket ref).

**Returns** — `{ action, linked, epic? }` where:

- `linked[]` carries the referenced roadmap items and notes (title, body,
  status) — where the real brief usually lives.
- `epic` is deepened into the batch rollup: `{ id, title, state, summary?,
  tasks: { total, byState }, drained, summaryNeeded, returned?, review?, body,
  openTasks }`. **`epic.body` is where the contracts shared by every ticket in
  the batch are written once instead of copied into each one — read it before you
  start.**
- Progress reported via `task_progress` comes back here too.

Two conditional blocks:

- **`review` + `_review`** — a ticket a human rejected, or finished work a
  reviewer bounced, answers with `{ outcome: "rejected" | "rework", reason, by,
  at, state }`, the reason **verbatim**. `_review` says what to do: a rejection
  is a correction to the PLAN (amend this ticket AND its condemned neighbours);
  a bounce is the brief for the next attempt at the same ticket.
- **`quality` + `_quality`** — on a still-open ticket (proposed / approved /
  executing), the ticket-quality contract's **non-blocking** warnings (names no
  surface, states no done condition, reads like more than one sitting), re-derived
  from the row's current text. They block nothing; settle them before you write
  code rather than guessing quietly.

`_epic` appears when this is the LAST unfinished task in its batch: your cue to
pass `epicSummary` to `task_complete`.

**Refusals / edges** — unknown ref → `task_not_found` (404); empty `id` is
rejected before any request.

```json
{ "id": "TDM-208" }
```

---

<a id="task_claim"></a>
## `task_claim`

**Purpose** — Claim a task you are about to do **yourself** (`approved` →
`executing`), so parallel sessions skip it.

**Key parameters** — `id` (**required**), `agentName` (claimant name; a
*registered* session always claims under its registered name, so this override
only applies to unregistered sessions).

**Returns on success** — `{ claimed: true, action: { …, ticketId }, claim: {
generation, holder, claimedAt }, session }`. Put `ticketId` (e.g. `TDM-142`) in
your commit messages. Switch to the returned `session` — it carries the fencing
token.

**Returns on a loss** — and **losing is normal**:

```
{ claimed: false, claimedBy,
  tapOut: true, reason, next: "queue_next", taskId, holder?, fenced?,
  claimGeneration?, attempts, message }
```

`tapOut: true` is the one thing to branch on, and it means **stop touching this
task**, not retry. `reason` is one of `already_claimed`, `already_lost`,
`not_your_claim`, `already_finished`, `fenced`.

**Refusals / edges**

- **If you are dispatching subagents, do not claim here.** A task claimed by an
  orchestrator that never touches it reads on the board as in-flight work nobody
  is doing.
- Asking a **second** time for a task you already lost is refused in the gateway
  without reaching the API (`reason: "already_lost"`, with `attempts`) — re-racing
  a lost claim is a loop, not a strategy.
- Never work a task you did not claim.

```json
{ "id": "TDM-208", "agentName": "docs-executor" }
```

---

<a id="task_progress"></a>
## `task_progress`

**Purpose** — One line of progress mid-flight — and the **heartbeat** that keeps
your claim alive.

**Key parameters**

| Param | Notes |
|---|---|
| `id` | **Required.** The task you claimed. |
| `note` | **Required.** One line: what you just did, found, or got blocked on. |
| `percent` | Optional 0–100. Folded into the stored line as `note (NN%)` — there is no percent field on the wire. |
| `agentName` | Report as the identity you claimed with. Defaults to the session's. |

**Returns** — `{ recorded: true, id, by, entries, percent?, claimedAt?,
leaseExtended, note }`. The fresh `claimedAt` IS the lease extension;
`leaseExtended` is true only when the server refreshed it for you as holder.

**Refusals / edges**

- The claim lease is **~15 minutes** from `claimedAt`. On work longer than that,
  report as you go or the task becomes reclaimable underneath you. The server
  only refreshes the lease for the holder reporting through this endpoint.
- A rejected heartbeat is an **answer, not a crash**: `{ recorded: false, id, by,
  apiError?, claimedBy?, state?, message }`. When the rejection is *contention*
  (another agent holds it, your claim was fenced, the work is already over) it
  also carries the full `tapOut` block and the loss is remembered, so you cannot
  follow it with a claim attempt.
- A task that is merely **not claimed** is not a tap-out — the answer there is
  `task_claim`, not `queue_next`.
- This is not the finish line. Call `task_complete`.

```json
{ "id": "TDM-208", "note": "Audited facade.ts; writing the doc now", "percent": 55 }
```

---

<a id="task_complete"></a>
## `task_complete`

**Purpose** — Finish a task with a result summary and evidence; the last step of
every task you claim. Leaving one `executing` blocks the queue.

**Key parameters**

| Param | Notes |
|---|---|
| `id` | **Required.** uuid or ticket ref. |
| `result` | **Required.** What was done and where — files, commit hashes, PR. It shows on the board and is the human's whole view of your work. |
| `links` | GitHub commit / PR / branch URLs. The board resolves them live (merged, open, checks failing). |
| `status` | `done` (default) \| `failed`. |
| `error` | Failure detail when `status: "failed"` — better than leaving it hanging. |
| `agentName` | Complete under the SAME identity you claimed with. |
| `epicSummary` | Facade-only addition: what the whole BATCH achieved. |

**Returns** — the completion, plus `epic: { …snapshot, openTasks }` and an
`_epic` line saying how many tasks are left (or that the batch has drained with
no summary). When `epicSummary` was passed it echoes `epicSummary: { written:
true, epicId, title }`.

**Refusals / edges**

- A refused completion (someone else holds it, your lease was fenced, the work is
  already over) comes back **untouched** as the tap-out shape — `completed:
  false`. Route on it; do not read past it.
- `epicSummary` on a task with **no epic** answers `{ written: false, reason:
  "This task belongs to no epic, so there was no batch to summarize." }` —
  honesty over silence.
- If the summary write fails but the task completed, you get `{ written: false,
  epicId, error, note: "The task completed; only the epic summary failed to
  save." }`. The task is still done.
- Pass `epicSummary` when this is the last unfinished task in the batch —
  `task_get`'s `_epic` tells you in advance, and after this completion there is
  no call left to put it on.

```json
{ "id": "TDM-208",
  "result": "Wrote docs/TOOLS.md — per-tool reference for all 18 facade tools. Commit abc1234.",
  "links": ["https://github.com/jaximus808/tandam/commit/abc1234"] }
```

---

<a id="task_propose"></a>
## `task_propose`

**Purpose** — Propose work for LATER sessions: one task, or a whole plan at once
via `tasks`.

**Key parameters**

| Param | Notes |
|---|---|
| `title` | Short imperative title. Required unless you pass `tasks`. |
| `body` | Tight brief: what to do, acceptance criteria. |
| `linkedIds` | Ids of notes / roadmap items carrying the heavy context — `task_get` hydrates them for whoever picks the ticket up. |
| `epicId` | The batch this belongs to. As a **call-level** field it applies to every item in `tasks` (an item's own `epicId` wins). |
| `assignee` | `agent` (default) \| `human`. |
| `requiresApproval` | Force the human gate even under an auto-approving policy — how an agent flags its own deviation. |
| `tasks` | Propose MANY at once, same item shape. One write instead of N. |

**Returns** — the created row(s) plus **`tellHuman`**: a paste-ready line naming
what is waiting, the ticket range and the board URL. Relay it in your very next
message.

**Refusals / edges**

- Every item in `tasks` needs a non-empty `title` — `tasks[i] needs a \`title\``
  is thrown before any write. Neither `title` nor `tasks`? Also rejected.
- Proposals land `proposed` and a **human** approves them on the board before any
  session can claim them (except: under the default `epic` policy a task added to
  an **already-approved** epic is born approved; under `auto` everything is; under
  `peer` nothing is — see `docs/ORCHESTRATION.md` §5).
- For a whole plan, prefer `epic_propose`: one approval instead of N.
- After proposing: **tell the human, then `queue_wait`.**

```json
{ "epicId": "d18eac2d-…", "tasks": [
  { "title": "docs/TOOLS.md — per-tool facade reference",
    "body": "Surface: NEW file docs/TOOLS.md. DONE: 18/18 tools covered.",
    "linkedIds": ["note-uuid"] }
] }
```

---

<a id="task_amend"></a>
## `task_amend`

**Purpose** — Correct or retract a task **you** proposed — and the way to answer
a rejection.

**Key parameters**

| Param | Notes |
|---|---|
| `id` | **Required.** uuid or ticket ref. |
| `title` / `body` / `epicId` / `linkedIds` | The fields to change. Omit to keep the current value. |
| `note` | **Required when the ticket is `rejected`**: one line saying what you CHANGED in response to the reason ("scoped it to the gateway; the API half is now TDM-9"). "Please reconsider" is not one. Ignored on a still-`proposed` task. |
| `withdraw` | `true` retracts (deletes) the proposal instead of editing it. |

**Returns** — one of `{ amended: true, id, url }`, `{ withdrawn: true, id, url }`,
or, for a rejected ticket, `{ resubmitted: true, id, ticketId?, state:
"proposed", note, url, _next }`.

**Refusals / edges**

Deliberately narrow — the guards are checked against the SERVER's view, never
anything self-reported. These throw:

- The task is not `proposed` or `rejected` (approved / executing / done are no
  longer yours: propose a follow-up, or ask the human to reject it).
- Someone else holds the claim.
- You did not author it — `authoredBy` is server-derived provenance. (A task
  predating provenance has none and is allowed rather than stranded.)
- `withdraw` on a **rejected** ticket: it is already off the queue, and deleting
  it would erase the human's reason.
- A `note` alone on a still-`proposed` ticket: there is no rejection to answer.
- Nothing to amend at all.

Resubmit refusals come back as **data** — `{ resubmitted: false, id, refusal,
message, _next }` with `refusal` one of `task_not_found`, `resubmit_wrong_state`,
`resubmit_not_author`, `resubmit_note_required`.

A resubmit is **not** an approval: the ticket is back at `proposed` behind the
human gate, with the original rejection reason and your note preserved on its
audit trail. Tell the human, then `queue_wait`. Never file a fresh near-duplicate
instead — it arrives with no memory of the rejection and lands the same way.

```json
{ "id": "TDM-208", "body": "Scoped to the gateway only.",
  "note": "Dropped the API half; it is now its own ticket." }
```

---

<a id="task_review"></a>
## `task_review`

**Purpose** — The reviewer's one verb, with two outcomes. Usable only on a canvas
whose owner turned on the **`peer`** approval policy (off by default).

**Key parameters**

| Param | Notes |
|---|---|
| `id` | **Required.** uuid or ticket ref. One task per call — there is no bulk review for agents, on purpose. |
| `outcome` | **Required.** `pass` approves a still-`proposed` task into the ready queue. `changes_requested` sends a `done` task back. Nothing else is a review outcome. |
| `reason` | **Required on `changes_requested`** — the only thing the author gets. Name what is wrong AND what "fixed" looks like. Kept verbatim on the audit trail. Ignored on `pass`. |

**Returns** — `{ reviewed: true, outcome, id, ticketId?, title?, state,
approvedBy? | reason, url, _next }`. On `changes_requested` the task leaves
`done`, loses its claim and its now-stale result, and returns to the ready queue
as `approved` with your reason attached — `task_get` on it then answers with a
`review` block carrying it verbatim.

**Refusals / edges** — refusals are **data, not errors**: `{ reviewed: false,
outcome, id, refusal, message, …extra, _next }`. Read `_next`; it is written for
the case you actually hit, including codes newer than this table.

| `refusal` | Means |
|---|---|
| `human_approval_only` | Not a `peer` canvas (on `pass`). |
| `rework_policy_required` | Not a `peer` canvas (on `changes_requested`). |
| `peer_self_approval` | You proposed this task. |
| `rework_self_review` | You finished this task. |
| `peer_epic_human_only` / `rework_task_only` | It is an epic. Human-only everywhere. |
| `peer_identity_required` / `rework_identity_required` | The session has no agent identity the server can see. |
| `peer_agent_unregistered` / `rework_agent_unregistered` | Your identity is not on this canvas's roster. |
| `peer_proposer_unknown` / `rework_completer_unknown` | The server cannot tell who proposed / finished it. **Fails closed** — a human decides. |
| `peer_same_model` / `rework_same_model` | The canvas requires cross-model review and you report the same model as the author. |
| `rework_not_finished` | The task is not `done`; the answer carries the state it is actually in. |
| `rework_reason_required` | Empty reason (the gateway stops this before the round trip). |
| `not_reviewable` | Uncoded state-machine refusal on `pass` — nothing is waiting on your yes. |

What it deliberately does **not** do:

1. **Killing work stays human.** There is no third outcome. Both agent moves are
   reversible with one human click; rejection is not. Saying no to a *proposal*
   means leaving it alone and reporting why.
2. **No self-review, ever.** Both doors compare you to server-derived provenance
   you cannot forge, and unknown either side fails closed.
3. **The `model` is self-asserted.** Cross-model review raises the cost of
   accidental same-model review; it is an honesty rail, not a guarantee.

Reviewing means **reading the work** — `task_get` the task, its result, and the
commit it links. A reviewer that passes everything is a slower `auto`. And having
reviewed a task, hand it on: don't claim it yourself.

```json
{ "id": "TDM-208", "outcome": "changes_requested",
  "reason": "Three tools are missing their refusal codes — cover queue_wait, doc_write and task_amend." }
```

---

<a id="epic_propose"></a>
## `epic_propose`

**Purpose** — Propose an EPIC (the named container a plan hangs off) **and** its
tickets in the same call, so the human approves once instead of task by task.

**Key parameters**

| Param | Notes |
|---|---|
| `title` | **Required.** Short name for the batch. |
| `body` | What the batch achieves; scope and intent. This is where the contracts shared by every ticket go — `task_get` projects it to each worker. |
| `linkedIds` | Notes / roadmap items carrying the detailed context. |
| `tasks` | The plan, created under the new epic in one write. Same item shape as `task_propose` (`title` required, `body`, `linkedIds`, `assignee`, `requiresApproval`); any item `epicId` is overridden with the new epic's id. **Two or more.** |

**Returns** — `{ created: true, epicId, state: "proposed", tasks: [{ id,
ticketId?, title, state }], warnings?, _warnings?, url, tellHuman, _next }`.
Pass `epicId` to later `task_propose` calls to add work to the same batch.

**Refusals / edges**

- **The hard half of the ticket-quality contract runs before any write**, so a
  refused plan leaves nothing behind — no epic, no tickets — and every failure is
  collected so you fix them in one pass. It refuses: a ticket with no real body, a
  ticket whose title just restates the epic's, and **an epic with exactly one
  ticket** (that is a task — use `task_propose`).
- The soft half rides back as non-blocking `warnings`, each naming a ticket
  (`taskId` / `ticketId`) and what it is missing. Amend with `task_amend` while
  they are still `proposed`. Warnings never block approval.
- The epic lands `proposed` and **a human approves it** — epics stay human-only
  on every policy, `peer` included, and the server refuses agent approval of an
  epic. Under the default `epic` policy that one approval **cascades** to every
  task under it; under `peer` the cascade is deliberately **off** and each task
  needs its own `task_review` pass.
- **When to reach for it**: could you write the ticket — name the surface, state
  a checkable done condition, one sitting of work — out of what the human
  actually said? If **no** for any part, `epic_propose` first, before a line of
  code. If **yes** for every part, just do the work; an epic there charges the
  human an approval for a decision they made when they asked.
- After proposing: relay `tellHuman`, then `queue_wait` with the returned
  `epicId`.

```json
{ "title": "MCP docs pass",
  "body": "Repo-side reference docs for the facade. Markdown only, no code changes.",
  "tasks": [
    { "title": "docs/TOOLS.md — per-tool reference for the 18-tool facade",
      "body": "Surface: NEW docs/TOOLS.md. DONE: 18/18 tools, each with params, returns, refusals, example." },
    { "title": "docs/FEATURES.md — what Tandem does, by surface",
      "body": "Surface: NEW docs/FEATURES.md. DONE: board, queue, docs and fleet view each documented." }
  ] }
```

---

<a id="doc_write"></a>
## `doc_write`

**Purpose** — Leave context behind: write a markdown note onto the canvas, as you
go rather than only at the end.

**Key parameters**

| Param | Notes |
|---|---|
| `body` | **Required.** Markdown. |
| `title` | Optional heading, prepended to the body as `## title`. |
| `document` | The notes tab to write into — an existing name or id, **or a NEW name, which creates that tab**. Omit for the canvas's default notes tab. |
| `noteId` | Rewrite this existing note instead of adding another. |

**Returns** — `{ created: true, noteId, documentId, url }` or `{ updated: true,
noteId, documentId?, url }`. **Keep the `noteId`** if you will revise the note.

**Refusals / edges**

- **`noteId` is append-vs-update.** Without it, a second `doc_write` appends a
  **second copy** of the note rather than updating the first. With it, the note
  is rewritten in place.
- A `noteId` that does not exist on this canvas **throws**, and says so plainly:
  your content was NOT saved. (The underlying note PATCH 200s for any id, so the
  gateway confirms the note exists first rather than reporting a silent drop as
  `updated: true`.)
- Product and strategy docs live on the canvas, not in the repo. Task outcomes go
  in `task_complete`'s `result`, not here.

```json
{ "document": "Findings", "title": "Facade audit",
  "body": "FACADE_NAMES is exactly 18; ORCHESTRATION.md still says 17." }
```

---

<a id="doc_read"></a>
## `doc_read`

**Purpose** — Read one document tab back — the read side of `doc_write`.

**Key parameters**

| Param | Notes |
|---|---|
| `document` | **Required.** The tab's NAME (case-insensitive, the one you gave `doc_write`) or its id. Unlike `doc_write`, this never creates one. |
| `noteCursor` | Continue a truncated read: `nextCursor.noteCursor` from the previous page. |
| `offset` | Byte offset into that note: `nextCursor.offset`. Don't compute one by hand. |

**Returns**

```
{ document: { id, name, type? }, noteCount,
  notes: [{ noteId, body, partial?, resumedAtByte?, bytesReturned?,
            bytesRemaining?, createdBy?, updatedAt? }],
  url, _next }
```

…and, when the tab did not fit: `truncated: true`, `budgetBytes`,
`bytesReturned`, `totalBytes`, `bytesRemaining`, `notesRemaining`, and
`nextCursor: { document, noteCursor, offset }`.

**Refusals / edges**

- **Budgeted at ~20KB of markdown per call**, so a huge tab can never blow your
  context in one answer. A tab that fits comes back whole with no paging fields
  at all; otherwise pass `nextCursor`'s two values straight back and repeat until
  the answer has no `truncated` flag.
- A note marked **`partial` is a FRAGMENT**: never `doc_write` it back under its
  `noteId` — that would replace the whole note with the piece you happen to hold.
- A `noteCursor` that is no longer in the tab **throws** (the note was deleted or
  replaced) rather than silently restarting from note 0.
- An unknown `document` comes back naming the tabs that DO exist. `context_get`
  lists them too.
- The read is scoped server-side: reading one tab never drags the rest of the
  canvas along. There is no reason to reach past the facade at the raw API.

```json
{ "document": "Thesis" }
```

---

<a id="board_status"></a>
## `board_status`

**Purpose** — A compact read of the BOARD, not the canvas: where the project
stands and who holds what. The orchestrator's report.

**Key parameters** — `epic` (optional): expand exactly ONE batch into its
per-ticket account — its id, or enough of its title to name it alone ("E15",
"token diet"). Everything else stays compact.

**Returns**

```
{ canvas,
  tasks: { total, byState },
  inFlight: [{ id, ticketId?, title, state, claimedBy, claimedAt?,
               claimAgeMinutes?, staleClaim?, lastProgress? }],
  epics: [ compact rows | one expanded ],
  unassignedTasks, expandedEpic?, unsummarizedEpics?,
  _epicNotExpanded?, _staleClaims?, _unsummarizedEpics?, _returned?, _epics?,
  _next }
```

Each compact epic row carries `{ id, title, state, tasks: { total, byState },
summary (first line, capped at 200 chars), summaryTruncated?, doneOmitted,
returned?, … }`.

**Refusals / edges**

- **`staleClaim: true`** means nothing has been reported on an in-flight task for
  over the ~15-minute claim lease: the holder has probably gone dark and the task
  is reclaimable. Report it as at risk — do NOT complete it on the holder's
  behalf.
- **`summaryNeeded` / `_unsummarizedEpics`** — batches that drained with nobody
  recording what they delivered. `unsummarizedEpics` lists at most 6; the rest are
  the rows flagged `summaryNeeded`.
- **`_returned`** — tickets that came back, inline on each epic's `returned`,
  with the reason and who said so. Reasons are **excerpted** here; `task_get` on
  the ticket has the whole thing.
- **`doneOmitted` / `_epics`** — the per-ticket account is one argument away, not
  something every read pays for. Each row says how many lines it is holding back.
- An `epic` ref matching nothing (or several batches) expands nothing and says so
  in `_epicNotExpanded`; the rest of the board read still answers.
- Cheap by default, and it never dumps canvas contents. For work you can start,
  use `queue_next`; to find one task by name, `task_find`.

```json
{ "epic": "MCP docs pass" }
```

---

## Coverage

18/18 of `FACADE_NAMES` (`apps/mcp-gateway/src/facade.ts`) documented above, in
manifest order: `canvas_connect`, `canvas_create`, `agent_register`,
`context_get`, `queue_next`, `queue_wait`, `task_find`, `task_get`, `task_claim`,
`task_progress`, `task_complete`, `task_propose`, `task_amend`, `task_review`,
`epic_propose`, `doc_write`, `doc_read`, `board_status`.

Not documented, on purpose:

- **`task_approve`** — routed but no longer advertised (`FACADE_LEGACY_NAMES`).
  It only ever did the `pass` half of `task_review`. Write `task_review`.
- **The ~80-tool CRUD surface** in `tools.ts`, advertised only behind
  `TANDEM_FULL_TOOLS=1`.
- **Webhooks.** There is deliberately no webhook tool on any manifest: outbound
  HTTP configured through an agent-facing tool is a prompt-injection exfiltration
  primitive, and canvas content is attacker-influenced. Webhooks are configured by
  a human in the web UI only.
