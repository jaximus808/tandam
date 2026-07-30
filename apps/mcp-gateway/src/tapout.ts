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
 * Which reason a rejected CLAIM gets. A fence and a lost race are different
 * causes with the same conclusion, and the loser is told which so a human
 * reading the board can tell "someone beat me" from "my claim went stale".
 */
export function claimReason(c: ReadConflict): TapOutReason {
  if (c.fenced) return "fenced";
  return "already_claimed";
}

/**
 * Which reason a rejected WRITE against someone else's task gets (progress,
 * complete, state move). Returns undefined when the rejection is NOT a tap-out —
 * i.e. nobody else holds it and it is not finished, which is the "you never
 * claimed this" case whose answer is task_claim, not queue_next.
 */
export function writeReason(c: ReadConflict): TapOutReason | undefined {
  if (c.fenced) return "fenced";
  if (c.holder) return "not_your_claim";
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
 */
export interface Loss {
  taskId: string;
  holder?: string;
  reason: TapOutReason;
  /** The live claim generation, when the API's fence reported one. */
  claimGeneration?: number;
  /** Date.now() of the most recent rejection. */
  at: number;
  /** How many times this session has been told to let go of this task. */
  attempts: number;
}

/** As long as the API's claim lease: past it, a loss proves nothing. */
export const LOSS_TTL_MS = 15 * 60 * 1000;

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

function fresh(loss: Loss, now = Date.now()): boolean {
  return now - loss.at < LOSS_TTL_MS;
}

/**
 * Remember that this session was told to let go of `taskId`, and return the
 * ledger entry (whose `attempts` is what makes the second refusal firmer than
 * the first). Re-recording the same task bumps the count and refreshes the clock.
 */
export function recordLoss(
  gateway: Gateway,
  taskId: string,
  info: { holder?: string; reason: TapOutReason; claimGeneration?: number }
): Loss {
  const ledger = ledgerFor(gateway);
  const key = lossKey(taskId);
  const prior = ledger.get(key);
  const loss: Loss = {
    taskId,
    ...(info.holder ? { holder: info.holder } : prior?.holder ? { holder: prior.holder } : {}),
    reason: info.reason,
    ...(info.claimGeneration !== undefined
      ? { claimGeneration: info.claimGeneration }
      : prior?.claimGeneration !== undefined
        ? { claimGeneration: prior.claimGeneration }
        : {}),
    at: Date.now(),
    attempts: (prior && fresh(prior) ? prior.attempts : 0) + 1,
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

/** Bump an existing loss's attempt count without changing why it was lost. */
export function bumpLoss(gateway: Gateway, loss: Loss): Loss {
  return recordLoss(gateway, loss.taskId, { holder: loss.holder, reason: loss.reason });
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
    `If a human releases this one it will appear there as ready again.`
  );
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
