/**
 * THE TAP-OUT CONTRACT (TDM-99 / E14) — losing means stopping, provably.
 *
 * Contention is normal in a fleet: two workers reach for one task and exactly
 * one wins. The gateway already answered the loser with DATA rather than a throw
 * (see claimRejectionMessage in tools.ts), but that answer was prose — and prose
 * is something a model can read as "try again, more politely". Two failures
 * followed:
 *
 *   1. There was no field to BRANCH on. A loser had to parse English to work out
 *      that it had lost, so a slightly-off model kept going.
 *   2. Nothing REMEMBERED the loss. queue_next → claim → lose → queue_next →
 *      claim → lose is a stable loop that burns tokens and looks, on the board,
 *      like a worker doing something.
 *
 * So every losing path now carries one machine-readable block alongside the
 * human sentence:
 *
 *     { tapOut: true, reason, holder?, taskId, next: "queue_next", attempts }
 *
 * `tapOut: true` is the single field to branch on: it means STOP TOUCHING THIS
 * TASK. `next` names the tool to call instead, and it is deliberately a tool the
 * DEFAULT manifest advertises (the TDM-72 bug class: never point a model at
 * something it cannot see).
 *
 * And the loss is remembered — see the ledger below — so the second attempt is
 * refused without even racing.
 *
 * WHAT IS NOT A TAP-OUT: a task that is merely un-claimed ("not_executing" on a
 * still-approved task). Nobody beat you there; the right move is to claim it and
 * work, so telling that caller to tap out would send it away from work it could
 * do. Tap-out is for contention (someone else holds it), fencing (the API
 * refused your write because your claim is stale), and terminal state (the work
 * is already finished). Nothing else.
 */

import type { Gateway } from "./gateway.js";

/**
 * The tool a tapped-out session is sent to. A literal, because the whole point
 * is that a loser routes on a fixed value instead of on prose — and it is pinned
 * against the advertised manifest in manifest.test.ts.
 */
export const TAP_OUT_NEXT = "queue_next" as const;

/**
 * Why you are being told to let go. A CLOSED set: a loser branches on `tapOut`
 * first and may branch on `reason` second, so a new reason is an API change and
 * has to be added here (and to the pinned list in the tests) on purpose.
 *
 *   already_claimed  — you lost the atomic claim race; someone else holds it.
 *   already_lost     — you already lost THIS task and asked again. Firmer, and
 *                      answered locally: the gateway does not re-race it.
 *   not_your_claim   — you tried to report on / finish / move a task another
 *                      agent holds.
 *   already_finished — the task is in a terminal state; there is no work left.
 *   fenced           — the API rejected the write because your claim is stale
 *                      (claim-generation fencing, TDM-98). Same conclusion:
 *                      the task moved on without you.
 */
export type TapOutReason =
  | "already_claimed"
  | "already_lost"
  | "not_your_claim"
  | "already_finished"
  | "fenced";

export const TAP_OUT_REASONS: readonly TapOutReason[] = [
  "already_claimed",
  "already_lost",
  "not_your_claim",
  "already_finished",
  "fenced",
];

export interface TapOut {
  /** The one field to branch on. Always true when present. */
  tapOut: true;
  reason: TapOutReason;
  /** The tool to call instead. Always "queue_next". */
  next: typeof TAP_OUT_NEXT;
  taskId: string;
  /** Who holds the task, when the API told us. */
  holder?: string;
  /** Present when the API fenced the write by claim generation (TDM-98). */
  fenced?: true;
  /** The live claim generation the fence reported, passed through untouched. */
  claimGeneration?: number;
  /** How many times THIS session has been told to let go of THIS task. */
  attempts: number;
}

/** States where the work is over, so there is nothing to hand back to. */
const TERMINAL_STATES = new Set(["done", "failed", "rejected", "cancelled"]);

// ── Reading the API's rejection ──────────────────────────────────────────────

/**
 * The shapes a 409/412 body can arrive in. Deliberately UNION-ish and all
 * optional: the API's contention bodies are `{error, claimedBy}` today, and
 * claim-generation fencing (TDM-98) is landing in parallel with a `{fenced: true,
 * holder}` shape. This gateway must not depend on which of those is deployed —
 * so read both spellings of "who has it", accept either signal for "fenced", and
 * keep whatever else came along in `raw` rather than swallowing it.
 */
export type ConflictBody = {
  error?: string;
  /** The fence path sends the code twice, as `error` and as `reason`. */
  reason?: string;
  message?: string;
  claimedBy?: string;
  holder?: string;
  state?: string;
  fenced?: boolean;
  claimGeneration?: number;
  expectedGeneration?: number;
} | null | undefined;

/** Error codes that mean "your claim is stale", whatever the field spelling. */
const FENCE_CODES = new Set(["fenced", "stale_claim", "stale_claim_generation", "claim_fenced"]);

export interface ReadConflict {
  holder?: string;
  /** The API's `error` (or `reason`) code, when it sent one. */
  code?: string;
  /** The task's state as the API reported it, when it sent one. */
  state?: string;
  fenced: boolean;
  /**
   * The live claim generation the fence reported, when it sent one. Passed
   * through untouched: it is the token a caller that LEGITIMATELY re-claims
   * would need to present, and swallowing it would make the refusal a dead end.
   */
  claimGeneration?: number;
  /** The API's own sentence, when it sent one and we have nothing better. */
  message?: string;
}

/** Normalize a conflict body into the few facts a tap-out is built from. */
export function readConflict(body: ConflictBody): ReadConflict {
  const holder = firstNonEmpty(body?.claimedBy, body?.holder);
  const code = firstNonEmpty(body?.error, body?.reason);
  const state = firstNonEmpty(body?.state);
  const message = firstNonEmpty(body?.message);
  const fenced = body?.fenced === true || (code !== undefined && FENCE_CODES.has(code));
  return {
    ...(holder ? { holder } : {}),
    ...(code ? { code } : {}),
    ...(state ? { state } : {}),
    fenced,
    ...(typeof body?.claimGeneration === "number"
      ? { claimGeneration: body.claimGeneration }
      : {}),
    ...(message ? { message } : {}),
  };
}

function firstNonEmpty(...values: Array<unknown>): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/**
 * A GENERATION fence specifically — "your claim generation is stale" — as opposed
 * to a rival simply holding the task (TDM-122).
 *
 * WHY THE CODE AND NOT THE FLAG. The API stamps `fenced: true` on EVERY refusal so
 * a client can branch on one field (see claim_fence.go — the flag means "you do not
 * hold this, stop"). But two different causes wear that flag: `claimed_by_other`
 * (a rival holds it) and `stale_claim_generation` (your lease was superseded). They
 * reach the SAME conclusion — let go — but a human reading the board wants "someone
 * beat me" told apart from "my claim went stale". So the reason is chosen off the
 * CODE, not the flag: only the FENCE_CODES are a real generation fence. Branching on
 * the flag alone (the pre-TDM-122 bug) collapsed both into "fenced" and made
 * "not_your_claim" unreachable on the write paths.
 */
function isGenerationFence(c: ReadConflict): boolean {
  if (c.code && FENCE_CODES.has(c.code)) return true;
  // A fenced flag with no code we recognize AND no named holder: nothing says it is
  // a rival, so trust the flag and treat it as a fence.
  return c.fenced && !c.code && !c.holder;
}

/**
 * Which reason a rejected CLAIM gets. A fence and a lost race are different
 * causes with the same conclusion, and the loser is told which so a human
 * reading the board can tell "someone beat me" from "my claim went stale". A
 * lost race arrives as `claimed_by_other` (a rival won) → "already_claimed"; only
 * a genuine generation fence → "fenced".
 */
export function claimReason(c: ReadConflict): TapOutReason {
  if (isGenerationFence(c)) return "fenced";
  return "already_claimed";
}

/**
 * Which reason a rejected WRITE against someone else's task gets (progress,
 * complete, state move). Returns undefined when the rejection is NOT a tap-out —
 * i.e. nobody else holds it and it is not finished, which is the "you never
 * claimed this" case whose answer is task_claim, not queue_next.
 *
 * The CODE, not the flag, decides fenced-vs-not_your_claim (TDM-122): a rival
 * holder (`claimed_by_other`, which also carries `fenced: true` on the current API)
 * is "not_your_claim"; a stale generation (`stale_claim_generation`) is "fenced".
 */
export function writeReason(c: ReadConflict): TapOutReason | undefined {
  if (isGenerationFence(c)) return "fenced";
  if (c.holder) return "not_your_claim";
  if (c.fenced) return "fenced";
  if (c.state && TERMINAL_STATES.has(c.state)) return "already_finished";
  return undefined;
}

// ── The loss ledger (anti-loop) ──────────────────────────────────────────────

/**
 * WHAT THIS SESSION HAS BEEN TOLD TO LET GO OF.
 *
 * Process-local and in-memory, keyed by canvas + claimant identity, which is the
 * same identity the API's claim guard uses. That works across the hosted
 * sidecar's fresh-Gateway-per-call model (identity round-trips inside the
 * `session` handle, so two calls from one logical session hash to one key).
 *
 * DOCUMENTED LIMITATION: it is per PROCESS. A subagent running its own
 * `tandem-mcp` process has its own ledger, a sidecar restart or a second replica
 * starts empty, and nothing is persisted to the API. That is deliberate for v1 —
 * the loop this exists to break is one session re-racing one task within one
 * run, which is exactly what process-local state covers. Cross-session memory
 * would have to live on the API (a per-agent "declined" list), and the honest
 * version of that needs the API's claim generation to hang off, which is TDM-98's
 * territory, not this ledger's.
 *
 * Two safety valves keep it from becoming a liar or a leak:
 *   - TTL. A loss older than the claim lease (~15 min) is no longer PROOF that
 *     the winner still holds the task, so it expires and the session may try
 *     again.
 *   - queue_next clears a loss the moment the server says the task is ready and
 *     unheld — the winner's claim ended, so refusing would be wrong. That makes
 *     the ready queue the self-healing path, which is also the tool every
 *     tap-out points at.
 *
 * THE CLOCK STARTS ONCE AND NEVER MOVES FORWARD (TDM-167). Both valves used to
 * be unreachable for the one case that needs them most — a holder that DIED
 * mid-task:
 *
 *   - queue_next cannot clear it, because a task stuck `executing` under a dead
 *     holder is not in the ready queue at all. It is exactly the task that never
 *     comes back through the self-healing path.
 *   - the TTL could not expire it either, because every retry re-stamped `at`.
 *     A session that asked again at minute 14 pushed its own deadline to minute
 *     29, forever. The ledger key is canvas + claimant() (the agent NAME), so
 *     reconnecting under the same name inherited the same trap; the only escape
 *     was registering under a NEW name, which leaves a duplicate on the fleet
 *     view. During E20 this stranded TDM-154 twice: a worker finished and
 *     committed a whole ticket and could then neither claim it nor heartbeat on
 *     it, so the board showed no trail and a human had to release it by hand.
 *
 * So `at` is the start of the current losing STREAK, not the last time we said
 * no, and nothing pushes it forward. The guard lifts on its own one lease after
 * the first loss, one claim reaches the server, and the SERVER decides — which
 * is the only place the decision can honestly be made:
 *
 *   - The claim path consults the lease (store.DefaultClaimTTL, lazy expiry at
 *     claim time), so a live holder still wins the race and the loser is
 *     recorded again for another lease. Re-racing a genuine claim still taps out
 *     — at most once per lease instead of once per turn, which is the loop this
 *     ledger exists to break.
 *   - A dead holder's lease has expired by then, the re-claim SUCCEEDS, and the
 *     session that did the work can report on it again.
 *
 * And only a rejected CLAIM is evidence a lease is live. The write fence
 * (progress / complete) is identity-only — see claim_fence.go: it refuses on the
 * holder's NAME whatever the lease age — so a refused heartbeat says "someone
 * else's name is on this", never "and their claim is still good". Letting those
 * rejections extend the clock is what welded the trap shut. They still record
 * the loss (the session must stop writing); they just cannot buy the holder
 * another 15 minutes.
 */
export interface Loss {
  taskId: string;
  holder?: string;
  reason: TapOutReason;
  /** The live claim generation, when the API's fence reported one. */
  claimGeneration?: number;
  /**
   * When this losing streak STARTED — the one clock freshness is measured
   * against, and the only field the TTL reads. Set when a loss is first recorded
   * (or first recorded again after one expired) and never pushed forward by a
   * later rejection or retry: an entry that re-stamped itself could never age
   * out under the retries it exists to refuse (TDM-167). Use `lastAt` for "when
   * did this session last ask".
   */
  at: number;
  /**
   * The most recent time this session was told to let go of this task — the
   * newest rejection or local refusal. Reporting only: it deliberately does NOT
   * affect expiry.
   */
  lastAt?: number;
  /** How many times this session has been told to let go of this task. */
  attempts: number;
}

/**
 * As long as the API's claim lease: past it, a loss proves nothing.
 *
 * Kept in step with the server's claim TTL (store.DefaultClaimTTL /
 * CLAIM_TTL_MINUTES, 15 min), because that is the moment a dead holder's task
 * becomes claimable again. Shorter and the gateway re-races claims the server
 * will still refuse; longer and it keeps refusing work the server would now
 * hand over.
 */
export const LOSS_TTL_MS = 15 * 60 * 1000;

/**
 * The clock the ledger ages losses against. Indirected ONLY so tests can wind
 * time past the lease without sleeping for it; production always reads
 * Date.now(). Kept module-private with a seam rather than passed through every
 * call site, so no production path can pass a clock of its own.
 */
let lossClock: () => number = Date.now;

/** Test seam: run the ledger on a fake clock (no argument restores Date.now). */
export function setLossClock(clock?: (() => number) | null): void {
  lossClock = clock ?? Date.now;
}

/**
 * Ledger keys are normalized task REFS, because a task has several spellings: a
 * uuid, "TDM-21", "tdm-21", "#21", "21" (the API resolves all of them — see
 * TASK_ID_PROP in tools.ts). A session that loses under one spelling and asks
 * again under the SAME one is caught locally; one that switches spelling mid-loop
 * gets one more real race, and is then recorded under that spelling too, so it
 * still converges. queue_next closes most of the gap by checking a listed task's
 * uuid AND its ticketId against the ledger.
 */
function lossKey(ref: string): string {
  return ref.trim().toLowerCase().replace(/^#/, "");
}

/** Bound the per-session ledger so a long-lived stdio process cannot grow forever. */
const MAX_LOSSES_PER_SESSION = 200;

const LEDGER = new Map<string, Map<string, Loss>>();

/**
 * The ledger key: canvas + claimant. Not the JWT and not the handle string —
 * a session re-exports its handle as identity changes (agent_register), and the
 * claimant is the one thing that is stable AND is what the API's guard compares.
 */
export function sessionKey(gateway: Gateway): string {
  const s = gateway.getSession();
  return `${s.canvasId}::${gateway.claimant()}`;
}

function ledgerFor(gateway: Gateway): Map<string, Loss> {
  const key = sessionKey(gateway);
  let m = LEDGER.get(key);
  if (!m) {
    m = new Map();
    LEDGER.set(key, m);
  }
  return m;
}

/**
 * Is this loss still inside the lease window that started it? Measured from
 * `at`, the START of the streak — see the Loss doc: a clock that moved on every
 * rejection never expired.
 */
function fresh(loss: Loss, now = lossClock()): boolean {
  return now - loss.at < LOSS_TTL_MS;
}

/**
 * Remember that this session was told to let go of `taskId`, and return the
 * ledger entry (whose `attempts` is what makes the second refusal firmer than
 * the first).
 *
 * Re-recording the same task bumps the count and records WHEN it last happened,
 * but it does NOT restart the expiry clock: `at` is carried over from the live
 * entry, so the streak still ends one lease after it began (TDM-167). A new
 * clock is started only when there is nothing live to carry — the first loss, or
 * the first one after an earlier streak expired or was forgotten.
 */
export function recordLoss(
  gateway: Gateway,
  taskId: string,
  info: { holder?: string; reason: TapOutReason; claimGeneration?: number }
): Loss {
  const ledger = ledgerFor(gateway);
  const key = lossKey(taskId);
  const stored = ledger.get(key);
  // Only a LIVE entry is carried forward; an expired one is a finished streak,
  // and starting from its clock would resurrect a refusal that already lapsed.
  const prior = stored && fresh(stored) ? stored : undefined;
  const now = lossClock();
  const loss: Loss = {
    taskId,
    ...(info.holder ? { holder: info.holder } : prior?.holder ? { holder: prior.holder } : {}),
    reason: info.reason,
    ...(info.claimGeneration !== undefined
      ? { claimGeneration: info.claimGeneration }
      : prior?.claimGeneration !== undefined
        ? { claimGeneration: prior.claimGeneration }
        : {}),
    at: prior ? prior.at : now,
    lastAt: now,
    attempts: (prior ? prior.attempts : 0) + 1,
  };
  ledger.set(key, loss);
  // Evict the oldest losses first — the recent ones are the ones a loop is
  // hammering, so they are the ones worth keeping.
  if (ledger.size > MAX_LOSSES_PER_SESSION) {
    const oldest = [...ledger.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [staleKey] of oldest.slice(0, ledger.size - MAX_LOSSES_PER_SESSION)) {
      ledger.delete(staleKey);
    }
  }
  return loss;
}

/** A live (non-expired) loss for this task, if this session has one. Prunes. */
export function findLoss(gateway: Gateway, taskId: string): Loss | undefined {
  const ledger = LEDGER.get(sessionKey(gateway));
  if (!ledger) return undefined;
  const key = lossKey(taskId);
  const loss = ledger.get(key);
  if (!loss) return undefined;
  if (!fresh(loss)) {
    ledger.delete(key);
    return undefined;
  }
  return loss;
}

/**
 * A live loss under ANY of a task's spellings — queue_next passes both the uuid
 * and the ticket ref, since it knows both and the loser may only know one.
 */
export function findAnyLoss(gateway: Gateway, refs: Array<string | undefined>): Loss | undefined {
  for (const ref of refs) {
    if (!ref) continue;
    const hit = findLoss(gateway, ref);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Forget a loss — called when the server PROVES the winner's claim is over (the
 * task is back in the ready queue with no holder). Without this the loser would
 * refuse work that is genuinely free again. Clears every spelling it was given.
 */
export function forgetLoss(gateway: Gateway, ...refs: Array<string | undefined>): void {
  const ledger = LEDGER.get(sessionKey(gateway));
  if (!ledger) return;
  for (const ref of refs) {
    if (ref) ledger.delete(lossKey(ref));
  }
}

/**
 * Bump an existing loss's attempt count without changing why it was lost — what
 * a LOCAL refusal records. Nothing new was learned (the gateway did not touch
 * the API), so this is the last thing that should be allowed to extend the
 * refusal: it counts the ask and moves `lastAt`, and leaves the expiry clock
 * exactly where the first loss put it (TDM-167).
 */
export function bumpLoss(gateway: Gateway, loss: Loss): Loss {
  const ledger = ledgerFor(gateway);
  const key = lossKey(loss.taskId);
  const current = ledger.get(key) ?? loss;
  const bumped: Loss = {
    ...current,
    lastAt: lossClock(),
    attempts: current.attempts + 1,
  };
  ledger.set(key, bumped);
  return bumped;
}

/** Test seam: drop every session's ledger. Never called in production paths. */
export function resetLossLedger(): void {
  LEDGER.clear();
}

// ── Building the answer ──────────────────────────────────────────────────────

/** The machine-readable block. Identical on every losing path, by construction. */
export function tapOutBlock(loss: Loss): TapOut {
  return {
    tapOut: true,
    reason: loss.reason,
    next: TAP_OUT_NEXT,
    taskId: loss.taskId,
    ...(loss.holder ? { holder: loss.holder } : {}),
    ...(loss.reason === "fenced" ? { fenced: true as const } : {}),
    ...(loss.claimGeneration !== undefined ? { claimGeneration: loss.claimGeneration } : {}),
    attempts: loss.attempts,
  };
}

/**
 * The REPEAT refusal (reason "already_lost"): what a session gets for asking
 * again about a task it already lost. Firmer than the first, and it says plainly
 * that no claim was attempted — the gateway did not touch the API, so there is
 * no race here to win on a third try.
 */
export function repeatClaimRejectionMessage(loss: Loss): string {
  const who = loss.holder ? `"${loss.holder}"` : "another session";
  return (
    `You already lost this task to ${who} and were told to stop — this is attempt ` +
    `${loss.attempts}. The gateway did NOT retry the claim: re-racing a task you lost is a loop, ` +
    `not a strategy. Do NOT work on it. Call queue_next and take a DIFFERENT ready task. ` +
    `If a human releases this one it will appear there as ready again. ` +
    // The way out that needs nobody: the refusal is time-boxed to one claim
    // lease from the FIRST loss, and asking again does not extend it (TDM-167).
    // Say so, or a session that hit a holder which then died reads this as
    // permanent and either gives up or re-registers under a new name.
    `This refusal also lifts by itself in ${minutesLeft(loss)} — if ${who} has gone dark, its ` +
    `claim expires and the next task_claim is allowed through to the server, which decides.`
  );
}

/** How long until a loss stops being proof, phrased for the refusal message. */
function minutesLeft(loss: Loss): string {
  const remaining = Math.max(0, loss.at + LOSS_TTL_MS - lossClock());
  const minutes = Math.ceil(remaining / 60_000);
  return minutes <= 1 ? "under a minute" : `about ${minutes} minutes`;
}

/** What a fenced write is told: your claim went stale, the task moved on. */
export function fenceRejectionMessage(taskId: string, holder?: string): string {
  return (
    `Your claim on this task is no longer current — the API fenced this write` +
    (holder ? ` and the task is now held by "${holder}"` : "") +
    `. That means the task was reclaimed or released while you were working, so anything you do ` +
    `to it now would be work nobody asked for. Do NOT work on it. Call queue_next and take a ` +
    `ready task. (task ${taskId})`
  );
}

/** What a non-holder is told when it tries to report on / finish someone else's task. */
export function notYourClaimMessage(holder: string, verb: string): string {
  return (
    `This task is claimed by "${holder}" — it is not yours to ${verb}. Do NOT work on it. ` +
    `Call queue_next and pick a task you can claim. If that session is dead, a human can ` +
    `release the task from the board (Working column).`
  );
}

/** What a caller is told when the work is already over. */
export function alreadyFinishedMessage(state: string): string {
  return (
    `This task is already "${state}" — the work is over, so there is nothing here to do. ` +
    `Do NOT work on it. Call queue_next and take a ready task.`
  );
}
