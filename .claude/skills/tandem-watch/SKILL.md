---
name: tandem-watch
description: Wait for tasks to be approved on a Tandem canvas and orchestrate them the moment they appear — connect as a planner, wait on queue_wait (one call that returns when work is approved), then dispatch one subagent per ready task with the handoff block it returns. You dispatch; the workers claim. Use when the user says to watch/wait for approvals, sit on the queue, or work tasks as they get approved.
---

# Tandem watch mode

You are going to sit on a Tandem canvas and wait. When the human approves tasks
on the board, you pick them up and run them. You do not stop after one batch and
you do not go looking for other work in the meantime.

This is the in-session twin of the webhook loop in `docs/ORCHESTRATION.md`. Same
job, different trigger: there a webhook relaunches Claude, here a live session
stays awake on `queue_wait` (ORCHESTRATION.md §0). Use this one when the user is
already in a session with you and wants you to keep working as they approve.

**The one rule this whole skill hangs on:** *an agent claims only what it will
personally do. An orchestrator dispatches; it never claims, never completes on a
worker's behalf, and never transports its `session` handle.* In this skill **you
are the orchestrator** — you read the queue and hand work out. Every `task_claim`
and every `task_complete` in the loop below happens inside a subagent, not here.

## 0. Which canvas

Default: **`TEGLQFXR`** (the Tandem planning canvas — the roadmap for this repo).

If the user passed a canvas code as an argument, or named one in the request, use
that instead. Codes are 8 characters, e.g. `AB3XK9QZ`. Never guess a code; if you
have no default that applies to the current repo and none was given, ask.

## 1. Connect and register as the planner — one call

```
canvas_connect  { code: "<CODE>", role: "planner", name: "watcher", model: "<your model id>" }
```

`role` on `canvas_connect` connects **and** registers you in the same call. The
result carries:

- `url` — surface it to the user immediately, before you start waiting, so they
  can approve on the board you are watching;
- `agentId` — your planner id. Every subagent parents under it, and `queue_next`
  bakes it into the handoff blocks for you;
- `agent` — `{ registered, agentId, name, role, parentAgentId? }`, plus a
  `problem` string if anything degraded (a bad `parentAgentId` still connects and
  still registers, just unparented — it is reported as data, never a failure);
- `session` — already carrying your identity. Pass it as `session` on every later
  call. **Never hand it to a subagent.** It is your identity: a worker holding it
  claims as you, and the fleet tree the board draws collapses to one node.

If `agent.registered` is false, read `agent.problem` and re-register with
`agent_register` (it is on the facade too). Do not stop over it — an unregistered
planner still works, its workers just show up unparented, and `queue_next` will
say so.

The role enum is `planner | executor`. There is no `orchestrator` role — you are
the `planner`, your subagents are `executor`s.

Tell the user, in one line, what you are about to do: which canvas, that you are
waiting on the queue, and that they can interrupt at any time.

## 2. The wait loop

```
queue_wait → dispatch what comes back ready → queue_wait → …
```

**Wait — one call, no interval, no sleep to arrange:**

```
queue_wait  { timeoutSeconds: 60, limit: 10 }
```

`queue_wait` parks **on the server** and returns the instant a task passes the
approval gate. Do not end your turn and do not hand-roll a poll interval: there
is nothing to schedule, because the waiting is not happening here. Branch on
`status`:

| `status` | Means | Do |
|---|---|---|
| `ready` | Approved tasks, each with its `handoff` block | §3 — dispatch |
| `timeout` | Nothing approved inside the window. **Not an error, not a failure** — it is the normal state of this loop | Call `queue_wait` again, immediately |
| `busy` | The canvas is at its waiter cap; the call read the queue for you instead | Dispatch anything it returned, then call again |
| `unsupported` | This API predates the wait endpoint; it read the queue for you instead | Dispatch anything it returned. If it is empty, say the server cannot wait and ask the user to ping you when they approve — do not fake a wait with a sleep loop |

An empty queue is not a reason to invent work: tasks the fleet proposed sit at
`proposed` until a human approves them on the board.

**Stop when:**

- The user interrupts or says stop. Immediate, no argument.
- **About 30 minutes of unbroken `timeout` answers** (roughly 30 calls at 60s).
  Stop and summarize rather than waiting forever. Reset that count the moment
  anything comes back `ready` — the human is at the board, so more is probably
  coming.

Every few `timeout` answers, say so in a few words, so the user can see you are
still alive and still waiting.

## 3. When tasks appear — dispatch, do not claim

Every task `queue_next` returns carries its own **`handoff`** block. That block
is the subagent's brief, already written for you:

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
placeholder spelled out in step 1 — when you never registered; if you see that,
re-register (§1) and call `queue_next` again so your workers nest under you.
`queue_next` also returns a `_dispatch` line saying the same thing in prose.

So, for each ready task:

1. **Spawn one subagent.** One per task. Not one per file, not one for the whole
   batch. Paste that task's `handoff` into the spawn **verbatim** — the `steps`
   are the instructions it follows, and they already cover connect+register,
   claim, brief, progress and completion. Add repo-local context on top if you
   have it (which package, which build command); do not rewrite the steps.
2. **What travels is the canvas CODE**, which is in the handoff. Your `session`
   handle does not travel, ever.
3. **You claim nothing and complete nothing.** Not before dispatch, not after,
   not "just to tidy up" when a worker comes back quiet. The worker claims its
   own task, and only the identity that claimed may complete it.
4. Independent tasks go out in parallel — send the spawns in one message. Tasks
   that obviously touch the same files go sequentially.
5. **Reconcile, read-only.** When the batch comes back, call **`board_status`**
   and read what actually landed: which tickets are `done`, which `failed`, which
   are still `executing`. That is for your report to the user — not a to-do list
   for you. A task still `executing` with no worker behind it is a fact you
   report (and its claim expires on its own TTL); it is not yours to complete.

Then call `queue_wait` again straight away. It returns immediately when work is
already approved — approvals often land while you work — and parks when there is
none, so the same call covers both without a separate `queue_next` read.

**What this buys, and what it does not.** Claims at the edge give you a truthful
`claimedBy`, failure isolation (one worker dying is one task `failed`, not a
batch), and an orchestrator whose context stays free for coordinating instead of
working. It does **not** buy fleet throughput: human approval is still the
serialization point, and the queue only moves as fast as the human approves it.
Do not sell the user on speed — sell them on knowing who holds what.

### Working alone

If this session has no subagent capability, the contract does not change — it
just means you are the worker. Pick **one** task, `task_get` it, `task_claim` it,
do it, `task_complete` it, then take the next. What you must never do is claim a
task you are about to hand to somebody else.

## Discipline

These are not suggestions. A coordination plane is only as good as the agents
that respect it. Some bind **whoever does the work** — in dispatch mode that is
the subagent, and the handoff already tells it so — and some bind **you, the
orchestrator**. Both sets hold at once; when you work alone you are both.

- **Never work an unclaimed task.** `task_claim` first, every time. Two sessions
  working the same ticket is the one failure this whole system exists to
  prevent.
- **Claim only what you will personally do.** Dispatching is not claiming. A task
  claimed by an orchestrator that never touches it reads on the board as
  in-flight work nobody is doing, and it blocks the queue for as long as the
  claim holds.
- **Never pass on your `session` handle.** Hand over the 8-character canvas
  **code** instead — that is what the handoff carries. A worker running on your
  handle claims as you, and the board can no longer tell the fleet apart.
- **Never work a `proposed` task.** Proposed means a human has not said yes yet.
  Approving it yourself, or working it "since it is obviously fine", defeats the
  gate. If something needs doing that is not approved, `task_propose` it and
  keep waiting.
- **Complete or fail everything you claim.** A task abandoned in `executing`
  blocks the queue until its TTL expires and reads to the human as an agent that
  went dark. There is no third option and no silent release.
- **Complete under the identity you claimed with.** Same `agentName` /
  registered identity, or the board attributes the work to a stranger. The
  corollary binds you as the orchestrator: **never complete on a worker's
  behalf.** If a subagent went dark, say so in your report and leave the task —
  a completion you write is a lie about who did the work.
- **Do not invent work.** An empty queue means wait, not "find something
  useful". If you think something should be on the board, propose it.
- **Put the ticket id in commit messages** (`TDM-61: add rate limiter`) so the
  commits trace back to the task.

## Stopping

When you stop — interrupted, or out of patience with the silence — give the user
a short summary:

- how long you watched,
- every task you dispatched, with its ticket id, which worker took it, and
  whether it landed `done` or `failed` — one line each, from `board_status`, not
  from memory,
- anything still sitting in `executing`, and who holds it,
- what is sitting in `proposed` waiting on them, if `board_status` shows any.

If you were interrupted mid-batch, say exactly what state each dispatched task is
in and who claimed it. You hold no claims yourself — that is the point.
