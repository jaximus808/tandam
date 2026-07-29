import { useMemo } from "react";
import { X } from "lucide-react";
import type { FeedEvent } from "../lib/useActivityFeed";
import { factKey } from "../lib/useActivityFeed";
import { ageOf, fullDate } from "../lib/relativeTime";

/* ─────────────────────────────────────────────────────────────────────────────
   ActivityFeed — the fleet's chronological record (TDM-48). Lives inside the
   FleetView popover as its second tab, because "who is working" and "what just
   happened" are two readings of one question and deserve one place.

   THE HANDOFF. Agents on a Tandem board do not message each other; they move
   state. So the closest thing this product has to a team conversation is the
   completion summary an agent leaves behind when it finishes — the next session
   picks the work up from that sentence. The feed treats it accordingly: every
   other fact is a one-liner, and a completion with a result gets a second line
   under it with room to actually be read.

   SHAPE. Exactly the roster's rhythm, so the two tabs scan the same way:

     planner-1                                    ← actor, mono; click to filter
       claimed     TDM-47  Fleet panel UI     12m
       completed   TDM-47  Fleet panel UI      2m
       │ Added FleetView + the roster hook; pnpm build green
     doc-agent
       proposed    TDM-49  Activity feed       5m

   verb column (colour = state) · ticket · title · mono age. Consecutive facts
   from one actor share a header — on a board where one agent does six things in
   a row, repeating its name six times is noise, not information.

   COLOUR. The closed semantic set from DESIGN.md and nothing else: working
   violet, done emerald, failed rose, ready sky, rejected zinc, and amber for
   the "went backwards" family (released / requeued / expired) — the facts that
   actually want your attention. `proposed` stays neutral ink: it is the most
   common fact on the board and lighting all of them up would say nothing.
   ──────────────────────────────────────────────────────────────────────────── */

interface Props {
  events: FeedEvent[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  /** Focus the action on the Board — the same handler the roster's rows use. */
  onOpenTask: (taskId: string) => void;
  /** Narrow the feed to one agent; null = everyone. */
  actorFilter: string | null;
  onFilterChange: (actor: string | null) => void;
}

// ── verbs ────────────────────────────────────────────────────────────────────

type Tone = "violet" | "emerald" | "rose" | "amber" | "sky" | "zinc" | "quiet";

const TONE_CLS: Record<Tone, string> = {
  violet: "text-violet-600 dark:text-violet-400",
  emerald: "text-emerald-600 dark:text-emerald-400",
  rose: "text-rose-600 dark:text-rose-400",
  amber: "text-amber-600 dark:text-amber-500",
  sky: "text-sky-600 dark:text-sky-400",
  zinc: "text-zinc-500 dark:text-zinc-400",
  quiet: "text-ink/55",
};

function verbOf(e: FeedEvent): { label: string; tone: Tone } {
  switch (e.action) {
    case "claimed":
      return { label: "claimed", tone: "violet" };
    // "completed" is the transition, not the outcome — the outcome is in state.
    case "completed":
      return e.state === "failed"
        ? { label: "failed", tone: "rose" }
        : { label: "completed", tone: "emerald" };
    case "approved":
      return { label: "approved", tone: "sky" };
    case "rejected":
      return { label: "rejected", tone: "zinc" };
    case "released":
      return { label: "released", tone: "amber" };
    case "requeued":
      return { label: "requeued", tone: "amber" };
    case "claim_expired":
      return { label: "expired", tone: "amber" };
    case "proposed":
    default:
      return { label: "proposed", tone: "quiet" };
  }
}

// Human-readable sentence for a screen reader, where the column layout is no help.
function spoken(e: FeedEvent): string {
  const { label } = verbOf(e);
  const what = e.ticketId ?? (e.title ? `"${e.title}"` : `a ${e.actionType}`);
  return `${e.actor ?? "Someone"} ${label} ${what}, ${ageOf(e.at)} ago.`;
}

// ── component ────────────────────────────────────────────────────────────────

export default function ActivityFeed({
  events,
  loading,
  error,
  onReload,
  onOpenTask,
  actorFilter,
  onFilterChange,
}: Props) {
  const shown = useMemo(
    () => (actorFilter ? events.filter((e) => (e.actor ?? "") === actorFilter) : events),
    [events, actorFilter],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The one filter this surface has, and its own dismissal. */}
      {actorFilter && (
        <div className="flex shrink-0 items-center gap-2 border-b border-ink/[0.07] px-3 py-1.5">
          <span className="shrink-0 text-[11px] text-ink/50">Only</span>
          <button
            onClick={() => onFilterChange(null)}
            title="Show every agent again"
            aria-label={`Filtering by ${actorFilter}. Clear the filter.`}
            className="group inline-flex min-w-0 items-center gap-1 rounded-[4px] bg-agent/10 py-px pl-1.5 pr-1 font-code text-[10.5px] font-medium text-agent transition-colors hover:bg-agent/[0.18] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <span className="truncate">{actorFilter}</span>
            <X size={11} className="shrink-0 opacity-70 group-hover:opacity-100" />
          </button>
          <span className="ml-auto shrink-0 font-code text-[10.5px] text-ink/50 tabular-nums">
            {shown.length}
          </span>
        </div>
      )}

      {/* A failed refresh keeps the history on screen — stale beats blank. */}
      {error && events.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-ink/[0.07] px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink/50">
            Couldn't refresh — showing what we have.
          </span>
          <button
            onClick={onReload}
            className="shrink-0 text-[11px] font-medium text-accent transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Retry
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && events.length === 0 ? (
          <div className="px-3 py-4">
            <p className="text-[12.5px] leading-relaxed text-ink/70">{error}</p>
            <button
              onClick={onReload}
              className="mt-2 rounded-md border border-ink/15 px-2.5 py-1 text-[12px] font-medium text-ink/70 transition-colors hover:border-ink/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Try again
            </button>
          </div>
        ) : loading && events.length === 0 ? (
          <p className="px-3 py-4 text-[12.5px] text-ink/50">Reading the feed…</p>
        ) : shown.length === 0 && actorFilter ? (
          <div className="px-3 py-4">
            <p className="text-[12.5px] font-medium text-ink/80">
              Nothing recent from {actorFilter}.
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink/55">
              The feed holds the last {events.length} facts on this canvas. This agent isn't
              among them.
            </p>
            <button
              onClick={() => onFilterChange(null)}
              className="mt-2 rounded-md border border-ink/15 px-2.5 py-1 text-[12px] font-medium text-ink/70 transition-colors hover:border-ink/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Show every agent
            </button>
          </div>
        ) : shown.length === 0 ? (
          <div className="px-3 py-4">
            <p className="text-[12.5px] font-medium text-ink/80">Nothing has happened yet.</p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink/55">
              Every proposal, claim, and completion on this canvas lands here the moment it
              happens — with whatever the agent wrote up on its way out.
            </p>
          </div>
        ) : (
          <ul className="py-1">
            {shown.map((e, i) => (
              <FeedRow
                key={factKey(e)}
                event={e}
                // Consecutive facts from one actor share the header above them.
                showActor={i === 0 || (shown[i - 1].actor ?? "") !== (e.actor ?? "")}
                onOpenTask={onOpenTask}
                onFilterActor={onFilterChange}
                filtered={actorFilter !== null}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* One fact. The event line is the click target when it points at a task (the
   roster's TaskLine does the same), so the whole row — not a 40px chip — is
   what you aim at on a dense list. */
function FeedRow({
  event,
  showActor,
  onOpenTask,
  onFilterActor,
  filtered,
}: {
  event: FeedEvent;
  showActor: boolean;
  onOpenTask: (taskId: string) => void;
  onFilterActor: (actor: string) => void;
  filtered: boolean;
}) {
  const verb = verbOf(event);
  const actor = event.actor ?? "unknown";
  const title = event.title || `Untitled ${event.actionType}`;
  // Only tasks have a home on the Board; an epic or a navigate op has no detail
  // view to focus, so those rows stay a readout rather than a dead button.
  const openable = event.actionType === "task";
  // The completion summary — the handoff. Errors take the same slot: a failure
  // with no reason on screen is the one thing worse than a failure.
  const note = (event.result || event.error || "").trim();

  const line = (
    <>
      <span className={`w-[62px] shrink-0 text-[11px] ${TONE_CLS[verb.tone]}`}>{verb.label}</span>
      {event.ticketId && (
        <span className="shrink-0 font-code text-[10.5px] font-medium text-ink/60">
          {event.ticketId}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink/70">{title}</span>
      <span
        className="shrink-0 font-code text-[10.5px] text-ink/50"
        title={fullDate(event.at)}
      >
        {ageOf(event.at)}
        {/* The right column is uniformly "how long ago" — say so where the
            visual column carries no meaning. */}
        <span className="sr-only"> ago</span>
      </span>
    </>
  );

  return (
    <li className={event.fresh ? "tandem-arrive" : undefined}>
      {showActor && !filtered && (
        <button
          onClick={() => onFilterActor(actor)}
          title={`Show only ${actor}`}
          aria-label={`Show only activity from ${actor}`}
          className="mt-1 flex max-w-full items-center rounded-[4px] px-3 py-px text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        >
          <span className="truncate font-code text-[11.5px] font-medium text-ink">{actor}</span>
        </button>
      )}

      <div className={filtered ? "px-3" : "pl-[22px] pr-3"}>
        {openable ? (
          <button
            onClick={() => onOpenTask(event.actionId)}
            title={`${event.ticketId ? `${event.ticketId} — ` : ""}${title}\nOpen on the Board`}
            aria-label={`${spoken(event)} Open it on the board.`}
            className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-[4px] px-1 py-px text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {line}
          </button>
        ) : (
          <div className="flex items-center gap-2 py-px">{line}</div>
        )}

        {note && (
          <p
            title={note}
            className="ml-[3px] mb-1 mt-0.5 line-clamp-2 border-l border-ink/15 pl-2 text-[11.5px] leading-[1.45] text-ink/55"
          >
            {note}
          </p>
        )}
      </div>
    </li>
  );
}
