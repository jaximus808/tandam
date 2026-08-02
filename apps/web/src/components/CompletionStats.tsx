import { useMemo } from "react";
import { ListChecks } from "lucide-react";
import type { CanvasState } from "../types";
import { T_HEAD, T_META, T_ROW } from "../lib/boardScale";
import { CHIP_BASE, STATE_CHIP } from "../lib/stateChips";
import { completionStats, type EpicProgress } from "../lib/summaryDerive";

/* ─────────────────────────────────────────────────────────────────────────────
   CompletionStats — a Summary surface section (TDM-193).

   The "where does this stand" numbers a human would otherwise get by reading
   board_status: how much of the board is done, what every ticket is doing right
   now, how much of the done pile landed this week, and which batches are
   carrying it.

   Derived entirely from the canvas-state prop (lib/summaryDerive.ts) — no
   fetches, so it moves with the socket like everything else on the surface, and
   it works unchanged under the mock backend. Layout only: the arithmetic is in
   the lib, and this section touches no file but its own.
   ──────────────────────────────────────────────────────────────────────────── */

/** Segmented done/working bar on an ink track — the board's ProgressBar shape,
 *  reimplemented here rather than refactoring TaskBoard to export it. */
function Bar({
  done,
  working,
  total,
  className = "",
}: {
  done: number;
  working: number;
  total: number;
  className?: string;
}) {
  const pct = (n: number) => (total > 0 ? `${(n / total) * 100}%` : "0%");
  return (
    <div className={`flex overflow-hidden rounded-full bg-ink/[0.08] ${className}`}>
      {total > 0 && done > 0 && (
        <div className={`h-full ${STATE_CHIP.done.dot}`} style={{ width: pct(done) }} />
      )}
      {total > 0 && working > 0 && (
        <div
          className={`h-full animate-pulse opacity-80 ${STATE_CHIP.executing.dot}`}
          style={{ width: pct(working) }}
        />
      )}
    </div>
  );
}

function EpicRow({ row }: { row: EpicProgress }) {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span
          className={`min-w-0 flex-1 truncate text-ink/70 ${T_HEAD}`}
          title={row.ticketRange ? `${row.title} · ${row.ticketRange}` : row.title}
        >
          {row.title}
        </span>
        {row.ticketRange && (
          <span className={`shrink-0 font-code text-ink/35 ${T_META}`}>{row.ticketRange}</span>
        )}
        <span className={`shrink-0 font-code text-ink/50 ${T_META}`}>
          {row.done}/{row.total}
        </span>
      </div>
      <Bar done={row.done} working={row.working} total={row.total} className="h-1" />
    </li>
  );
}

export default function CompletionStats({
  state,
  code,
}: {
  /** The live canvas state — tasks live in `state.actions`. */
  state: CanvasState;
  /** Canvas code, for building links into the board / a ticket page. */
  code: string;
}) {
  // The stats are counts, not destinations — nothing in this section navigates.
  // `code` stays on the props contract every Summary section shares.
  void code;

  const stats = useMemo(() => completionStats(state), [state]);
  const present = stats.byState.filter((s) => s.count > 0);

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

      {stats.total === 0 ? (
        <div className="rounded-md border border-dashed border-ink/15 bg-surface px-4 py-6 text-[13px] text-ink/45">
          No tickets on this canvas yet. Counts, share done and recent throughput
          appear as soon as there is work to count.
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-md border border-ink/10 bg-surface px-4 py-3">
          {/* The headline: one number, then the bar it summarises. */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2">
              <span className="font-code text-[22px] font-semibold leading-none tracking-tight text-ink/85">
                {stats.donePercent}%
              </span>
              <span className={`text-ink/55 ${T_ROW}`}>
                done — {stats.done} of {stats.total} {stats.total === 1 ? "ticket" : "tickets"}
              </span>
            </div>
            <Bar done={stats.done} working={stats.working} total={stats.total} className="h-1.5" />
          </div>

          {/* Every ticket's state, in board order. */}
          <ul className="flex flex-wrap items-center gap-1.5">
            {present.map(({ state: s, count }) => {
              const def = STATE_CHIP[s] ?? STATE_CHIP.proposed;
              return (
                <li key={s} className="flex items-center gap-1">
                  <span className={`${CHIP_BASE} ${def.chip}`}>{def.label}</span>
                  <span className={`font-code text-ink/60 ${T_META}`}>{count}</span>
                </li>
              );
            })}
          </ul>

          {/* Throughput, split at the trailing week — the cheapest read of
              "is this project still moving, or is the done pile all history?" */}
          <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-ink/55 ${T_HEAD}`}>
            <span>
              <span className={`font-code font-semibold ${STATE_CHIP.done.text}`}>
                {stats.doneLast7}
              </span>{" "}
              done in the last 7 days
            </span>
            <span className="text-ink/40">
              <span className="font-code font-semibold">{stats.doneBefore}</span> before that
            </span>
            {stats.working > 0 && (
              <span className={STATE_CHIP.executing.text}>
                <span className="font-code font-semibold">{stats.working}</span> in flight
              </span>
            )}
          </div>

          {/* Per-batch progress — live epics first, then the ones that drained. */}
          {stats.perEpic.length > 0 && (
            <div className="flex flex-col gap-1.5 border-t border-ink/[0.08] pt-2.5">
              <h4 className={`font-semibold uppercase tracking-[0.08em] text-ink/40 ${T_META}`}>
                By epic
              </h4>
              <ul className="flex flex-col gap-2">
                {stats.perEpic.map((row) => (
                  <EpicRow key={row.id ?? "no-epic"} row={row} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
