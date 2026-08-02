import { Gauge } from "lucide-react";
import type { CanvasState } from "../types";
import CompletionStats from "./CompletionStats";
import EpicTimeline from "./EpicTimeline";
import StaleTasksSection from "./StaleTasksSection";

/* ─────────────────────────────────────────────────────────────────────────────
   SummaryPanel — the Summary surface's full-page view (TDM-192 shell).

   The read-only "where does this project stand" answer: epics over time, the
   completion numbers, and the work that has stopped moving. It derives
   everything from the same canvas-state props every other view gets, so WS
   pushes move it live — no polling, no fetches, and it works unchanged under
   the mock backend (lib/mockWS.ts).

   It is a COMPOSITION POINT and nothing else: each section is its own file and
   owns its own layout, so the follow-up tickets that fill them in (TDM-193,
   TDM-195) touch one section file each and never this one. Adding a section
   here is the only reason to edit this file.
   ──────────────────────────────────────────────────────────────────────────── */

export default function SummaryPanel({
  code,
  state,
}: {
  /** Canvas code — passed to sections that link back into the board. */
  code: string;
  /** The live canvas state; sections read `state.actions` for epics + tasks. */
  state: CanvasState;
}) {
  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto bg-paper text-ink">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Gauge size={18} strokeWidth={1.75} className="text-ink/45" />
            <h2 className="text-[15px] font-semibold tracking-tight text-ink/85">Summary</h2>
          </div>
          <p className="text-[13px] text-ink/50">
            Where this canvas stands — read-only, and live as the board changes.
          </p>
        </header>

        <EpicTimeline state={state} code={code} />
        <CompletionStats state={state} code={code} />
        <StaleTasksSection state={state} code={code} />
      </div>
    </div>
  );
}
