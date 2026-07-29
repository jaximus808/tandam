/* Context freshness — the web mirror of the Go derivation (TDM-27/E1.2,
   apps/api/internal/store/freshness.go).

   Freshness is never stored. Migration 0037 persists only the pair
   (verified_at, stale_after_seconds); the status is computed from that pair
   plus the current instant, so it can never itself be stale on read. This file
   is that computation on the client — same inputs, same rules, same answers as
   the API, which matters because the two render the same items side by side
   (the board here, context_get there) and disagreeing about whether a note is
   stale would be worse than not showing freshness at all.

   Pure by design: `now` is always a parameter, never Date.now(). Callers own
   the clock (see useFreshnessNow, which ticks it), and the boundaries stay
   testable at exact instants.

   KEEP IN LOCKSTEP WITH freshness.go. The two rules easiest to get wrong, both
   deliberate:
     - no shelf life declared → fresh, forever, never ageing. The author
       vouched and declined to say it would expire, so there is no basis to
       start doubting it; ageing it anyway would invent a decay policy nobody
       set.
     - never verified → "unknown", which is NOT stale. "Nobody has vouched for
       this" is a different and more honest claim than "someone vouched and
       that vouching ran out", and the UI says so by rendering nothing at all. */

import type { FreshnessFields, FreshnessPatchFields } from "../types";

export type Freshness = "unknown" | "fresh" | "aging" | "stale";

/** Fraction of the shelf life after which an item reads as aging rather than
 *  fresh. Mirrors store.AgingThreshold — policy, tuned in code, not schema. */
export const AGING_THRESHOLD = 0.5;

/**
 * The derived trust status of a piece of canvas context.
 *
 * Rules, in order (identical to Go's DeriveFreshness):
 *   no verifiedAt                     → unknown
 *   no staleAfterSeconds, or <= 0     → fresh
 *   elapsed >= window                 → stale   (the boundary instant is stale)
 *   elapsed >= window * 0.5           → aging   (the boundary instant is aging)
 *   otherwise                         → fresh
 *
 * A `now` before verifiedAt (clock skew, or a verification stamped in the
 * future) gives a negative elapsed and therefore fresh, as in Go. A
 * non-positive window is folded into "no shelf life declared" rather than read
 * as instantly stale — a nonsensical window is an absent window, not an expired
 * one. An unparseable timestamp is treated as no verification: we will not
 * assert a vouching we cannot read.
 */
export function deriveFreshness(item: FreshnessFields | undefined, now: number): Freshness {
  const verifiedAt = verifiedAtMs(item);
  if (verifiedAt === null) return "unknown";

  const seconds = item?.staleAfterSeconds;
  if (seconds == null || seconds <= 0) return "fresh";

  const windowMs = seconds * 1000;
  const elapsed = now - verifiedAt;
  if (elapsed >= windowMs) return "stale";
  if (elapsed >= windowMs * AGING_THRESHOLD) return "aging";
  return "fresh";
}

/** verifiedAt as epoch ms, or null when absent/unparseable. */
export function verifiedAtMs(item: FreshnessFields | undefined): number | null {
  if (!item?.verifiedAt) return null;
  const t = Date.parse(item.verifiedAt);
  return Number.isNaN(t) ? null : t;
}

/** Aging and stale are the two states a human can act on — the review set. */
export function needsReview(status: Freshness): boolean {
  return status === "aging" || status === "stale";
}

/** How many of these items are worth re-verifying right now. */
export function countNeedingReview(items: FreshnessFields[], now: number): number {
  let n = 0;
  for (const item of items) if (needsReview(deriveFreshness(item, now))) n++;
  return n;
}

// ── Shelf life ───────────────────────────────────────────────────────────────

const DAY = 86_400;

/** The shelf lives a human can pick without typing a number. Four options, not
 *  a duration picker: the point is to declare roughly how fast this kind of
 *  fact rots, and "a day / a week / a month" is the whole vocabulary people
 *  actually use for that. `null` = declare no shelf life. */
export const SHELF_LIVES: { label: string; hint: string; seconds: number | null }[] = [
  { label: "No expiry", hint: "stays verified until someone says otherwise", seconds: null },
  { label: "1 day", hint: "moves fast — check daily", seconds: DAY },
  { label: "1 week", hint: "a normal working horizon", seconds: 7 * DAY },
  { label: "1 month", hint: "durable, but not forever", seconds: 30 * DAY },
];

/** The label for a stored shelf life ("1 week"), or a compact fallback for a
 *  value some other client set (an agent can declare any number of seconds). */
export function shelfLifeLabel(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return "No expiry";
  const known = SHELF_LIVES.find((o) => o.seconds === seconds);
  return known ? known.label : formatDuration(seconds * 1000);
}

// ── Patch builders ───────────────────────────────────────────────────────────

/**
 * The patch for "I vouch for this, as of now".
 *
 * `shelfLife` undefined leaves the declared shelf life alone (re-verifying
 * shouldn't silently change how fast something is meant to rot); `null`
 * explicitly clears it; a number sets it.
 */
export function verifyPatch(now: number, shelfLife?: number | null): FreshnessPatchFields {
  const patch: FreshnessPatchFields = { verifiedAt: new Date(now).toISOString() };
  if (shelfLife === null) patch.clearStaleAfterSeconds = true;
  else if (shelfLife !== undefined) patch.staleAfterSeconds = shelfLife;
  return patch;
}

/** The patch for retracting a verification — back to "nobody has vouched for
 *  this". The shelf life goes with it: a declared expiry on an unverified item
 *  measures nothing. */
export function unverifyPatch(): FreshnessPatchFields {
  return { clearVerifiedAt: true, clearStaleAfterSeconds: true };
}

// ── Formatting ───────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** A compact age for the chip: "now", "9m", "6h", "6d", "3w", "5mo", "2y".
 *  Machine text — rendered in the mono face, like every other measurement. */
export function formatAge(ms: number): string {
  if (ms < MINUTE) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR)}h`;
  if (ms < WEEK_MS) return `${Math.floor(ms / DAY_MS)}d`;
  if (ms < MONTH_MS) return `${Math.floor(ms / WEEK_MS)}w`;
  if (ms < YEAR_MS) return `${Math.floor(ms / MONTH_MS)}mo`;
  return `${Math.floor(ms / YEAR_MS)}y`;
}

/** A spelled-out duration for prose ("6 days", "2 weeks"). */
export function formatDuration(ms: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (ms < MINUTE) return "less than a minute";
  if (ms < HOUR) return unit(Math.floor(ms / MINUTE), "minute");
  if (ms < DAY_MS) return unit(Math.floor(ms / HOUR), "hour");
  if (ms < WEEK_MS) return unit(Math.floor(ms / DAY_MS), "day");
  if (ms < MONTH_MS) return unit(Math.floor(ms / WEEK_MS), "week");
  if (ms < YEAR_MS) return unit(Math.floor(ms / MONTH_MS), "month");
  return unit(Math.floor(ms / YEAR_MS), "year");
}

/** The full sentence behind the chip — the hover title and the screen-reader
 *  text. Says what was vouched for, when, and what happens next, in that order,
 *  because that's the order a reader deciding whether to trust it needs. */
export function freshnessSentence(
  item: FreshnessFields | undefined,
  status: Freshness,
  now: number,
): string {
  if (status === "unknown") return "Never verified";
  const verifiedAt = verifiedAtMs(item);
  const age = verifiedAt === null ? 0 : Math.max(0, now - verifiedAt);
  const when = age < MINUTE ? "Verified just now" : `Verified ${formatDuration(age)} ago`;

  const seconds = item?.staleAfterSeconds;
  if (seconds == null || seconds <= 0) return `${when} · no shelf life declared`;

  const windowMs = seconds * 1000;
  if (status === "stale") return `${when} · shelf life of ${formatDuration(windowMs)} has run out`;
  const left = Math.max(0, windowMs - age);
  return `${when} · goes stale in ${formatDuration(left)}`;
}
