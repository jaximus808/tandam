# TDM-34 — E2.3 Acceptance run: real job in ≤5 tool calls

Acceptance artifact for the intent facade (`src/facade.ts`, TDM-32 / E2.1).
Run date: 2026-07-29. Gateway `@jaximus/tandem-mcp` 2.3.0, built from this branch
(`dist/index.js`), driven as a child process over stdio MCP JSON-RPC against a
live Tandem API at `http://localhost:7891`.

**Verdict: PASS, with one caveat that matters.** The lifecycle completes in 5
facade-only calls, and in 4 if you accept a title-only brief. But the 5-call
budget is met only because one of the two "orient yourself" calls has to be
dropped, and the facade's own `_next` hint points at a 6-call path.

**Scratch canvas: `A25GPRM5`** ("acceptance-tdm34-scratch",
id `c135f01e-b923-4360-96d6-3d943be95a03`) — throwaway, safe to delete.
Three tasks on it (TDM-1/2/3), all left in `done`. `TEGLQFXR` was not touched.

---

## 1. Setup and method

| | |
|---|---|
| Build | `PNPM_CONFIG_STRICT_DEP_BUILDS=false pnpm build` → clean, 8ms |
| Env for measured runs | `API_URL=http://localhost:7891`, `TANDEM_FULL_TOOLS` **unset**, `TANDEM_CANVAS_CODE` **unset** |
| Env for fixture only | same + `TANDEM_FULL_TOOLS=1` |
| Driver | throwaway Node script in scratch space; `initialize` → `notifications/initialized` → `tools/list` → N × `tools/call` |

`tools/list` and `initialize` are protocol calls, not tool calls, and are not
counted. Neither is anything in the fixture stage.

**Manifest verified.** With the default env, `tools/list` returns **exactly 10
tools**, in facade order:

```
canvas_connect, context_get, queue_next, task_get, task_claim,
task_progress, task_complete, task_propose, doc_write, board_status
```

Combined description text: **5,743 chars (~1.4k tokens)**. With
`TANDEM_FULL_TOOLS=1` the manifest is 90 tools. stderr confirms the choice on
boot: `[tandem] tool manifest: intent facade (10 tools)`.

## 2. Fixture (uncounted — every call listed)

The measured runs needed approved work to exist. Approval is not reachable from
the facade: `task_propose` lands `proposed`, and nothing in the 10 tools moves it
to `approved` — by design, that's the human gate. So the fixture used the CRUD
surface.

| # | Call | Env | Result |
|---|---|---|---|
| F1 | `canvas_create {name:"acceptance-tdm34-scratch"}` | full | code `A25GPRM5`, 371ms |
| F2 | `canvas_task_add` "Write the release notes for v2.4" | full | TDM-1, `proposed`, 598ms |
| F3 | `canvas_task_list` | full | confirms `proposed` |
| F4 | `canvas_connect A25GPRM5` | full | fresh process |
| F5 | `canvas_action_approve {id:TDM-1}` | full | → `approved`, `approvedBy: "human"` |
| F6 | `canvas_task_list {state:"approved"}` | full | confirms ready |
| F7 | `canvas_task_add` "Write the upgrade guide for v2.4" | **default** | TDM-2, `proposed` |
| F8 | `canvas_action_approve {id:TDM-2}` | **default** | → `approved` |
| F9 | `canvas_task_add` "Ship the v2.4 deprecation notice" (hidden brief) | **default** | TDM-3, `proposed` |
| F10 | `canvas_action_approve {id:TDM-3}` | **default** | → `approved` |

Note F7–F10: those ran with `TANDEM_FULL_TOOLS` **unset** and worked anyway.
`server.ts` routes by tool name, not by manifest, so unadvertised CRUD tools stay
callable. That's intentional and documented ("Gating the manifest is a
context-window decision, not an access control") — recorded here because it means
"facade only" is a property of how a run is *written*, not something the gateway
enforces. The measured runs below use facade names exclusively.

## 3. Measured runs

### Run A — 5 calls, opening with `context_get` (passes, but hollow)

`canvas_connect` → `context_get` → `queue_next` → `task_claim` → `task_complete`

| # | Call | ms | Outcome |
|---|---|---|---|
| 1 | `canvas_connect {code}` | 275 | `connected:true`, `session` handle, `url` |
| 2 | `context_get {session}` | **707** | `source:"composed"`, counts, docs, `queue.ready[TDM-1]` |
| 3 | `queue_next {session}` | 156 | 1 ready task, compact rows |
| 4 | `task_claim {id, session}` | 292 | `claimed:true` → `executing`, `claimedBy: session-ku49ix` |
| 5 | `task_complete {id, result, session}` | 739 | → **`done`**, 1,047-char result stored |

Passes on the letter of the AC. **But this run never read the task body.** Both
`queue_next` and `context_get.queue.ready` return compact rows —
`{id, ticketId, title, state}` — with no `body`. The only reason the deliverable
was correct is that I wrote the fixture and already knew the brief. A real
session would have been working from a title. See F1.

### Run C — 5 calls, honest (the run that actually proves the AC)

Re-run against TDM-3, whose body carried constraints the title cannot imply
(a marker string, "exactly three sentences", "must end with `END-OF-NOTICE`",
"do not promise a removal date").

`canvas_connect` → `queue_next` → `task_get` → `task_claim` → `task_complete`

| # | Call | ms | Outcome |
|---|---|---|---|
| 1 | `canvas_connect {code}` | 190 | session handle |
| 2 | `queue_next {session}` | 156 | TDM-3 ready |
| 3 | `task_get {id, session}` | 143 | `{action, linked: []}` — **full body retrieved** |
| 4 | `task_claim {id, session}` | 327 | `claimed:true` → `executing` |
| 5 | `task_complete {id, result, session}` | 710 | → **`done`**, all four hidden constraints satisfied |

This is the real pass: 5 facade calls, no CRUD, no manual step, and the session
genuinely learned the job from the canvas. Call 5 ran in a **different OS
process** carrying only the `session` handle, and the task still completed under
the same claimant (`session-9id532`) that claimed it in call 4.

### Run B — 4 calls (passes only for title-sufficient work)

`canvas_connect` → `context_get` → `task_claim` → `task_complete` = **4 calls**,
TDM-2 → `done`. `context_get.queue.ready[0].id` feeds `task_claim` directly, so
`queue_next` is genuinely redundant when you already called `context_get`.

Caveat: same hole as Run A — no body anywhere in the path. 4 calls is real, but
only for a task whose title is the whole brief. `canvas_connect` → `queue_next` →
`task_claim` → `task_complete` is also 4 and strictly cheaper (156ms vs 711ms for
step 2).

### Final state (verified, full tools)

```
TDM-3 done | Ship the v2.4 deprecation notice
TDM-2 done | Write the upgrade guide for v2.4
TDM-1 done | Write the release notes for v2.4
```

`board_status`: `{total: 3, byState: {done: 3}}`, `inFlight: []`.

---

## 4. Friction log

### F1 — The queue never carries the brief, so `task_get` is mandatory and the budget has room for exactly one orienting call

The highest-value finding. `queue_next` and `context_get.queue.ready` both return
`{id, ticketId, title, state, epicId}` and no `body`. To actually know what to do,
a session must spend a call on `task_get`. That makes the honest floor:

```
connect → queue_next → task_get → task_claim → task_complete   = 5  ✅
connect → context_get → queue_next → task_get → claim → complete = 6  ❌
```

`context_get` is a luxury the budget cannot afford. Worse, **the facade tells you
to blow the budget**: `context_get`'s own `_next` reads

> "There is approved work waiting. Call queue_next, then task_get + task_claim on the one you'll do."

which is literally the 6-call path, and it recommends `queue_next` even though
`context_get` just returned the identical ready list.

*Suggested fixes (not implemented):*
1. **Best: have `task_claim` return what `task_get` returns.** It already returns
   the full `action` including `payload.body`; it just lacks `linked`/`epic`. If
   `task_claim` returned `{claimed, action, linked, epic}`, then
   `connect → queue_next → task_claim → task_complete` = **4 calls with the full
   brief**, and `task_get` becomes a pre-claim peek rather than a required hop.
   That also fixes an ordering smell: today the recommended sequence reads the
   task *before* claiming it, so the read is wasted whenever the claim is lost.
2. Include a truncated `body` (~400 chars) in `queue_next` rows, so simple tasks
   need no `task_get` at all.
3. Rewrite `context_get`'s `_next` to stop routing through `queue_next`:
   "There is approved work waiting (see `queue.ready`). task_claim one of those
   ids — task_get first if you need the full brief."

### F2 — `context_get` is the slowest call in the run and returns the least

707ms and 711ms across two runs, versus 156ms for `queue_next`. It fans out to
four HTTP calls, and `GET /api/canvas/state` alone accounted for ~700ms of it.
On the scratch canvas the return was `counts` of nearly all zeros, `names: {}`,
`documents: []` — 700ms to learn nothing, wrapped around a queue block that
`queue_next` serves in a fifth of the time.

The composed fallback **did fire correctly**: response was `"source": "composed"`,
and stderr shows `GET /api/canvas/context -> 200 (2ms)`. The live API has no such
route and answers with the SPA's `index.html` at HTTP 200 — exactly the trap
`getIfAvailable`'s content-type check was written for, and it caught it. Good
defensive call; it works.

But the probe is re-issued on **every** `context_get`, forever, against any API
without the endpoint. Cheap locally (2–3ms), less cheap over the network, and it
puts a misleading `-> 200` line in the log for a route that doesn't exist.

*Suggested fixes:* memoize the probe result on the Gateway instance (probe once
per session, then remember "absent"); and consider making the `/api/canvas/state`
summary the optional part of the briefing rather than the blocking one.

### F3 — Stale-state claim failures leak raw HTTP plumbing

`task_claim` on an already-`done` task returned:

```
Error: PATCH /api/canvas/actions/53ea765c-63d7-42db-8166-9e28116a340c failed:
400 {"error":"illegal action state transition: cannot claim task in state \"done\""}
```

The tool description promises a structured losing path — "`{ claimed: false,
claimedBy }` means another session got there first ... go back to queue_next" —
and `patchWithConflict` delivers exactly that for HTTP 409. But a **400** falls
through to the generic `assertOk` string, exposing the verb, the full path, and a
nested JSON blob. This is not an exotic case: it is what a session gets whenever
its queue snapshot is a few seconds stale, which is the normal condition in the
multi-session scenario the facade exists to serve. The agent is left string-
matching an error to decide whether to retry.

*Suggested fix:* in the same place 409 is special-cased, map a 400 whose body
matches `illegal action state transition` to
`{claimed: false, reason: "state", state: "done", message: "TDM-1 is already done — call queue_next for current work."}`.

### F4 — `task_progress` writes to completed tasks owned by other sessions

Probe: `task_progress` on TDM-2 — state `done`, claimed by a *different* session —
returned `{recorded: true, entries: 1}` and appended to the payload. The guard in
`facade.ts` is `if (action.state === "executing" && holder && ...)`, so a terminal
task has no guard at all, and any session can append narration to someone else's
finished work. Not a blocker; it quietly corrupts the audit trail that
`task_progress`'s whole "progress travels WITH the task" design exists to protect.

*Suggested fix:* reject terminal states outright —
`{recorded: false, state: "done", message: "TDM-2 is already done; progress can only be reported on a task you are executing."}`.

### F5 — `board_status.unassignedTasks` counts finished work

Reported `unassignedTasks: 3` when all three tasks were `done`. The field means
"tasks with no `epicId`", but next to `inFlight: []` and `byState: {done: 3}` it
reads as "3 tasks available and unclaimed" — the opposite of the truth.

*Suggested fix:* rename to `tasksWithoutEpic`, or restrict the count to
non-terminal states.

### F6 — The session handle works exactly as advertised (and costs real tokens)

Worth recording as a strength because it is the load-bearing, easy-to-get-wrong
part, and it held up under direct test:

- A fresh gateway process with **no `canvas_connect` at all**, passing only the
  handle, successfully ran `queue_next`, `task_progress` and `board_status`.
- Run C's `task_complete` executed in a different process from its `task_claim`
  and still recorded `claimedBy: session-9id532` — the minted claimant identity
  travels inside the handle, so cross-process completion preserves ownership.
- The not-connected error is genuinely actionable: *"Not connected to a canvas.
  If you already connected this session, pass the `session` handle ... Otherwise
  call `canvas_connect` with a canvas code first."* Both branches, no guessing.

The tax: the handle is a ~380-char opaque base64 blob echoed on every call — about
1.9KB of pure ceremony across a 5-call run — and `_session_note` re-explains it in
full on every `connect`/`create`. Inherent to the stateless-handle design (which
deliberately rejected server-side session memory), so this is a noted cost, not a
requested change.

### F7 — Descriptions sequence correctly, except for the opening move

Working only from `tools/list`, the intended order was unambiguous:
`canvas_connect` says "STEP 1 of every session", `queue_next` says "THE ENTRY
POINT FOR WORK ... Pick ONE, then task_get it for the full brief and task_claim
it before you touch anything", `task_complete` says "the last step of every task
you claim". That is good instructional writing and it is why Run C sequenced
right on the first attempt.

The gap is the first move after connect. `context_get` claims it ("Call it once
after canvas_connect to orient yourself") and so does `queue_next` ("Start here
rather than reading the canvas"). `context_get` does hedge — "If you already know
the canvas and just want work, skip it" — but a session that has *never* seen the
canvas reads that as "so I should call context_get", and that is the call that
turns a 5-call job into a 6-call one (F1).

*Suggested fix:* make `context_get`'s "skip it" clause stronger and cost-aware:
"If you were given a task to do, skip this and call queue_next — context_get is
for orienting on an unfamiliar canvas, and it is the more expensive call."

### F8 — Document-shaped deliverables don't fit in 5 calls

TDM-1/2/3 all produced written artifacts, and I put each deliverable into
`task_complete`'s `result` string, because a `doc_write` would have been a 6th
call. But `doc_write`'s own description says it is "the main write path; use it
as you go, not only at the end", and `task_complete` says `result` should be "a
short human-readable account of what was done and where". Followed literally,
those two together require 6 calls for any task whose output is prose.

For reference, `doc_write` with a new `document` name worked and was pleasant —
one call created the tab and the note (`{created:true, noteId, documentId, url}`)
— but cost 1,645ms across three round trips (`GET documents`, `POST documents`,
`POST notes`).

*Suggested fix:* nothing in the tool; either accept that a document deliverable
is a 6-call job and say so in the AC, or let `task_complete` take an optional
`document`/`note` field so the artifact and the completion land together.

---

## 5. Nothing was broken

No blocker was hit. Every facade tool called did what its description said, the
composed-context fallback handled the missing `/api/canvas/context` route
correctly, and the atomic claim, cross-process session rebind, and terminal state
transitions all behaved. F3 and F4 are correctness rough edges, not failures.

Per the task's constraints, no gateway source was modified — this run measures
what is committed on the branch.

## 6. Cleanup for a human

- Scratch canvas **`A25GPRM5`** (`acceptance-tdm34-scratch`,
  id `c135f01e-b923-4360-96d6-3d943be95a03`) — delete when convenient.
  It holds TDM-1/2/3 (all `done`), one progress entry on TDM-2 from the F4 probe,
  and one note in an "Acceptance log" document tab.
- It lives in the shared Supabase the local API points at, so it will also be
  visible from the hosted app until deleted.
- Nothing else was created; `TEGLQFXR` was not touched.
