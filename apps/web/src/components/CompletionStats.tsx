import { ListChecks } from "lucide-react";
import type { CanvasState } from "../types";

/* ─────────────────────────────────────────────────────────────────────────────
   CompletionStats — a Summary surface section (stub).

   Will roll the canvas's tasks up into the "where does this stand" numbers:
   counts by state, how much of the board is done, and the recent completion
   rate — the same read board_status gives an agent, for a human.

   SHELL ONLY (TDM-192). The section is deliberately SELF-CONTAINED — no shared
   section wrapper — so the follow-up that fills it in edits this file and only
   this file, never SummaryPanel or its sibling sections. Take the props you
   need from `state` / `code`; both are already wired.
   ──────────────────────────────────────────────────────────────────────────── */

export default function CompletionStats({
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
    <section aria-labelledby="summary-completion-stats" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <ListChecks size={15} strokeWidth={1.75} className="text-ink/40" />
        <h3
          id="summary-completion-stats"
          className="text-[13px] font-semibold tracking-tight text-ink/80"
        >
          Completion stats
        </h3>
      </div>
      <div className="rounded-md border border-dashed border-ink/15 bg-surface px-4 py-6 text-[13px] text-ink/45">
        Counts by state, share done, recent throughput. Coming in TDM-193.
      </div>
    </section>
  );
}
