import { Milestone } from "lucide-react";
import type { CanvasState } from "../types";

/* ─────────────────────────────────────────────────────────────────────────────
   EpicTimeline — a Summary surface section (stub).

   Will render the canvas's epics on a time axis: when each was proposed,
   approved and drained, with its tickets' states rolled up, so "what has this
   project actually shipped, and in what order" is one read.

   SHELL ONLY (TDM-192). The section is deliberately SELF-CONTAINED — no shared
   section wrapper — so the follow-up that fills it in edits this file and only
   this file, never SummaryPanel or its sibling sections. Take the props you
   need from `state` / `code`; both are already wired.
   ──────────────────────────────────────────────────────────────────────────── */

export default function EpicTimeline({
  state,
  code,
}: {
  /** The live canvas state — epics/tasks live in `state.actions`. */
  state: CanvasState;
  /** Canvas code, for building links into the board / a ticket page. */
  code: string;
}) {
  void state;
  void code;

  return (
    <section aria-labelledby="summary-epic-timeline" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Milestone size={15} strokeWidth={1.75} className="text-ink/40" />
        <h3
          id="summary-epic-timeline"
          className="text-[13px] font-semibold tracking-tight text-ink/80"
        >
          Epic timeline
        </h3>
      </div>
      <div className="rounded-md border border-dashed border-ink/15 bg-surface px-4 py-6 text-[13px] text-ink/45">
        Epics on a time axis — proposed, approved, drained. Coming in TDM-193.
      </div>
    </section>
  );
}
