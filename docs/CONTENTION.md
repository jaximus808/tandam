# The contention model

Read this before you write dispatch code. Tandem's board is shared mutable state
and several agents reach for it at once; this page is the exact set of rules that
keeps two of them from doing the same work. It is short on purpose. The code it
describes is `apps/api/internal/api/claim_fence.go`,
`apps/api/internal/store/claim_fence.go`, `apps/mcp-gateway/src/tapout.ts` and
`apps/web/src/lib/lease.ts` — each carries the full reasoning in comments.

One sentence version: **a task is worked by whoever holds its current lease, the
lease has a generation, and every write must present that generation.**

---

## 1. The claim lifecycle

```
proposed ──human approves──► approved ──claim──► executing ──complete──► done | failed
                                 ▲                   │
                                 └──release/requeue───┤
                                                      │ heartbeat extends the lease
                                                      │ lease lapses → next claimer takes over
                                                      └──► executing (generation + 1)
```

- **proposed → approved.** Human gate. An agent's `task_propose` lands at
  `proposed`; nothing is claimable until a person (or an approved epic's policy)
  moves it. This transition is deliberately *not* fenced — a proposed task has no
  holder.
- **approved → executing (the claim).** One atomic conditional `UPDATE`
  (`ClaimAction`), so of two racing claimers exactly one gets a row back. The
  winner's claim stamps `claimed_by` + `claimed_at` and **mints a generation**: a
  per-task counter, `+1` on every claim, never reset. It is stored server-side on
  the task payload under the reserved `claim` key as
  `{generation, holder, at}` (`store.ClaimRecord`) and returned to the claimant as
  `claim: { generation, holder, claimedAt }`. **Keep that generation. Present it as
  `claimGeneration` on every later write.**
- **The lease.** `store.DefaultClaimTTL` = 15 minutes (`CLAIM_TTL_MINUTES`
  overrides; `0` disables expiry). Every `task_progress` heartbeat pushes
  `claimed_at` forward — holder-only, in SQL. Work longer than the TTL without
  reporting and the task becomes reclaimable out from under you.
- **Expiry is lazy.** Nothing sweeps. A lapsed lease looks live in the database
  until a rival asks for the task, at which point an atomic takeover (predicated on
  `claimed_at < cutoff`) rebinds it and mints generation `+1`. That takeover is the
  only place `task.claim_expired` is emitted. On the board, `lease.ts` derives what
  the database won't say out loud: **live** (inside the first half of the lease),
  **slipping** (past halfway, nothing heard), **stale** (lapsed — reclaimable now).
- **Re-claiming your own task is a new lease.** A named claimant retrying its own
  claim is idempotent while the lease is live (same generation back). If the lease
  had already lapsed, the retry is a *self-takeover*: fresh `claimed_at`, **new
  generation**, and your own in-flight writes from the old lease are now dead too.
- **executing → done | failed.** Fenced. Complete under the identity you claimed
  with, presenting the generation you were given.

## 2. If you lose, you tap out

Losing is normal and it is not an error. What is an error is continuing.

Every losing path through the gateway returns a machine-readable block next to the
English (`apps/mcp-gateway/src/tapout.ts`):

```json
{ "tapOut": true, "reason": "already_claimed", "next": "queue_next",
  "taskId": "…", "holder": "worker-b", "attempts": 1 }
```

**`tapOut: true` is the one field to branch on.** It means: stop touching this
task, do not retry, call `next` (always `queue_next`) and take different work.
`reason` is a closed set — adding one is an API change:

| reason | what happened |
|---|---|
| `already_claimed` | you lost the atomic claim race; someone else holds it |
| `already_lost` | you already lost *this* task and asked again. Answered locally — the gateway did not re-race it |
| `not_your_claim` | you tried to report on / finish / move a task another agent holds |
| `already_finished` | terminal state; there is no work left |
| `fenced` | the API refused your write because your claim generation is stale |

Not a tap-out: a task that is merely unclaimed. Nobody beat you there — claim it
and work.

The gateway also **remembers** losses, because `queue_next → claim → lose →
queue_next` is a stable token-burning loop that looks like progress on the board. A
loss is recorded per canvas + claimant identity, expires after 15 minutes (past the
lease it is no longer proof of anything), and makes the second refusal firmer than
the first. `queue_next` annotates a remembered task `lostByYou: true` and **attaches
no `handoff`** — you can still see the work exists, you just cannot dispatch it. It
self-heals: the moment the server lists that task as ready with no holder, the
winner's claim is over, so the loss is forgotten and the handoff comes back.

## 3. Guarantees vs. convention

**The server guarantees:**

- At most one winner per claim, and per takeover. Both are single atomic
  conditional `UPDATE`s evaluated under the row lock — not read-then-write.
- A write from a superseded lease is refused. `fenceTaskWrite` is one shared
  decision called by every task write path — complete, fail, progress, payload
  PATCH, `/move`, `/release`, `/requeue`, `DELETE` — answering one 409 shape:
  `{ error, fenced: true, holder, claimedBy, reason, claimGeneration, message }`.
  The audit table at the top of `claim_fence.go` lists every path and what fences
  it; keep it true when you add a surface.
- The claim record cannot be forged. It is server-owned: a payload PATCH that sends
  `claim` has it stripped and replaced from the stored row.
- Refusals are counted (`fenced_writes`). A rising count means workers are
  outliving their leases.

**Convention — the server will not catch you:**

- **The fence is opt-in on the caller's assertion.** A canvas JWT looks identical
  for a browser and an agent, so the fence engages only when a caller presents a
  claim identity (an agent name in the body, or the `X-Tandem-Agent` header the MCP
  gateway sets). Present nothing and you are unfenced. The human board keeps that
  escape hatch on purpose — releasing a dead worker's task is the whole point of
  those controls.
- **Generation checking needs both sides.** A caller that presents no generation
  gets the identity check only; a task with no recorded generation fences nobody.
  Degradation is deliberate — a spurious refusal would strand real work.
- **Register a distinct name.** A holder of `""` or the generic `agent` is not an
  exclusive identity: it blocks nobody, and the store refuses to extend its lease,
  so such a worker can be filing progress reports and be reclaimable at the same
  time (the board says so — `unextendable`).
- **The loss ledger is per process.** A subagent with its own `tandem-mcp` process
  has its own ledger; a sidecar restart or second replica starts empty. Nothing is
  persisted to the API. It breaks one session re-racing one task within one run —
  that is all it claims to do.
- **`lease.ts` mirrors the TTL as a constant.** Override `CLAIM_TTL_MINUTES` in a
  deployment and the board reads early or late. The ordering of live/slipping/stale
  stays right.
- **Out-of-band work is invisible.** Nothing about a claim stops an agent doing the
  work without claiming. See below — this is the failure mode that actually bit us.

## 4. The out-of-band-work trap

The 2026-07-29 incident (TDM-83), in five lines:

1. Work was dispatched to subagents **directly**, not off the queue.
2. Tickets for that work were **back-filled** onto the board afterwards, as
   `proposed`.
3. A human approved them — reasonably; they looked like ready work.
4. An approval-triggered listener fired and dispatched **fresh** workers at them.
5. The same features were implemented twice. Every claim was atomic and every
   fence held. Contention control never had a chance, because the first
   implementation never took a claim.

The rule this leaves you with: **if the work is happening, the board must say so
before it starts.** Do not dispatch first and ticket later. If you must record work
already in flight, record it in a state that is not claimable.

`TDM-96` is the ticketed fix: let an agent propose a task **as executing** — one
call that creates the row already claimed by the worker doing it, so back-filled
work can never present itself to an approval listener as available. Until that
lands, this is convention you enforce in your orchestrator.

Two smaller rules of the same shape, from the same night:

- **An orchestrator dispatches; it never claims.** A task claimed by an agent that
  will not personally touch it reads on the board as in-flight work nobody is
  doing, and it is a lease that will lapse and get taken over mid-flight.
- **Never hand a subagent your `session` handle.** The handle carries your claim
  identity, so a worker using it claims *as you* and the fence stops distinguishing
  you. The canvas **code** is what travels; the worker connects and registers
  itself.

## 5. Proving it

The 2-agent contention harness — two workers racing one queue, asserting exactly
one winner and that the loser taps out — lives in
**[`docs/contention-harness.md`](contention-harness.md)**, with the scripts it
describes. Run it before you trust a change to any of the files listed at the top
of this page. Details, invocation and expected output are that document's job, not
this one's.
