import { useCallback, useEffect, useMemo, useState } from "react";
import SiteHeader from "../components/SiteHeader";
import {
  fetchLoadtestRuns,
  fetchMetricsHistory,
  loadtestExportUrl,
  MetricsAccessError,
  metricsHistoryExportUrl,
  type LoadtestRun,
  type MetricsHistory,
  type MetricsSnapshot,
} from "../lib/api";

// TDM-94 — the operator console for Tandem's own performance.
//
// /api/metrics has always served the numbers; it served them as a live,
// in-memory, 5-minute window that died with the process, so nothing could be
// compared to anything. This page reads the persisted series (migration 0040) and
// answers the two questions that shape actually change: "what changed since the
// last deploy" and "is this worse than last week".
//
// THE HONESTY PROBLEM this page exists to solve, and the thing to preserve if you
// edit it: most of the stored numbers are CUMULATIVE SINCE PROCESS BOOT. Plotting
// them raw draws a staircase that resets to zero on every deploy and says nothing
// about rate. Plotting naive deltas is worse — the delta ACROSS a restart is a
// large negative number, so a deploy renders as a catastrophic outage. So:
//
//   • counters are shown as per-minute rates, computed as deltas;
//   • every delta series is SPLIT at each restart boundary, and the first sample
//     of a new process is dropped (there is nothing to diff it against);
//   • gauges (connected clients) and windowed percentiles are NOT differenced,
//     and deliberately NOT split — those values are meaningful across a restart;
//   • restarts are drawn as vertical rules, because "the line changed here" and
//     "we deployed here" are the same event and the page should say so.
//
// Charts are hand-rolled SVG, matching modes/ChartsMode.tsx: the app ships no
// charting library and adding one for an internal console would be the tail
// wagging the dog.

// ── Window selection ──────────────────────────────────────────────────────────

const WINDOWS = [
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
] as const;

// ── Series maths ──────────────────────────────────────────────────────────────

type Point = { t: number; v: number };
// A segment is a run of points with no restart in the middle, so it can be drawn
// as one unbroken line.
type Segment = Point[];
type Series = { label: string; color: string; segments: Segment[] };

const COLORS = {
  latency: "#3b82f6",
  fanout: "#8b5cf6",
  requests: "#10b981",
  conflicts: "#f59e0b",
  expiries: "#ef4444",
  clients: "#0ea5e9",
} as const;

const ms = (iso: string) => new Date(iso).getTime();

// restartIndices returns the snapshot indices that begin a new process. Derived
// from processStartedAt rather than trusting the server's `restarts` list alone,
// so the split is correct even if the two ever disagree — but the server's list is
// what labels the rules, since it is the same computation.
function restartIndices(snaps: MetricsSnapshot[]): Set<number> {
  const out = new Set<number>();
  for (let i = 1; i < snaps.length; i++) {
    if (snaps[i].processStartedAt !== snaps[i - 1].processStartedAt) out.add(i);
  }
  return out;
}

// rateSegments differences a cumulative counter into a per-minute rate.
//
// Two guards, both load-bearing:
//   • a restart starts a NEW segment and its first sample is dropped — diffing
//     across a boot would render a deploy as a huge negative spike;
//   • a negative delta inside one process is impossible, so if one appears
//     (clock skew, a row written by a second instance) it is treated as a break
//     rather than drawn, because a wrong number is worse than a gap.
function rateSegments(snaps: MetricsSnapshot[], pick: (s: MetricsSnapshot) => number): Segment[] {
  const breaks = restartIndices(snaps);
  const segments: Segment[] = [];
  let current: Segment = [];
  for (let i = 1; i < snaps.length; i++) {
    if (breaks.has(i)) {
      if (current.length) segments.push(current);
      current = [];
      continue; // no predecessor within this process
    }
    const dtMin = (ms(snaps[i].capturedAt) - ms(snaps[i - 1].capturedAt)) / 60000;
    const dv = pick(snaps[i]) - pick(snaps[i - 1]);
    if (dtMin <= 0 || dv < 0) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push({ t: ms(snaps[i].capturedAt), v: dv / dtMin });
  }
  if (current.length) segments.push(current);
  return segments;
}

// levelSegments plots a value as-is: gauges and windowed percentiles, which mean
// the same thing before and after a restart and so are drawn as one line.
function levelSegments(snaps: MetricsSnapshot[], pick: (s: MetricsSnapshot) => number): Segment[] {
  const pts = snaps.map((s) => ({ t: ms(s.capturedAt), v: pick(s) }));
  return pts.length ? [pts] : [];
}

// niceCeil rounds a y-axis maximum up to a readable 1/2/5×10ⁿ boundary (the same
// helper ChartsMode uses, kept local so the two pages can diverge).
function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "–";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2).replace(/\.00$/, "");
}

function fmtClock(t: number, spanHours: number): string {
  const d = new Date(t);
  if (spanHours <= 48) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

// ── Chart ─────────────────────────────────────────────────────────────────────

const W = 720;
const H = 200;
const M = { top: 12, right: 12, bottom: 26, left: 48 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

function Chart({
  series,
  tMin,
  tMax,
  unit,
  restarts,
}: {
  series: Series[];
  tMin: number;
  tMax: number;
  unit: string;
  restarts: number[];
}) {
  const all = series.flatMap((s) => s.segments.flat());
  if (!all.length) {
    return (
      <div className="flex h-[200px] items-center justify-center text-sm text-ink/40">
        No data in this window
      </div>
    );
  }
  const yMax = niceCeil(Math.max(...all.map((p) => p.v)));
  const span = Math.max(1, tMax - tMin);
  const x = (t: number) => M.left + ((t - tMin) / span) * PW;
  // Zero is always the baseline: a rate or a latency chart with a floating floor
  // exaggerates every wiggle into a crisis.
  const y = (v: number) => M.top + PH - (v / yMax) * PH;
  const ticks = [0, yMax / 4, yMax / 2, (3 * yMax) / 4, yMax];
  const xTicks = [tMin, tMin + span / 2, tMax];
  const spanHours = span / 3_600_000;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="block" role="img">
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={M.left}
            y1={y(t)}
            x2={M.left + PW}
            y2={y(t)}
            className="stroke-ink/10"
            strokeWidth={1}
          />
          <text x={M.left - 6} y={y(t) + 3} textAnchor="end" fontSize={9} className="fill-ink/40">
            {fmtNum(t)}
          </text>
        </g>
      ))}
      {xTicks.map((t, i) => (
        <text
          key={t}
          x={x(t)}
          y={H - 8}
          textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
          fontSize={9}
          className="fill-ink/40"
        >
          {fmtClock(t, spanHours)}
        </text>
      ))}
      {/* Restart / deploy rules. Dashed so they read as annotation, not data. */}
      {restarts.map((t) => (
        <line
          key={`r${t}`}
          x1={x(t)}
          y1={M.top}
          x2={x(t)}
          y2={M.top + PH}
          className="stroke-ink/30"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      ))}
      {series.map((s) =>
        s.segments.map((seg, si) => (
          <path
            key={`${s.label}-${si}`}
            d={`M ${seg.map((p) => `${x(p.t)},${y(p.v)}`).join(" L ")}`}
            fill="none"
            stroke={s.color}
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )),
      )}
      <text x={M.left} y={M.top - 2} fontSize={9} className="fill-ink/40">
        {unit}
      </text>
    </svg>
  );
}

function ChartCard({
  title,
  hint,
  series,
  unit,
  tMin,
  tMax,
  restarts,
}: {
  title: string;
  hint: string;
  series: Series[];
  unit: string;
  tMin: number;
  tMax: number;
  restarts: number[];
}) {
  return (
    <section className="rounded-2xl border border-ink/10 bg-surface p-4">
      <header className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="flex items-center gap-3">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5 text-xs text-ink/60">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
            </span>
          ))}
        </div>
      </header>
      <p className="mb-2 text-xs leading-relaxed text-ink/50">{hint}</p>
      <Chart series={series} tMin={tMin} tMax={tMax} unit={unit} restarts={restarts} />
    </section>
  );
}

// ── Headline tiles ────────────────────────────────────────────────────────────

function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-ink/10 bg-surface px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-ink/40">{label}</div>
      <div className="mt-0.5 font-code text-xl tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-ink/50">{sub}</div>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Load =
  | { status: "loading" }
  | { status: "denied"; httpStatus: number }
  | { status: "error"; message: string }
  | { status: "ready"; history: MetricsHistory; runs: LoadtestRun[] };

interface Props {
  onHome: () => void;
  onOpenMCP: () => void;
  onShowCanvases: () => void;
  onShowSettings: () => void;
  onShowAbout: () => void;
  onOpenCanvas: (code: string) => void;
}

export default function MetricsPage(props: Props) {
  const [hours, setHours] = useState<number>(24);
  const [load, setLoad] = useState<Load>({ status: "loading" });

  const reload = useCallback(
    async (h: number) => {
      setLoad({ status: "loading" });
      try {
        // The loadtest history is a nice-to-have next to the series, so its own
        // failure must not blank the page: it degrades to an empty table.
        const [history, runs] = await Promise.all([
          fetchMetricsHistory(h),
          fetchLoadtestRuns().catch(() => [] as LoadtestRun[]),
        ]);
        setLoad({ status: "ready", history, runs });
      } catch (err) {
        if (err instanceof MetricsAccessError) {
          setLoad({ status: "denied", httpStatus: err.status });
          return;
        }
        setLoad({ status: "error", message: err instanceof Error ? err.message : "Failed to load" });
      }
    },
    [],
  );

  useEffect(() => {
    void reload(hours);
  }, [hours, reload]);

  const view = useMemo(() => {
    if (load.status !== "ready") return null;
    const snaps = load.history.snapshots;
    if (!snaps.length) return null;
    const tMin = ms(load.history.since);
    const tMax = ms(load.history.until);
    const restarts = load.history.restarts.map((r) => ms(r.at));
    const latest = snaps[snaps.length - 1];
    return {
      snaps,
      tMin,
      tMax,
      restarts,
      latest,
      latency: [
        { label: "slowest route p95", color: COLORS.latency, segments: levelSegments(snaps, (s) => s.routeP95Ms) },
      ] as Series[],
      fanout: [
        { label: "broadcast fan-out p95", color: COLORS.fanout, segments: levelSegments(snaps, (s) => s.fanoutP95Ms) },
      ] as Series[],
      requests: [
        { label: "requests", color: COLORS.requests, segments: rateSegments(snaps, (s) => s.requestsTotal) },
      ] as Series[],
      contention: [
        { label: "claims", color: COLORS.requests, segments: rateSegments(snaps, (s) => s.claims) },
        { label: "conflicts", color: COLORS.conflicts, segments: rateSegments(snaps, (s) => s.claimConflicts) },
        { label: "TTL takeovers", color: COLORS.expiries, segments: rateSegments(snaps, (s) => s.ttlExpiries) },
      ] as Series[],
      clients: [
        { label: "connected clients", color: COLORS.clients, segments: levelSegments(snaps, (s) => s.wsClients) },
      ] as Series[],
    };
  }, [load]);

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteHeader
        onHome={props.onHome}
        label="Performance"
        onOpenMCP={props.onOpenMCP}
        onShowCanvases={props.onShowCanvases}
        onShowSettings={props.onShowSettings}
        onShowAbout={props.onShowAbout}
        onOpenCanvas={props.onOpenCanvas}
      >
        <button
          onClick={() => void reload(hours)}
          className="rounded-md border border-ink/10 px-2.5 py-1 text-xs hover:bg-ink/5"
        >
          Refresh
        </button>
      </SiteHeader>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Performance history</h1>
            <p className="mt-0.5 text-sm text-ink/50">
              Persisted from <code className="font-code text-xs">/api/metrics</code>. Dashed rules
              are restarts — a deploy is one.
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-ink/10 bg-surface p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.hours}
                onClick={() => setHours(w.hours)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  hours === w.hours ? "bg-ink/10 font-medium" : "text-ink/60 hover:bg-ink/5"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        {load.status === "loading" && <p className="text-sm text-ink/40">Loading…</p>}

        {load.status === "denied" && <Denied httpStatus={load.httpStatus} />}

        {load.status === "error" && (
          <p className="rounded-xl border border-ink/10 bg-surface px-4 py-3 text-sm text-ink/70">
            {load.message}
          </p>
        )}

        {load.status === "ready" && !view && (
          <div className="rounded-2xl border border-ink/10 bg-surface px-5 py-6 text-sm text-ink/60">
            <p className="font-medium text-ink">Nothing recorded in this window yet.</p>
            <p className="mt-1.5 leading-relaxed">
              The collector writes one row per{" "}
              <code className="font-code text-xs">METRICS_SNAPSHOT_INTERVAL_SECONDS</code> (60s by
              default), starting one interval after boot. If this stays empty, check that migration{" "}
              <code className="font-code text-xs">0040_metrics_history.sql</code> has been applied.
            </p>
          </div>
        )}

        {load.status === "ready" && view && (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile
                label="slowest route p95"
                value={`${fmtNum(view.latest.routeP95Ms)} ms`}
                sub={`${view.latest.routeP95Method} ${view.latest.routeP95Route}`}
              />
              <Tile
                label="fan-out p95"
                value={`${fmtNum(view.latest.fanoutP95Ms)} ms`}
                sub="WebSocket broadcast"
              />
              <Tile label="ws clients" value={fmtNum(view.latest.wsClients)} sub="right now" />
              <Tile
                label="uptime"
                value={fmtDuration(view.latest.uptimeSeconds)}
                sub={`since ${new Date(view.latest.processStartedAt).toLocaleString()}`}
              />
            </div>

            {load.history.truncated && (
              <p className="mb-4 rounded-lg border border-ink/10 bg-surface px-3 py-2 text-xs text-ink/60">
                Row cap reached — this shows the most recent {view.snaps.length} snapshots, so the
                chart starts later than the window you picked.
              </p>
            )}

            <div className="grid gap-4">
              <ChartCard
                title="Latency"
                hint="The worst route p95 in each snapshot's 5-minute window. Not differenced — a percentile is already a rate."
                series={view.latency}
                unit="ms"
                tMin={view.tMin}
                tMax={view.tMax}
                restarts={view.restarts}
              />
              <ChartCard
                title="Broadcast fan-out"
                hint="How long the hub takes to push one canvas change to every connected client. Invisible to request latency, and the number that decides whether a fleet feels live."
                series={view.fanout}
                unit="ms"
                tMin={view.tMin}
                tMax={view.tMax}
                restarts={view.restarts}
              />
              <ChartCard
                title="Throughput"
                hint="Requests per minute, differenced from the cumulative counter. Lines break at restarts because the counter resets there."
                series={view.requests}
                unit="req/min"
                tMin={view.tMin}
                tMax={view.tMax}
                restarts={view.restarts}
              />
              <ChartCard
                title="Queue contention"
                hint="Claims, claims lost to a rival, and takeovers of a lapsed claim — per minute. Conflicts climbing with claims is a fleet racing; TTL takeovers climbing means workers are outliving their leases."
                series={view.contention}
                unit="per min"
                tMin={view.tMin}
                tMax={view.tMax}
                restarts={view.restarts}
              />
              <ChartCard
                title="Connected clients"
                hint="A gauge, so it is plotted as-is and not split at restarts: the drop to zero and back IS what a restart does to live connections."
                series={view.clients}
                unit="clients"
                tMin={view.tMin}
                tMax={view.tMax}
                restarts={view.restarts}
              />
            </div>

            {load.history.restarts.length > 0 && (
              <section className="mt-5 rounded-2xl border border-ink/10 bg-surface p-4">
                <h2 className="text-sm font-semibold">
                  Restarts in this window ({load.history.restarts.length})
                </h2>
                <p className="mt-0.5 text-xs text-ink/50">
                  Each is an upper bound: the true restart is between this snapshot and the one
                  before it.
                </p>
                <ul className="mt-2 space-y-1 font-code text-xs text-ink/70">
                  {load.history.restarts.map((r) => (
                    <li key={r.at}>{new Date(r.at).toLocaleString()}</li>
                  ))}
                </ul>
              </section>
            )}

            <ExportRow
              links={[
                { label: "history CSV", href: metricsHistoryExportUrl(hours, "csv") },
                { label: "history JSON", href: metricsHistoryExportUrl(hours, "json") },
                { label: "loadtest CSV", href: loadtestExportUrl("csv") },
                { label: "loadtest JSON", href: loadtestExportUrl("json") },
              ]}
            />

            <LoadtestTable runs={load.runs} />
          </>
        )}
      </main>
    </div>
  );
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Denied({ httpStatus }: { httpStatus: number }) {
  // Three refusals, three answers. Collapsing them into one message is how an
  // operator spends an afternoon debugging a missing env var as a login problem.
  const copy =
    httpStatus === 404
      ? {
          title: "Not configured on this deployment",
          body: (
            <>
              The metrics console is gated on an allowlist. Set{" "}
              <code className="font-code text-xs">METRICS_OWNER_EMAILS</code> on the API to a
              comma-separated list of the accounts allowed to read it, then reload.
            </>
          ),
        }
      : httpStatus === 401
        ? { title: "Sign in to continue", body: <>This page needs a signed-in session.</> }
        : {
            title: "Not your console",
            body: <>Your account is signed in but is not on the metrics allowlist.</>,
          };
  return (
    <div className="rounded-2xl border border-ink/10 bg-surface px-5 py-6">
      <p className="font-medium">{copy.title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-ink/60">{copy.body}</p>
    </div>
  );
}

function ExportRow({ links }: { links: { label: string; href: string }[] }) {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <span className="text-xs text-ink/40">Export</span>
      {links.map((l) => (
        <a
          key={l.href}
          href={l.href}
          className="rounded-md border border-ink/10 bg-surface px-2.5 py-1 text-xs hover:bg-ink/5"
        >
          {l.label}
        </a>
      ))}
    </div>
  );
}

// LoadtestTable renders the cmd/loadtest baselines as a RUN HISTORY, which is the
// point: a directory of JSON files cannot show that the 64-agent throughput moved,
// and a table sorted newest-first can. Rows are per (run, scenario) because
// comparing an 8-agent number against a 64-agent one is meaningless.
function LoadtestTable({ runs }: { runs: LoadtestRun[] }) {
  if (!runs.length) {
    return (
      <section className="mt-5 rounded-2xl border border-ink/10 bg-surface p-4">
        <h2 className="text-sm font-semibold">Loadtest baselines</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink/50">
          Nothing published yet. Run{" "}
          <code className="font-code">go run ./cmd/loadtest -api … -publish</code> (with{" "}
          <code className="font-code">TANDEM_PAT</code> set) to add a run, or POST an existing{" "}
          <code className="font-code">cmd/loadtest/baselines/*.json</code> to{" "}
          <code className="font-code">/api/metrics/loadtest</code> to backfill one.
        </p>
      </section>
    );
  }
  return (
    <section className="mt-5 rounded-2xl border border-ink/10 bg-surface p-4">
      <h2 className="text-sm font-semibold">Loadtest baselines</h2>
      <p className="mt-0.5 text-xs text-ink/50">
        One row per scenario per run, newest first. A dirty tree is flagged — those numbers describe
        code that is not in any commit.
      </p>
      <div className="mt-3 -mx-1 overflow-x-auto">
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr className="border-b border-ink/10 text-left text-ink/50">
              <th className="px-1 py-1.5 font-medium">when</th>
              <th className="px-1 py-1.5 font-medium">scenario</th>
              <th className="px-1 py-1.5 text-right font-medium">agents</th>
              <th className="px-1 py-1.5 text-right font-medium">ops/sec</th>
              <th className="px-1 py-1.5 text-right font-medium">claim p95</th>
              <th className="px-1 py-1.5 text-right font-medium">queue p95</th>
              <th className="px-1 py-1.5 text-right font-medium">errors</th>
              <th className="px-1 py-1.5 text-right font-medium">assertions</th>
              <th className="px-1 py-1.5 font-medium">rev</th>
            </tr>
          </thead>
          <tbody className="font-code tabular-nums">
            {runs.map((r) => (
              <tr key={`${r.runId}-${r.scenario}`} className="border-b border-ink/5">
                <td className="whitespace-nowrap px-1 py-1.5 text-ink/60">
                  {new Date(r.startedAt).toLocaleString()}
                </td>
                <td className="px-1 py-1.5">
                  {r.scenario}
                  {r.skipped && <span className="ml-1 text-ink/40">skipped</span>}
                  {r.aborted && <span className="ml-1 text-red-500">aborted</span>}
                </td>
                <td className="px-1 py-1.5 text-right">{r.liveAgents}</td>
                <td className="px-1 py-1.5 text-right">{fmtNum(r.taskOpsPerSec)}</td>
                <td className="px-1 py-1.5 text-right">{fmtNum(r.claimP95Ms)}</td>
                <td className="px-1 py-1.5 text-right">{fmtNum(r.queueP95Ms)}</td>
                <td className="px-1 py-1.5 text-right">{(r.errorRate * 100).toFixed(2)}%</td>
                <td className="px-1 py-1.5 text-right">
                  {r.assertionsPassed}/{r.assertionsPassed + r.assertionsFailed}
                </td>
                <td className="px-1 py-1.5 text-ink/50">
                  {r.gitRev.slice(0, 7)}
                  {r.gitDirty && <span className="ml-1 text-amber-500">dirty</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
