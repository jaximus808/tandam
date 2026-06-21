import { useEffect, useMemo, useState } from "react";
import { listRecent, removeRecent } from "../lib/recentCanvases";
import { fetchMe, GOOGLE_CLIENT_ID, type User } from "../lib/auth";
import TandemLogo from "../components/TandemLogo";
import AccountMenu from "../components/AccountMenu";
import CanvasLauncher from "../components/CanvasLauncher";
import SignInModal from "../components/SignInModal";

interface Props {
  onJoin: (code: string) => void;
  onOpenMCP: () => void;
  onShowCanvases: () => void;
}

/* ─────────────────────────────────────────────────────────────────────────────
   The whole page rides one idea: the site IS the worksurface. A dot-grid canvas
   where the content itself is "selected objects" — frames, corner handles,
   editor tags — and a live op feed shows agents speaking in operations while
   humans speak in names. Humans are ink; agents are terracotta.

   The hero canvas morphs through four real flows — Operations, Builders, Life,
   Research — while the headline word, accent colour, and op feed change in
   lockstep. `sceneIdx` lives up here in the page so everything stays in sync.
   ───────────────────────────────────────────────────────────────────────────── */

const INK = "#1C1917";
const AGENT = "#C75B39";

interface Accent {
  solid: string;
  soft: string;
  line: string;
}

interface Editor {
  name: string;
  kind: "human" | "agent";
  at: React.CSSProperties; // where this cursor sits inside the canvas body
  drift: "a" | "b";
}

interface OpLine {
  t: string; // wall-clock-ish timestamp
  actor: string;
  kind: "human" | "agent";
  op: string; // the MCP-ish operation name
  arg: string; // human-readable payload
}

interface Scene {
  key: "ops" | "build" | "life" | "research";
  tab: string; // scene switcher label
  canvasName: string; // shown in the canvas title bar
  code: string; // cosmetic 8-char code
  mode: string; // highlighted mode tab
  phrase: string; // the cycling headline phrase
  heroAgent: string; // the cursor by the headline — distinct from the canvas editors
  accent: Accent;
  editors: [Editor, Editor]; // the two drifting cursors
  ops: OpLine[]; // the live feed under the canvas
}

const SCENES: Scene[] = [
  {
    key: "ops",
    tab: "Operations",
    canvasName: "Incident bridge",
    code: "OPS5K3R7",
    mode: "Sheets",
    phrase: "run operations",
    heroAgent: "Claude",
    accent: { solid: "#F43F5E", soft: "rgba(244,63,94,0.10)", line: "rgba(244,63,94,0.24)" },
    editors: [
      { name: "ops-agent", kind: "agent", at: { top: "30%", left: "53%" }, drift: "a" },
      { name: "Priya", kind: "human", at: { bottom: "10%", left: "20%" }, drift: "b" },
    ],
    ops: [
      { t: "14:02:31", actor: "ops-agent", kind: "agent", op: "sheet.row.add", arg: '"API 5xx spike"' },
      { t: "14:02:34", actor: "ops-agent", kind: "agent", op: "row.update", arg: "status → mitigating" },
      { t: "14:02:41", actor: "priya", kind: "human", op: "note.add", arg: '"rollback v2.3.1 first"' },
      { t: "14:02:45", actor: "ops-agent", kind: "agent", op: "chart.update", arg: "error-rate / 5m" },
    ],
  },
  {
    key: "build",
    tab: "Builders",
    canvasName: "Q3 product build",
    code: "BUILD8QX",
    mode: "Roadmap",
    phrase: "ship the build",
    heroAgent: "Cursor",
    accent: { solid: "#0EA5E9", soft: "rgba(14,165,233,0.10)", line: "rgba(14,165,233,0.24)" },
    editors: [
      { name: "Codex", kind: "agent", at: { top: "34%", right: "10%" }, drift: "a" },
      { name: "Devin", kind: "human", at: { top: "55%", right: "22%" }, drift: "b" },
    ],
    ops: [
      { t: "09:41:02", actor: "codex", kind: "agent", op: "item.update", arg: '"Realtime cursors" → in_progress' },
      { t: "09:41:18", actor: "devin", kind: "human", op: "item.add", arg: '"Billing webhooks"' },
      { t: "09:41:26", actor: "codex", kind: "agent", op: "sheet.row.add", arg: "perf budget · p95 400ms" },
      { t: "09:41:53", actor: "codex", kind: "agent", op: "item.update", arg: '"Charts mode" → done' },
    ],
  },
  {
    key: "life",
    tab: "Life",
    canvasName: "Our 2026",
    code: "YEAR42KP",
    mode: "Itinerary",
    phrase: "plan the year",
    heroAgent: "Codex",
    accent: { solid: "#F59E0B", soft: "rgba(245,158,11,0.12)", line: "rgba(245,158,11,0.26)" },
    editors: [
      { name: "Claude", kind: "agent", at: { top: "26%", right: "12%" }, drift: "a" },
      { name: "Sam", kind: "human", at: { bottom: "14%", right: "16%" }, drift: "b" },
    ],
    ops: [
      { t: "19:12:08", actor: "claude", kind: "agent", op: "event.add", arg: '"Apartment tours" · Mar' },
      { t: "19:12:15", actor: "sam", kind: "human", op: "pin.add", arg: '"Shinjuku hotel"' },
      { t: "19:12:19", actor: "claude", kind: "agent", op: "event.update", arg: "Japan → flights held" },
      { t: "19:12:31", actor: "claude", kind: "agent", op: "note.add", arg: '"no visa needed < 90 days"' },
    ],
  },
  {
    key: "research",
    tab: "Research",
    canvasName: "Vendor scan",
    code: "SCOUT9WZ",
    mode: "Map",
    phrase: "map the unknown",
    heroAgent: "Claude Code",
    accent: { solid: "#10B981", soft: "rgba(16,185,129,0.10)", line: "rgba(16,185,129,0.24)" },
    editors: [
      { name: "scout-agent", kind: "agent", at: { top: "30%", left: "30%" }, drift: "a" },
      { name: "Lee", kind: "human", at: { bottom: "12%", left: "12%" }, drift: "b" },
    ],
    ops: [
      { t: "11:23:44", actor: "scout-agent", kind: "agent", op: "pin.add", arg: '"Acme HQ" · 37.78,-122.41' },
      { t: "11:23:52", actor: "scout-agent", kind: "agent", op: "note.update", arg: "Findings.md › pricing" },
      { t: "11:24:07", actor: "lee", kind: "human", op: "row.update", arg: "Northwind → shortlist" },
      { t: "11:24:19", actor: "scout-agent", kind: "agent", op: "pin.add", arg: '"Globex labs"' },
    ],
  },
];

const SCENE_MS = 4200;

// Only show the public "N canvases created" counter once it's real social
// proof — a tiny number reads as anti-proof. Bump down as adoption grows.
const CANVAS_COUNT_FLOOR = 50;

const MODE_TABS = ["Map", "Itinerary", "Docs", "Roadmap", "Sheets", "Charts"];

const USE_CASES = [
  "Incident response",
  "Sprint planning",
  "Trip itineraries",
  "Market research",
  "Hiring pipelines",
  "Product roadmaps",
  "Event logistics",
  "Fundraising",
  "Content calendars",
  "Move planning",
  "Course syllabi",
  "Launch checklists",
  "Household budgets",
  "Field research",
  "Wedding planning",
  "Go-to-market",
];

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

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

/* ── small inline icon set (no lucide dependency, so nothing to version-match) ── */

function Icon({ name, className = "" }: { name: string; className?: string }) {
  const c = {
    className,
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "arrow":
      return (
        <svg {...c}>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      );
    case "spark":
      return (
        <svg {...c} fill="currentColor" stroke="none">
          <path d="M12 2l1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z" />
        </svg>
      );
    case "check":
      return (
        <svg {...c}>
          <path d="M20 6L9 17l-5-5" />
        </svg>
      );
    case "github":
      return (
        <svg {...c} fill="currentColor" stroke="none" viewBox="0 0 24 24">
          <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.09.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05A9.36 9.36 0 0112 6.84c.85 0 1.71.12 2.51.34 1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.59.69.49A10.02 10.02 0 0022 12.25C22 6.58 17.52 2 12 2z" />
        </svg>
      );
    case "map":
      return (
        <svg {...c}>
          <path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z" />
          <circle cx="12" cy="11" r="2" />
        </svg>
      );
    case "itinerary":
      return (
        <svg {...c}>
          <rect x="3" y="4.5" width="18" height="16" rx="2" />
          <path d="M3 9h18M8 3v3M16 3v3M7.5 13h3M7.5 16.5h6" />
        </svg>
      );
    case "docs":
      return (
        <svg {...c}>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4M9 12h6M9 15.5h6M9 8.5h2" />
        </svg>
      );
    case "sheets":
      return (
        <svg {...c}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M3.5 9.5h17M3.5 14.5h17M9 4.5v15M15 4.5v15" />
        </svg>
      );
    case "roadmap":
      return (
        <svg {...c}>
          <path d="M5 6h12M8 12h11M11 18h8" />
          <circle cx="3.5" cy="6" r="1.4" />
          <circle cx="6.5" cy="12" r="1.4" />
          <circle cx="9.5" cy="18" r="1.4" />
        </svg>
      );
    case "charts":
      return (
        <svg {...c}>
          <path d="M4 21h16M7 21v-7M12 21V6M17 21v-10" />
        </svg>
      );
    case "save":
      return (
        <svg {...c}>
          <path d="M5 3h11l3 3v15H5z" />
          <path d="M8 3v5h7M8 21v-7h8v7" />
        </svg>
      );
    case "devices":
      return (
        <svg {...c}>
          <rect x="2.5" y="5" width="13" height="9" rx="1.5" />
          <path d="M1.5 17h13" />
          <rect x="16.5" y="9" width="6" height="11" rx="1.5" />
          <path d="M18.5 17.5h2" />
        </svg>
      );
    case "copy":
      return (
        <svg {...c}>
          <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
          <path d="M5.5 15.5H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2v.5" />
        </svg>
      );
    default:
      return null;
  }
}

/* ── worksurface vocabulary: pointers, tags, frames, system labels ──────────── */

function PointerGlyph({ color }: { color: string }) {
  // display:block so it never picks up the line-height of big surrounding
  // type (inside the h1 an inline svg sits in a ~60px line box).
  return (
    <svg width="18" height="20" viewBox="0 0 20 22" className="block" aria-hidden="true">
      <path
        d="M2 1.5l13.5 6.2-5.6 1.6-2 5.7z"
        fill={color}
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A multiplayer name tag — square corners, mono, agent vs human colour. */
function NameTag({ name, kind, color }: { name: string; kind: "human" | "agent"; color?: string }) {
  const bg = color ?? (kind === "agent" ? AGENT : INK);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[3px] px-1.5 py-0.5 font-code text-[10px] font-medium leading-none text-white"
      style={{ backgroundColor: bg }}
    >
      {kind === "agent" && <Icon name="spark" className="h-2.5 w-2.5" />}
      {name}
    </span>
  );
}

/** A cursor that wanders a section of the page — the site itself is multiplayer. */
function RoamingCursor({
  name,
  kind,
  roam,
  className = "",
  style,
}: {
  name: string;
  kind: "human" | "agent";
  roam: "a" | "b";
  className?: string;
  style?: React.CSSProperties;
}) {
  const color = kind === "agent" ? AGENT : INK;
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute z-20 hidden xl:block ${className}`}
      style={style}
    >
      <div className={roam === "a" ? "tandem-roam-a" : "tandem-roam-b"}>
        <PointerGlyph color={color} />
        <div className="ml-3 mt-0.5">
          <NameTag name={name} kind={kind} />
        </div>
      </div>
    </div>
  );
}

/** Selection frame: wraps content in a "selected object" rectangle w/ handles. */
function SelectionFrame({
  children,
  tag,
  tagKind = "human",
  className = "",
  color = INK,
}: {
  children: React.ReactNode;
  tag?: string;
  tagKind?: "human" | "agent";
  className?: string;
  color?: string;
}) {
  // The frame sits at -16px x / -12px y around the content; handles are 7px
  // squares centred on each frame corner.
  return (
    <div className={`relative ${className}`} style={{ color }}>
      <span aria-hidden="true" className="pointer-events-none absolute -inset-x-4 -inset-y-3 border-[1.5px] border-current opacity-25" />
      <span aria-hidden="true" className="sel-handle" style={{ top: -15, left: -19 }} />
      <span aria-hidden="true" className="sel-handle" style={{ top: -15, right: -19 }} />
      <span aria-hidden="true" className="sel-handle" style={{ bottom: -15, left: -19 }} />
      <span aria-hidden="true" className="sel-handle" style={{ bottom: -15, right: -19 }} />
      {tag && (
        <span className="pointer-events-none absolute -left-4 -top-3 -translate-y-[calc(100%+5px)]">
          <NameTag name={tag} kind={tagKind} />
        </span>
      )}
      <div className="text-ink">{children}</div>
    </div>
  );
}

/** Tiny mono system label — coordinates, section ids, telemetry. */
function SysLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`font-code text-[11px] uppercase tracking-[0.22em] text-ink/40 ${className}`}>
      {children}
    </span>
  );
}

/* ── the floating cursors inside the demo canvas ─────────────────────────────── */

function Cursor({ editor, accent }: { editor: Editor; accent: Accent }) {
  const color = editor.kind === "agent" ? AGENT : accent.solid;
  return (
    <div className="absolute z-30 pointer-events-none" style={editor.at}>
      <div className={editor.drift === "a" ? "tandem-drift-a" : "tandem-drift-b"}>
        <PointerGlyph color={color} />
        <div className="mt-0.5">
          <NameTag name={editor.name} kind={editor.kind} color={color} />
        </div>
      </div>
    </div>
  );
}

/* ── per-scene body: each flow renders a genuinely different layout ──────────── */

function Pill({ label, accent, tone }: { label: string; accent: Accent; tone: "accent" | "done" | "muted" }) {
  if (tone === "done") {
    return (
      <span className="inline-flex items-center gap-1 rounded-[3px] bg-emerald-50 px-2 py-0.5 font-code text-[9px] font-medium text-emerald-600">
        <Icon name="check" className="w-2.5 h-2.5" />
        done
      </span>
    );
  }
  if (tone === "muted") {
    return (
      <span className="rounded-[3px] bg-ink/5 px-2 py-0.5 font-code text-[9px] font-medium text-ink/35">
        {label.toLowerCase()}
      </span>
    );
  }
  return (
    <span
      className="rounded-[3px] px-2 py-0.5 font-code text-[9px] font-medium"
      style={{ backgroundColor: accent.soft, color: accent.solid }}
    >
      {label.toLowerCase()}
    </span>
  );
}

function OpsBody() {
  const cols: { title: string; cards: { name: string; meta: string; sev: string }[] }[] = [
    {
      title: "Triage",
      cards: [
        { name: "API 5xx spike", meta: "edge-eu · 4m", sev: "#F43F5E" },
        { name: "Checkout latency", meta: "p95 1.8s", sev: "#F59E0B" },
        { name: "Webhook backlog", meta: "12k queued", sev: "#F59E0B" },
      ],
    },
    {
      title: "Mitigating",
      cards: [
        { name: "Rollback v2.3.1", meta: "ops-agent", sev: "#0EA5E9" },
        { name: "Drain edge-eu", meta: "Priya · now", sev: "#0EA5E9" },
      ],
    },
    {
      title: "Resolved",
      cards: [
        { name: "Scale workers ×3", meta: "done · 2m", sev: "#10B981" },
        { name: "Cache flush", meta: "done · 6m", sev: "#10B981" },
        { name: "Status page", meta: "posted", sev: "#10B981" },
      ],
    },
  ];
  return (
    <div className="grid h-full grid-cols-3 gap-2.5 p-4">
      {cols.map((col) => (
        <div key={col.title} className="flex flex-col gap-2">
          <div className="font-code text-[9px] font-medium uppercase tracking-[0.14em] text-ink/35">
            {col.title}
          </div>
          {col.cards.map((card) => (
            <div
              key={card.name}
              className="rounded-md border border-ink/10 bg-white px-2.5 py-2"
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: card.sev }}
                />
                <span className="truncate text-[10.5px] font-semibold text-ink/85">
                  {card.name}
                </span>
              </div>
              <div className="mt-0.5 font-code text-[8.5px] text-ink/35">{card.meta}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function BuildBody({ accent }: { accent: Accent }) {
  const rows: { name: string; tone: "accent" | "done" | "muted"; label: string; who?: string }[] = [
    { name: "Auth rewrite", tone: "done", label: "Done" },
    { name: "Realtime cursors", tone: "accent", label: "In progress", who: "Devin" },
    { name: "Charts mode", tone: "accent", label: "In progress", who: "Codex" },
    { name: "Billing webhooks", tone: "muted", label: "Todo" },
    { name: "Mobile layout", tone: "muted", label: "Todo" },
  ];
  return (
    <div className="flex h-full flex-col gap-2 p-4">
      {rows.map((row) => (
        <div
          key={row.name}
          className="flex items-center gap-2 rounded-md border border-ink/10 bg-white px-3 py-2"
        >
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{
              backgroundColor:
                row.tone === "done" ? "#10B981" : row.tone === "accent" ? accent.solid : "#D6D3D1",
            }}
          />
          <span className="flex-1 truncate text-[12px] font-medium text-ink/85">{row.name}</span>
          {row.who && (
            <span className="hidden rounded-[3px] bg-ink/5 px-1.5 py-0.5 font-code text-[8.5px] font-medium text-ink/45 sm:inline">
              {row.who}
            </span>
          )}
          <Pill label={row.label} accent={accent} tone={row.tone} />
        </div>
      ))}
    </div>
  );
}

function LifeBody({ accent }: { accent: Accent }) {
  void accent;
  const items = [
    { when: "Mar", what: "Apartment tours", note: "3 saved", color: "#0EA5E9" },
    { when: "Jun", what: "Japan — 2 weeks", note: "flights held", color: "#F59E0B" },
    { when: "Sep", what: "Grad school starts", note: "deposit paid", color: "#7C3AED" },
    { when: "Dec", what: "Family reunion", note: "12 going", color: "#10B981" },
  ];
  return (
    <div className="relative h-full p-4">
      <div className="absolute bottom-5 left-[34px] top-5 w-px bg-ink/10" />
      <div className="flex h-full flex-col justify-between">
        {items.map((it) => (
          <div key={it.what} className="relative flex items-center gap-3">
            <span className="w-6 shrink-0 text-right font-code text-[9px] font-medium text-ink/35">
              {it.when}
            </span>
            <span
              className="z-10 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-white"
              style={{ backgroundColor: it.color }}
            />
            <div className="flex-1 rounded-md border border-ink/10 bg-white px-2.5 py-1.5">
              <div className="text-[11px] font-semibold text-ink/85">{it.what}</div>
              <div className="font-code text-[8.5px] text-ink/35">{it.note}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResearchBody({ accent }: { accent: Accent }) {
  const pins = [
    { label: "Acme", top: "26%", left: "22%", color: "#10B981" },
    { label: "Northwind", top: "58%", left: "44%", color: "#0EA5E9" },
    { label: "Globex", top: "38%", left: "70%", color: "#F59E0B" },
  ];
  return (
    <div className="flex h-full gap-3 p-4">
      <div
        className="relative flex-1 overflow-hidden rounded-md border border-ink/10"
        style={{ background: "linear-gradient(135deg,#ecfdf5,#e0f2fe)" }}
      >
        <div
          aria-hidden="true"
          className="tandem-grid-pan absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(16,185,129,0.10) 1px, transparent 1px), linear-gradient(to bottom, rgba(16,185,129,0.10) 1px, transparent 1px)",
            backgroundSize: "34px 34px",
          }}
        />
        {pins.map((p) => (
          <div
            key={p.label}
            className="absolute -translate-x-1/2 -translate-y-full"
            style={{ top: p.top, left: p.left }}
          >
            <div className="flex flex-col items-center">
              <svg width="18" height="23" viewBox="0 0 18 23" aria-hidden="true">
                <path
                  d="M9 0C4 0 0 4 0 9c0 6.2 9 14 9 14s9-7.8 9-14c0-5-4-9-9-9z"
                  fill={p.color}
                />
                <circle cx="9" cy="9" r="3.2" fill="#fff" />
              </svg>
              <span className="mt-0.5 rounded-[3px] bg-white/90 px-1 py-0.5 font-code text-[8.5px] font-medium text-ink/70">
                {p.label}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex w-28 shrink-0 flex-col gap-1.5">
        <div className="font-code text-[9px] font-medium uppercase tracking-[0.14em] text-ink/35">Docs</div>
        {["Findings.md", "Shortlist", "Pricing grid"].map((d) => (
          <div
            key={d}
            className="flex items-center gap-1.5 rounded-md border border-ink/10 bg-white px-2 py-1.5"
          >
            <span style={{ color: accent.solid }}>
              <Icon name="docs" className="h-3 w-3" />
            </span>
            <span className="truncate text-[10px] font-medium text-ink/70">{d}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SceneBody({ scene }: { scene: Scene }) {
  switch (scene.key) {
    case "ops":
      return <OpsBody />;
    case "build":
      return <BuildBody accent={scene.accent} />;
    case "life":
      return <LifeBody accent={scene.accent} />;
    case "research":
      return <ResearchBody accent={scene.accent} />;
  }
}

/* ── the live op feed: agents speak in operations, humans in names ───────────── */

function OpFeed({ scene }: { scene: Scene }) {
  return (
    <div
      key={scene.key}
      className="mt-3 overflow-hidden rounded-md border border-ink/15 bg-white"
    >
      <div className="flex items-center gap-2 border-b border-ink/10 bg-paper px-3 py-1.5">
        <span className="relative flex h-1.5 w-1.5">
          <span className="tandem-ping absolute inline-flex h-full w-full rounded-full bg-agent opacity-70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-agent" />
        </span>
        <span className="font-code text-[10px] font-medium text-ink/50">canvas.ops — live</span>
        <span className="ml-auto font-code text-[10px] tracking-[0.14em] text-ink/30">
          {scene.code}
        </span>
      </div>
      <div className="px-3 py-2 font-code text-[10.5px] leading-[1.9]">
        {scene.ops.map((line, i) => (
          <div
            key={`${scene.key}-${i}`}
            className="tandem-op-in flex items-baseline gap-2 whitespace-nowrap"
            style={{ animationDelay: `${180 + i * 340}ms` }}
          >
            <span className="text-ink/30">{line.t}</span>
            <span
              className="font-medium"
              style={{ color: line.kind === "agent" ? AGENT : INK }}
            >
              {line.actor}
            </span>
            <span className="text-ink/45">{line.op}</span>
            <span className="truncate text-ink/70">{line.arg}</span>
          </div>
        ))}
        <div className="flex items-center gap-2 text-ink/30">
          <span
            className="tandem-caret inline-block h-3 w-[7px] translate-y-[1px] bg-agent/80"
            style={{ animationDelay: "1.6s" }}
          />
        </div>
      </div>
    </div>
  );
}

/* ── the morphing canvas: chrome + body + cursors, driven by sceneIdx ────────── */

function MorphCanvas({
  sceneIdx,
  setSceneIdx,
}: {
  sceneIdx: number;
  setSceneIdx: (i: number) => void;
}) {
  const scene = SCENES[sceneIdx];
  const { accent } = scene;

  return (
    <div className="relative w-full">
      {/* scene switcher — mono, like view tabs on a surface */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {SCENES.map((s, i) => {
          const active = i === sceneIdx;
          return (
            <button
              key={s.key}
              onClick={() => setSceneIdx(i)}
              className={[
                "rounded-md border px-3 py-1 font-code text-[11px] font-medium transition-colors",
                active
                  ? "border-ink bg-ink text-paper"
                  : "border-ink/15 bg-white text-ink/50 hover:border-ink/35 hover:text-ink",
              ].join(" ")}
            >
              {active && (
                <span
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                  style={{ backgroundColor: s.accent.solid }}
                />
              )}
              {s.tab}
            </button>
          );
        })}
      </div>

      <div className="relative overflow-hidden rounded-lg border-[1.5px] border-ink bg-white shadow-[8px_8px_0_rgba(28,25,23,0.10)]">
        {/* title bar */}
        <div className="flex items-center gap-2.5 border-b border-ink/10 bg-paper px-3.5 py-2">
          <span className="truncate font-display text-[13px] font-medium text-ink">
            {scene.canvasName}
          </span>
          <span className="rounded-[3px] border border-ink/10 px-1.5 py-px font-code text-[9.5px] tracking-[0.14em] text-ink/40">
            {scene.code}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {/* who's on this surface, agent first */}
            <span
              className="grid h-5 w-5 place-items-center rounded-[4px] text-white"
              style={{ backgroundColor: AGENT }}
              title={scene.editors[0].name}
            >
              <Icon name="spark" className="h-2.5 w-2.5" />
            </span>
            <span className="grid h-5 w-5 place-items-center rounded-[4px] bg-ink font-code text-[9px] font-medium text-paper">
              {scene.editors[1].name.slice(0, 1)}
            </span>
            <span className="ml-1 font-code text-[9.5px] text-ink/40">2 here</span>
          </div>
        </div>

        {/* mode tabs */}
        <div className="flex items-center gap-0.5 overflow-x-auto border-b border-ink/10 px-2.5 py-1.5">
          {MODE_TABS.map((m) => {
            const active = m === scene.mode;
            return (
              <span
                key={m}
                className="shrink-0 rounded-[4px] px-2 py-0.5 font-code text-[10px] font-medium transition-colors"
                style={
                  active
                    ? { backgroundColor: accent.soft, color: accent.solid, boxShadow: `inset 0 0 0 1px ${accent.line}` }
                    : { color: "rgba(28,25,23,0.35)" }
                }
              >
                {m.toLowerCase()}
              </span>
            );
          })}
        </div>

        {/* body — re-keyed on scene so it replays the entrance animation */}
        <div className="surface-grid-faint relative h-[300px]">
          {/* "editing" pill — bottom corner so it never covers the first row */}
          <div className="absolute bottom-3 left-3 z-30 flex items-center gap-2 rounded-[4px] border border-ink/10 bg-white/95 px-2 py-1 backdrop-blur">
            <span className="relative flex h-1.5 w-1.5">
              <span className="tandem-ping absolute inline-flex h-full w-full rounded-full bg-agent opacity-70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-agent" />
            </span>
            <span key={scene.key} className="tandem-fade-in font-code text-[10px] text-ink/55">
              {scene.editors[0].name} is editing…
            </span>
          </div>

          {scene.editors.map((ed) => (
            <Cursor key={ed.name} editor={ed} accent={accent} />
          ))}

          <div key={scene.key} className="tandem-scene-in h-full">
            <SceneBody scene={scene} />
          </div>
        </div>
      </div>

      {/* the op feed: same edits, as the agents see them */}
      <OpFeed scene={scene} />
    </div>
  );
}

/* ── content data for the lower sections ─────────────────────────────────────── */

const MODE_DOCS: { kind: string; name: string; color: string; desc: string }[] = [
  {
    kind: "map",
    name: "Map",
    color: "#0EA5E9",
    desc: "Pins with labels, notes, and colours on a real map. Switch base maps — or just ask your agent to.",
  },
  {
    kind: "itinerary",
    name: "Itinerary",
    color: "#F59E0B",
    desc: "A day-by-day schedule. Events link back to their pins, so the plan and the place stay in sync.",
  },
  {
    kind: "docs",
    name: "Docs",
    color: "#7C3AED",
    desc: "Free-form markdown — briefs, research, checklists, anything that doesn't belong on the map.",
  },
  {
    kind: "sheets",
    name: "Sheets",
    color: "#10B981",
    desc: "Typed columns and drag-to-reorder rows. Budgets, comparisons, trackers, triage boards.",
  },
  {
    kind: "roadmap",
    name: "Roadmap",
    color: "#F43F5E",
    desc: "Nested, draggable items with status — todo, in progress, done, blocked. Plan and track in one place.",
  },
  {
    kind: "charts",
    name: "Charts",
    color: "#6366F1",
    desc: "Turn the numbers on your canvas into live charts the whole team — and every agent — can read.",
  },
];

const STEPS: { title: string; body: string }[] = [
  { title: "Create a canvas", body: "Name it and you get a short, shareable 8-character code." },
  {
    title: "Connect your agents",
    body: "Point any MCP-aware agent at the code — Claude, Codex, Cursor, or your own.",
  },
  {
    title: "Work in tandem",
    body: "You, your team, and your agents all edit the same canvas — and its shared memory — live.",
  },
];

const AUDIENCES: { title: string; blurb: string; tags: string[]; accent: string; tilt: string }[] = [
  {
    title: "Operations",
    blurb:
      "Stand up an incident bridge, a launch checklist, or a daily ops board. Agents triage and update while the room watches.",
    tags: ["Incidents", "Launches", "Logistics"],
    accent: "#F43F5E",
    tilt: "lg:-rotate-1",
  },
  {
    title: "Builders",
    blurb:
      "Plan the quarter, split work across coding agents, and watch the roadmap move from todo to done in real time.",
    tags: ["Roadmaps", "Sprints", "Research"],
    accent: "#0EA5E9",
    tilt: "lg:rotate-[0.5deg] lg:translate-y-3",
  },
  {
    title: "Teams & life",
    blurb:
      "A trip, a move, a wedding, a whole year. Bring the people who matter and an agent to do the legwork.",
    tags: ["Trips", "Plans", "Budgets"],
    accent: "#F59E0B",
    tilt: "lg:rotate-1",
  },
];

const ACCOUNT_PERKS: { icon: string; title: string; desc: string }[] = [
  {
    icon: "save",
    title: "Keep your canvases",
    desc: "Sign in and the canvases you create are saved to your account — yours to come back to, not just a link you hope you didn't lose.",
  },
  {
    icon: "devices",
    title: "On every device",
    desc: "Open Tandem on your laptop or your phone and every canvas you own is right there — no more digging through a chat for the code.",
  },
  {
    icon: "copy",
    title: "Make any canvas yours",
    desc: "Got a canvas by its code? Copy it into your account in one click to keep your own editable version.",
  },
];

/* ── the page ────────────────────────────────────────────────────────────────── */

export default function Landing({ onJoin, onOpenMCP, onShowCanvases }: Props) {
  const reduced = usePrefersReducedMotion();
  const [sceneIdx, setSceneIdx] = useState(0);
  const [launcher, setLauncher] = useState<null | "create" | "join">(null);
  const [recents, setRecents] = useState(() => listRecent());
  const [user, setUser] = useState<User | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [canvasCount, setCanvasCount] = useState<number | null>(null);

  const hasRecents = useMemo(() => recents.length > 0, [recents]);
  const scene = SCENES[sceneIdx];

  // Whether to show the "create an account" pitch: only when sign-in is
  // configured and the visitor isn't already signed in.
  const showSignUp = Boolean(GOOGLE_CLIENT_ID) && !user;

  useEffect(() => {
    let cancelled = false;
    fetchMe().then((u) => {
      if (!cancelled) setUser(u);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Public social-proof counter. Degrades silently — no error UI, and the
  // number only renders once it's worth showing (see threshold below).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/stats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.canvases === "number") setCanvasCount(d.canvases);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-advance the hero scene (and with it the headline word + accent). Pausing
  // is implicit: any manual click resets the timer because sceneIdx is a dep.
  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setSceneIdx((sceneIdx + 1) % SCENES.length), SCENE_MS);
    return () => clearTimeout(t);
  }, [sceneIdx, reduced]);

  function handleForgetRecent(c: string) {
    removeRecent(c);
    setRecents(listRecent());
  }

  return (
    <div className="min-h-screen overflow-x-clip scroll-smooth bg-paper font-brand text-ink [text-rendering:optimizeLegibility] antialiased">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-ink/10 bg-paper/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-6">
          <div className="flex items-center gap-2 text-[16px] font-semibold tracking-tight">
            <TandemLogo size={24} />
            <span>Tandem</span>
            <span className="ml-1 hidden items-center gap-1.5 rounded-[3px] border border-ink/10 px-1.5 py-0.5 font-code text-[9px] uppercase tracking-[0.14em] text-ink/40 md:inline-flex">
              <span className="relative flex h-1 w-1">
                <span className="tandem-ping absolute inline-flex h-full w-full rounded-full bg-agent opacity-70" />
                <span className="relative inline-flex h-1 w-1 rounded-full bg-agent" />
              </span>
              multiplayer
            </span>
          </div>
          <nav className="ml-auto flex items-center gap-1 text-sm sm:gap-1.5">
            <a
              href="#use-cases"
              className="hidden rounded-md px-3 py-1.5 text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink sm:inline"
            >
              Use cases
            </a>
            <a
              href="#modes"
              className="hidden rounded-md px-3 py-1.5 text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink sm:inline"
            >
              Modes
            </a>
            <a
              href="https://github.com/jaximus808/tandam"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden rounded-md px-3 py-1.5 text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink sm:inline"
            >
              GitHub
            </a>
            <button
              onClick={onOpenMCP}
              className="rounded-md px-3 py-1.5 font-medium text-ink/80 transition-colors hover:bg-ink/5"
            >
              Connect an agent
            </button>
            <AccountMenu onShowCanvases={onShowCanvases} />
          </nav>
        </div>
      </header>

      {/* Hero — the worksurface */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="surface-grid absolute inset-0"
          style={{
            maskImage: "radial-gradient(120% 90% at 50% 0%, black 55%, transparent 100%)",
            WebkitMaskImage: "radial-gradient(120% 90% at 50% 0%, black 55%, transparent 100%)",
          }}
        />
        {/* viewport telemetry in the corners */}
        <span aria-hidden="true" className="absolute left-4 top-3 hidden font-code text-[10px] text-ink/25 lg:block">
          + 0,0
        </span>
        <span aria-hidden="true" className="absolute right-4 top-3 hidden font-code text-[10px] text-ink/25 lg:block">
          zoom 100% +
        </span>

        <div className="relative mx-auto grid max-w-6xl items-start gap-14 px-6 pb-20 pt-16 lg:grid-cols-[1.02fr_1fr] lg:gap-10 lg:pb-24 lg:pt-20">
          {/* Left: copy + actions */}
          <div className="min-w-0 max-w-xl lg:pt-4">
            <div className="tandem-rise">
              <SysLabel>One surface · humans + agents · live</SysLabel>
            </div>

            {/* mt-12 leaves headroom for the frame's "you" tag above the h1.
                z-10: tandem-rise's lingering transform makes this and the demo
                canvas column stacking contexts; without it the hero cursor
                paints behind the canvas when it overhangs the column gap. */}
            <div className="tandem-rise relative z-10 mt-12" style={{ animationDelay: "60ms" }}>
              {/* All four scene headlines render stacked in one grid cell, the
                  inactive ones invisible — so this block is always as tall as
                  the tallest phrase and the page below never shifts when the
                  cycling word changes line count. */}
              <SelectionFrame tag="you" className="inline-block">
                <h1 className="grid font-display text-[2.3rem] font-medium leading-[1.08] tracking-tight text-ink sm:text-[3.5rem] sm:leading-[1.06]">
                  {SCENES.map((s, i) => {
                    const active = i === sceneIdx;
                    return (
                      <span
                        key={s.key}
                        aria-hidden={!active}
                        className={`col-start-1 row-start-1 block ${active ? "" : "invisible"}`}
                      >
                        Where teams and agents{" "}
                        <span className="relative inline-block">
                          <span
                            key={active ? `${s.key}-on` : s.key}
                            className={`inline-block px-1 italic ${active ? "tandem-word-in" : ""}`}
                            style={{
                              color: s.accent.solid,
                              backgroundColor: s.accent.soft,
                              boxShadow: `inset 0 0 0 1.5px ${s.accent.line}`,
                            }}
                          >
                            {s.phrase}
                          </span>
                          {/* the agent's cursor hovers in the free space right
                              of the phrase, arrow tip aimed back at the word */}
                          {active && (
                            <span className="pointer-events-none absolute left-full top-1/2 ml-1.5 hidden -translate-y-1/2 sm:block">
                              <span key={s.key} className="tandem-fade-in block">
                                <span className="tandem-hover block leading-none">
                                  <PointerGlyph color={AGENT} />
                                  {/* flex: keeps the tiny tag out of the h1's
                                      ~56px inline line box, snug under the arrow */}
                                  <span className="ml-2.5 mt-px flex w-max">
                                    <NameTag name={s.heroAgent} kind="agent" />
                                  </span>
                                </span>
                              </span>
                            </span>
                          )}
                        </span>{" "}
                        together.
                      </span>
                    );
                  })}
                </h1>
              </SelectionFrame>
            </div>

            <p
              className="tandem-rise mt-7 text-[1.05rem] leading-relaxed text-ink/65"
              style={{ animationDelay: "120ms" }}
            >
              Tandem is a shared agent artifact — one live canvas, with shared memory, that any
              number of people and agents edit at once. Operations, builders, or a family planning
              their future: bring everyone you work with, human and AI, to create what's already in
              everyone's mind.
            </p>

            {/* Primary actions — the create / join forms live in the launcher modal */}
            <div
              className="tandem-rise mt-9 flex flex-wrap items-center gap-4"
              style={{ animationDelay: "180ms" }}
            >
              <button
                onClick={() => setLauncher("create")}
                className="btn-press inline-flex items-center justify-center gap-2 rounded-md bg-ink px-6 py-3 font-medium text-paper shadow-[4px_4px_0_#C75B39]"
              >
                Create a canvas
                <Icon name="arrow" className="h-4 w-4" />
              </button>
              <button
                onClick={() => setLauncher("join")}
                className="btn-press rounded-md border-[1.5px] border-ink bg-white px-6 py-3 font-medium text-ink shadow-[4px_4px_0_rgba(28,25,23,0.15)]"
              >
                Join with a code
              </button>
            </div>

            <div
              className="tandem-rise mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 font-code text-[11px] text-ink/40"
              style={{ animationDelay: "220ms" }}
            >
              <button
                onClick={onOpenMCP}
                className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-agent transition-colors hover:text-ink"
              >
                <Icon name="spark" className="h-3.5 w-3.5" />
                connect an AI agent →
              </button>
              <span>
                no sign-up to start
                {showSignUp && (
                  <>
                    {" · "}
                    <button
                      onClick={() => setSignInOpen(true)}
                      className="underline underline-offset-2 transition-colors hover:text-ink"
                    >
                      free account to do more
                    </button>
                  </>
                )}
              </span>
              {canvasCount !== null && canvasCount >= CANVAS_COUNT_FLOOR && (
                <span className="tabular-nums">
                  {canvasCount.toLocaleString()} canvases created
                </span>
              )}
            </div>
          </div>

          {/* Right: the morphing canvas + its op feed */}
          <div className="tandem-rise min-w-0" style={{ animationDelay: "140ms" }}>
            <MorphCanvas sceneIdx={sceneIdx} setSceneIdx={setSceneIdx} />
          </div>
        </div>
      </section>

      {/* "Becomes anything" marquee */}
      <section className="border-y border-ink/10 bg-white py-5">
        <div className="mx-auto mb-3 max-w-6xl px-6">
          <SysLabel>One canvas → anything your team and agents do</SysLabel>
        </div>
        <div className="relative flex overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
          <div className="tandem-marquee flex shrink-0 items-center gap-3 pr-3">
            {[...USE_CASES, ...USE_CASES].map((u, i) => (
              <span
                key={`${u}-${i}`}
                className={`whitespace-nowrap rounded-md border border-ink/15 bg-paper px-4 py-1.5 text-sm font-medium text-ink/70 ${
                  i % 3 === 0 ? "rotate-1" : i % 3 === 1 ? "-rotate-1" : ""
                }`}
              >
                {u}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Recent canvases */}
      {hasRecents && (
        <section className="mx-auto max-w-6xl px-6 pt-10">
          <div className="max-w-md">
            <h2 className="mb-2">
              <SysLabel>Jump back in</SysLabel>
            </h2>
            <ul className="overflow-hidden rounded-md border border-ink/15 bg-white">
              {recents.map((r, i) => (
                <li
                  key={r.code}
                  className={`group flex items-center gap-2 px-3 py-2 transition-colors hover:bg-paper ${
                    i > 0 ? "border-t border-ink/10" : ""
                  }`}
                >
                  <button
                    onClick={() => onJoin(r.code)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink">{r.name}</div>
                      <div className="font-code text-[10px] text-ink/35">{relativeTime(r.lastOpenedAt)}</div>
                    </div>
                    <span className="font-code text-[11px] tracking-[0.14em] text-ink/35">{r.code}</span>
                  </button>
                  <button
                    onClick={() => handleForgetRecent(r.code)}
                    aria-label={`Remove ${r.name} from recents`}
                    title="Remove from recents"
                    className="text-ink/25 opacity-0 transition-opacity hover:text-ink/60 group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Use cases / audiences — three boards pinned to the surface */}
      <section id="use-cases" className="relative overflow-hidden">
        <div aria-hidden="true" className="surface-grid-faint absolute inset-0" />
        <div className="relative mx-auto max-w-6xl px-6 py-24">
          <div className="max-w-2xl">
            <SysLabel>Who shows up</SysLabel>
            <h2 className="mt-3 font-display text-3xl font-medium tracking-tight text-ink sm:text-4xl">
              Bring your team. Bring your agents.
            </h2>
            <p className="mt-3 leading-relaxed text-ink/65">
              The same canvas reshapes itself for whoever shows up and whatever they're trying to
              create. A few of the rooms people open every day:
            </p>
          </div>

          <div className="mt-14 grid gap-6 sm:grid-cols-3">
            {AUDIENCES.map((a) => (
              <div
                key={a.title}
                className={`group relative rounded-md border-[1.5px] border-ink/80 bg-white p-6 transition-all duration-300 lg:hover:rotate-0 lg:hover:translate-y-0 hover:shadow-[6px_6px_0_rgba(28,25,23,0.12)] ${a.tilt}`}
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-1 rounded-t-[3px]"
                  style={{ backgroundColor: a.accent }}
                />
                <h3 className="mt-1 font-display text-xl font-medium text-ink">{a.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink/65">{a.blurb}</p>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {a.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded-[3px] border border-ink/10 bg-paper px-2 py-0.5 font-code text-[10px] font-medium text-ink/50"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Shared memory / multi-agent — the wire. Dark room. */}
      <section className="bg-ink text-paper">
        <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 py-24 lg:grid-cols-2">
          <div>
            <span className="font-code text-[11px] uppercase tracking-[0.22em] text-agent">
              Shared memory
            </span>
            <h2 className="mt-4 font-display text-3xl font-medium tracking-tight sm:text-4xl">
              The canvas is the blackboard.
            </h2>
            <p className="mt-5 leading-relaxed text-paper/65">
              Every pin, row, note, and roadmap item is shared state — broadcast over the wire to
              every browser and every agent on the code. Hand-offs happen through the canvas, not
              through a copied prompt, so you can split work across specialised agents and mix
              vendors without rewriting the orchestration.
            </p>
            <p className="mt-4 leading-relaxed text-paper/65">
              Reopen it next week and the whole plan is still there, with everything the team and the
              agents have added since. The work and the deliverable are the same thing.
            </p>
            <button
              onClick={onOpenMCP}
              className="btn-press mt-8 inline-flex items-center gap-2 rounded-md border-[1.5px] border-paper/30 bg-transparent px-4 py-2.5 text-sm font-medium text-paper shadow-[4px_4px_0_rgba(199,91,57,0.55)] transition-colors hover:border-paper/60"
            >
              See how multi-agent flows work
              <Icon name="arrow" className="h-4 w-4" />
            </button>
          </div>

          {/* agents ⇄ canvas ⇄ people, with live wires. Row on sm+; stacked
              vertically on phones so it can never force horizontal scroll. */}
          <div className="relative rounded-md border border-paper/15 bg-white/[0.03] p-5 sm:p-7">
            <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
              <div className="flex flex-row flex-wrap justify-center gap-2 sm:flex-col sm:gap-2.5">
                {["scout-agent", "planner", "reporter"].map((n) => (
                  <span
                    key={n}
                    className="inline-flex items-center gap-1.5 rounded-[4px] border border-agent/50 bg-agent/15 px-2.5 py-1 font-code text-[10.5px] font-medium text-[#E89277]"
                  >
                    <Icon name="spark" className="h-3 w-3" />
                    {n}
                  </span>
                ))}
              </div>

              <div className="flex min-w-0 flex-col gap-1 px-2 sm:flex-1">
                <span className="text-center font-code text-[9px] uppercase tracking-[0.18em] text-agent/80">
                  ops →
                </span>
                <div className="tandem-wire text-agent/60" />
                <span className="text-center font-code text-[9px] uppercase tracking-[0.18em] text-paper/40">
                  ← state
                </span>
              </div>

              <div className="flex flex-col items-center gap-1.5">
                <div className="grid h-20 w-20 place-items-center rounded-md border-[1.5px] border-paper/25 bg-paper shadow-[5px_5px_0_rgba(199,91,57,0.4)]">
                  <TandemLogo size={40} animate={false} />
                </div>
                <span className="font-code text-[9px] uppercase tracking-[0.18em] text-paper/40">
                  canvas
                </span>
              </div>

              <div className="flex min-w-0 flex-col gap-1 px-2 sm:flex-1">
                <span className="text-center font-code text-[9px] uppercase tracking-[0.18em] text-paper/60">
                  edits →
                </span>
                <div className="tandem-wire text-paper/40" style={{ animationDirection: "reverse" }} />
                <span className="text-center font-code text-[9px] uppercase tracking-[0.18em] text-paper/40">
                  ← live
                </span>
              </div>

              <div className="flex flex-row flex-wrap justify-center gap-2 sm:flex-col sm:gap-2.5">
                {["Priya", "Devin", "Sam"].map((n) => (
                  <span
                    key={n}
                    className="inline-flex items-center justify-end gap-1.5 rounded-[4px] border border-paper/25 bg-paper/10 px-2.5 py-1 font-code text-[10.5px] font-medium text-paper/85"
                  >
                    {n}
                  </span>
                ))}
              </div>
            </div>
            <p className="mt-6 text-center font-code text-[10px] text-paper/40 sm:mt-7">
              many agents · many people · one shared, persistent state
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-6 py-24">
        <div className="grid gap-10 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <div key={step.title} className="border-t-2 border-ink pt-5">
              <span className="font-code text-[11px] font-medium tracking-[0.18em] text-ink/35">
                0{i + 1}
              </span>
              <h3 className="mt-2 font-display text-xl font-medium text-ink">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink/65">
                {step.body}
                {i === 1 && (
                  <>
                    {" "}
                    <button
                      onClick={onOpenMCP}
                      className="font-medium text-agent underline underline-offset-2 transition-colors hover:text-ink"
                    >
                      Setup guide
                    </button>
                    .
                  </>
                )}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Modes */}
      <section id="modes" className="relative overflow-hidden border-y border-ink/10 bg-white">
        <div aria-hidden="true" className="surface-grid-faint absolute inset-0 opacity-60" />
        <div className="relative mx-auto max-w-6xl px-6 py-24">
          <div className="max-w-2xl">
            <SysLabel>The surface, six ways</SysLabel>
            <h2 className="mt-3 font-display text-3xl font-medium tracking-tight text-ink sm:text-4xl">
              One canvas, six ways to see it.
            </h2>
            <p className="mt-3 leading-relaxed text-ink/65">
              Switch views from the top of any canvas. Every mode is fully editable by you and your
              agents alike — they read and write the same entities you do.
            </p>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {MODE_DOCS.map((m) => (
              <div
                key={m.kind}
                className="group rounded-md border border-ink/15 bg-paper p-5 transition-all hover:-translate-y-0.5 hover:shadow-[5px_5px_0_rgba(28,25,23,0.10)]"
                style={{ ["--mode" as string]: m.color }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="grid h-8 w-8 place-items-center rounded-[5px] border border-ink/10 bg-white"
                    style={{ color: m.color }}
                  >
                    <Icon name={m.kind} className="h-4 w-4" />
                  </span>
                  <span className="font-code text-[10px] text-ink/35">
                    mode:<span style={{ color: m.color }}>{m.kind}</span>
                  </span>
                </div>
                <h3 className="mt-3 font-display text-lg font-medium text-ink">{m.name}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink/65">{m.desc}</p>
              </div>
            ))}

            {/* Bring-your-own-agent card — a terminal on the surface */}
            <div className="flex flex-col overflow-hidden rounded-md border-[1.5px] border-ink bg-ink text-paper shadow-[5px_5px_0_rgba(199,91,57,0.5)]">
              <div className="flex items-center gap-2 border-b border-paper/10 px-4 py-2.5">
                <span className="h-2 w-2 rounded-full bg-paper/20" />
                <span className="h-2 w-2 rounded-full bg-paper/20" />
                <span className="font-code text-[10px] text-paper/45">bring-your-own-agent</span>
              </div>
              <div className="flex-1 px-4 py-3 font-code text-[11.5px] leading-relaxed">
                <div className="text-paper/55">
                  <span className="text-agent">$</span> npx -y @jaximus/tandem-mcp
                </div>
                <div className="mt-1 text-emerald-400/90">✓ connected · canvas TOKYO7X3K</div>
                <div className="mt-1 text-paper/45">
                  watching for ops<span className="tandem-caret ml-1 inline-block h-3 w-[7px] translate-y-[2px] bg-agent" />
                </div>
              </div>
              <div className="px-4 pb-4">
                <p className="text-xs leading-relaxed text-paper/60">
                  Tandem speaks MCP — not locked to any one assistant. Claude, Codex, Cursor, or an
                  orchestrator you wrote yourself.
                </p>
                <button
                  onClick={onOpenMCP}
                  className="mt-2.5 text-left font-code text-[11px] font-medium text-agent transition-colors hover:text-paper"
                >
                  read the setup guide →
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Sign-up pitch — only for visitors who aren't already signed in */}
      {showSignUp && (
        <section className="mx-auto max-w-6xl px-6 py-24">
          <div className="relative rounded-md border-[1.5px] border-ink bg-ink px-8 py-12 text-paper shadow-[8px_8px_0_rgba(28,25,23,0.15)] sm:px-12">
            <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.1fr]">
              <div>
                <span className="font-code text-[11px] uppercase tracking-[0.22em] text-agent">
                  Free account
                </span>
                <h2 className="mt-3 font-display text-3xl font-medium tracking-tight sm:text-4xl">
                  Start free. Sign up to unlock more.
                </h2>
                <p className="mt-4 leading-relaxed text-paper/65">
                  Anyone can spin up a canvas and share the code. Create a free account to keep
                  your canvases, get to them from any device, and copy any shared canvas to make it
                  your own.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-4">
                  <button
                    onClick={() => setSignInOpen(true)}
                    className="btn-press inline-flex items-center gap-2 rounded-md bg-paper px-6 py-3 font-medium text-ink shadow-[4px_4px_0_#C75B39]"
                  >
                    Create your free account
                  </button>
                  <button
                    onClick={() => setLauncher("create")}
                    className="rounded-md border border-paper/25 px-6 py-3 font-medium text-paper transition-colors hover:bg-paper/10"
                  >
                    Try it without signing up
                  </button>
                </div>
              </div>

              <div className="divide-y divide-paper/10 rounded-md border border-paper/15">
                {ACCOUNT_PERKS.map((perk) => (
                  <div key={perk.title} className="flex gap-4 p-5">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[5px] border border-agent/40 bg-agent/15 text-[#E89277]">
                      <Icon name={perk.icon} className="h-[18px] w-[18px]" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-paper">{perk.title}</h3>
                      <p className="mt-1 text-xs leading-relaxed text-paper/55">{perk.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Manifesto / closing CTA — back on the open surface */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="surface-grid absolute inset-0"
          style={{
            maskImage: "radial-gradient(100% 100% at 50% 100%, black 40%, transparent 95%)",
            WebkitMaskImage: "radial-gradient(100% 100% at 50% 100%, black 40%, transparent 95%)",
          }}
        />
        {/* kept to the far margins so their roam radius never reaches the copy */}
        <RoamingCursor name="scout-agent" kind="agent" roam="b" style={{ bottom: "14%", left: "3%" }} />
        <RoamingCursor name="Priya" kind="human" roam="a" style={{ top: "12%", right: "3%" }} />
        <div className="relative mx-auto max-w-3xl px-6 py-28 text-center">
          <TandemLogo size={44} />
          <div className="mt-10 inline-block">
            <SelectionFrame tag="everyone" tagKind="human" className="inline-block">
              <h2 className="font-display text-3xl font-medium leading-tight tracking-tight text-ink sm:text-[2.5rem]">
                The place to bring your team and your agents, to create what's{" "}
                <em className="text-agent">truly envisioned</em> in everyone's mind.
              </h2>
            </SelectionFrame>
          </div>
          <p className="mx-auto mt-8 max-w-xl leading-relaxed text-ink/65">
            Stop copy-pasting plans out of a chat window. Open one canvas, share one link, and let
            everyone — human and AI — build the thing together.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <button
              onClick={() => setLauncher("create")}
              className="btn-press inline-flex items-center gap-2 rounded-md bg-ink px-6 py-3 font-medium text-paper shadow-[4px_4px_0_#C75B39]"
            >
              Start a canvas
              <Icon name="arrow" className="h-4 w-4" />
            </button>
            <button
              onClick={onOpenMCP}
              className="btn-press rounded-md border-[1.5px] border-ink bg-white px-6 py-3 font-medium text-ink shadow-[4px_4px_0_rgba(28,25,23,0.15)]"
            >
              Connect an agent
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-ink/10 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 font-code text-[11px] text-ink/40 sm:flex-row">
          <div className="flex items-center gap-2">
            <TandemLogo size={18} animate={false} />
            <span>Tandem — you and your agents, in tandem.</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/jaximus808/tandam"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
            >
              <Icon name="github" className="h-4 w-4" />
              GitHub
            </a>
            <p>
              made with <span className="text-agent">♥</span> by{" "}
              <a
                href="https://www.jaxonp.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline transition-colors hover:text-ink"
              >
                Jaxon
              </a>
            </p>
          </div>
        </div>
      </footer>

      {launcher && (
        <CanvasLauncher
          initialMode={launcher}
          onJoin={onJoin}
          onClose={() => setLauncher(null)}
          onOpenMCP={() => {
            setLauncher(null);
            onOpenMCP();
          }}
        />
      )}

      {signInOpen && (
        <SignInModal
          onClose={() => setSignInOpen(false)}
          onSignedIn={(u) => {
            setUser(u);
            setSignInOpen(false);
          }}
        />
      )}
    </div>
  );
}
