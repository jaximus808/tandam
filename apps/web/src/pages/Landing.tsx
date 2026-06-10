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
}

/* ─────────────────────────────────────────────────────────────────────────────
   The whole page rides one idea: Tandem becomes anything. A single shared canvas
   that humans and agents co-edit, reshaping itself for whatever the team is doing.
   So the hero IS a canvas that morphs through four real flows — Operations,
   Builders, Life, Research — while the headline word and accent colour change in
   lockstep. `sceneIdx` lives up here in the page so the canvas and the headline
   stay in sync.
   ───────────────────────────────────────────────────────────────────────────── */

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

interface Scene {
  key: "ops" | "build" | "life" | "research";
  tab: string; // scene switcher label
  canvasName: string; // shown in the canvas title bar
  code: string; // cosmetic 8-char code
  mode: string; // highlighted mode tab
  phrase: string; // the cycling headline phrase
  accent: Accent;
  editors: [Editor, Editor]; // the two drifting cursors
}

const SCENES: Scene[] = [
  {
    key: "ops",
    tab: "Operations",
    canvasName: "Incident bridge",
    code: "OPS5K3R7",
    mode: "Sheets",
    phrase: "run operations",
    accent: { solid: "#F43F5E", soft: "rgba(244,63,94,0.10)", line: "rgba(244,63,94,0.24)" },
    editors: [
      { name: "ops-agent", kind: "agent", at: { top: "30%", left: "53%" }, drift: "a" },
      { name: "Priya", kind: "human", at: { bottom: "10%", left: "20%" }, drift: "b" },
    ],
  },
  {
    key: "build",
    tab: "Builders",
    canvasName: "Q3 product build",
    code: "BUILD8QX",
    mode: "Roadmap",
    phrase: "ship the build",
    accent: { solid: "#0EA5E9", soft: "rgba(14,165,233,0.10)", line: "rgba(14,165,233,0.24)" },
    editors: [
      { name: "Codex", kind: "agent", at: { top: "34%", right: "10%" }, drift: "a" },
      { name: "Devin", kind: "human", at: { top: "55%", right: "22%" }, drift: "b" },
    ],
  },
  {
    key: "life",
    tab: "Life",
    canvasName: "Our 2026",
    code: "YEAR42KP",
    mode: "Itinerary",
    phrase: "plan the year",
    accent: { solid: "#F59E0B", soft: "rgba(245,158,11,0.12)", line: "rgba(245,158,11,0.26)" },
    editors: [
      { name: "Claude", kind: "agent", at: { top: "26%", right: "12%" }, drift: "a" },
      { name: "Sam", kind: "human", at: { bottom: "14%", right: "16%" }, drift: "b" },
    ],
  },
  {
    key: "research",
    tab: "Research",
    canvasName: "Vendor scan",
    code: "SCOUT9WZ",
    mode: "Map",
    phrase: "map the unknown",
    accent: { solid: "#10B981", soft: "rgba(16,185,129,0.10)", line: "rgba(16,185,129,0.24)" },
    editors: [
      { name: "scout-agent", kind: "agent", at: { top: "30%", left: "30%" }, drift: "a" },
      { name: "Lee", kind: "human", at: { bottom: "12%", left: "12%" }, drift: "b" },
    ],
  },
];

const SCENE_MS = 3600;

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
    case "people":
      return (
        <svg {...c}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M16.5 14a5.5 5.5 0 0 1 4 5.8" />
        </svg>
      );
    case "lock":
      return (
        <svg {...c}>
          <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
          <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
        </svg>
      );
    default:
      return null;
  }
}

/* ── the floating cursors that drift across the canvas ───────────────────────── */

function Cursor({ editor, accent }: { editor: Editor; accent: Accent }) {
  return (
    <div className="absolute z-30 pointer-events-none" style={editor.at}>
      <div className={editor.drift === "a" ? "tandem-drift-a" : "tandem-drift-b"}>
        <svg width="20" height="22" viewBox="0 0 20 22" aria-hidden="true">
          <path
            d="M2 1.5l13.5 6.2-5.6 1.6-2 5.7z"
            fill={accent.solid}
            stroke="#fff"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        <span
          className="mt-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm"
          style={{ backgroundColor: accent.solid }}
        >
          {editor.kind === "agent" && <Icon name="spark" className="w-2.5 h-2.5" />}
          {editor.name}
        </span>
      </div>
    </div>
  );
}

/* ── per-scene body: each flow renders a genuinely different layout ──────────── */

function Pill({ label, accent, tone }: { label: string; accent: Accent; tone: "accent" | "done" | "muted" }) {
  if (tone === "done") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
        <Icon name="check" className="w-2.5 h-2.5" />
        Done
      </span>
    );
  }
  if (tone === "muted") {
    return (
      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-400">
        {label}
      </span>
    );
  }
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ backgroundColor: accent.soft, color: accent.solid }}
    >
      {label}
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
          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            {col.title}
          </div>
          {col.cards.map((card) => (
            <div
              key={card.name}
              className="rounded-lg border border-gray-100 bg-white px-2.5 py-2 shadow-sm"
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: card.sev }}
                />
                <span className="truncate text-[10.5px] font-semibold text-gray-800">
                  {card.name}
                </span>
              </div>
              <div className="mt-0.5 text-[9.5px] text-gray-400">{card.meta}</div>
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
          className="flex items-center gap-2 rounded-lg border border-gray-100 bg-white px-3 py-2 shadow-sm"
        >
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{
              backgroundColor:
                row.tone === "done" ? "#10B981" : row.tone === "accent" ? accent.solid : "#D1D5DB",
            }}
          />
          <span className="flex-1 truncate text-[12px] font-medium text-gray-800">{row.name}</span>
          {row.who && (
            <span className="hidden rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-semibold text-gray-500 sm:inline">
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
  const items = [
    { when: "Mar", what: "Apartment tours", note: "3 saved", color: "#0EA5E9" },
    { when: "Jun", what: "Japan — 2 weeks", note: "flights held", color: "#F59E0B" },
    { when: "Sep", what: "Grad school starts", note: "deposit paid", color: "#7C3AED" },
    { when: "Dec", what: "Family reunion", note: "12 going", color: "#10B981" },
  ];
  return (
    <div className="relative h-full p-4">
      <div className="absolute bottom-5 left-[34px] top-5 w-px bg-gray-200" />
      <div className="flex h-full flex-col justify-between">
        {items.map((it) => (
          <div key={it.what} className="relative flex items-center gap-3">
            <span className="w-6 shrink-0 text-right text-[10px] font-semibold text-gray-400">
              {it.when}
            </span>
            <span
              className="z-10 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-white"
              style={{ backgroundColor: it.color }}
            />
            <div className="flex-1 rounded-lg border border-gray-100 bg-white px-2.5 py-1.5 shadow-sm">
              <div className="text-[11px] font-semibold text-gray-800">{it.what}</div>
              <div className="text-[10px] text-gray-400">{it.note}</div>
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
        className="relative flex-1 overflow-hidden rounded-lg border border-gray-100"
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
              <span className="mt-0.5 rounded bg-white/90 px-1 py-0.5 text-[9px] font-semibold text-gray-700 shadow-sm">
                {p.label}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex w-28 shrink-0 flex-col gap-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Docs</div>
        {["Findings.md", "Shortlist", "Pricing grid"].map((d) => (
          <div
            key={d}
            className="flex items-center gap-1.5 rounded-lg border border-gray-100 bg-white px-2 py-1.5 shadow-sm"
          >
            <span style={{ color: accent.solid }}>
              <Icon name="docs" className="h-3 w-3" />
            </span>
            <span className="truncate text-[10px] font-medium text-gray-700">{d}</span>
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
      {/* ambient glow, tinted to the active scene */}
      <div
        aria-hidden="true"
        className="tandem-blob absolute -inset-8 -z-10 rounded-[3rem] blur-3xl transition-colors duration-700"
        style={{ background: `radial-gradient(60% 60% at 60% 30%, ${accent.soft}, transparent 70%)` }}
      />

      {/* scene switcher */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {SCENES.map((s, i) => {
          const active = i === sceneIdx;
          return (
            <button
              key={s.key}
              onClick={() => setSceneIdx(i)}
              className="rounded-full px-3 py-1 text-xs font-semibold transition-colors"
              style={
                active
                  ? { backgroundColor: s.accent.solid, color: "#fff" }
                  : { backgroundColor: "rgba(0,0,0,0.04)", color: "#6b7280" }
              }
            >
              {s.tab}
            </button>
          );
        })}
      </div>

      <div
        className="relative overflow-hidden rounded-2xl border bg-white shadow-2xl shadow-gray-900/10 transition-colors duration-700"
        style={{ borderColor: accent.line }}
      >
        {/* title bar */}
        <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50/80 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-gray-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-gray-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-gray-200" />
          <span className="ml-2 truncate text-xs font-semibold text-gray-600">{scene.canvasName}</span>
          <span className="ml-auto font-code text-[11px] tracking-widest text-gray-300">
            {scene.code}
          </span>
        </div>

        {/* mode tabs */}
        <div className="flex items-center gap-1 overflow-x-auto border-b border-gray-100 px-3 py-1.5">
          {MODE_TABS.map((m) => {
            const active = m === scene.mode;
            return (
              <span
                key={m}
                className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
                style={
                  active
                    ? { backgroundColor: accent.soft, color: accent.solid }
                    : { color: "#9ca3af" }
                }
              >
                {m}
              </span>
            );
          })}
        </div>

        {/* body — re-keyed on scene so it replays the entrance animation */}
        <div className="relative h-[300px]">
          {/* "editing" pill */}
          <div className="absolute left-3 top-3 z-30 flex items-center gap-2 rounded-full border border-gray-100 bg-white/90 px-2.5 py-1 shadow-sm backdrop-blur">
            <span className="relative flex h-2 w-2">
              <span
                className="tandem-ping absolute inline-flex h-full w-full rounded-full opacity-70"
                style={{ backgroundColor: accent.solid }}
              />
              <span
                className="relative inline-flex h-2 w-2 rounded-full"
                style={{ backgroundColor: accent.solid }}
              />
            </span>
            <span key={scene.key} className="tandem-fade-in text-[11px] font-medium text-gray-600">
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
    </div>
  );
}

/* ── content data for the lower sections ─────────────────────────────────────── */

const MODE_DOCS: { kind: string; name: string; tint: string; desc: string }[] = [
  {
    kind: "map",
    name: "Map",
    tint: "text-sky-600 bg-sky-50",
    desc: "Pins with labels, notes, and colours on a real map. Switch base maps — or just ask your agent to.",
  },
  {
    kind: "itinerary",
    name: "Itinerary",
    tint: "text-amber-600 bg-amber-50",
    desc: "A day-by-day schedule. Events link back to their pins, so the plan and the place stay in sync.",
  },
  {
    kind: "docs",
    name: "Docs",
    tint: "text-violet-600 bg-violet-50",
    desc: "Free-form markdown — briefs, research, checklists, anything that doesn't belong on the map.",
  },
  {
    kind: "sheets",
    name: "Sheets",
    tint: "text-emerald-600 bg-emerald-50",
    desc: "Typed columns and drag-to-reorder rows. Budgets, comparisons, trackers, triage boards.",
  },
  {
    kind: "roadmap",
    name: "Roadmap",
    tint: "text-rose-600 bg-rose-50",
    desc: "Nested, draggable items with status — todo, in progress, done, blocked. Plan and track in one place.",
  },
  {
    kind: "charts",
    name: "Charts",
    tint: "text-indigo-600 bg-indigo-50",
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

const AUDIENCES: { title: string; blurb: string; tags: string[]; accent: string }[] = [
  {
    title: "Operations",
    blurb:
      "Stand up an incident bridge, a launch checklist, or a daily ops board. Agents triage and update while the room watches.",
    tags: ["Incidents", "Launches", "Logistics"],
    accent: "#F43F5E",
  },
  {
    title: "Builders",
    blurb:
      "Plan the quarter, split work across coding agents, and watch the roadmap move from todo to done in real time.",
    tags: ["Roadmaps", "Sprints", "Research"],
    accent: "#0EA5E9",
  },
  {
    title: "Teams & life",
    blurb:
      "A trip, a move, a wedding, a whole year. Bring the people who matter and an agent to do the legwork.",
    tags: ["Trips", "Plans", "Budgets"],
    accent: "#F59E0B",
  },
];

const ACCOUNT_PERKS: { icon: string; title: string; desc: string }[] = [
  {
    icon: "save",
    title: "Keep your canvases",
    desc: "Sign up and your canvases are tied to your account — yours to come back to, not just a link you hope you didn't lose.",
  },
  {
    icon: "spark",
    title: "Built-in Tandem agents",
    desc: "Chat with an agent that already lives on the canvas — no MCP setup of your own to wire up.",
  },
  {
    icon: "people",
    title: "Share with your team",
    desc: "Invite specific teammates to a canvas so the right people — and their agents — are in the room.",
  },
  {
    icon: "lock",
    title: "Private canvases",
    desc: "Keep work that matters locked to your account, not open to anyone with the code.",
  },
];

/* ── the page ────────────────────────────────────────────────────────────────── */

export default function Landing({ onJoin, onOpenMCP }: Props) {
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
    fetch("/api/stats/canvas-count")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.count === "number") setCanvasCount(d.count);
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
    <div className="min-h-screen scroll-smooth bg-[#FBFAF8] font-brand text-gray-900 [text-rendering:optimizeLegibility] antialiased">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-gray-900/5 bg-[#FBFAF8]/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-6">
          <div className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
            <TandemLogo size={26} />
            <span>Tandem</span>
          </div>
          <nav className="ml-auto flex items-center gap-1 text-sm sm:gap-2">
            <a
              href="#use-cases"
              className="hidden rounded-lg px-3 py-1.5 text-gray-500 transition-colors hover:bg-gray-900/5 hover:text-gray-900 sm:inline"
            >
              Use cases
            </a>
            <a
              href="#modes"
              className="hidden rounded-lg px-3 py-1.5 text-gray-500 transition-colors hover:bg-gray-900/5 hover:text-gray-900 sm:inline"
            >
              Modes
            </a>
            <a
              href="https://github.com/jaximus808/tandam"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden rounded-lg px-3 py-1.5 text-gray-500 transition-colors hover:bg-gray-900/5 hover:text-gray-900 sm:inline"
            >
              GitHub
            </a>
            <button
              onClick={onOpenMCP}
              className="rounded-lg px-3 py-1.5 font-medium text-gray-700 transition-colors hover:bg-gray-900/5"
            >
              Connect an agent
            </button>
            <AccountMenu />
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="tandem-blob absolute -right-40 -top-40 h-[34rem] w-[34rem] rounded-full blur-3xl transition-colors duration-700"
          style={{ background: `radial-gradient(circle, ${scene.accent.soft}, transparent 70%)` }}
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-14 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:pb-28 lg:pt-20">
          {/* Left: copy + actions */}
          <div className="max-w-xl">
            <span className="tandem-rise inline-flex items-center gap-2 rounded-full border border-gray-900/10 bg-white px-3 py-1 text-xs font-medium text-gray-600 shadow-sm">
              <span className="text-amber-500">
                <Icon name="spark" className="h-3 w-3" />
              </span>
              The shared canvas for humans <span className="text-gray-300">+</span> agents
            </span>

            <h1
              className="tandem-rise mt-5 font-display text-[2.7rem] font-medium leading-[1.04] tracking-tight text-gray-900 sm:text-6xl"
              style={{ animationDelay: "60ms" }}
            >
              Where teams and agents{" "}
              <span className="relative inline-block">
                <span
                  key={scene.key}
                  className="tandem-word-in italic"
                  style={{ color: scene.accent.solid }}
                >
                  {scene.phrase}
                </span>
              </span>{" "}
              together.
            </h1>

            <p
              className="tandem-rise mt-5 text-[1.05rem] leading-relaxed text-gray-600"
              style={{ animationDelay: "120ms" }}
            >
              Tandem is a shared agent artifact — one live canvas, with shared memory, that any
              number of people and agents edit at once. Operations, builders, or a family planning
              their future: bring everyone you work with, human and AI, to create what's already in
              everyone's mind.
            </p>

            {/* Primary actions — the create / join forms live in the launcher modal */}
            <div
              className="tandem-rise mt-8 flex flex-wrap items-center gap-3"
              style={{ animationDelay: "180ms" }}
            >
              <button
                onClick={() => setLauncher("create")}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gray-900 px-6 py-3 font-medium text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md"
              >
                Create a canvas
                <Icon name="arrow" className="h-4 w-4" />
              </button>
              <button
                onClick={() => setLauncher("join")}
                className="rounded-xl border border-gray-300 bg-white px-6 py-3 font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                Join with a code
              </button>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-400">
              <button
                onClick={onOpenMCP}
                className="inline-flex items-center gap-1.5 font-medium text-sky-600 transition-colors hover:text-sky-700"
              >
                <Icon name="spark" className="h-3.5 w-3.5" />
                Connect an AI agent
                <Icon name="arrow" className="h-3.5 w-3.5" />
              </button>
              <span>
                No sign-up to start
                {showSignUp && (
                  <>
                    {" · "}
                    <button
                      onClick={() => setSignInOpen(true)}
                      className="font-medium text-gray-500 underline underline-offset-2 transition-colors hover:text-gray-700"
                    >
                      free account to do more
                    </button>
                  </>
                )}
              </span>
              {canvasCount !== null && canvasCount >= CANVAS_COUNT_FLOOR && (
                <span className="font-code tabular-nums text-gray-500">
                  {canvasCount.toLocaleString()} canvases created
                </span>
              )}
            </div>
          </div>

          {/* Right: the morphing canvas */}
          <div className="tandem-rise lg:pl-2" style={{ animationDelay: "140ms" }}>
            <MorphCanvas sceneIdx={sceneIdx} setSceneIdx={setSceneIdx} />
          </div>
        </div>
      </section>

      {/* "Becomes anything" marquee */}
      <section className="border-y border-gray-900/5 bg-white py-5">
        <div className="mx-auto mb-3 max-w-6xl px-6">
          <span className="font-code text-[11px] uppercase tracking-[0.2em] text-gray-400">
            One canvas → anything your team and agents do
          </span>
        </div>
        <div className="relative flex overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
          <div className="tandem-marquee flex shrink-0 gap-3 pr-3">
            {[...USE_CASES, ...USE_CASES].map((u, i) => (
              <span
                key={`${u}-${i}`}
                className="whitespace-nowrap rounded-full border border-gray-200 bg-[#FBFAF8] px-4 py-1.5 text-sm font-medium text-gray-600"
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
            <h2 className="mb-2 font-code text-[11px] uppercase tracking-[0.2em] text-gray-400">
              Jump back in
            </h2>
            <ul className="space-y-1.5">
              {recents.map((r) => (
                <li
                  key={r.code}
                  className="group flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 transition-colors hover:border-sky-400"
                >
                  <button
                    onClick={() => onJoin(r.code)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-gray-900">{r.name}</div>
                      <div className="text-xs text-gray-400">{relativeTime(r.lastOpenedAt)}</div>
                    </div>
                    <span className="font-code text-xs tracking-widest text-gray-400">{r.code}</span>
                  </button>
                  <button
                    onClick={() => handleForgetRecent(r.code)}
                    aria-label={`Remove ${r.name} from recents`}
                    title="Remove from recents"
                    className="text-gray-300 opacity-0 transition-opacity hover:text-gray-500 group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Use cases / audiences */}
      <section id="use-cases" className="mx-auto max-w-6xl px-6 py-20">
        <div className="max-w-2xl">
          <h2 className="font-display text-3xl font-medium tracking-tight text-gray-900 sm:text-4xl">
            Bring your team. Bring your agents.
          </h2>
          <p className="mt-3 leading-relaxed text-gray-600">
            The same canvas reshapes itself for whoever shows up and whatever they're trying to
            create. A few of the rooms people open every day:
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {AUDIENCES.map((a) => (
            <div
              key={a.title}
              className="group relative overflow-hidden rounded-2xl border border-gray-200 bg-white p-6 transition-all hover:-translate-y-0.5 hover:shadow-lg"
            >
              <div
                aria-hidden="true"
                className="absolute -right-10 -top-10 h-28 w-28 rounded-full opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100"
                style={{ backgroundColor: a.accent }}
              />
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: a.accent }}
              />
              <h3 className="mt-3 text-lg font-semibold text-gray-900">{a.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">{a.blurb}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {a.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-medium text-gray-500"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Shared memory / multi-agent */}
      <section className="border-y border-gray-900/5 bg-gradient-to-b from-white to-[#FBFAF8]">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-2">
          <div>
            <span className="font-code text-[11px] uppercase tracking-[0.2em] text-sky-600">
              Shared memory
            </span>
            <h2 className="mt-3 font-display text-3xl font-medium tracking-tight text-gray-900 sm:text-4xl">
              The canvas is the blackboard.
            </h2>
            <p className="mt-4 leading-relaxed text-gray-600">
              Every pin, row, note, and roadmap item is shared state — broadcast over the wire to
              every browser and every agent on the code. Hand-offs happen through the canvas, not
              through a copied prompt, so you can split work across specialised agents and mix
              vendors without rewriting the orchestration.
            </p>
            <p className="mt-4 leading-relaxed text-gray-600">
              Reopen it next week and the whole plan is still there, with everything the team and the
              agents have added since. The work and the deliverable are the same thing.
            </p>
            <button
              onClick={onOpenMCP}
              className="mt-6 inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              See how multi-agent flows work
              <Icon name="arrow" className="h-4 w-4" />
            </button>
          </div>

          {/* simple agents → canvas → people diagram */}
          <div className="relative rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-2">
                {["scout-agent", "planner", "reporter"].map((n) => (
                  <span
                    key={n}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-sky-100 bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700"
                  >
                    <Icon name="spark" className="h-3 w-3" />
                    {n}
                  </span>
                ))}
              </div>

              <div className="flex flex-col items-center gap-1">
                <div className="flex h-20 w-20 items-center justify-center rounded-2xl border-2 border-gray-900/10 bg-[#FBFAF8] shadow-inner">
                  <TandemLogo size={40} animate={false} />
                </div>
                <span className="font-code text-[10px] uppercase tracking-widest text-gray-400">
                  canvas
                </span>
              </div>

              <div className="flex flex-col gap-2">
                {["Priya", "Devin", "Sam"].map((n) => (
                  <span
                    key={n}
                    className="inline-flex items-center justify-end gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-700"
                  >
                    {n}
                  </span>
                ))}
              </div>
            </div>
            <p className="mt-6 text-center text-xs text-gray-400">
              Many agents, many people — one shared, persistent state.
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="grid gap-8 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <div key={step.title}>
              <div className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-900 font-code text-sm font-semibold text-white">
                  {i + 1}
                </span>
                <h3 className="font-semibold text-gray-900">{step.title}</h3>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">
                {step.body}
                {i === 1 && (
                  <>
                    {" "}
                    <button
                      onClick={onOpenMCP}
                      className="text-sky-600 underline transition-colors hover:text-sky-700"
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
      <section id="modes" className="border-y border-gray-900/5 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="max-w-2xl">
            <h2 className="font-display text-3xl font-medium tracking-tight text-gray-900 sm:text-4xl">
              One canvas, six ways to see it.
            </h2>
            <p className="mt-3 leading-relaxed text-gray-600">
              Switch views from the top of any canvas. Every mode is fully editable by you and your
              agents alike — they read and write the same entities you do.
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {MODE_DOCS.map((m) => (
              <div
                key={m.kind}
                className="rounded-2xl border border-gray-200 bg-[#FBFAF8] p-5 transition-all hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-sm"
              >
                <div
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${m.tint}`}
                >
                  <Icon name={m.kind} className="h-5 w-5" />
                </div>
                <h3 className="mt-3 font-semibold text-gray-900">{m.name}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-gray-600">{m.desc}</p>
              </div>
            ))}

            {/* Bring-your-own-agent card */}
            <div className="flex flex-col rounded-2xl bg-gray-900 p-5 text-white">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-sky-300">
                <TandemLogo size={22} animate={false} />
              </div>
              <h3 className="mt-3 font-semibold">Bring your own agent</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-300">
                Tandem speaks the Model Context Protocol — it isn't locked to any one assistant.
                Claude, Codex, Cursor, the OpenAI Agents SDK, or an orchestrator you wrote yourself.
              </p>
              <code className="mt-3 block overflow-x-auto rounded-lg bg-black/40 px-3 py-2 font-code text-xs text-sky-200">
                npx -y @jaximus/tandem-mcp
              </code>
              <button
                onClick={onOpenMCP}
                className="mt-3 text-left text-sm font-medium text-sky-300 transition-colors hover:text-sky-200"
              >
                Read the setup guide →
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Sign-up pitch — only for visitors who aren't already signed in */}
      {showSignUp && (
        <section className="mx-auto max-w-6xl px-6 py-20">
          <div className="relative overflow-hidden rounded-3xl bg-gray-900 px-8 py-12 text-white sm:px-12">
            <div
              aria-hidden="true"
              className="tandem-blob absolute -right-20 -top-24 h-80 w-80 rounded-full bg-sky-500/20 blur-3xl"
            />
            <div
              aria-hidden="true"
              className="tandem-blob absolute -bottom-24 -left-16 h-72 w-72 rounded-full bg-amber-400/10 blur-3xl"
            />
            <div className="relative grid items-center gap-10 lg:grid-cols-[1fr_1.1fr]">
              <div>
                <span className="font-code text-[11px] uppercase tracking-[0.2em] text-sky-300">
                  Free account
                </span>
                <h2 className="mt-3 font-display text-3xl font-medium tracking-tight sm:text-4xl">
                  Start free. Sign up to unlock more.
                </h2>
                <p className="mt-4 leading-relaxed text-gray-300">
                  Anyone can spin up a canvas and share the code. Create a free account to unlock
                  more — keep your canvases, make them private, and bring built-in agents and real
                  teammates into the room.
                </p>
                <div className="mt-7 flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => setSignInOpen(true)}
                    className="inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 font-medium text-gray-900 shadow-sm transition-all hover:shadow-md"
                  >
                    <Icon name="spark" className="h-4 w-4 text-amber-500" />
                    Create your free account
                  </button>
                  <button
                    onClick={() => setLauncher("create")}
                    className="rounded-xl border border-white/20 px-6 py-3 font-medium text-white transition-colors hover:bg-white/10"
                  >
                    Try it without signing up
                  </button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {ACCOUNT_PERKS.map((perk) => (
                  <div
                    key={perk.title}
                    className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur"
                  >
                    <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-sky-300">
                      <Icon name={perk.icon} className="h-5 w-5" />
                    </div>
                    <h3 className="mt-3 text-sm font-semibold text-white">{perk.title}</h3>
                    <p className="mt-1 text-xs leading-relaxed text-gray-400">{perk.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Manifesto / closing CTA */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="tandem-blob absolute -left-32 bottom-0 h-96 w-96 rounded-full bg-sky-100/60 blur-3xl"
        />
        <div className="relative mx-auto max-w-3xl px-6 py-24 text-center">
          <TandemLogo size={44} />
          <h2 className="mt-6 font-display text-3xl font-medium leading-tight tracking-tight text-gray-900 sm:text-[2.6rem]">
            The place to bring your team and your agents, to create what's truly envisioned in
            everyone's mind.
          </h2>
          <p className="mx-auto mt-5 max-w-xl leading-relaxed text-gray-600">
            Stop copy-pasting plans out of a chat window. Open one canvas, share one link, and let
            everyone — human and AI — build the thing together.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => setLauncher("create")}
              className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-6 py-3 font-medium text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md"
            >
              Start a canvas
              <Icon name="arrow" className="h-4 w-4" />
            </button>
            <button
              onClick={onOpenMCP}
              className="rounded-xl border border-gray-300 bg-white px-6 py-3 font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Connect an agent
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-900/5 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 text-xs text-gray-400 sm:flex-row">
          <div className="flex items-center gap-2">
            <TandemLogo size={18} animate={false} />
            <span>Tandem — you and your agents, in tandem.</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/jaximus808/tandam"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 transition-colors hover:text-gray-600"
            >
              <Icon name="github" className="h-4 w-4" />
              GitHub
            </a>
            <p>
              Made with <span className="text-rose-400">♥</span> by{" "}
              <a
                href="https://www.jaxonp.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline transition-colors hover:text-gray-600"
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
