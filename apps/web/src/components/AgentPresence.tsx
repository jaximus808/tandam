import { useState } from "react";
import { X, Zap } from "lucide-react";
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
 * Header presence: who's in the room (agents), and — when one is mid-edit — a
 * live "editing {Mode}" chip you can click to jump to where it's working.
 *
 * Swarm view (v1): when executors register with a parentId pointing at a
 * present orchestrator, a tree panel drops below the cluster — planner as the
 * parent node, its executors nested beneath, each labelled with the executing
 * task it claimed. Structural only (parentId set at agent_register); agents
 * without a present parent render flat as before.
 */
export default function AgentPresence({ agents, edit, reading, onJump, onOpenTask }: Props) {
  // Swarm panel visibility — dismissible (it floats over mode content at z-40,
  // so it must never be un-closable); the avatar cluster re-opens it.
  const [swarmOpen, setSwarmOpen] = useState(true);
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

  // Group executors under their (present) parent. An executor whose parent is
  // gone stays in the flat cluster only.
  const byId = new Map(agents.map((a) => [a.id, a]));
  const children = new Map<string, PresentAgent[]>();
  for (const a of agents) {
    if (a.parentId && byId.has(a.parentId)) {
      const kids = children.get(a.parentId) ?? [];
      kids.push(a);
      children.set(a.parentId, kids);
    }
  }
  // Roots only: an agent that both HAS a parent and IS a parent (planner →
  // sub-planner → executors) must render once, nested — not duplicated at the
  // top level. Rendering recurses through children.
  const roots = agents.filter(
    (a) => children.has(a.id) && (!a.parentId || !byId.has(a.parentId)),
  );

  function renderNode(a: PresentAgent, depth: number): JSX.Element {
    const kids = children.get(a.id) ?? [];
    return (
      <div key={a.id} className={depth === 0 ? "mb-2 last:mb-0" : ""}>
        <div className="flex min-w-0 items-center gap-1.5">
          <MiniChip isClaude={a.isClaude} size={depth === 0 ? 5 : 4} />
          <span
            className={
              depth === 0
                ? "truncate font-code text-[11px] font-medium text-ink"
                : "shrink-0 font-code text-[10.5px] text-ink/80"
            }
          >
            {a.name}
          </span>
          {depth === 0 ? (
            <span className="shrink-0 rounded-[3px] bg-ink/[0.06] px-1 py-px text-[10px] font-medium uppercase tracking-wide text-ink/50">
              {a.role ?? "planner"}
            </span>
          ) : a.taskLabel && a.taskId ? (
            // Following this executor = seeing its task: click through to the
            // Board, scoped to the task's epic with its detail open.
            // Working-violet — the shared executing-state hue.
            <button
              onClick={() => onOpenTask(a.taskId!)}
              title={`${a.taskLabel} — open on the Board`}
              aria-label={`Open ${a.name}'s task ${a.taskTicket ?? ""} on the Board`}
              className={`inline-flex min-w-0 items-center gap-1 text-left text-[10px] font-medium ${STATE_CHIP.executing.text} transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
            >
              <Zap size={10} className="shrink-0" />
              <span className="truncate">{a.taskLabel}</span>
            </button>
          ) : a.taskLabel ? (
            <span
              className={`inline-flex min-w-0 items-center gap-1 text-[10px] font-medium ${STATE_CHIP.executing.text}`}
              title={a.taskLabel}
            >
              <Zap size={10} className="shrink-0" />
              <span className="truncate">{a.taskLabel}</span>
            </span>
          ) : (
            <span className="text-[10px] font-medium text-ink/50">idle</span>
          )}
        </div>
        {kids.length > 0 && (
          <div className="ml-[9px] mt-1.5 space-y-1.5 border-l border-ink/10 pl-2.5">
            {kids.map((c) => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative hidden items-center gap-2 sm:flex">
      {/* Avatar cluster — agents are square terracotta chips, like their tags.
          A scan-line sweeps across them while the agent is reading. */}
      <div
        className={`flex -space-x-1 rounded-md ${
          roots.length > 0
            ? "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            : ""
        }`}
        role={roots.length > 0 ? "button" : undefined}
        tabIndex={roots.length > 0 ? 0 : undefined}
        aria-expanded={roots.length > 0 ? swarmOpen : undefined}
        onClick={roots.length > 0 ? () => setSwarmOpen((o) => !o) : undefined}
        onKeyDown={
          roots.length > 0
            ? (e) => {
                // Keyboard parity for the swarm-panel toggle (it was a bare
                // clickable div): Enter/Space on the cluster itself only —
                // the nested avatar buttons keep their own activation.
                if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                  e.preventDefault();
                  setSwarmOpen((o) => !o);
                }
              }
            : undefined
        }
        title={roots.length > 0 ? "Toggle swarm panel" : undefined}
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

      {/* Swarm tree — visible while any executor is nested under a present
          orchestrator; dismissible, re-opened by clicking the avatar cluster. */}
      {roots.length > 0 && swarmOpen && (
        <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-lg border border-ink/10 bg-surface p-3 shadow-lg">
          <button
            onClick={() => setSwarmOpen(false)}
            aria-label="Hide swarm panel"
            className="absolute right-1.5 top-1.5 rounded p-0.5 text-ink/35 transition-colors hover:bg-ink/5 hover:text-ink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X size={12} />
          </button>
          {roots.map((r) => renderNode(r, 0))}
        </div>
      )}

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

// Small square agent chip for tree rows — same terracotta identity (the
// `agent` token) as the header cluster, sized down.
function MiniChip({ isClaude, size }: { isClaude: boolean; size: 4 | 5 }) {
  return (
    <span
      aria-hidden="true"
      className={`${size === 5 ? "h-[18px] w-[18px]" : "h-3.5 w-3.5"} grid shrink-0 place-items-center rounded-[4px] ${
        isClaude ? "bg-agent" : "bg-zinc-800"
      }`}
    >
      <Sparkle />
    </span>
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
