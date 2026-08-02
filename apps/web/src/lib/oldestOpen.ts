/* Oldest open tasks (TDM-195) — the Summary surface's "what has been sitting
   here longest" read.

   WHY A RANKING AND NOT A THRESHOLD. The first cut of this section was a
   staleness cutoff ("open more than 48h = stale"). On a board where normal
   tickets routinely wait a couple of days for a human approval, that lights up
   half the queue and stops meaning anything — a warning that fires on everything
   is wallpaper. So this ranks instead: ALWAYS the N oldest still-open tasks,
   never a judgement about whether N is too many. A young board shows young rows
   and that is the honest answer.

   DEFINITIONS, in one place:

     open       any task NOT in a terminal state — i.e. not done / failed /
                rejected (TERMINAL_STATES, reused from lib/epicLifecycle so the
                two surfaces can't drift). proposed, approved and executing are
                all open: waiting on a human is just as much "still open" as
                waiting on an agent.
     age        now − createdAt. That is the only clock the row can be honest
                about: the canvas stores when a task was CREATED, not when it
                entered its current state, so "proposed for 3 days" is not
                derivable — a task created a week ago and approved an hour ago
                still reads "open 7d". Time-in-state would be the better number
                and is simply not stored; saying "open" rather than "proposed
                for" is the wording that keeps that promise honest.
     staleClaim the ONE judgement kept from the threshold version, because it is
                the one a human can act on: an `executing` task whose claim lease
                has lapsed (nothing heard from the holder inside the ~15-minute
                TTL — lib/lease's "stale") almost always means the holder went
                dark. Derived by deriveLease, not re-implemented here.

   Pure data: CanvasState in, plain rows out, no React and no formatting — the
   component owns the words and the clock. */

import type { Action, ActionState, CanvasState, TaskPayload } from "../types";
import { TERMINAL_STATES } from "./epicLifecycle";
import { deriveLease } from "./lease";

/** How many of the oldest open tasks the section lists. Deliberately a constant
 *  and not a prop: this is an editorial call about how long the list should be
 *  before it stops being a summary, and one number keeps it tweakable. */
export const OLDEST_OPEN_LIMIT = 10;

export interface OldestOpenRow {
  id: string;
  /** "TDM-195" when the task has a ticket, else undefined. */
  ticketId?: string;
  title: string;
  state: ActionState;
  /** The agent holding an executing claim, when there is one. */
  holder: string | null;
  /** ISO instant the task was created — the age clock's origin. */
  createdAt: string;
  /** now − createdAt, clamped at 0 for clock skew. */
  ageMs: number;
  /** Executing, and its claim lease has lapsed: the holder likely went dark. */
  staleClaim: boolean;
}

/** Is this action an open task — a task, and not in a terminal state? */
export function isOpenTask(a: Action): boolean {
  return a.type === "task" && !TERMINAL_STATES.includes(a.state);
}

/**
 * The `limit` oldest open tasks, oldest first.
 *
 * `now` (epoch ms) is passed in rather than read here so the caller owns the
 * clock — the same contract lib/lease.ts keeps, and what lets the ages tick
 * without a canvas push.
 */
export function deriveOldestOpenTasks(
  state: CanvasState,
  now: number,
  limit: number = OLDEST_OPEN_LIMIT,
): OldestOpenRow[] {
  const open = Object.values(state.actions ?? {}).filter(isOpenTask);

  open.sort((a, b) => {
    const at = Date.parse(a.createdAt);
    const bt = Date.parse(b.createdAt);
    // Unparseable timestamps sort last rather than poisoning the order.
    const av = Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
    const bv = Number.isNaN(bt) ? Number.POSITIVE_INFINITY : bt;
    if (av !== bv) return av - bv;
    // Same instant (bulk-created tickets share a timestamp): ticket order, so
    // the list is stable across renders instead of shuffling on every push.
    return (a.ticket ?? 0) - (b.ticket ?? 0);
  });

  return open.slice(0, Math.max(0, limit)).map((a) => {
    const created = Date.parse(a.createdAt);
    const lease = deriveLease(a, now);
    return {
      id: a.id,
      ticketId: a.ticketId,
      title: (a.payload as TaskPayload | undefined)?.title?.trim() || "Untitled task",
      state: a.state,
      holder: a.claimedBy ?? null,
      createdAt: a.createdAt,
      ageMs: Number.isNaN(created) ? 0 : Math.max(0, now - created),
      staleClaim: lease.health === "stale",
    };
  });
}

/** How many open tasks there are in total — the denominator behind "top 10 of". */
export function countOpenTasks(state: CanvasState): number {
  return Object.values(state.actions ?? {}).filter(isOpenTask).length;
}
