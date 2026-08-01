import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import type { GateMetrics } from "../lib/api";
import { fetchGateMetrics } from "../lib/api";

/* ─────────────────────────────────────────────────────────────────────────────
   GateRecord — the approval gate's report card, and the ONE renderer for it.

   TDM-165 derived the figure server-side (`GET /api/canvas/gate`) and put it in
   Settings, under the policy disclosure it reports on. TDM-172 brings it to the
   Board, where the gating actually happens — and the reason it is a shared
   component rather than a second copy of the markup is the constraint itself:
   the qualifying words ship from the server WITH the numbers so that no surface
   can render the figure without them. Two hand-written copies is exactly how one
   of them ends up without the caveat.

   ── Why the board shows it behind a word, not as a badge ────────────────────

   The obvious board placement — a "23%" chip in the toolbar, or beside the
   Proposed lane's Approve/Reject buttons — is the one placement this metric
   cannot survive. A rate rendered permanently next to the buttons that move it
   is a score, and a score you can raise by rejecting produces rejection
   theater: it destroys good tickets AND fakes the measurement, which is worse
   than rubber-stamping. The server's own caveat says so in as many words.

   So the board gets a DISCLOSURE, not a readout:
     · the trigger is a WORD ("Gate record"), never the number. Nothing about
       the board's resting state tells you whether you are "doing well", so
       there is no figure sitting in your eyeline while you decide on a ticket;
     · opening it renders the figure and the server's caveat and definition
       together, in one panel, always — the caveat is not a tooltip and not
       collapsed. You cannot get the number out of this UI without the words;
     · it is fetched only when opened. A number you have to ask for is a
       diagnostic; a number that greets you is a target.

   That answers "readable from the board without opening Settings" — one click,
   on the board, no surface switch — without turning the board into a
   leaderboard.

   ── Everything below is ungamified on purpose ───────────────────────────────

   No progress bar, no goal line, no target rendered as a thing to reach; no
   green/red and no "good"/"bad", so the UI never congratulates you for
   rejecting or scolds you for approving. Every figure is plain ink. If you are
   editing this file and reaching for a colour or a meter, that is the thing
   this component exists to refuse.
   ──────────────────────────────────────────────────────────────────────────── */

/** Fetch the gate's report card. `enabled` false holds the request — the board
 *  passes the disclosure's open state, so a board nobody asks costs nothing.
 *  Null forever on failure: a metric that can't load must never break the
 *  surface it lives in, so callers render the surface and skip the section. */
export function useGateMetrics(
  code: string,
  enabled = true,
): { gate: GateMetrics | null; loading: boolean } {
  const [gate, setGate] = useState<GateMetrics | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    (async () => {
      try {
        const m = await fetchGateMetrics(code);
        if (live) setGate(m);
      } catch {
        if (live) setGate(null);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [code, enabled]);

  return { gate, loading };
}

/** The report card itself: heading, figure, the sentence that reads it, the
 *  all-time line, the server's caveat, and the server's definition. Callers
 *  supply their own section wrapper; nothing here is optional, because the
 *  parts that qualify the number are the reason it is safe to show. */
export function GateRecord({ gate }: { gate: GateMetrics }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink/40">
          Pre-work intervention
        </p>
        <span className="rounded-full bg-ink/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-ink/50">
          {gate.windowDays}d
        </span>
      </div>

      {gate.window.hasRate ? (
        <>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-3xl font-semibold tracking-tight tabular-nums text-ink">
              {gate.window.ratePct}
            </span>
            <span className="text-lg font-medium tabular-nums text-ink/35">%</span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink/45">
            {gate.window.intervened} of {gate.window.decided} decided ticket
            {gate.window.decided === 1 ? " was" : "s were"} rejected or rewritten before an agent
            built {gate.window.intervened === 1 ? "it" : "them"}.
          </p>
        </>
      ) : (
        <p className="mt-2 text-[12px] leading-relaxed text-ink/45">
          Nothing decided in the last {gate.windowDays} days — no rate to report yet.
          {gate.window.pending > 0 &&
            ` ${gate.window.pending} ticket${gate.window.pending === 1 ? " is" : "s are"} still in the gate.`}
        </p>
      )}

      {/* All-time alongside the window: a board that used to have a gate and one
          that still does are different situations, and only the pair
          distinguishes them. */}
      {gate.allTime.hasRate && (
        <p className="mt-1.5 font-code text-[11px] leading-relaxed text-ink/35">
          all time {gate.allTime.ratePct}% · {gate.allTime.rejected} rejected ·{" "}
          {gate.allTime.amended} amended · {gate.allTime.decided} decided
          {gate.allTime.rejectionsUndone > 0 &&
            ` · ${gate.allTime.rejectionsUndone} rejection${gate.allTime.rejectionsUndone === 1 ? "" : "s"} undone`}
          {gate.allTime.postWorkBounces > 0 &&
            ` · ${gate.allTime.postWorkBounces} sent back after the work`}
          {gate.allTime.ungatedAuto > 0 && ` · ${gate.allTime.ungatedAuto} ungated`}
        </p>
      )}

      <p className="mt-2.5 text-[12px] leading-relaxed text-ink/45">{gate.caveat}</p>

      {/* The definition, verbatim from the server. A metric whose definition is
          implicit gets misread, and this one has two edges people guess wrong:
          what counts as "materially amended", and what an undone rejection does
          to the number. */}
      <details className="mt-2 [&_summary::-webkit-details-marker]:hidden">
        <summary className="cursor-pointer list-none text-[11px] font-medium text-ink/40 transition-colors hover:text-ink/65">
          How this is counted
        </summary>
        <ul className="mt-2 space-y-1.5 border-l border-ink/10 pl-3">
          {gate.definition.map((line) => (
            <li key={line} className="text-[11px] leading-relaxed text-ink/40">
              {line}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/** The board's route to the record: a labelled control that opens the report
 *  card in place. The trigger never carries the figure — see the note at the
 *  top of this file for why that is the whole design. */
export function GateRecordDisclosure({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const { gate, loading } = useGateMetrics(code, open);

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Gate record — what this board's approval gate has actually done"
        title="What this board's approval gate has actually done with agent-proposed work"
        className={[
          "flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-7",
          open ? "bg-ink/[0.06] text-ink/80" : "text-ink/50 hover:bg-ink/5 hover:text-ink/80",
        ].join(" ")}
      >
        <ScrollText size={13} className="shrink-0" aria-hidden="true" />
        <span className="hidden sm:inline">Gate record</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="tandem-fade-in absolute left-0 z-40 mt-1.5 max-h-[70vh] w-[21rem] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-lg border border-ink/10 bg-surface p-4 shadow-lg">
            {gate ? (
              <GateRecord gate={gate} />
            ) : (
              <p className="text-[12px] leading-relaxed text-ink/45">
                {loading
                  ? "Reading the gate record…"
                  : "The gate record could not be loaded right now."}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
