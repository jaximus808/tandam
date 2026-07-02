import { useEffect, useRef, useState } from "react";
import TandemLogo from "../components/TandemLogo";

interface Props {
  onHome: () => void;
}

interface Stats {
  canvases: number;
  users: number;
  recurring: number;
  recurringPct: number;
}

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; stats: Stats; at: number };

// Count a number up from 0 on mount — the only "animation" here, kept cheap
// (one rAF loop, ~700ms, eased). Respects prefers-reduced-motion by snapping.
function useCountUp(target: number, run: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!run) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || target <= 0) {
      setN(target);
      return;
    }
    const DUR = 700;
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / DUR);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setN(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, run]);
  return n;
}

function StatCard({
  value,
  label,
  hint,
  accent,
  suffix,
  animate,
}: {
  value: number;
  label: string;
  hint?: string;
  accent: string;
  suffix?: string;
  animate: boolean;
}) {
  const shown = useCountUp(value, animate);
  return (
    <div className="relative overflow-hidden rounded-2xl border border-gray-900/10 bg-white px-6 py-7">
      <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: accent }} />
      <div className="flex items-baseline gap-1">
        <span className="font-display text-5xl font-semibold tracking-tight tabular-nums text-gray-900 sm:text-6xl">
          {shown.toLocaleString()}
        </span>
        {suffix && (
          <span className="font-display text-2xl font-medium tabular-nums text-gray-400">{suffix}</span>
        )}
      </div>
      <div className="mt-2 font-display text-sm font-medium text-gray-900">{label}</div>
      {hint && <div className="mt-0.5 text-xs leading-snug text-gray-400">{hint}</div>}
    </div>
  );
}

export default function StatsPage({ onHome }: Props) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const reqId = useRef(0);

  async function refresh() {
    const id = ++reqId.current;
    setLoad({ status: "loading" });
    try {
      const r = await fetch("/api/stats");
      if (!r.ok) throw new Error(`stats request failed (${r.status})`);
      const d = (await r.json()) as Stats;
      if (id === reqId.current) setLoad({ status: "ready", stats: d, at: Date.now() });
    } catch (e) {
      if (id === reqId.current)
        setLoad({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = load.status === "ready" ? load.stats : null;

  return (
    <div className="flex min-h-screen flex-col bg-paper font-brand text-gray-900">
      <header className="flex items-center gap-2 border-b border-gray-900/5 px-4 py-3">
        <button onClick={onHome} className="group flex items-center gap-1.5" title="Back to home">
          <TandemLogo size={28} animate={false} />
          <span className="hidden font-semibold tracking-tight transition-colors group-hover:text-sky-600 sm:inline">
            Tandem
          </span>
        </button>
        <span className="text-gray-200">/</span>
        <span className="font-display text-[15px] font-medium">By the numbers</span>
        <button
          onClick={refresh}
          className="ml-auto rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
          title="Refresh"
        >
          Refresh
        </button>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-2xl font-medium tracking-tight">Tandem, by the numbers</h1>
          <p className="mt-1 text-sm text-gray-500">
            Private dashboard — not linked from the homepage. Refresh to pull live counts.
          </p>
        </div>

        {load.status === "loading" && <p className="text-sm text-gray-500">Pulling numbers…</p>}

        {load.status === "error" && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-6 py-5">
            <p className="text-sm font-medium text-red-700">Couldn’t load stats</p>
            <p className="mt-1 font-code text-xs text-red-500">{load.message}</p>
            <p className="mt-2 text-xs text-gray-500">
              If this is local, the API has to be running and reachable at <code>/api/stats</code>.
            </p>
          </div>
        )}

        {ready && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <StatCard
                value={ready.canvases}
                label="Canvases created"
                hint="Every canvas ever spun up"
                accent="#0EA5E9"
                animate
              />
              <StatCard
                value={ready.users}
                label="Accounts created"
                hint="Signed-in users (Google)"
                accent="#10B981"
                animate
              />
              <StatCard
                value={ready.recurringPct}
                suffix="%"
                label="Came back another day"
                hint={`${ready.recurring.toLocaleString()} of ${ready.canvases.toLocaleString()} canvases`}
                accent="#F59E0B"
                animate
              />
            </div>

            {/* The recurrence bar — the one number that actually matters. */}
            <div className="mt-8 rounded-2xl border border-gray-900/10 bg-white px-6 py-5">
              <div className="flex items-center justify-between">
                <span className="font-display text-sm font-medium text-gray-900">
                  Recurrence — the success metric
                </span>
                <span className="font-display text-sm font-semibold tabular-nums text-amber-600">
                  {ready.recurringPct}%
                </span>
              </div>
              <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full bg-amber-500 transition-[width] duration-700 ease-out"
                  style={{ width: `${Math.min(100, ready.recurringPct)}%` }}
                />
              </div>
              <p className="mt-3 text-xs leading-relaxed text-gray-500">
                Share of canvases touched again on a <span className="font-medium">later day</span> than they
                were created — a proxy for “someone came back.” It’s canvas-level (no per-user identity on edits
                yet) and counts last-touch only, so it <span className="font-medium">undercounts</span> on
                purpose. Watch this climb week over week — that’s the gate moving.
              </p>
            </div>

            <p className="mt-6 text-xs text-gray-400">
              Last refreshed {new Date(load.status === "ready" ? load.at : Date.now()).toLocaleString()}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
