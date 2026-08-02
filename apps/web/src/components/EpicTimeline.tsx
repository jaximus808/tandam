import { useMemo } from "react";
import { Milestone } from "lucide-react";
import type { CanvasState } from "../types";
import { T_HEAD, T_META, T_ROW } from "../lib/boardScale";
import { ageOf, fullDate } from "../lib/relativeTime";
import { CHIP_BASE, STATE_CHIP } from "../lib/stateChips";
import { epicTimeline, type TimelineEpic } from "../lib/summaryDerive";

/* ─────────────────────────────────────────────────────────────────────────────
   EpicTimeline — a Summary surface section (TDM-193).

   The canvas's finished work on a time axis: every epic that has stopped
   moving — drained (every ticket terminal) or archived (rejected) — oldest
   first, so reading down the rail is reading what this project shipped and in
   what order. Live epics are deliberately absent: they are what the board is
   for, and mixing them in would turn a history into a second backlog.

   Layout only. Every number and every ordering decision lives in
   lib/summaryDerive.ts (pure CanvasState → data), so this file never grows
   arithmetic and the section stays self-contained — no shared section wrapper,
   nothing here reaches into SummaryPanel or its siblings.
   ──────────────────────────────────────────────────────────────────────────── */

/** Lifecycle → the chip and dot it borrows from the closed state palette:
 *  a drained batch reads as done, an archived one as rejected. No new hues. */
const LOOK = {
  finished: { chip: STATE_CHIP.done, label: "Drained" },
  archived: { chip: STATE_CHIP.rejected, label: "Archived" },
} as const;

function TimelineEntry({ entry }: { entry: TimelineEpic }) {
  const look = LOOK[entry.lifecycle];
  const when = entry.completedAt;
  return (
    <li className="relative pl-5">
      {/* The rail node, straddling the border-left of the list. */}
      <span
        aria-hidden
        className={`absolute left-0 top-2 h-2 w-2 -translate-x-1/2 rounded-full ring-2 ring-paper ${look.chip.dot}`}
      />
      <div className="rounded-md border border-ink/10 bg-surface px-3 py-2">
        <div className="flex items-start gap-2">
          <span
            className={`min-w-0 flex-1 font-semibold leading-snug text-ink/85 ${T_ROW}`}
            title={entry.title}
          >
            {entry.title}
          </span>
          <span className={`${CHIP_BASE} ${look.chip.chip}`}>{look.label}</span>
        </div>

        <div
          className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-code text-ink/50 ${T_META}`}
        >
          {entry.ticketRange && <span>{entry.ticketRange}</span>}
          <span>
            {entry.taskCount} {entry.taskCount === 1 ? "ticket" : "tickets"}
          </span>
          <span>
            {entry.doneCount}/{entry.taskCount} done
          </span>
          {entry.failedCount > 0 && (
            <span className={STATE_CHIP.failed.text}>{entry.failedCount} failed</span>
          )}
          <span className="ml-auto" title={fullDate(when ?? undefined)}>
            {when ? `${ageOf(when)} ago` : "—"}
          </span>
        </div>

        {/* What the batch achieved, first line only — the whole summary lives
            on the board's epic panel, and the timeline is a scan, not a read. */}
        {entry.summaryLine && (
          <p className={`mt-1 truncate leading-snug text-ink/55 ${T_HEAD}`} title={entry.summaryLine}>
            {entry.summaryLine}
          </p>
        )}
      </div>
    </li>
  );
}

export default function EpicTimeline({
  state,
  code,
}: {
  /** The live canvas state — epics/tasks live in `state.actions`. */
  state: CanvasState;
  /** Canvas code, for building links into the board / a ticket page. */
  code: string;
}) {
  // Nothing here links out yet: an epic has no page of its own, and a ticket
  // RANGE has no single destination. `code` stays on the props contract every
  // Summary section shares rather than being dropped from this one alone.
  void code;

  const entries = useMemo(() => epicTimeline(state), [state]);

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
        {entries.length > 0 && (
          <span className={`font-code text-ink/40 ${T_META}`}>{entries.length}</span>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="rounded-md border border-dashed border-ink/15 bg-surface px-4 py-6 text-[13px] text-ink/45">
          No batch has finished yet. Epics land here once every ticket under them
          is terminal — or once the epic itself is rejected.
        </div>
      ) : (
        <ol className="ml-1 flex flex-col gap-2 border-l border-ink/10 pl-0">
          {entries.map((e) => (
            <TimelineEntry key={e.id} entry={e} />
          ))}
        </ol>
      )}
    </section>
  );
}
