import { useEffect, useState } from "react";

// Cycled through the "editing" pill, one per loop — drives home that Tandem
// works with any MCP agent, not just Claude.
const AGENTS = ["Claude", "Codex", "Cursor", "your agent"];

interface DemoPin {
  label: string;
  top: string;
  left: string;
  color: string;
}

const PINS: DemoPin[] = [
  { label: "Shibuya", top: "58%", left: "30%", color: "#38BDF8" },
  { label: "Senso-ji", top: "30%", left: "62%", color: "#F59E0B" },
  { label: "Tsukiji", top: "70%", left: "66%", color: "#F43F5E" },
  { label: "Shinjuku", top: "36%", left: "24%", color: "#10B981" },
];

const ROWS: { day: string; label: string; color: string }[] = [
  { day: "Day 1", label: "Shibuya Crossing", color: "#38BDF8" },
  { day: "Day 2", label: "Senso-ji Temple", color: "#F59E0B" },
  { day: "Day 3", label: "Tsukiji Market", color: "#F43F5E" },
];

const STEP_MS = 750;
const HOLD_STEPS = 3;
const TOTAL_REVEAL = PINS.length + ROWS.length;
const CYCLE = TOTAL_REVEAL + HOLD_STEPS;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

function PinMarker({ color }: { color: string }) {
  return (
    <svg width="22" height="28" viewBox="0 0 22 28" aria-hidden="true">
      <path
        d="M11 0C4.9 0 0 4.9 0 11c0 7.6 11 17 11 17s11-9.4 11-17C22 4.9 17.1 0 11 0z"
        fill={color}
      />
      <circle cx="11" cy="11" r="4" fill="#fff" />
    </svg>
  );
}

export default function HeroCanvasDemo() {
  const reduced = usePrefersReducedMotion();
  const [tick, setTick] = useState(0);
  const [agentIdx, setAgentIdx] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const iv = setInterval(() => {
      setTick((t) => {
        const next = t + 1;
        if (next >= CYCLE) {
          setAgentIdx((a) => (a + 1) % AGENTS.length);
          return 0;
        }
        return next;
      });
    }, STEP_MS);
    return () => clearInterval(iv);
  }, [reduced]);

  const pinsVisible = reduced ? PINS.length : Math.min(tick, PINS.length);
  const rowsVisible = reduced
    ? ROWS.length
    : Math.max(0, Math.min(tick - PINS.length, ROWS.length));
  const agent = AGENTS[agentIdx];

  return (
    <div className="relative w-full">
      {/* soft glow behind the frame */}
      <div
        aria-hidden="true"
        className="absolute -inset-6 rounded-[2rem] bg-gradient-to-tr from-sky-200/40 via-blue-200/30 to-transparent blur-2xl"
      />

      <div className="relative rounded-2xl bg-white border border-gray-200 shadow-xl shadow-sky-900/5 overflow-hidden">
        {/* title bar */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 bg-gray-50/80">
          <span className="w-2.5 h-2.5 rounded-full bg-gray-200" />
          <span className="w-2.5 h-2.5 rounded-full bg-gray-200" />
          <span className="w-2.5 h-2.5 rounded-full bg-gray-200" />
          <span className="ml-2 text-xs font-medium text-gray-400">Tokyo trip</span>
          <span className="ml-auto font-mono text-[11px] tracking-widest text-gray-300">
            TOKYO7X3K
          </span>
        </div>

        <div className="flex h-[300px]">
          {/* map */}
          <div className="relative flex-1 overflow-hidden bg-gradient-to-br from-sky-50 to-blue-100">
            {/* faint grid */}
            <div
              aria-hidden="true"
              className="absolute inset-0 opacity-60"
              style={{
                backgroundImage:
                  "linear-gradient(to right, rgba(56,189,248,0.10) 1px, transparent 1px), linear-gradient(to bottom, rgba(56,189,248,0.10) 1px, transparent 1px)",
                backgroundSize: "32px 32px",
              }}
            />
            {/* abstract landmass blobs */}
            <div
              aria-hidden="true"
              className="absolute -left-8 top-10 w-40 h-40 rounded-full bg-emerald-200/40 blur-2xl"
            />
            <div
              aria-hidden="true"
              className="absolute right-2 bottom-2 w-44 h-32 rounded-full bg-sky-300/30 blur-2xl"
            />

            {/* editing pill */}
            <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-full bg-white/90 backdrop-blur px-3 py-1.5 shadow-sm border border-gray-100">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-70 tandem-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
              </span>
              <span key={agentIdx} className="text-xs font-medium text-gray-700 tandem-fade-in">
                {agent} is editing…
              </span>
            </div>

            {/* pins */}
            {PINS.slice(0, pinsVisible).map((pin) => (
              <div
                key={pin.label}
                className="absolute -translate-x-1/2 -translate-y-full tandem-pin-drop"
                style={{ top: pin.top, left: pin.left }}
              >
                <div className="flex flex-col items-center">
                  <PinMarker color={pin.color} />
                  <span className="mt-0.5 px-1.5 py-0.5 rounded bg-white/90 text-[10px] font-medium text-gray-700 shadow-sm whitespace-nowrap">
                    {pin.label}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* itinerary panel */}
          <div className="w-40 shrink-0 border-l border-gray-100 bg-white p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-2">
              Itinerary
            </div>
            <div className="space-y-1.5">
              {ROWS.slice(0, rowsVisible).map((row) => (
                <div
                  key={row.day}
                  className="tandem-row-slide flex items-start gap-2 rounded-lg border border-gray-100 bg-gray-50/70 px-2 py-1.5"
                >
                  <span
                    className="mt-1 w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: row.color }}
                  />
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold text-gray-500">{row.day}</div>
                    <div className="text-[11px] text-gray-800 leading-tight truncate">
                      {row.label}
                    </div>
                  </div>
                </div>
              ))}
              {rowsVisible === 0 && (
                <div className="text-[11px] text-gray-300 leading-relaxed">
                  Waiting for the agent to plan the days…
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
