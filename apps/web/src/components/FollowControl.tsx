import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Eye, EyeOff, PauseCircle } from "lucide-react";
import type { PresentAgent } from "../lib/useAgentActivity";
import {
  followSummary,
  toggleFollowedAgent,
  type FollowPrefs,
} from "../lib/followAgents";

/* ─────────────────────────────────────────────────────────────────────────────
   FollowControl — the camera switch, in the header beside the fleet readout.

   TDM-47 retired the old "Follow agent" toggle because a camera that trailed
   ONE agent through the document tabs answered the wrong question once a team
   was working. This is the answer to the RIGHT question: follow the FLEET —
   or the two members of it you actually care about — and let their work come
   to you, on whichever surface it lands on.

   The trigger states the whole setting at a glance ("Following" / "Following 2"
   / "Follow off") and, when the viewer is typing, says so — because a camera
   that silently stops is indistinguishable from one that's broken.
   ──────────────────────────────────────────────────────────────────────────── */

interface Props {
  agents: PresentAgent[];
  prefs: FollowPrefs;
  onChange: (next: FollowPrefs) => void;
  /** The viewer is writing — follow is holding its fire (useFocusGuard). */
  paused: boolean;
  /** Moves buffered while they were writing. */
  pending: number;
}

export default function FollowControl({ agents, prefs, onChange, paused, pending }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  const names = agents.map((a) => a.name);
  const all = prefs.agents === null;
  const isOn = (name: string) =>
    prefs.on && (all || prefs.agents!.some((a) => a.toLowerCase() === name.toLowerCase()));

  // Live state of the camera, in priority order: off → paused → armed.
  const live = prefs.on && !paused;

  // ZONE 3 · CONTROLS of the canvas header's collapse contract (see the block
  // comment above `HEADER_DROP` in App.tsx): `shrink-0`, and never inside an
  // overflow-hidden ancestor — the panel below is absolutely positioned and
  // would be clipped by one. This control owns two rungs of the header's drop
  // ladder: rank 3 hides the text label below lg (the eye carries the state on
  // its own), rank 4 hides the whole control below md.
  return (
    <div className="relative hidden shrink-0 md:block">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          !prefs.on
            ? "Agent changes happen quietly — turn following on to be taken to them"
            : paused
              ? "Following is paused while you're editing — it resumes when you click away"
              : all
                ? "You're following every agent: their changes bring you to the board or the document they touch"
                : `You're following ${prefs.agents!.join(", ")}`
        }
        className={[
          "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
          open
            ? "bg-accent/[0.08] text-accent"
            : live
              ? "text-agent hover:bg-agent/[0.08]"
              : "text-ink/50 hover:bg-ink/5 hover:text-ink/85",
        ].join(" ")}
      >
        {!prefs.on ? (
          <EyeOff size={14} className="shrink-0" />
        ) : paused ? (
          <PauseCircle size={14} className="shrink-0" />
        ) : (
          <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            <Eye size={14} />
            {/* The live tell: following is a thing that's HAPPENING. */}
            <span className="absolute -right-0.5 -top-0.5 flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-agent opacity-70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-agent" />
            </span>
          </span>
        )}
        <span className="hidden lg:inline">{paused && prefs.on ? "Paused" : followSummary(prefs)}</span>
        {pending > 0 && (
          <span
            aria-label={`${pending} agent moves while you were editing`}
            className="flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-agent px-1 text-[10px] font-semibold leading-none text-white tabular-nums"
          >
            {pending > 9 ? "9+" : pending}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} aria-hidden="true" />
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Follow agents"
            className="absolute right-0 top-full z-50 mt-2 w-[min(300px,calc(100vw-1.5rem))] overflow-hidden rounded-[10px] border border-ink/10 bg-surface shadow-lg"
          >
            <button
              onClick={() => onChange({ on: !prefs.on, agents: prefs.agents })}
              className="flex w-full items-start gap-2.5 border-b border-ink/10 px-3 py-2.5 text-left transition-colors hover:bg-ink/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
            >
              <span
                aria-hidden="true"
                className={`mt-px flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors ${
                  prefs.on ? "bg-agent" : "bg-ink/20"
                }`}
              >
                <span
                  className={`h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
                    prefs.on ? "translate-x-3" : "translate-x-0"
                  }`}
                />
              </span>
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium text-ink/85">Follow agent work</span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-ink/55">
                  Their changes bring you along — to the board when a task moves, to the
                  document when one gets written.
                </span>
              </span>
            </button>

            {/* Why nothing is moving right now. Stated, never silent. */}
            {prefs.on && paused && (
              <p className="flex items-center gap-1.5 border-b border-ink/10 bg-ink/[0.02] px-3 py-1.5 text-[11.5px] text-ink/60">
                <PauseCircle size={12} className="shrink-0" />
                Paused while you're editing
                {pending > 0 && ` — ${pending} move${pending === 1 ? "" : "s"} waiting`}
              </p>
            )}

            <div className="max-h-[min(40vh,280px)] overflow-y-auto py-1">
              <button
                onClick={() => onChange({ on: true, agents: null })}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-ink/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
              >
                <Check
                  size={13}
                  className={`shrink-0 ${prefs.on && all ? "text-agent" : "text-transparent"}`}
                />
                <span className="text-[12px] font-medium text-ink/80">Everyone</span>
                <span className="ml-auto shrink-0 text-[11px] text-ink/45">
                  {agents.length || "—"}
                </span>
              </button>
              {agents.length === 0 ? (
                <p className="px-3 py-2 text-[11.5px] leading-snug text-ink/50">
                  No agents are here yet. Connect one and it shows up on this list.
                </p>
              ) : (
                agents.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => onChange(toggleFollowedAgent(prefs, a.name, names))}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-ink/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                  >
                    <Check
                      size={13}
                      className={`shrink-0 ${isOn(a.name) ? "text-agent" : "text-transparent"}`}
                    />
                    <span className="min-w-0 flex-1 truncate font-code text-[11.5px] text-ink/80">
                      {a.name}
                    </span>
                    {a.taskTicket && (
                      <span className="shrink-0 font-code text-[10px] text-violet-600 dark:text-violet-400">
                        {a.taskTicket}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
