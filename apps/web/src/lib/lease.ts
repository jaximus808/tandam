/* Claim leases on the client (TDM-101) — is the agent holding this task still
   alive, and may someone else take it?

   WHY THIS EXISTS. The lease is already real on the server: a claim stamps
   `claimed_at`, every `task_progress` heartbeat pushes that stamp forward
   (holder-only — see TouchActionClaim / statusProgress), and a claim older than
   the TTL is taken over atomically by the next agent that asks for the task
   (supabaseStore.takeOverExpiredClaim). Expiry is LAZY: nothing sweeps, so a
   lapsed lease sits there looking exactly like a live one until a rival happens
   to want the task. Which means the board — the only place a human watches a
   fleet — showed a stalled worker and a working worker identically. That is the
   gap this closes.

   Nothing is fetched and nothing is stored. `claimedAt` and `payload.progress[]`
   already ride every canvas-state push, so a heartbeat landing re-renders the
   lease over the existing socket. The only thing that has to move on its own is
   the CLOCK: a stalled worker sends nothing, so with no ticking `now` the age
   would freeze at whatever it read when the last push arrived — and freezing is
   the exact failure mode this is meant to make visible. Callers own the clock
   (components/Freshness's useFreshnessNow), the same way lib/freshness.ts does.

   Two facts, deliberately kept apart:

     LAST HEARD FROM — max(claimedAt, newest progress.at). "Is anyone home."
     LAPSES AT       — claimedAt + TTL. "Will the server hand this to a rival."

   For an exclusive holder they are the same number, because its heartbeats move
   claimed_at. They diverge for a NON-EXCLUSIVE holder (the generic "agent"
   identity, or an empty one): the store's claimed_by predicate refuses to
   extend those leases, so such a worker can be filing reports and reclaimable
   at the same time. That is a real state, not a rounding error, and the chip's
   title says so rather than picking one of the two facts and hiding the other.

   Keep CLAIM_TTL_MS in step with the server. It is deliberately a plain mirror
   of the default rather than something read off an endpoint: the value is
   process-wide policy, it has changed once ever, and being a minute wrong about
   a 15-minute window is not worth an API surface. If a deployment overrides
   CLAIM_TTL_MINUTES, this reads slightly early or late — the ordering of the
   three states is still right, which is the whole job. */

import type { Action, TaskPayload } from "../types";

/** How long a claim is honoured before a rival can take it over. Mirrors
 *  store.DefaultClaimTTL / the CLAIM_TTL_MINUTES default in apps/api. */
export const CLAIM_TTL_MS = 15 * 60_000;

/** Fraction of the lease spent before it reads as slipping rather than live.
 *  Same threshold, and the same reasoning, as freshness's AGING_THRESHOLD: half
 *  a window gone with nothing heard is when a human starts wanting to know. */
export const SLIPPING_THRESHOLD = 0.5;

/**
 * live      heartbeating inside the first half of its lease — nothing to do.
 * slipping  past halfway with no report. Not yet reclaimable; worth an eyebrow.
 * stale     the lease has lapsed. Any agent asking for this task takes it over,
 *           and a human can release it now instead of waiting for that.
 * none      no lease to speak of: not executing, or executing with no stamp at
 *           all (a row from before claimed_at was written). Renders as nothing —
 *           an "unknown" badge on every historical task is noise standing in for
 *           information (the same rule Freshness applies to never-verified).
 */
export type LeaseHealth = "live" | "slipping" | "stale" | "none";

export interface Lease {
  health: LeaseHealth;
  /** Who holds it, or null. */
  holder: string | null;
  /** ms since we last heard anything from the holder. 0 when health is "none". */
  silentMs: number;
  /** ms until the lease lapses; 0 once it has. */
  remainingMs: number;
  /** ms the lease has already been over by; 0 until it lapses. */
  overdueMs: number;
  /** True once a rival's claim would take this task over. */
  reclaimable: boolean;
  /** The holder filed a progress report more recently than its lease was
   *  extended — a non-exclusive claimant, alive but reclaimable anyway. */
  unextendable: boolean;
  /** Whether the last thing we heard was a report rather than the bare claim. */
  heardFromProgress: boolean;
}

const NO_LEASE: Lease = {
  health: "none",
  holder: null,
  silentMs: 0,
  remainingMs: 0,
  overdueMs: 0,
  reclaimable: false,
  unextendable: false,
  heardFromProgress: false,
};

function ms(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** The newest progress report's instant, or null when there are none. */
export function lastProgressAt(payload: TaskPayload | undefined): number | null {
  let newest: number | null = null;
  for (const e of payload?.progress ?? []) {
    const t = ms(e.at);
    if (t !== null && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

/**
 * The lease on an action, as of `now` (epoch ms).
 *
 * Only an `executing` task has one: a lease is the right to be the agent
 * working a task, so approved/done/failed rows have nothing to report even
 * though they may still carry a claimedBy for the record.
 *
 * A stamp in the FUTURE (clock skew between the viewer and the server) clamps to
 * zero elapsed and reads live rather than going negative — same call
 * deriveFreshness makes.
 */
export function deriveLease(action: Action | undefined, now: number): Lease {
  if (!action || action.type !== "task" || action.state !== "executing") return NO_LEASE;
  const claimedAt = ms(action.claimedAt);
  if (claimedAt === null) return NO_LEASE;

  const progressAt = lastProgressAt(action.payload as TaskPayload | undefined);
  const heardAt = progressAt !== null && progressAt > claimedAt ? progressAt : claimedAt;

  const silentMs = Math.max(0, now - heardAt);
  const elapsed = Math.max(0, now - claimedAt);
  const remainingMs = Math.max(0, CLAIM_TTL_MS - elapsed);
  const overdueMs = Math.max(0, elapsed - CLAIM_TTL_MS);
  const reclaimable = elapsed >= CLAIM_TTL_MS;

  const health: LeaseHealth = reclaimable
    ? "stale"
    : elapsed >= CLAIM_TTL_MS * SLIPPING_THRESHOLD
      ? "slipping"
      : "live";

  return {
    health,
    holder: action.claimedBy ?? null,
    silentMs,
    remainingMs,
    overdueMs,
    reclaimable,
    // Reports are landing but the lease is not moving with them, so the holder
    // is one the store won't extend for. Only interesting once it costs
    // something, i.e. once the lease is actually running out.
    unextendable: progressAt !== null && progressAt > claimedAt && health !== "live",
    heardFromProgress: progressAt !== null && progressAt >= claimedAt,
  };
}

// ── Words ────────────────────────────────────────────────────────────────────

/** Compact duration for the chip — "now", "4m", "1h", "2d". Machine text, so it
 *  renders in the mono face wherever it is used. */
export function leaseAge(msSpan: number): string {
  if (msSpan < 60_000) return "now";
  const m = Math.floor(msSpan / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Spelled-out duration for prose — "4 minutes", "2 hours". */
function spelled(msSpan: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (msSpan < 60_000) return "less than a minute";
  const m = Math.floor(msSpan / 60_000);
  if (m < 60) return unit(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return unit(h, "hour");
  return unit(Math.floor(h / 24), "day");
}

/**
 * The whole sentence behind the chip: the hover title and the screen-reader
 * text. Order is what a person deciding whether to intervene needs — who, how
 * long since we heard from them, and what happens next.
 */
export function leaseSentence(lease: Lease): string {
  if (lease.health === "none") return "";
  const who = lease.holder ? `${lease.holder} holds this task` : "This task is claimed";
  const heard =
    lease.silentMs < 60_000
      ? "last heard from just now"
      : `last heard from ${spelled(lease.silentMs)} ago`;

  if (lease.health === "stale") {
    const over =
      lease.overdueMs < 60_000
        ? "its 15-minute claim lease has just run out"
        : `its 15-minute claim lease ran out ${spelled(lease.overdueMs)} ago`;
    const extra = lease.unextendable
      ? " It is still filing reports, but the lease is not moving with them — usually a claim taken under the shared 'agent' identity, which the server will not extend."
      : "";
    return `${who}, ${heard} — ${over}. The next agent that asks for this task takes it over; release it to put it back in the queue now.${extra}`;
  }
  if (lease.health === "slipping") {
    const extra = lease.unextendable
      ? " Its reports are landing but the lease is not moving with them — usually a claim taken under the shared 'agent' identity, which the server will not extend."
      : "";
    return `${who}, ${heard} — the claim lease lapses in ${spelled(lease.remainingMs)}, after which another agent can take the task over.${extra}`;
  }
  return `${who}, ${heard} — the claim lease is good for another ${spelled(lease.remainingMs)}.`;
}

/**
 * The short label the chip shows beside the age — ONE state gets a word.
 *
 * Live and slipping are carried by the dot and the hue alone (pulsing violet /
 * hollow amber ring, and the age text going amber with it). Spending a word on
 * slipping would put amber prose on every card of every task that has honestly
 * been working for eight minutes, which is how a signal becomes wallpaper. The
 * word is reserved for the state that asks a human for something.
 */
export function leaseLabel(health: LeaseHealth): string | null {
  return health === "stale" ? "reclaimable" : null;
}
