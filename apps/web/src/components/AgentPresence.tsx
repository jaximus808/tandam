import { useState } from "react";
import { X } from "lucide-react";
import type { CanvasMode } from "../types";
import { modeTheme } from "../lib/modeTheme";
import type { AgentEdit, PresentAgent } from "../lib/useAgentActivity";

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
  const t = edit ? modeTheme(edit.mode) : null;
  // Editing takes precedence over reading — if a cursor is live, show where.
  const showReading = !edit && reading;

  // "Following them = seeing their task": the most recent claimant among the
  // present agents gets a compact ⚡ TDM-n chip beside the cluster that clicks
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
            <span className="shrink-0 rounded-[3px] bg-ink/[0.06] px-1 py-px font-code text-[9px] uppercase tracking-[0.12em] text-ink/45">
              {a.role ?? "planner"}
            </span>
          ) : a.taskLabel && a.taskId ? (
            // Following this executor = seeing its task: click through to the
            // Board, scoped to the task's epic with its detail open.
            <button
              onClick={() => onOpenTask(a.taskId!)}
              title={`${a.taskLabel} — open on the Board`}
              aria-label={`Open ${a.name}'s task ${a.taskTicket ?? ""} on the Board`}
              className="min-w-0 truncate text-left font-code text-[10px] text-agent transition-colors hover:underline"
            >
              ⚡ {a.taskLabel}
            </button>
          ) : a.taskLabel ? (
            <span className="min-w-0 truncate font-code text-[10px] text-agent" title={a.taskLabel}>
              ⚡ {a.taskLabel}
            </span>
          ) : (
            <span className="font-code text-[10px] text-ink/35">idle</span>
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
        className={`flex -space-x-1 ${roots.length > 0 ? "cursor-pointer" : ""}`}
        onClick={roots.length > 0 ? () => setSwarmOpen((o) => !o) : undefined}
        title={roots.length > 0 ? "Toggle swarm panel" : undefined}
      >
        {agents.map((a) => {
          const title = [a.isClaude ? `${a.name} (Claude)` : a.name, a.taskLabel && `⚡ ${a.taskLabel}`]
            .filter(Boolean)
            .join(" — ");
          const cls = "relative grid h-6 w-6 place-items-center overflow-hidden rounded-[5px] ring-2 ring-paper";
          const bg = { background: a.isClaude ? "#C75B39" : "#1C1917" };
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
              style={bg}
            >
              <Sparkle />
              {showReading && <span aria-hidden="true" className="tandem-scan absolute inset-0" />}
            </button>
          ) : (
            <span key={a.id} title={title} className={cls} style={bg}>
              <Sparkle />
              {showReading && <span aria-hidden="true" className="tandem-scan absolute inset-0" />}
            </span>
          );
        })}
      </div>

      {/* Swarm tree — visible while any executor is nested under a present
          orchestrator; dismissible, re-opened by clicking the avatar cluster. */}
      {roots.length > 0 && swarmOpen && (
        <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-lg border border-ink/10 bg-paper p-2.5 shadow-lg">
          <button
            onClick={() => setSwarmOpen(false)}
            aria-label="Hide swarm panel"
            className="absolute right-1.5 top-1.5 rounded p-0.5 text-ink/35 transition-colors hover:bg-ink/5 hover:text-ink/70"
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
          className="inline-flex items-center gap-1 rounded-[4px] px-2 py-1 font-code text-[10.5px] font-medium text-violet-600 transition-opacity hover:opacity-80 dark:text-violet-400"
          style={{
            backgroundColor: "rgba(139,92,246,0.10)",
            boxShadow: "inset 0 0 0 1px rgba(139,92,246,0.22)",
          }}
          title={`${followed.name} is working ${followed.taskLabel ?? "a task"} — open it on the Board`}
          aria-label={`Open ${followed.name}'s task ${followed.taskTicket ?? ""} on the Board`}
        >
          ⚡ {followed.taskTicket ?? "task"}
        </button>
      )}

      {/* Live status chip. Priority: editing (where it's writing) → reading
          (it's looking at the canvas) → idle ("here"). */}
      {edit && t ? (
        <button
          onClick={() => onJump(edit.mode)}
          className="inline-flex items-center gap-1.5 rounded-[4px] px-2 py-1 font-code text-[10.5px] font-medium transition-colors"
          style={{ backgroundColor: t.soft, color: t.solid, boxShadow: `inset 0 0 0 1px ${t.line}` }}
          title={`Jump to ${MODE_LABEL[edit.mode]} — where it's writing`}
        >
          <span className="relative flex h-1.5 w-1.5">
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
              style={{ backgroundColor: t.solid }}
            />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.solid }} />
          </span>
          editing {MODE_LABEL[edit.mode].toLowerCase()}
        </button>
      ) : showReading ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-[4px] px-2 py-1 font-code text-[10.5px] font-medium text-agent"
          style={{ backgroundColor: "rgba(199,91,57,0.10)", boxShadow: "inset 0 0 0 1px rgba(199,91,57,0.22)" }}
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
        <span className="font-code text-[10.5px] font-medium text-ink/35">here</span>
      )}
    </div>
  );
}

// Small square agent chip for tree rows — same terracotta identity as the
// header cluster, sized down.
function MiniChip({ isClaude, size }: { isClaude: boolean; size: 4 | 5 }) {
  return (
    <span
      aria-hidden="true"
      className={`${size === 5 ? "h-[18px] w-[18px]" : "h-3.5 w-3.5"} grid shrink-0 place-items-center rounded-[4px]`}
      style={{ background: isClaude ? "#C75B39" : "#1C1917" }}
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
