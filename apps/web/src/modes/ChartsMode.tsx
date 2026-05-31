import { useMemo, useState } from "react";
import type { CanvasState, Chart, ChartType, Sheet, SheetRow } from "../types";
import { sendOp } from "../lib/ws";
import EmptyState from "../components/EmptyState";

interface Props {
  state: CanvasState;
}

const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: "bar", label: "Bar" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "pie", label: "Pie" },
];

// Series palette — kept in sync with the agent-facing docs (first color = first
// y column, etc).
const SERIES_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
  "#ef4444",
  "#14b8a6",
  "#ec4899",
  "#64748b",
];

export default function ChartsMode({ state }: Props) {
  const charts = useMemo(
    () =>
      Object.values(state.charts).sort(
        (a, b) => a.sortOrder - b.sortOrder || a.updatedAt - b.updatedAt,
      ),
    [state.charts],
  );
  const sheets = useMemo(
    () =>
      Object.values(state.sheets).sort(
        (a, b) => a.sortOrder - b.sortOrder || a.updatedAt - b.updatedAt,
      ),
    [state.sheets],
  );

  function nextSortOrder(): number {
    if (charts.length === 0) return 0;
    return Math.max(...charts.map((c) => c.sortOrder)) + 1;
  }

  function handleAddChart() {
    const sheet = sheets[0];
    if (!sheet) return;
    const cols = [...sheet.columns].sort((a, b) => a.sortOrder - b.sortOrder);
    const xCol =
      cols.find((c) => c.type === "date") ?? cols.find((c) => c.type === "text") ?? cols[0];
    const yCol = cols.find((c) => c.type === "number" && c.id !== xCol?.id);
    sendOp({
      op: "chart.add",
      data: {
        name: "New chart",
        sheetId: sheet.id,
        chartType: "bar",
        xColumn: xCol?.id ?? "",
        yColumns: yCol ? [yCol.id] : [],
        sortOrder: nextSortOrder(),
      },
    });
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 max-w-5xl mx-auto w-full px-6 pt-6 pb-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">Charts</h1>
          <button
            onClick={handleAddChart}
            disabled={sheets.length === 0}
            className="text-sm px-3 py-1.5 rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={sheets.length === 0 ? "Create a sheet first — charts read from sheet data" : "Add a chart"}
          >
            + New chart
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto w-full px-6 pb-8">
          {charts.length === 0 ? (
            <EmptyState
              title="No charts yet"
              hint={
                sheets.length === 0
                  ? "Charts visualize sheet data. Create a sheet first, then add a chart — or ask the agent to graph it."
                  : "Click + New chart to plot a sheet, or ask the agent to graph your data over time."
              }
            />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {charts.map((chart) => (
                <ChartCard key={chart.id} chart={chart} sheets={sheets} state={state} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Chart card (render + editor) ──────────────────────────────────────────────

function ChartCard({
  chart,
  sheets,
  state,
}: {
  chart: Chart;
  sheets: Sheet[];
  state: CanvasState;
}) {
  const [editing, setEditing] = useState(false);
  const sheet = state.sheets[chart.sheetId];
  const rows = useMemo(() => rowsForSheet(state, chart.sheetId), [state, chart.sheetId]);

  function handleDelete() {
    if (!confirm(`Delete chart "${chart.name || "Untitled"}"?`)) return;
    sendOp({ op: "chart.delete", id: chart.id });
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-gray-100">
        <input
          value={chart.name}
          onChange={(e) => sendOp({ op: "chart.update", id: chart.id, partial: { name: e.target.value } })}
          placeholder="Untitled chart"
          className="text-sm font-semibold text-gray-900 bg-transparent focus:outline-none focus:border-b focus:border-blue-300 min-w-0 flex-1"
        />
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setEditing((v) => !v)}
            className={`text-xs px-2 py-1 rounded ${editing ? "bg-blue-50 text-blue-700" : "text-gray-500 hover:bg-gray-100"}`}
            title="Configure chart"
          >
            Edit
          </button>
          <button
            onClick={handleDelete}
            className="text-gray-400 hover:text-red-600 px-1.5 py-1 rounded hover:bg-red-50"
            title="Delete chart"
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M3 3 L 9 9 M 9 3 L 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {editing && <ChartEditor chart={chart} sheets={sheets} sheet={sheet} />}

      <div className="p-4 flex-1">
        {!sheet ? (
          <ChartNotice text="Source sheet was deleted. Edit this chart to pick another sheet, or delete it." />
        ) : (
          <ChartBody chart={chart} sheet={sheet} rows={rows} />
        )}
      </div>
    </div>
  );
}

function ChartEditor({
  chart,
  sheets,
  sheet,
}: {
  chart: Chart;
  sheets: Sheet[];
  sheet: Sheet | undefined;
}) {
  const cols = sheet ? [...sheet.columns].sort((a, b) => a.sortOrder - b.sortOrder) : [];

  function update(
    partial: Partial<Pick<Chart, "name" | "sheetId" | "chartType" | "xColumn" | "yColumns" | "sortOrder">>,
  ) {
    sendOp({ op: "chart.update", id: chart.id, partial });
  }

  function toggleY(colId: string) {
    const set = new Set(chart.yColumns);
    if (set.has(colId)) set.delete(colId);
    else set.add(colId);
    const ordered = cols.filter((c) => set.has(c.id)).map((c) => c.id);
    update({ yColumns: ordered });
  }

  return (
    <div className="px-4 py-3 bg-gray-50/70 border-b border-gray-100 grid grid-cols-2 gap-3 text-xs">
      <label className="flex flex-col gap-1">
        <span className="text-gray-500 font-medium">Source sheet</span>
        <select
          value={chart.sheetId}
          onChange={(e) => update({ sheetId: e.target.value })}
          className="border border-gray-300 rounded px-2 py-1 bg-white"
        >
          {sheets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || "Untitled"}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-gray-500 font-medium">Chart type</span>
        <select
          value={chart.chartType}
          onChange={(e) => update({ chartType: e.target.value as ChartType })}
          className="border border-gray-300 rounded px-2 py-1 bg-white"
        >
          {CHART_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-gray-500 font-medium">{chart.chartType === "pie" ? "Categories (x)" : "X axis"}</span>
        <select
          value={chart.xColumn}
          onChange={(e) => update({ xColumn: e.target.value })}
          className="border border-gray-300 rounded px-2 py-1 bg-white"
        >
          <option value="">— none —</option>
          {cols.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || "Untitled"} ({c.type})
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-gray-500 font-medium">
          {chart.chartType === "pie" ? "Value (y) — first used" : "Y series"}
        </span>
        <div className="flex flex-col gap-0.5 max-h-28 overflow-y-auto border border-gray-200 rounded bg-white px-2 py-1">
          {cols.length === 0 ? (
            <span className="text-gray-400 italic py-0.5">No columns</span>
          ) : (
            cols.map((c) => {
              const idx = chart.yColumns.indexOf(c.id);
              return (
                <label key={c.id} className="flex items-center gap-1.5 cursor-pointer py-0.5">
                  <input type="checkbox" checked={idx >= 0} onChange={() => toggleY(c.id)} />
                  {idx >= 0 && (
                    <span
                      className="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ background: SERIES_COLORS[idx % SERIES_COLORS.length] }}
                    />
                  )}
                  <span className={c.type === "number" ? "text-gray-700" : "text-gray-400"}>
                    {c.name || "Untitled"}
                  </span>
                </label>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ── Chart body: dispatch to the renderer ──────────────────────────────────────

interface Series {
  name: string;
  color: string;
  values: (number | null)[];
}

function ChartBody({ chart, sheet, rows }: { chart: Chart; sheet: Sheet; rows: SheetRow[] }) {
  const xCol = sheet.columns.find((c) => c.id === chart.xColumn);
  const yCols = chart.yColumns
    .map((id) => sheet.columns.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  if (!xCol || yCols.length === 0) {
    return <ChartNotice text="Click Edit to pick an X axis and at least one Y series." />;
  }
  if (rows.length === 0) {
    return <ChartNotice text="The source sheet has no rows yet — add data and the chart fills in." />;
  }

  const categories = rows.map((r) => formatCell(r.data[xCol.id]));
  const series: Series[] = yCols.map((col, i) => ({
    name: col.name || "Untitled",
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    values: rows.map((r) => {
      const n = Number(r.data[col.id]);
      return Number.isFinite(n) ? n : null;
    }),
  }));

  if (chart.chartType === "pie") {
    return <PieChart categories={categories} series={series[0]} />;
  }
  return <AxisChart type={chart.chartType} categories={categories} series={series} />;
}

// ── Axis-based charts (bar / line / area) ─────────────────────────────────────

const W = 640;
const H = 300;
const M = { top: 16, right: 16, bottom: 52, left: 52 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

function AxisChart({
  type,
  categories,
  series,
}: {
  type: ChartType;
  categories: string[];
  series: Series[];
}) {
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const dataMax = all.length ? Math.max(...all) : 1;
  const dataMin = all.length ? Math.min(...all) : 0;
  const yMax = niceCeil(Math.max(0, dataMax));
  const yMin = dataMin < 0 ? -niceCeil(-dataMin) : 0;
  const span = yMax - yMin || 1;
  const ticks = makeTicks(yMin, yMax, 4);

  const n = categories.length;
  const band = PW / Math.max(n, 1);
  const xCenter = (i: number) => M.left + band * (i + 0.5);
  const yScale = (v: number) => M.top + PH - ((v - yMin) / span) * PH;
  const baseY = yScale(0);

  // For dense category axes, thin the x labels.
  const labelEvery = Math.ceil(n / 12);

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="block" role="img">
        {/* gridlines + y labels */}
        {ticks.map((t) => {
          const y = yScale(t);
          return (
            <g key={t}>
              <line x1={M.left} y1={y} x2={M.left + PW} y2={y} stroke="#eef2f7" strokeWidth={1} />
              <text x={M.left - 8} y={y + 3} textAnchor="end" fontSize={10} fill="#94a3b8">
                {formatNum(t)}
              </text>
            </g>
          );
        })}
        {/* zero baseline emphasized if negatives exist */}
        {yMin < 0 && <line x1={M.left} y1={baseY} x2={M.left + PW} y2={baseY} stroke="#cbd5e1" strokeWidth={1} />}

        {/* series */}
        {type === "bar"
          ? series.map((s, si) => {
              const groupW = band * 0.7;
              const barW = groupW / series.length;
              return (
                <g key={si}>
                  {s.values.map((v, i) => {
                    if (v === null) return null;
                    const x = M.left + band * i + band * 0.15 + si * barW;
                    const y = yScale(Math.max(v, 0));
                    const h = Math.abs(yScale(v) - baseY);
                    return <rect key={i} x={x} y={y} width={Math.max(barW - 1, 1)} height={Math.max(h, 0)} rx={1} fill={s.color} />;
                  })}
                </g>
              );
            })
          : series.map((s, si) => {
              const pts = s.values
                .map((v, i) => (v === null ? null : `${xCenter(i)},${yScale(v)}`))
                .filter((p): p is string => p !== null);
              if (pts.length === 0) return null;
              const linePath = `M ${pts.join(" L ")}`;
              const areaPath =
                type === "area"
                  ? `${linePath} L ${xCenter(lastIdx(s.values))},${baseY} L ${xCenter(firstIdx(s.values))},${baseY} Z`
                  : "";
              return (
                <g key={si}>
                  {type === "area" && <path d={areaPath} fill={s.color} fillOpacity={0.15} />}
                  <path d={linePath} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {s.values.map((v, i) =>
                    v === null ? null : <circle key={i} cx={xCenter(i)} cy={yScale(v)} r={2.5} fill={s.color} />,
                  )}
                </g>
              );
            })}

        {/* x axis line + labels */}
        <line x1={M.left} y1={M.top + PH} x2={M.left + PW} y2={M.top + PH} stroke="#cbd5e1" strokeWidth={1} />
        {categories.map((c, i) =>
          i % labelEvery === 0 ? (
            <text key={i} x={xCenter(i)} y={M.top + PH + 16} textAnchor="middle" fontSize={10} fill="#64748b">
              {truncate(c, 12)}
            </text>
          ) : null,
        )}
      </svg>
      <Legend series={series} />
    </div>
  );
}

// ── Pie chart ─────────────────────────────────────────────────────────────────

function PieChart({ categories, series }: { categories: string[]; series: Series | undefined }) {
  if (!series) return <ChartNotice text="Pick a Y value column to slice the pie." />;
  const slices = categories
    .map((label, i) => ({ label, value: series.values[i] ?? 0, color: SERIES_COLORS[i % SERIES_COLORS.length] }))
    .filter((s) => s.value > 0);
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  if (total <= 0) return <ChartNotice text="No positive values to chart in this column." />;

  const cx = 150;
  const cy = 150;
  const r = 130;
  let angle = -Math.PI / 2; // start at top

  return (
    <div className="w-full flex flex-col sm:flex-row items-center gap-4">
      <svg viewBox="0 0 300 300" width="100%" className="block max-w-[280px] mx-auto" role="img">
        {slices.map((s, i) => {
          const frac = s.value / total;
          const a0 = angle;
          const a1 = angle + frac * Math.PI * 2;
          angle = a1;
          if (frac >= 0.9999) {
            return <circle key={i} cx={cx} cy={cy} r={r} fill={s.color} />;
          }
          const x0 = cx + r * Math.cos(a0);
          const y0 = cy + r * Math.sin(a0);
          const x1 = cx + r * Math.cos(a1);
          const y1 = cy + r * Math.sin(a1);
          const large = a1 - a0 > Math.PI ? 1 : 0;
          return (
            <path
              key={i}
              d={`M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`}
              fill={s.color}
              stroke="#fff"
              strokeWidth={1.5}
            />
          );
        })}
      </svg>
      <div className="flex flex-col gap-1 text-xs min-w-0 sm:w-44 shrink-0">
        {slices.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5 min-w-0">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
            <span className="truncate text-gray-700" title={s.label}>
              {s.label || "—"}
            </span>
            <span className="ml-auto tabular-nums text-gray-400 shrink-0">
              {Math.round((s.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Shared bits ───────────────────────────────────────────────────────────────

function Legend({ series }: { series: Series[] }) {
  if (series.length <= 1) return null;
  return (
    <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mt-1 px-2 text-xs text-gray-600">
      {series.map((s, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

function ChartNotice({ text }: { text: string }) {
  return (
    <div className="h-48 flex items-center justify-center text-center text-sm text-gray-400 px-6">
      {text}
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

function rowsForSheet(state: CanvasState, sheetId: string): SheetRow[] {
  return Object.values(state.sheetRows)
    .filter((r) => r.sheetId === sheetId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.updatedAt - b.updatedAt);
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "✓" : "";
  return String(v);
}

function firstIdx(values: (number | null)[]): number {
  const i = values.findIndex((v) => v !== null);
  return i < 0 ? 0 : i;
}

function lastIdx(values: (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
  return values.length - 1;
}

// Round up to a "nice" number (1/2/5 × 10^n) for axis maxima.
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const f = v / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

function makeTicks(min: number, max: number, count: number): number[] {
  const step = (max - min) / count;
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(min + step * i);
  return out;
}

function formatNum(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${trim(v / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(v / 1_000)}k`;
  return trim(v);
}

function trim(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
