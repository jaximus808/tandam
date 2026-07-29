import { Zap } from "lucide-react";
import type { CanvasMode } from "../types";
import type { AgentEdit, PresentAgent } from "../lib/useAgentActivity";
import { STATE_CHIP } from "../lib/stateChips";

interface Props {
  agents: PresentAgent[];
  edit: AgentEdit | null;
  reading: boolean;
  onJump: (mode: CanvasMode) => void;
  // Follow an agent to its task: opens the Board focused on the given task
  // (scope → epic, detail slide-over open). Fired from any presence surface
  // where an agent shows a claimed task.
  onOpenTask: (taskId: string) => void;
  // Open the fleet roster (components/FleetView.tsx) — the cluster is the
  // second door into it, since "who are these agents?" is exactly the question
  // the cluster raises.
  onOpenFleet: () => void;
}

const MODE_LABEL: Record<CanvasMode, string> = {
  welcome: "Templates",
  map: "Map",
  itinerary: "Itinerary",
  docs: "Docs",
  roadmap: "Roadmap",
  sheets: "Sheets",
  charts: "Charts",
};

/**
 * Header presence: who's in the room right now (agents), and — when one is
 * mid-edit — a live "editing {Mode}" chip you can click to jump to where it's
 * working. This surface answers "is something happening on my canvas"; the
 * roster question ("who are they, what do they hold, what's blocked") belongs
 * to the fleet panel, which the cluster opens. The swarm tree that used to drop
 * out of this cluster was retired into that panel (TDM-47) rather than shipping
 * two overlapping popovers a few pixels apart.
 */
export default function AgentPresence({ agents, edit, reading, onJump, onOpenTask, onOpenFleet }: Props) {
  if (agents.length === 0) return null;
  // Editing takes precedence over reading — if a cursor is live, show where.
  const showReading = !edit && reading;

  // "Following them = seeing their task": the most recent claimant among the
  // present agents gets a compact Zap TDM-n chip beside the cluster that clicks
  // through to the task on the Board. Working-violet, matching the board's
  // executing treatment.
  const followed = [...agents]
    .filter((a) => a.taskId)
    // Numeric compare, not string: RFC3339Nano strips trailing zeros, so a
    // lexicographic sort misorders same-second claims (".5Z" < "Z").
    .sort(
      (x, y) =>
        (Date.parse(y.taskClaimedAt ?? "") || 0) - (Date.parse(x.taskClaimedAt ?? "") || 0),
    )[0];

  return (
    <div className="relative hidden items-center gap-2 sm:flex">
      {/* Avatar cluster — agents are square terracotta chips, like their tags.
          A scan-line sweeps across them while the agent is reading. Clicking
          anywhere but a mid-task chip opens the fleet roster. */}
      <div
        className="flex -space-x-1 cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        role="button"
        tabIndex={0}
        onClick={onOpenFleet}
        onKeyDown={(e) => {
          // Enter/Space on the cluster itself only — the nested avatar buttons
          // keep their own activation.
          if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
            e.preventDefault();
            onOpenFleet();
          }
        }}
        aria-label="Open the fleet roster"
        title="Open the fleet"
      >
        {agents.map((a) => {
          const title = [a.isClaude ? `${a.name} (Claude)` : a.name, a.taskLabel && `working ${a.taskLabel}`]
            .filter(Boolean)
            .join(" — ");
          // Agent identity is the ONE place terracotta survives (muted, via the
          // `agent` token); non-Claude sessions get a fixed neutral.
          const cls = `relative grid h-6 w-6 place-items-center overflow-hidden rounded-[5px] ring-2 ring-paper ${
            a.isClaude ? "bg-agent" : "bg-zinc-800"
          }`;
          // Mid-task agents click through to their task on the Board
          // (stopPropagation so the cluster's swarm-panel toggle doesn't fire).
          return a.taskId ? (
            <button
              key={a.id}
              onClick={(e) => {
                e.stopPropagation();
                onOpenTask(a.taskId!);
              }}
              title={`${title} — open on the Board`}
              aria-label={`Open ${a.name}'s task ${a.taskTicket ?? ""} on the Board`}
              className={`${cls} cursor-pointer`}
            >
              <Sparkle />
              {showReading && <span aria-hidden="true" className="tandem-scan absolute inset-0" />}
            </button>
          ) : (
            <span key={a.id} title={title} className={cls}>
              <Sparkle />
              {showReading && <span aria-hidden="true" className="tandem-scan absolute inset-0" />}
            </span>
          );
        })}
      </div>

      {/* Mid-task mini-chip — the most recent claimant's ticket, one click from
          the task itself. Sits beside the cluster, styled like the header's
          other status chips. */}
      {followed?.taskId && (
        <button
          onClick={() => onOpenTask(followed.taskId!)}
          className={`inline-flex items-center gap-1 rounded-[4px] bg-violet-500/10 px-2 py-1 font-code text-[10.5px] font-medium ring-1 ring-inset ring-violet-500/20 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${STATE_CHIP.executing.text}`}
          title={`${followed.name} is working ${followed.taskLabel ?? "a task"} — open it on the Board`}
          aria-label={`Open ${followed.name}'s task ${followed.taskTicket ?? ""} on the Board`}
        >
          <Zap size={11} className="shrink-0" />
          {followed.taskTicket ?? "task"}
        </button>
      )}

      {/* Live status chip. Priority: editing (where it's writing) → reading
          (it's looking at the canvas) → idle ("here"). Agent activity is
          terracotta EVERYWHERE (the `agent` token) — the chip names the mode
          in words instead of borrowing the mode's content hue (/DESIGN.md:
          modeTheme is content-level semantics only). */}
      {edit ? (
        <button
          onClick={() => onJump(edit.mode)}
          className="inline-flex items-center gap-1.5 rounded-[4px] bg-agent/10 px-2 py-1 text-[10.5px] font-medium text-agent ring-1 ring-inset ring-agent/20 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={`Jump to ${MODE_LABEL[edit.mode]} — where it's writing`}
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-agent opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-agent" />
          </span>
          editing {MODE_LABEL[edit.mode].toLowerCase()}
        </button>
      ) : showReading ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-[4px] bg-agent/10 px-2 py-1 text-[10.5px] font-medium text-agent ring-1 ring-inset ring-agent/20"
          title="The agent is reading the canvas"
        >
          {/* Three sweeping bars — a little "scanning" equaliser. */}
          <span className="flex items-end gap-[2px]" aria-hidden="true">
            <span className="tandem-read-bar h-2 w-[2px] rounded-full bg-agent" style={{ animationDelay: "0ms" }} />
            <span className="tandem-read-bar h-2 w-[2px] rounded-full bg-agent" style={{ animationDelay: "140ms" }} />
            <span className="tandem-read-bar h-2 w-[2px] rounded-full bg-agent" style={{ animationDelay: "280ms" }} />
          </span>
          reading
        </span>
      ) : (
        <span className="text-[10.5px] font-medium text-ink/50">here</span>
      )}
    </div>
  );
}

function Sparkle() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M6 0.5 C6.4 3 7.2 3.8 9.5 4.2 C7.2 4.6 6.4 5.4 6 7.8 C5.6 5.4 4.8 4.6 2.5 4.2 C4.8 3.8 5.6 3 6 0.5 Z"
        fill="white"
      />
      <circle cx="10" cy="9" r="1" fill="white" opacity="0.85" />
    </svg>
  );
}
