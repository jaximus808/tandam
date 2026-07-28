/* ─────────────────────────────────────────────────────────────────────────────
   HeroBoardDemo — the landing hero visual (TDM-3).

   An animated recreation of the launch demo's Act-2 arc: two Claude Code
   terminal panes draining a shared Tandem task queue in parallel, next to a
   live mini board. The narrative climax is the atomic-claim rejection —
   session-B tries the task session-A just claimed, gets `claimed: false`,
   and pivots to the next task. Loops forever (~20s), pure CSS/JS timeline,
   no video, no external libs beyond lucide (already an app dependency).

   Usage (TDM-6 assembler): props-free drop-in, sizes to its container width.

     import HeroBoardDemo from "../components/landing/HeroBoardDemo";
     <HeroBoardDemo />

   Two-column ≥md (terminals left, board right), stacked below. Honors
   prefers-reduced-motion by rendering a single static end-state frame.
   ──────────────────────────────────────────────────────────────────────────── */

import { useEffect, useState } from "react";
import { GitCommitHorizontal, Layers, Zap } from "lucide-react";

// ── Timeline ─────────────────────────────────────────────────────────────────
// Everything below renders as a pure function of elapsed time `t` (ms into the
// loop), so the loop reset is just t wrapping to 0 — no imperative cleanup, no
// state to un-wind, no jank.

const TOTAL = 20_000; // full loop length
const STATIC_T = 18_000; // frame shown under prefers-reduced-motion (all done)

type LineKind = "cmd" | "ok" | "warn" | "dim";

interface TermLine {
  start: number; // ms when the line begins appearing
  kind: LineKind;
  text: string;
  dur?: number; // cmd lines type over this many ms; output lines pop in
}

// Terminal A — session-A. Wins the contested claim.
const LINES_A: TermLine[] = [
  { start: 500, kind: "cmd", text: "canvas_task_start TDM-7", dur: 900 },
  { start: 1_600, kind: "ok", text: '{ claimed: true }  # TDM-7' },
  { start: 2_100, kind: "dim", text: "→ working: ticket prefix check" },
  { start: 6_200, kind: "cmd", text: "canvas_task_complete TDM-7", dur: 900 },
  { start: 7_400, kind: "ok", text: "✓ done · TDM-7: prefix check · a3f8c21" },
  { start: 8_300, kind: "cmd", text: "canvas_task_start TDM-9", dur: 900 },
  { start: 9_400, kind: "ok", text: '{ claimed: true }  # TDM-9' },
  { start: 13_900, kind: "cmd", text: "canvas_task_complete TDM-9", dur: 950 },
  { start: 15_000, kind: "ok", text: "✓ done · TDM-9: claim age · c76d1b4" },
  { start: 17_600, kind: "dim", text: "queue empty — 4/4 done" },
];

// Terminal B — session-B. Loses the race on TDM-7: THE MONEY SHOT. The
// rejection wording mirrors the real gateway result (apps/mcp-gateway/src/
// tools.ts → `already claimed by "session-A"`).
const LINES_B: TermLine[] = [
  { start: 1_200, kind: "cmd", text: "canvas_task_start TDM-7", dur: 900 },
  { start: 2_700, kind: "warn", text: "claimed: false" },
  { start: 2_750, kind: "warn", text: '→ already claimed by "session-A"' },
  { start: 3_800, kind: "dim", text: "→ claiming TDM-8 instead" },
  { start: 4_700, kind: "cmd", text: "canvas_task_start TDM-8", dur: 900 },
  { start: 5_800, kind: "ok", text: '{ claimed: true }  # TDM-8' },
  { start: 10_300, kind: "cmd", text: "canvas_task_complete TDM-8", dur: 950 },
  { start: 11_500, kind: "ok", text: "✓ done · TDM-8: queue sort · 9d41e07" },
  { start: 12_300, kind: "cmd", text: "canvas_task_start TDM-10", dur: 950 },
  { start: 13_400, kind: "ok", text: '{ claimed: true }  # TDM-10' },
  { start: 15_700, kind: "cmd", text: "canvas_task_complete TDM-10", dur: 950 },
  { start: 16_900, kind: "ok", text: "✓ done · TDM-10: sort tests · 5b2fa9c" },
];

// Amber glow on terminal B while the rejection is on screen.
const MONEY_GLOW: [number, number] = [2_600, 5_600];
// The contested board card pulses amber over the same beat.
const CONTESTED: [number, number] = [2_700, 4_400];

interface DemoTask {
  id: string;
  title: string;
  claimant: string;
  hash: string;
  workAt: number; // ready → working
  doneAt: number; // working → done
}

// Task titles come from the demo SPEC.md sections (docs/demo-script.md).
const TASKS: DemoTask[] = [
  { id: "TDM-7", title: "Ticket prefix enforcement", claimant: "session-A", hash: "a3f8c21", workAt: 1_700, doneAt: 7_500 },
  { id: "TDM-8", title: "Queue ordering: oldest-first", claimant: "session-B", hash: "9d41e07", workAt: 5_900, doneAt: 11_600 },
  { id: "TDM-9", title: "Stale-claim visibility", claimant: "session-A", hash: "c76d1b4", workAt: 9_500, doneAt: 15_100 },
  { id: "TDM-10", title: "Unit-test the queue sort", claimant: "session-B", hash: "5b2fa9c", workAt: 13_500, doneAt: 17_000 },
];

// Agent chips in the board header appear when each session first acts.
const SESSIONS = [
  { name: "session-A", activeAt: 1_600 },
  { name: "session-B", activeAt: 2_700 },
];

type TaskState = "ready" | "working" | "done";

function taskStateAt(task: DemoTask, t: number): TaskState {
  if (t >= task.doneAt) return "done";
  if (t >= task.workAt) return "working";
  return "ready";
}

// Loop fade: quick fade-in at the top, gentle fade-out at the tail, a short
// dark beat before the wrap so the reset never pops mid-frame.
function loopOpacity(t: number): number {
  if (t < 450) return t / 450;
  if (t > 19_200) return Math.max(0, 1 - (t - 19_200) / 650);
  return 1;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// ── Terminal pane ────────────────────────────────────────────────────────────

const LINE_CLS: Record<LineKind, string> = {
  cmd: "text-zinc-100",
  ok: "text-emerald-400",
  warn: "text-amber-300 font-medium",
  dim: "text-zinc-500",
};

function TerminalPane({
  name,
  lines,
  t,
  glow,
  animate,
}: {
  name: string;
  lines: TermLine[];
  t: number;
  glow: boolean;
  animate: boolean;
}) {
  const visible = lines.filter((l) => t >= l.start);
  const last = visible[visible.length - 1];
  const typing =
    !!last && last.kind === "cmd" && !!last.dur && t < last.start + last.dur;
  return (
    <div
      className={[
        // Money-shot highlight = 1px amber border + subtle ring only (no bloom).
        "overflow-hidden rounded-lg border bg-[#101014] transition-colors duration-500",
        glow ? "border-amber-400/60 ring-1 ring-amber-400/25" : "border-white/10 shadow-sm",
      ].join(" ")}
    >
      {/* Title bar: traffic lights + session name. */}
      <div className="flex items-center gap-1.5 border-b border-white/[0.06] px-3 py-1.5">
        <span className="h-2 w-2 rounded-full bg-[#FF5F57]" />
        <span className="h-2 w-2 rounded-full bg-[#FEBC2E]" />
        <span className="h-2 w-2 rounded-full bg-[#28C840]" />
        <span className="ml-2 truncate font-code text-[10px] text-zinc-500">
          {name} — claude
        </span>
      </div>
      {/* Body: newest lines pinned to the bottom, older ones clip off the top. */}
      <div className="flex h-40 flex-col justify-end overflow-hidden px-3 pb-2.5 pt-1 font-code text-[12px] leading-[1.55] sm:h-44 sm:text-[12.5px]">
        {visible.map((l) => {
          const isCmd = l.kind === "cmd";
          const shown =
            isCmd && l.dur
              ? l.text.slice(
                  0,
                  Math.max(1, Math.ceil(((t - l.start) / l.dur) * l.text.length)),
                )
              : l.text;
          const isTypingLine = typing && l === last;
          return (
            <div key={l.start} className={`whitespace-pre-wrap break-words ${LINE_CLS[l.kind]}`}>
              {isCmd && <span className="text-indigo-400">❯ </span>}
              {shown}
              {isTypingLine && animate && (
                <span className="text-zinc-300">▍</span>
              )}
            </div>
          );
        })}
        {/* Idle prompt with a blinking cursor whenever nothing is typing. */}
        {!typing && (
          <div className="whitespace-pre text-zinc-100">
            <span className="text-indigo-400">❯ </span>
            <span className={animate ? "hero-demo-blink text-zinc-300" : "text-zinc-300"}>▍</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Board mock ───────────────────────────────────────────────────────────────
// Mirrors the real TaskBoard language: column header dots (sky/violet/emerald),
// TDM ticket badges in tiny mono, violet claimant chip with the Zap glyph,
// emerald mono commit chips, and the epic progress bar (emerald done segment +
// pulsing violet in-flight segment).

const COLS: { key: TaskState; label: string; dot: string }[] = [
  { key: "ready", label: "Ready", dot: "#0EA5E9" },
  { key: "working", label: "Working", dot: "#8B5CF6" },
  { key: "done", label: "Done", dot: "#10B981" },
];

function BoardCard({
  task,
  state,
  contested,
  animate,
}: {
  task: DemoTask;
  state: TaskState;
  contested: boolean;
  animate: boolean;
}) {
  return (
    <div
      className={[
        "rounded-lg border bg-surface p-2",
        animate ? "hero-demo-card-in" : "",
        contested ? "border-amber-400/70 ring-1 ring-amber-400/25" : "border-ink/10",
      ].join(" ")}
    >
      <div className="min-w-0">
        <span className="block font-code text-[9.5px] font-medium tracking-tight text-ink/40">
          {task.id}
        </span>
        <span
          className={`mt-0.5 block text-[11px] font-semibold leading-snug ${
            state === "done" ? "text-ink/50" : "text-ink"
          }`}
          style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {task.title}
        </span>
      </div>
      {state === "working" && (
        <span className="mt-1 inline-flex min-w-0 items-center gap-1 text-[10.5px] font-medium text-violet-600 dark:text-violet-400">
          <Zap size={10} className="shrink-0" />
          <span className="truncate">{task.claimant}</span>
        </span>
      )}
      {state === "done" && (
        <span className="mt-1 inline-flex items-center gap-1 rounded-[4px] border border-emerald-600/20 bg-emerald-500/10 px-1 py-px font-code text-[9.5px] text-emerald-700 dark:text-emerald-300">
          <GitCommitHorizontal size={9} className="shrink-0" />
          {task.hash}
        </span>
      )}
    </div>
  );
}

function BoardPane({ t, animate }: { t: number; animate: boolean }) {
  const states = TASKS.map((task) => ({ task, state: taskStateAt(task, t) }));
  const done = states.filter((s) => s.state === "done").length;
  const working = states.filter((s) => s.state === "working").length;
  const activeSessions = SESSIONS.filter((s) => t >= s.activeAt);
  return (
    <div className="flex h-full flex-col rounded-lg border border-ink/10 bg-paper p-3 shadow-sm">
      {/* Header: board label + agent chips (terracotta = agent, app-wide). */}
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold text-ink">Board</span>
        <span className="font-code text-[10px] text-ink/40">4 tasks · 1 epic</span>
        <span className="ml-auto flex items-center gap-1">
          {activeSessions.map((s) => (
            <span
              key={s.name}
              className="hero-demo-card-in inline-flex items-center gap-1 whitespace-nowrap rounded-[4px] border border-agent/25 bg-agent/10 px-1.5 py-px font-code text-[9.5px] font-medium text-agent"
            >
              <span className="h-1.5 w-1.5 rounded-[2px] bg-agent" />
              {s.name}
            </span>
          ))}
        </span>
      </div>
      {/* Epic progress: emerald done, pulsing violet in flight. */}
      <div className="mt-2">
        <div className="flex items-center gap-1.5">
          <Layers size={11} className="shrink-0 text-ink/45" />
          <span className="min-w-0 truncate text-[11px] font-medium text-ink/70">
            Task queue quality-of-life
          </span>
          <span className="ml-auto shrink-0 font-code text-[10px] text-ink/45">
            {done}/4 done
          </span>
        </div>
        <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-ink/[0.08]">
          {done > 0 && (
            <div
              className="h-full bg-emerald-500 transition-[width] duration-500"
              style={{ width: `${(done / TASKS.length) * 100}%` }}
            />
          )}
          {working > 0 && (
            <div
              className={`h-full bg-violet-500/80 transition-[width] duration-500 ${animate ? "animate-pulse" : ""}`}
              style={{ width: `${(working / TASKS.length) * 100}%` }}
            />
          )}
        </div>
      </div>
      {/* Kanban: three fixed columns so the layout never jumps mid-loop. */}
      <div className="mt-2.5 grid min-h-0 flex-1 grid-cols-3 gap-2">
        {COLS.map((col) => {
          const cards = states.filter((s) => s.state === col.key);
          return (
            <div key={col.key} className="flex min-h-0 flex-col">
              <div className="mb-1.5 flex items-center gap-1 px-0.5">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: col.dot, opacity: cards.length ? 1 : 0.35 }}
                />
                <span className="truncate text-[9px] font-semibold uppercase tracking-[0.1em] text-ink/50">
                  {col.label}
                </span>
                <span className="shrink-0 font-code text-[9px] text-ink/35">
                  {cards.length}
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden rounded-lg border border-dashed border-ink/[0.07] p-1">
                {cards.map(({ task, state }) => (
                  <BoardCard
                    // Keyed on state so a column move re-mounts the card and
                    // replays the slide-in — reads as the card arriving.
                    key={`${task.id}-${state}`}
                    task={task}
                    state={state}
                    contested={
                      task.id === "TDM-7" && t >= CONTESTED[0] && t < CONTESTED[1]
                    }
                    animate={animate}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function HeroBoardDemo() {
  const reduced = usePrefersReducedMotion();
  const [t, setT] = useState(() => (reduced ? STATIC_T : 0));

  useEffect(() => {
    if (reduced) {
      setT(STATIC_T);
      return;
    }
    let raf = 0;
    const origin = performance.now();
    const tick = (now: number) => {
      // Quantize to ~30fps — plenty for typing cadence, third of the renders.
      const elapsed = (now - origin) % TOTAL;
      setT(Math.floor(elapsed / 33) * 33);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  const animate = !reduced;
  const glowB = animate && t >= MONEY_GLOW[0] && t < MONEY_GLOW[1];

  return (
    <div
      role="img"
      aria-label='Animated demo: two Claude Code sessions drain a shared Tandem task queue in parallel. Session B tries a task session A already claimed, gets "claimed: false — already claimed by session-A", and takes the next task instead. Completed tasks land on the board with commit hashes.'
      className="w-full select-none"
    >
      {/* Self-contained keyframes — no global CSS required. */}
      <style>{`
        @keyframes hero-demo-card-in {
          from { opacity: 0; transform: translateX(-10px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .hero-demo-card-in { animation: hero-demo-card-in 0.35s ease; }
        @keyframes hero-demo-blink { 50% { opacity: 0; } }
        .hero-demo-blink { animation: hero-demo-blink 1.1s steps(2, jump-none) infinite; }
        @media (prefers-reduced-motion: reduce) {
          .hero-demo-card-in, .hero-demo-blink { animation: none; }
        }
      `}</style>
      <div
        aria-hidden="true"
        className="grid gap-3 md:grid-cols-2"
        style={{ opacity: animate ? loopOpacity(t) : 1 }}
      >
        {/* Left: the two parallel sessions. */}
        <div className="flex min-w-0 flex-col gap-3">
          <TerminalPane name="session-A" lines={LINES_A} t={t} glow={false} animate={animate} />
          <TerminalPane name="session-B" lines={LINES_B} t={t} glow={glowB} animate={animate} />
        </div>
        {/* Right: the shared board, moving live. */}
        <div className="min-w-0">
          <BoardPane t={t} animate={animate} />
        </div>
      </div>
    </div>
  );
}
