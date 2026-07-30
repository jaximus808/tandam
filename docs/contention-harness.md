# The contention harness — the tap-out proof

**TDM-102 / E14.** Point two agents at one task and watch one of them let go.

In a live multi-subagent run the contention story failed in the worst possible
way: two workers reached for the same task and *neither stopped*. They looped —
claim, lose, re-read the queue, claim again — burning tokens and, on the board,
looking busy. The contracts that fix that shipped as code with unit tests behind
them (the gateway's tap-out block, TDM-99; the API's claim fence, TDM-98). What
did not exist was a way to **run** the thing: two agents, one task, one of them
provably tapping out, against a real server, repeatably.

That is this harness. It is the acceptance test for the rest of E14 — re-run it
after any change to the claim protocol.

```
cd apps/mcp-gateway && pnpm qa:contention
```

| flag | meaning |
| --- | --- |
| `--api=<url>` | API base URL. Defaults to `$API_URL`, then `http://localhost:7891`. |
| `--require-fence` | Turn capability SKIPs into FAILures. Use once the API build under test has the full TDM-98 fence. |
| `--keep` | Leave the scratch tasks behind for inspection instead of deleting them. |

Exit code 0 = the contention contract holds. Non-zero = it regressed, and the
failing check names what broke.

## What an "agent" is here

Two `Gateway` instances in one Node process, each with its own canvas session and
its own registered identity, driven through the same entry point a real MCP client
goes through (`handleTool` / `handleFacadeTool`). So the tool layer, the loss
ledger, the conflict parsing and every HTTP call are the production paths. The
only thing scripted is the decision-making a model would otherwise do — which is
exactly the part that has to be deterministic for this to be re-runnable in CI.
**No LLM in the loop.**

The harness creates its **own scratch canvas** and works only in there. It never
touches a canvas you name, and never the planning canvas.

- `apps/mcp-gateway/scripts/contention-harness.ts` — the harness.
- `apps/api/internal/api/contention_harness_test.go` — scenario 2's TTL half (see
  [the split](#the-split-why-scenario-2-is-half-go)).

## The scenarios

**Scenario 1 — the race (phases 1–5).** One approved task, two simultaneous
claims.

1. **the race** — exactly one `claimed:true`; the loser gets the tap-out block
   (`tapOut:true`, `reason:"already_claimed"`, `next:"queue_next"`, `attempts:1`)
   naming the winner as holder, and `claim_conflicts` rises on `/api/metrics`.
2. **the loser writes anyway** — `task_progress`, `task_complete` and a state
   move are all refused with a tap-out, and the task is **byte-identical**
   afterwards: same state, same holder, no `progress[]` entry, no `result`. Zero
   mutations, proven by a neutral read before and after rather than by trusting
   the refusal.
3. **the anti-loop** — the incident, reproduced on purpose: a bad loser that
   *ignores* its tap-out and re-claims ten times. Every answer is
   `reason:"already_lost"` with a rising `attempts`, and the gateway makes
   **zero API calls** doing it (the loss ledger answers locally). Then the
   contract-respecting worker is measured: it stops after **1** attempt.
4. **the winner finishes** — heartbeats (lease extended), completes; the server
   records exactly one completion, by the winner, with the winner's summary.
5. **the aftermath** — a *third* fresh worker writing to the finished task taps
   out too, so the refusal is a property of the task's state and not of one
   session's memory.

**Scenario 2 — kill the winner (phases 6–7).** The winner claims and goes silent.

6. **lease recovery** — the task comes back to `approved` with no holder;
   `queue_next` **forgets** the loser's remembered loss the moment the server says
   the task is ready and unheld (otherwise the loser would refuse work that is
   genuinely free — a deadlock dressed up as good behaviour), and hands it back
   *with* a `handoff`. The loser reclaims under a **new generation**. The dead
   winner's late completion is refused and the task stays `executing` under the
   new holder.
7. **the fence** — a write presenting a **stale** claim generation is refused
   `409 {fenced:true, reason:"stale_claim_generation", claimGeneration:<live>}`
   and mutates nothing, while the live holder's write still lands. This is the
   case holder identity cannot see, and it is asserted against the API directly
   because the gateway has no field to send a generation in — see
   [gaps](#known-gaps).

**Phase 8** is not an assertion about the protocol; it measures the *client*: it
reads the bodies of every write this run made and asks whether any of them carried
a fencing token.

## The split: why scenario 2 is half Go

"The winner goes silent and the task comes back" turns on the claim **lease**, and
the lease window is fixed when the server boots (`CLAIM_TTL_MINUTES`, default 15
minutes — `store.DefaultClaimTTL`). It is not injectable at runtime, this harness
does not start or stop servers, and a 15-minute sleep is not something you put in
CI. So the two causes of a lease ending are proven in two places:

| cause the lease ended | where it is proven |
| --- | --- |
| a human released the task from the board | the live harness, phase 6 |
| the lease **expired** (TTL, lazy, no sweeper) | `TestContentionHarnessScenario2LeaseExpiry` in `apps/api/internal/api` |

The recovery is identical either way — the task goes back to `approved` with no
holder — so the live path uses the fast cause and the Go test (against the store
fake, which can backdate a claim) covers the slow one, walking the same two-agent
narrative through the same endpoints the gateway uses. TDM-98's own tests next
door cover the fence's full lifecycle in more shapes; the harness test is the
narrative one, and the one the docs point at.

## Expected output

A green run against a **fully deployed** API is all `PASS`, `failures: 0`,
`skipped: 0`, `gaps: 0`. Below is a real run against the local docker server on
`:7891`, which shows the two things that are *not* failures — a capability SKIP
and a measured GAP — so you can tell them apart from a regression.

```text
Tandem contention harness (TDM-102) — two agents, one task
api: http://localhost:7891

── phase 0 · server capabilities ───────────────────────────────────────
  PASS  server reachable and exposing /api/metrics counters
  note  counters have NO fenced_writes — this build predates the TDM-98 fence metric
scratch canvas: http://localhost:7891/c/LYNZHET8  (code LYNZHET8)
  PASS  two sessions are DIFFERENT claimants

── phase 1 · simultaneous claim on ONE approved task ───────────────────
  PASS  exactly ONE claimed:true
  PASS  exactly ONE loser
  winner: harness-worker-a   loser: harness-worker-b
  PASS  loser: tapOut:true
  PASS  loser: next = "queue_next"
  PASS  loser: reason is in the closed set
  PASS  loser: reason = "already_claimed"
  PASS  loser: attempts = 1
  PASS  loser: holder = "harness-worker-a"
  PASS  loser: message tells it to stop
  PASS  loser's claimedBy names the winner
  PASS  server says the task is executing
  PASS  server says the WINNER holds it
  PASS  the winning claim minted a fencing token (claim.generation >= 1)
  PASS  claim_conflicts rose by at least 1 (the contention signal)

── phase 2 · the loser's writes are refused, with ZERO mutations ───────
  PASS  progress refused (recorded:false)
  PASS  progress: tapOut:true
  PASS  progress: next = "queue_next"
  PASS  progress: reason is in the closed set
  PASS  progress: reason in {not_your_claim, fenced}
  PASS  progress: holder = "harness-worker-a"
  PASS  progress: message tells it to stop
  note  the API's code was "claimed_by_other" but the tap-out reason is "fenced" — …
  PASS  complete refused (completed:false)
  …
  PASS  state move refused (moved:false)
  …
  PASS  the task is UNCHANGED after three refused writes
  PASS  no progress entry was appended
  PASS  result is still empty
  SKIP  fenced_writes counts the loser's refused writes
        this API build exposes no fenced_writes counter

── phase 3 · a bad loser loops 10x — locally refused, zero API calls ───
  PASS  the gateway made ZERO API calls for 10 repeat claims
  PASS  every repeat claim answered claimed:false
  PASS  every repeat claim reason = "already_lost"
  PASS  attempts rise monotonically (the refusal gets firmer)
  note  attempt counter after the loop: 14
  PASS  a worker that honours tapOut stops after 1 attempt

── phase 4 · the winner works and completes — exactly one completion ───
  PASS  winner's progress recorded
  PASS  winner's heartbeat extended the lease
  PASS  winner's completion accepted
  PASS  server state = done
  PASS  done by the winner
  PASS  the winner's result is the one on record
  PASS  exactly ONE completion write landed for T1

── phase 5 · a write against finished work taps out ────────────────────
  PASS  progress on a done task refused
  PASS  late progress: tapOut:true
  …

── phase 6 · the winner goes silent — the task comes back and is reclaimed
  PASS  worker-a claims T2
  PASS  worker-b on T2: reason = "already_claimed"
  …
  PASS  the board could release the dead winner's task
  PASS  released task is approved again
  PASS  released task has no holder
  PASS  queue_next offers T2 back to worker-b
  PASS  T2 is NOT marked lostByYou any more
  PASS  T2 comes back WITH a handoff
  PASS  worker-b reclaims T2
  PASS  the reclaim minted a NEW generation
  PASS  the dead winner's completion is REFUSED
  PASS  T2 is still executing (not completed by the zombie)
  PASS  T2 is still held by worker-b

── phase 7 · a write under a STALE claim generation is fenced ──────────
  PASS  stale-generation write refused with 409
  PASS  refusal carries fenced:true
  PASS  refusal code = "stale_claim_generation"
  PASS  refusal hands back the LIVE generation
  PASS  the fenced write mutated nothing
  PASS  the live holder can still finish
  PASS  T2 state = done

── phase 8 · does the gateway present its fencing token? ───────────────
  GAP   gateway writes carry claimGeneration
        0 of 13 agent-identified writes presented a generation. …

  note  scratch tasks deleted; empty canvas left at http://localhost:7891/c/LYNZHET8

════════════════════════════════════════════════════════════════════════
api calls: 49 (29 writes)   failures: 0   skipped: 1   gaps: 1
RESULT: PASS — two agents raced, one tapped out, and it stayed tapped out.
```

**Numbers worth recognising.** `attempts: 14` after the phase-3 loop is right, not
drift: 1 lost claim + 3 refused writes + 10 repeat claims, all of which are
"you were told to let go of this task" events on one ledger entry. `api calls: 49`
is the whole run including the harness's own setup and reads; the phase-3 slice of
it is **0**, which is the number that matters.

## SKIP, GAP and FAIL

Three outcomes that are not the same thing:

- **SKIP** — the *server* does not implement what the check needs, so there is
  nothing to assert. Printed with the reason. `--require-fence` converts these to
  failures, which is what you want once the deployment under test is current.
- **GAP** — the harness *measured* a hole in our own code. Not a regression, so it
  does not fail the run (a suite that goes red for known work can't be a
  regression gate), but every gap names the tripwire test that will fail when it
  closes.
- **FAIL** — a contract that used to hold does not any more. Read the check name
  and the `got:` line under it.

### Known gaps

**The gateway does not present its claim generation.** It reads one out of a
refusal (`tapout.ts` keeps `claimGeneration` and passes it through untouched) but
has no field to send one on a write, so every gateway write is identity-checked
only. Identity cannot catch the one case the token exists for: a lease that came
back to the **same agent name** (worker-a → worker-b → worker-a, where worker-a's
lease-1 write must still die). Phase 7 therefore has to reach past the tool layer
to exercise the fence at all. Tripwire:
`TestGatewayWithoutAFencingTokenIsNotFencedOnSelfTakeover` — it pins the current
degradation and fails when the gateway starts carrying the token, at which point
invert it and delete this paragraph.

### Observations from the live run

**A fenced write can no longer say "not_your_claim".** The API sets `fenced:true`
on *every* refusal body, including `claimed_by_other`, and the gateway's
`readConflict` checks that flag first — so `writeReason` returns `"fenced"` for a
plain non-holder write and the `not_your_claim` reason is unreachable on the write
paths. Same conclusion for the worker (stop), less signal for the human reading
the board, which is the distinction `tapout.ts` says it wants to keep. The harness
accepts either reason and prints a `note` when it sees the collapse. Claims are
unaffected: the atomic claim's 409 does not set `fenced`, so a lost race still
reports `already_claimed`.

**The local docker image can lag the fence metric.** The run above found
generations minted and stale writes fenced, but no `fenced_writes` counter on
`/api/metrics` — an image built before that counter landed. Rebuild
(`scripts/rebuild-local.sh`) and re-run with `--require-fence` to close the SKIP.

## Housekeeping

The harness creates a scratch canvas per run and deletes the tasks it made on the
way out. The **canvas itself stays**: deleting a canvas needs an owning user
account, and the harness runs anonymous on purpose so it works with nothing but an
API URL. An empty scratch canvas is inert, and its code is printed either way so
you can open or delete it yourself.

Related: `docs/CONTENTION.md` for the protocol these checks are about.
