import { Timer } from "lucide-react";
import type { CanvasState } from "../types";

/* ─────────────────────────────────────────────────────────────────────────────
   StaleTasksSection — a Summary surface section (stub).

   Will list the open work that has stopped moving: tasks sitting proposed or
   approved for too long, and claims whose heartbeat has lapsed — each with an
   age chip, so the stuck things are visible without scanning the board.

   SHELL ONLY (TDM-192). The section is deliberately SELF-CONTAINED — no shared
   section wrapper — so the follow-up that fills it in edits this file and only
   this file, never SummaryPanel or its sibling sections. Take the props you
   need from `state` / `code`; both are already wired. (`lib/lease.ts` already
   derives claim staleness for the board — reuse it rather than re-deriving.)
   ──────────────────────────────────────────────────────────────────────────── */

export default function StaleTasksSection({
  state,
  code,
}: {
  /** The live canvas state — tasks live in `state.actions`. */
  state: CanvasState;
  /** Canvas code, for building links into the board / a ticket page. */
  code: string;
}) {
  void state;
  void code;

  return (
    <section aria-labelledby="summary-stale-tasks" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Timer size={15} strokeWidth={1.75} className="text-ink/40" />
        <h3
          id="summary-stale-tasks"
          className="text-[13px] font-semibold tracking-tight text-ink/80"
        >
          Stale tasks
        </h3>
      </div>
      <div className="rounded-md border border-dashed border-ink/15 bg-surface px-4 py-6 text-[13px] text-ink/45">
        Open work that stopped moving, with age chips. Coming in TDM-195.
      </div>
    </section>
  );
}
