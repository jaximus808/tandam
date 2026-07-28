import type { Action, ActionState } from "../types";

/* ─────────────────────────────────────────────────────────────────────────────
   Epic lifecycle (TDM-9 age-out) — the ONE derived predicate shared by the
   Board sidebar and the Tasks panel. Purely frontend-derived from canvas
   state; nothing is persisted server-side.

     · finished — approved, has at least one task, and every task is terminal
       (done / failed / rejected): the epic has drained.
     · archived — the epic itself was rejected.
     · active   — everything else, including approved-with-zero-tasks (an
       empty epic is awaiting tasks, not finished).
   ──────────────────────────────────────────────────────────────────────────── */

// Terminal task states — a task in one of these never moves again on its own.
export const TERMINAL_STATES: ActionState[] = ["done", "failed", "rejected"];

export type EpicLifecycle = "active" | "finished" | "archived";

export function epicLifecycle(epic: Action, epicTasks: Action[]): EpicLifecycle {
  if (epic.state === "rejected") return "archived";
  if (
    epic.state === "approved" &&
    epicTasks.length > 0 &&
    epicTasks.every((t) => TERMINAL_STATES.includes(t.state))
  ) {
    return "finished";
  }
  return "active";
}
