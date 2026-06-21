import type { CanvasMode } from "../types";
import { modeTheme } from "../lib/modeTheme";
import type { AgentEdit, PresentAgent } from "../lib/useAgentActivity";

interface Props {
  agents: PresentAgent[];
  edit: AgentEdit | null;
  reading: boolean;
  onJump: (mode: CanvasMode) => void;
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
 */
export default function AgentPresence({ agents, edit, reading, onJump }: Props) {
  if (agents.length === 0) return null;
  const t = edit ? modeTheme(edit.mode) : null;
  // Editing takes precedence over reading — if a cursor is live, show where.
  const showReading = !edit && reading;

  return (
    <div className="hidden items-center gap-2 sm:flex">
      {/* Avatar cluster — agents are square terracotta chips, like their tags.
          A scan-line sweeps across them while the agent is reading. */}
      <div className="flex -space-x-1">
        {agents.map((a, i) => (
          <span
            key={`${a.name}-${i}`}
            title={a.isClaude ? `${a.name} (Claude)` : a.name}
            className="relative grid h-6 w-6 place-items-center overflow-hidden rounded-[5px] ring-2 ring-paper"
            style={{
              background: a.isClaude ? "#C75B39" : "#1C1917",
            }}
          >
            <Sparkle />
            {showReading && <span aria-hidden="true" className="tandem-scan absolute inset-0" />}
          </span>
        ))}
      </div>

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
