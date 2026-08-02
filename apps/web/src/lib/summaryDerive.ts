import type { Action, ActionState, CanvasState } from "../types";
import { TERMINAL_STATES, epicLifecycle, type EpicLifecycle } from "./epicLifecycle";

/* ─────────────────────────────────────────────────────────────────────────────
   summaryDerive — the Summary surface's arithmetic (TDM-193).

   Pure functions: CanvasState in, plain data out. No React, no fetches, no
   component state — so the sections that render this stay layout-only and the
   numbers can be reasoned about (and, later, tested) on their own.

   The rollups here deliberately AGREE with the board rather than reaching into
   it: `epicLifecycle` is imported (one definition of "this batch has drained"),
   and the completion INSTANT of an epic uses the same approximation TaskBoard's
   drain chip does — the newest updatedAt among the epic's tasks, i.e. the
   moment the last one reached a terminal state. Epics carry no completion
   column, so that is the best fact available; a task edited after the fact
   would nudge it, which is acceptable for a timeline and is why the surface
   shows a relative age rather than pretending to a precise timestamp.
   ──────────────────────────────────────────────────────────────────────────── */

/** Board order for state breakdowns — the same six-state order as the chips. */
export const TASK_STATE_ORDER: ActionState[] = [
  "proposed",
  "approved",
  "executing",
  "done",
  "failed",
  "rejected",
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Payloads are a union (navigate | task | epic); every kind the board shows
 *  carries a title, and only epics carry a summary. Read them defensively
 *  rather than casting to one arm of the union. */
function titleOf(a: Action): string {
  const t = (a.payload as { title?: string }).title;
  return (t ?? "").trim();
}

function summaryOf(a: Action): string {
  return ((a.payload as { summary?: string }).summary ?? "").trim();
}

function epicIdOf(a: Action): string | null {
  return (a.payload as { epicId?: string }).epicId ?? null;
}

function msOf(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** The canvas's actions split the way every summary section wants them. */
export interface ActionIndex {
  tasks: Action[];
  epics: Action[];
  /** epic id → its tasks. Tasks with no epic are not in here — see `orphans`. */
  tasksByEpic: Map<string, Action[]>;
  /** Tasks belonging to no epic (or to an epic that no longer exists). */
  orphans: Action[];
}

export function indexActions(state: CanvasState): ActionIndex {
  const all = Object.values(state.actions ?? {});
  const tasks = all.filter((a) => a.type === "task");
  const epics = all.filter((a) => a.type === "epic");
  const known = new Set(epics.map((e) => e.id));
  const tasksByEpic = new Map<string, Action[]>();
  const orphans: Action[] = [];
  for (const t of tasks) {
    const eid = epicIdOf(t);
    if (eid && known.has(eid)) {
      const list = tasksByEpic.get(eid);
      if (list) list.push(t);
      else tasksByEpic.set(eid, [t]);
    } else {
      orphans.push(t);
    }
  }
  return { tasks, epics, tasksByEpic, orphans };
}

/** "TDM-12" for one ticket, "TDM-12–TDM-19" for a span, null when the batch
 *  has no numbered tickets (an epic whose tasks all predate ticket numbers). */
export function ticketRange(tasks: Action[]): string | null {
  const nums = tasks
    .map((t) => t.ticket)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (nums.length === 0) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return lo === hi ? `TDM-${lo}` : `TDM-${lo}–TDM-${hi}`;
}

/** How many of these tasks sit in each state (only the states present). */
function countByState(tasks: Action[]): Map<ActionState, number> {
  const out = new Map<ActionState, number>();
  for (const t of tasks) out.set(t.state, (out.get(t.state) ?? 0) + 1);
  return out;
}

// ── Epic timeline ────────────────────────────────────────────────────────────

/** One entry on the timeline: a batch that has stopped moving. */
export interface TimelineEpic {
  id: string;
  title: string;
  /** Never "active" — the timeline is the finished-work axis. */
  lifecycle: Exclude<EpicLifecycle, "active">;
  ticketRange: string | null;
  taskCount: number;
  doneCount: number;
  failedCount: number;
  /** When the batch stopped moving; null when nothing datable is on it. */
  completedAt: string | null;
  completedMs: number | null;
  /** First line of the epic's summary, when it has one. */
  summaryLine: string | null;
}

/**
 * Finished (drained) and archived (rejected) epics in CHRONOLOGICAL order —
 * oldest first, so reading top to bottom is reading the project's history.
 *
 * Completion instant: for a drained epic, the newest updatedAt among its tasks
 * (the last one to go terminal — TaskBoard's drain chip measures to the same
 * point). For an archived epic, the epic's own updatedAt: the moment it was
 * rejected, since its tasks may never have moved at all.
 */
export function epicTimeline(state: CanvasState): TimelineEpic[] {
  const { epics, tasksByEpic } = indexActions(state);
  const entries: TimelineEpic[] = [];

  for (const epic of epics) {
    const tasks = tasksByEpic.get(epic.id) ?? [];
    const lifecycle = epicLifecycle(epic, tasks);
    if (lifecycle === "active") continue;

    const taskMs = tasks
      .map((t) => msOf(t.updatedAt))
      .filter((n): n is number => n !== null);
    const epicMs = msOf(epic.updatedAt);
    const completedMs =
      lifecycle === "archived"
        ? epicMs
        : taskMs.length > 0
          ? Math.max(...taskMs)
          : epicMs;

    const summary = summaryOf(epic);
    const counts = countByState(tasks);

    entries.push({
      id: epic.id,
      title: titleOf(epic) || "Untitled epic",
      lifecycle,
      ticketRange: ticketRange(tasks),
      taskCount: tasks.length,
      doneCount: counts.get("done") ?? 0,
      failedCount: counts.get("failed") ?? 0,
      completedAt: completedMs === null ? null : new Date(completedMs).toISOString(),
      completedMs,
      summaryLine: summary ? (summary.split("\n").find((l) => l.trim()) ?? "").trim() || null : null,
    });
  }

  // Oldest → newest. Anything undatable sinks to the bottom rather than
  // claiming the epoch and pretending to be the project's first shipment.
  return entries.sort((a, b) => {
    if (a.completedMs === null && b.completedMs === null) return a.title.localeCompare(b.title);
    if (a.completedMs === null) return 1;
    if (b.completedMs === null) return -1;
    return a.completedMs - b.completedMs;
  });
}

// ── Completion statistics ────────────────────────────────────────────────────

/** One row of the per-epic progress list. `id: null` is the no-epic bucket. */
export interface EpicProgress {
  id: string | null;
  title: string;
  lifecycle: EpicLifecycle;
  total: number;
  done: number;
  working: number;
  ticketRange: string | null;
}

export interface StateCount {
  state: ActionState;
  count: number;
}

export interface CompletionStatsData {
  /** Every task on the canvas, including rejected ones. */
  total: number;
  /** Counts in board order — all six states, zeros included. */
  byState: StateCount[];
  done: number;
  /** Done + failed + rejected: work that will not move again. */
  terminal: number;
  working: number;
  /** done / total as a whole percent (0 when there are no tasks). */
  donePercent: number;
  /** Done tasks whose last move was inside the trailing 7 days, and before. */
  doneLast7: number;
  doneBefore: number;
  perEpic: EpicProgress[];
}

/**
 * The "where does this stand" numbers, derived from canvas state alone.
 *
 * `now` is injectable so the 7-day split is a pure function of its inputs;
 * callers in the UI leave it out and get wall-clock.
 */
export function completionStats(state: CanvasState, now: number = Date.now()): CompletionStatsData {
  const { tasks, epics, tasksByEpic, orphans } = indexActions(state);
  const counts = countByState(tasks);
  const byState: StateCount[] = TASK_STATE_ORDER.map((s) => ({
    state: s,
    count: counts.get(s) ?? 0,
  }));

  const done = counts.get("done") ?? 0;
  const working = counts.get("executing") ?? 0;
  const terminal = tasks.filter((t) => TERMINAL_STATES.includes(t.state)).length;

  const cutoff = now - WEEK_MS;
  let doneLast7 = 0;
  for (const t of tasks) {
    if (t.state !== "done") continue;
    const ms = msOf(t.updatedAt);
    if (ms !== null && ms >= cutoff) doneLast7 += 1;
  }

  // Per-epic rows: live batches first (that's where the movement is), then
  // newest-first inside each group, so the list reads like the board's sidebar.
  const perEpic: EpicProgress[] = epics
    .map((epic) => {
      const list = tasksByEpic.get(epic.id) ?? [];
      const c = countByState(list);
      return {
        id: epic.id,
        title: titleOf(epic) || "Untitled epic",
        lifecycle: epicLifecycle(epic, list),
        total: list.length,
        done: c.get("done") ?? 0,
        working: c.get("executing") ?? 0,
        ticketRange: ticketRange(list),
        createdMs: msOf(epic.createdAt) ?? 0,
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => {
      const rank = (l: EpicLifecycle) => (l === "active" ? 0 : 1);
      if (rank(a.lifecycle) !== rank(b.lifecycle)) return rank(a.lifecycle) - rank(b.lifecycle);
      return b.createdMs - a.createdMs;
    })
    .map(({ createdMs: _createdMs, ...row }) => row);

  if (orphans.length > 0) {
    const c = countByState(orphans);
    perEpic.push({
      id: null,
      title: "No epic",
      lifecycle: "active",
      total: orphans.length,
      done: c.get("done") ?? 0,
      working: c.get("executing") ?? 0,
      ticketRange: ticketRange(orphans),
    });
  }

  return {
    total: tasks.length,
    byState,
    done,
    terminal,
    working,
    donePercent: tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100),
    doneLast7,
    doneBefore: done - doneLast7,
    perEpic,
  };
}
