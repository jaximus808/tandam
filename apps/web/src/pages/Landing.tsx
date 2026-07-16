import { useEffect, useMemo, useRef, useState } from "react";
import { listRecent, removeRecent } from "../lib/recentCanvases";
import { fetchMe, getCachedUser, GOOGLE_CLIENT_ID, type User } from "../lib/auth";
import TandemLogo from "../components/TandemLogo";
import LandingNav from "../components/LandingNav";
import CanvasLauncher from "../components/CanvasLauncher";
import SignInModal from "../components/SignInModal";

interface Props {
  onJoin: (code: string) => void;
  onOpenMCP: () => void;
  onShowCanvases: () => void;
  onShowSettings: () => void;
  onAbout: () => void;
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

interface Chat {
  user: string; // the human's prompt, in the chat they already live in
  building: string; // what the agent is doing, e.g. "building the roadmap"
  reply: string; // the agent's natural-language confirmation (no op names)
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
  chat: Chat; // the prescripted "you ask → agent builds it" exchange below the canvas
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
    // heroAgent is the morphing headline word: "{agent} made this." Cycling it
    // Claude → ChatGPT → Cursor → Codex SHOWS agent-agnosticism instead of
    // telling it. Any one entry is a single-line edit if a client stops working.
    accent: { solid: "#F43F5E", soft: "rgba(244,63,94,0.10)", line: "rgba(244,63,94,0.24)" },
    editors: [
      { name: "ops-agent", kind: "agent", at: { top: "30%", left: "53%" }, drift: "a" },
      { name: "Priya", kind: "human", at: { bottom: "10%", left: "20%" }, drift: "b" },
    ],
    chat: {
      user: "API 5xx just spiked on edge-eu — spin up an incident board.",
      building: "triaging the incident",
      reply: "Done — board's up, alerts triaged, and I kicked off the v2.3.1 rollback.",
    },
  },
  {
    key: "build",
    tab: "Builders",
    canvasName: "Q3 product build",
    code: "BUILD8QX",
    mode: "Roadmap",
    phrase: "ship the build",
    heroAgent: "ChatGPT",
    accent: { solid: "#0EA5E9", soft: "rgba(14,165,233,0.10)", line: "rgba(14,165,233,0.24)" },
    editors: [
      { name: "Codex", kind: "agent", at: { top: "34%", right: "10%" }, drift: "a" },
      { name: "Devin", kind: "human", at: { top: "55%", right: "22%" }, drift: "b" },
    ],
    chat: {
      user: "Turn our Q3 notes into a roadmap I can actually track.",
      building: "building the roadmap",
      reply: "Up now — items scoped with status. Realtime cursors is in progress, Charts mode shipped.",
    },
  },
  {
    key: "life",
    tab: "Life",
    canvasName: "Our 2026",
    code: "YEAR42KP",
    mode: "Itinerary",
    phrase: "plan the year",
    heroAgent: "Cursor",
    accent: { solid: "#F59E0B", soft: "rgba(245,158,11,0.12)", line: "rgba(245,158,11,0.26)" },
    editors: [
      { name: "Claude", kind: "agent", at: { top: "26%", right: "12%" }, drift: "a" },
      { name: "Sam", kind: "human", at: { bottom: "14%", right: "16%" }, drift: "b" },
    ],
    chat: {
      user: "Plan our Japan trip for March.",
      building: "filling the itinerary",
      reply: "Laid out the days, held your flights, and dropped hotel options on the map.",
    },
  },
  {
    key: "research",
    tab: "Research",
    canvasName: "Vendor scan",
    code: "SCOUT9WZ",
    mode: "Map",
    phrase: "map the unknown",
    heroAgent: "Codex",
    accent: { solid: "#10B981", soft: "rgba(16,185,129,0.10)", line: "rgba(16,185,129,0.24)" },
    editors: [
      { name: "scout-agent", kind: "agent", at: { top: "30%", left: "30%" }, drift: "a" },
      { name: "Lee", kind: "human", at: { bottom: "12%", left: "12%" }, drift: "b" },
    ],
    chat: {
      user: "Scan these three vendors and map them for me.",
      building: "mapping the vendors",
      reply: "Mapped all three with pricing notes — Northwind's on the shortlist.",
    },
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
        className="stroke-paper"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A multiplayer name tag — square corners, mono, agent vs human colour. */
function NameTag({ name, kind, color }: { name: string; kind: "human" | "agent"; color?: string }) {
  // Default human tag mirrors the real canvas "you" chip (bg-ink/text-paper) so
  // it inverts with the theme; an explicit color (or the agent terracotta) is a
  // fixed colored bg that keeps white text in both themes.
  const inkText = !color && kind === "human";
  const bg = color ?? (kind === "agent" ? AGENT : "rgb(var(--color-ink))");
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[3px] px-1.5 py-0.5 font-code text-[10px] font-medium leading-none"
      style={{ backgroundColor: bg, color: inkText ? "rgb(var(--color-paper))" : "#fff" }}
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
  const color = kind === "agent" ? AGENT : "rgb(var(--color-ink))";
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
  color = "rgb(var(--color-ink))",
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
      <span className="inline-flex items-center gap-1 rounded-[3px] bg-emerald-500/15 px-2 py-0.5 font-code text-[9px] font-medium text-emerald-600">
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
  let order = 0; // flat add-order across all columns, so cards glow in one by one
  return (
    <div className="grid h-full grid-cols-3 gap-2.5 p-4">
      {cols.map((col) => (
        <div key={col.title} className="flex flex-col gap-2">
          <div className="font-code text-[9px] font-medium uppercase tracking-[0.14em] text-ink/35">
            {col.title}
          </div>
          {col.cards.map((card) => {
            const delay = 460 + order++ * 150;
            return (
            <div
              key={card.name}
              className="tandem-item-in relative rounded-md border border-ink/10 bg-surface px-2.5 py-2"
              style={{ animationDelay: `${delay}ms`, "--item-accent": card.sev } as React.CSSProperties}
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
            );
          })}
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
      {rows.map((row, i) => {
        const rowColor =
          row.tone === "done" ? "#10B981" : row.tone === "accent" ? accent.solid : "rgb(var(--color-ink) / 0.25)";
        const delay = 460 + i * 150;
        return (
        <div
          key={row.name}
          className="tandem-item-in relative flex items-center gap-2 rounded-md border border-ink/10 bg-surface px-3 py-2"
          style={{ animationDelay: `${delay}ms`, "--item-accent": rowColor } as React.CSSProperties}
        >
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{ backgroundColor: rowColor }}
          />
          <span className="flex-1 truncate text-[12px] font-medium text-ink/85">{row.name}</span>
          {row.who && (
            <span className="hidden rounded-[3px] bg-ink/5 px-1.5 py-0.5 font-code text-[8.5px] font-medium text-ink/45 sm:inline">
              {row.who}
            </span>
          )}
          <Pill label={row.label} accent={accent} tone={row.tone} />
        </div>
        );
      })}
    </div>
  );
}

function LifeBody() {
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
        {items.map((it, i) => {
          const delay = 460 + i * 150;
          return (
          <div
            key={it.what}
            className="tandem-item-in relative flex items-center gap-3"
            style={{ animationDelay: `${delay}ms`, "--item-accent": it.color } as React.CSSProperties}
          >
            <span className="w-6 shrink-0 text-right font-code text-[9px] font-medium text-ink/35">
              {it.when}
            </span>
            <span
              className="z-10 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-surface"
              style={{ backgroundColor: it.color }}
            />
            <div className="flex-1 rounded-md border border-ink/10 bg-surface px-2.5 py-1.5">
              <div className="text-[11px] font-semibold text-ink/85">{it.what}</div>
              <div className="font-code text-[8.5px] text-ink/35">{it.note}</div>
            </div>
          </div>
          );
        })}
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
      <div className="morph-map relative flex-1 overflow-hidden rounded-md border border-ink/10">
        <div
          aria-hidden="true"
          className="tandem-grid-pan absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(16,185,129,0.10) 1px, transparent 1px), linear-gradient(to bottom, rgba(16,185,129,0.10) 1px, transparent 1px)",
            backgroundSize: "34px 34px",
          }}
        />
        {pins.map((p, i) => {
          const delay = 460 + i * 150;
          return (
          <div
            key={p.label}
            className="absolute -translate-x-1/2 -translate-y-full"
            style={{ top: p.top, left: p.left }}
          >
            {/* glow on the inner group, not the positioned wrapper, so the pin's
                translate isn't clobbered by the animation's transform */}
            <div
              className="tandem-item-in relative flex flex-col items-center"
              style={{ animationDelay: `${delay}ms`, "--item-accent": p.color } as React.CSSProperties}
            >
              <svg width="18" height="23" viewBox="0 0 18 23" aria-hidden="true">
                <path
                  d="M9 0C4 0 0 4 0 9c0 6.2 9 14 9 14s9-7.8 9-14c0-5-4-9-9-9z"
                  fill={p.color}
                />
                <circle cx="9" cy="9" r="3.2" fill="#fff" />
              </svg>
              <span className="mt-0.5 rounded-[3px] bg-surface/90 px-1 py-0.5 font-code text-[8.5px] font-medium text-ink/70">
                {p.label}
              </span>
            </div>
          </div>
          );
        })}
      </div>
      <div className="flex w-28 shrink-0 flex-col gap-1.5">
        <div className="font-code text-[9px] font-medium uppercase tracking-[0.14em] text-ink/35">Docs</div>
        {["Findings.md", "Shortlist", "Pricing grid"].map((d, j) => (
          <div
            key={d}
            className="tandem-item-in flex items-center gap-1.5 rounded-md border border-ink/10 bg-surface px-2 py-1.5"
            style={{ animationDelay: `${460 + (pins.length + j) * 150}ms`, "--item-accent": accent.solid } as React.CSSProperties}
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
      return <LifeBody />;
    case "research":
      return <ResearchBody accent={scene.accent} />;
  }
}

/* ── the hero chat: you ask in the chat you already live in, the agent builds
   the canvas above. Reversed causality, coded — no video, no jank, always on.
   Replaces the old canvas.ops feed, which showed raw MCP op names and so read as
   "just an MCP server." Re-keyed on scene.key so it replays on every morph. ──── */

function HeroChat({ scene }: { scene: Scene }) {
  const { chat, accent } = scene;
  return (
    <div
      key={scene.key}
      className="mt-3 overflow-hidden rounded-md border border-ink/15 bg-surface"
    >
      <div className="flex items-center gap-2 border-b border-ink/10 bg-paper px-3 py-1.5">
        <span
          className="grid h-3.5 w-3.5 place-items-center rounded-[3px] text-white"
          style={{ backgroundColor: AGENT }}
        >
          <Icon name="spark" className="h-2 w-2" />
        </span>
        <span className="font-code text-[10px] font-medium text-ink/50">
          {scene.heroAgent.toLowerCase()} · chat
        </span>
        <span className="ml-auto font-code text-[10px] tracking-[0.14em] text-ink/30">
          {scene.code}
        </span>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        {/* you → (lands first — the prompt that causes everything above) */}
        <div className="tandem-op-in flex justify-end" style={{ animationDelay: "100ms" }}>
          <span className="max-w-[80%] rounded-[9px] rounded-br-[3px] bg-ink px-2.5 py-1.5 text-[11.5px] leading-snug text-paper">
            {chat.user}
          </span>
        </div>
        {/* the agent, working — the cause of the canvas above filling in */}
        <div
          className="tandem-op-in flex items-center gap-1.5 pl-0.5 font-code text-[10px] text-ink/45"
          style={{ animationDelay: "520ms" }}
        >
          <span className="relative flex h-1.5 w-1.5">
            <span
              className="tandem-ping absolute inline-flex h-full w-full rounded-full opacity-70"
              style={{ backgroundColor: accent.solid }}
            />
            <span
              className="relative inline-flex h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: accent.solid }}
            />
          </span>
          {scene.heroAgent} is {chat.building}…
        </div>
        {/* ← the agent's reply, after the items finish building (natural language, never an op name) */}
        <div className="tandem-op-in flex justify-start" style={{ animationDelay: "2000ms" }}>
          <span
            className="max-w-[85%] rounded-[9px] rounded-bl-[3px] px-2.5 py-1.5 text-[11.5px] leading-snug text-ink"
            style={{ backgroundColor: accent.soft, boxShadow: `inset 0 0 0 1px ${accent.line}` }}
          >
            {chat.reply}
          </span>
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
  const reduced = usePrefersReducedMotion();
  const bodyRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);

  // One persistent agent cursor: hidden until the first item lands, then it jumps
  // to each item as it spawns (the same 460 + i*150ms cadence SceneBody staggers
  // them at) — so the build reads as a single agent hopping around placing things.
  // Positions are measured live; styling is imperative to dodge re-render churn.
  useEffect(() => {
    const body = bodyRef.current;
    const cur = cursorRef.current;
    if (!body || !cur) return;
    cur.style.opacity = "0"; // empty at the start of every scene
    if (reduced) return;
    const glide = "transform .34s cubic-bezier(.22,1,.36,1), opacity .22s ease";
    const items = Array.from(body.querySelectorAll<HTMLElement>(".tandem-item-in"));
    const timers = items.map((item, k) =>
      window.setTimeout(
        () => {
          const cr = body.getBoundingClientRect();
          const ir = item.getBoundingClientRect();
          const x = ir.left - cr.left + 2;
          const y = ir.top - cr.top + 2;
          if (cur.style.opacity !== "1") {
            // first appearance: teleport to the item, then fade in (no glide from 0,0)
            cur.style.transition = "none";
            cur.style.transform = `translate(${x}px, ${y}px)`;
            void cur.offsetWidth;
            cur.style.transition = glide;
            cur.style.opacity = "1";
          } else {
            cur.style.transition = glide;
            cur.style.transform = `translate(${x}px, ${y}px)`;
          }
        },
        460 + k * 150,
      ),
    );
    // once the big changes are done, the agent's work is finished — fade the
    // cursor away ~1s after the last item lands so it gets out of the way.
    if (items.length) {
      timers.push(
        window.setTimeout(
          () => {
            cur.style.transition = glide;
            cur.style.opacity = "0";
          },
          460 + (items.length - 1) * 150 + 1000,
        ),
      );
    }
    return () => timers.forEach((t) => clearTimeout(t));
  }, [sceneIdx, reduced]);

  return (
    // The demo canvas follows the page theme so it previews the real dark
    // worksurface visitors get (not a blinding white slab on the dark page).
    // Card/title/tab surfaces use paper/surface/ink tokens that flip; scene
    // accents (severity dots, pin colours) and the map gradient are theme-aware
    // (the map via `.morph-map` in index.css).
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
                  : "border-ink/15 bg-surface text-ink/50 hover:border-ink/35 hover:text-ink",
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

      {/* The canvas frame stays put; its CONTENTS rebuild per scene — each item
          inside builds in one at a time with the agent-edit glow (see SceneBody
          + tandem-item-in). */}
      <div className="relative overflow-hidden rounded-lg border-[1.5px] border-ink bg-surface shadow-[8px_8px_0_rgba(28,25,23,0.10)]">
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
                    : { color: "rgb(var(--color-ink) / 0.35)" }
                }
              >
                {m.toLowerCase()}
              </span>
            );
          })}
        </div>

        {/* body — re-keyed on scene so it replays the entrance animation */}
        <div ref={bodyRef} className="surface-grid-faint relative h-[300px]">
          {/* Only the human collaborator roams now — the agent's presence is the
              single build cursor below. The roaming agent cursors + "editing" pill
              were removed as messy. */}
          {scene.editors
            .filter((ed) => ed.kind === "human")
            .map((ed) => (
              <Cursor key={ed.name} editor={ed} accent={accent} />
            ))}

          {/* re-keyed so SceneBody remounts and its items rebuild each morph */}
          <div key={scene.key} className="h-full">
            <SceneBody scene={scene} />
          </div>

          {/* the single persistent build cursor — position driven imperatively by
              the effect above; it hops to each item as it lands */}
          <div
            ref={cursorRef}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 z-40 flex items-start"
            style={{ opacity: 0 }}
          >
            <PointerGlyph color={AGENT} />
            <span className="ml-1 mt-0.5 flex w-max">
              <NameTag name={scene.heroAgent} kind="agent" />
            </span>
          </div>
        </div>
      </div>

      {/* the chat that made it: you ask, the agent builds the canvas above */}
      <HeroChat scene={scene} />
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
    desc: "Turn the numbers on your canvas into live charts you and your agent can both read.",
  },
];

const STEPS: { title: string; body: string }[] = [
  { title: "Create a canvas", body: "Name it and you get a short, shareable 8-character code." },
  {
    title: "Connect your agents",
    body: "Point any MCP-aware agent at the code — Claude, Codex, Cursor, or your own.",
  },
  {
    title: "Let it build",
    body: "Your agent works in the chat you're already in — and the result lands here, yours to open and edit.",
  },
];

const AUDIENCES: { title: string; blurb: string; tags: string[]; accent: string; tilt: string }[] = [
  {
    title: "Operations",
    blurb:
      "Stand up an incident bridge, a launch checklist, or a daily ops board. Your agent triages and updates it while you watch.",
    tags: ["Incidents", "Launches", "Logistics"],
    accent: "#F43F5E",
    tilt: "lg:-rotate-1",
  },
  {
    title: "Builders",
    blurb:
      "Plan the quarter, split work across coding agents, and watch the roadmap move from todo to done as the work gets done.",
    tags: ["Roadmaps", "Sprints", "Research"],
    accent: "#0EA5E9",
    tilt: "lg:rotate-[0.5deg] lg:translate-y-3",
  },
  {
    title: "Life & plans",
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

export default function Landing({ onJoin, onOpenMCP, onShowCanvases, onShowSettings, onAbout }: Props) {
  const reduced = usePrefersReducedMotion();
  const [sceneIdx, setSceneIdx] = useState(0);
  const [launcher, setLauncher] = useState<null | "create" | "join">(null);
  const [recents, setRecents] = useState(() => listRecent());
  const [user, setUser] = useState<User | null>(getCachedUser);
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
    // The page follows the global theme (light/dark). The hero illustration
    // (MorphCanvas) now follows the theme too, so it previews the real dark
    // worksurface. What stays pinned with `theme-light`: the intentionally-dark
    // bands (bg-ink text-paper) that would otherwise INVERT to light in dark mode.
    <div className="min-h-screen overflow-x-clip scroll-smooth bg-paper font-brand text-ink [text-rendering:optimizeLegibility] antialiased">
      {/* Nav — shared across Landing / MCP / About via LandingNav. */}
      <LandingNav
        onHome={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        onJoin={onJoin}
        onOpenMCP={onOpenMCP}
        onShowCanvases={onShowCanvases}
        onShowSettings={onShowSettings}
        onAbout={onAbout}
        onUserChange={setUser}
        samePageAnchors
      />

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
              <SysLabel>One prompt in · a real artifact out</SysLabel>
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
                        <span
                          key={active ? `${s.key}-on` : s.key}
                          className={`inline-block px-1 italic ${active ? "tandem-word-in" : ""}`}
                          style={{
                            color: s.accent.solid,
                            backgroundColor: s.accent.soft,
                            boxShadow: `inset 0 0 0 1.5px ${s.accent.line}`,
                          }}
                        >
                          {s.heroAgent}
                        </span>{" "}
                        made this. You keep it.
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
              You ask in the chat you're already in. Your agent does the work and leaves it here —
              a real artifact you can open, edit, and keep, not a chat log you'll never find again.
              A doc has no agent. An MCP server has no human. Tandem is the one thing that's both.
            </p>

            {/* Primary actions — the create / join forms live in the launcher modal.
                Signed in, the primary path is the dashboard (like Supabase's
                "start your project"); signed out, it's straight to create. */}
            <div
              className="tandem-rise mt-9 flex flex-wrap items-center gap-4"
              style={{ animationDelay: "180ms" }}
            >
              {user ? (
                <>
                  <button
                    onClick={onShowCanvases}
                    className="btn-press inline-flex items-center justify-center gap-2 rounded-md bg-ink px-6 py-3 font-medium text-paper shadow-[4px_4px_0_#0D6E66]"
                  >
                    Go to your dashboard
                    <Icon name="arrow" className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setLauncher("create")}
                    className="btn-press rounded-md border-[1.5px] border-ink bg-surface px-6 py-3 font-medium text-ink shadow-[4px_4px_0_rgba(28,25,23,0.15)]"
                  >
                    Create a canvas
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setLauncher("create")}
                    className="btn-press inline-flex items-center justify-center gap-2 rounded-md bg-ink px-6 py-3 font-medium text-paper shadow-[4px_4px_0_#0D6E66]"
                  >
                    Create a canvas
                    <Icon name="arrow" className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setLauncher("join")}
                    className="btn-press rounded-md border-[1.5px] border-ink bg-surface px-6 py-3 font-medium text-ink shadow-[4px_4px_0_rgba(28,25,23,0.15)]"
                  >
                    Join with a code
                  </button>
                </>
              )}
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

          {/* Right: the morphing canvas illustration + its prescripted chat */}
          <div className="tandem-rise min-w-0" style={{ animationDelay: "140ms" }}>
            <MorphCanvas sceneIdx={sceneIdx} setSceneIdx={setSceneIdx} />
          </div>
        </div>
      </section>

      {/* "Becomes anything" marquee */}
      <section className="border-y border-ink/10 bg-surface py-5">
        <div className="mx-auto mb-3 max-w-6xl px-6">
          <SysLabel>One canvas → anything your agent can build</SysLabel>
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
            <ul className="overflow-hidden rounded-md border border-ink/15 bg-surface">
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
            <SysLabel>What it becomes</SysLabel>
            <h2 className="mt-3 font-display text-3xl font-medium tracking-tight text-ink sm:text-4xl">
              Ask for anything. It shows up here.
            </h2>
            <p className="mt-3 leading-relaxed text-ink/65">
              The same canvas reshapes itself around whatever you ask your agent for. A few of the
              things people build every day:
            </p>
          </div>

          <div className="mt-14 grid gap-6 sm:grid-cols-3">
            {AUDIENCES.map((a) => (
              <div
                key={a.title}
                className={`group relative rounded-md border-[1.5px] border-ink/80 bg-surface p-6 transition-all duration-300 lg:hover:rotate-0 lg:hover:translate-y-0 hover:shadow-[6px_6px_0_rgba(28,25,23,0.12)] ${a.tilt}`}
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

      {/* Shared memory / multi-agent — the wire. Dark room. theme-light pins the
          light palette so `bg-ink text-paper` stays a dark band in both themes
          (without it, the tokens flip and the room inverts to light). */}
      <section className="theme-light bg-ink text-paper">
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
      <section id="modes" className="relative overflow-hidden border-y border-ink/10 bg-surface">
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
                    className="grid h-8 w-8 place-items-center rounded-[5px] border border-ink/10 bg-surface"
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

            {/* Bring-your-own-agent card — a terminal on the surface. theme-light
                keeps the terminal dark in both themes (else it inverts to light). */}
            <div className="theme-light flex flex-col overflow-hidden rounded-md border-[1.5px] border-ink bg-ink text-paper shadow-[5px_5px_0_rgba(199,91,57,0.5)]">
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
                  Speaks MCP — Claude, ChatGPT, Cursor, Codex, or an orchestrator you wrote
                  yourself. However you already work, the artifact lands here.
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

      {/* Sign-up pitch — only for visitors who aren't already signed in.
          A full-bleed dark band (rather than a black card floating on the paper)
          so the transition reads as an intentional section, not a naked hard edge. */}
      {showSignUp && (
        <section className="theme-light relative overflow-hidden bg-ink text-paper">
          {/* Warm glow + hairline so the flat slab has depth and the top edge
              eases in instead of hard-cutting from paper to black. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{ background: "radial-gradient(120% 90% at 12% 0%, rgba(199,91,57,0.12), transparent 55%)" }}
          />
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-paper/10" />
          <div className="relative mx-auto max-w-6xl px-6 py-24 sm:px-12">
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
                    className="btn-press inline-flex items-center gap-2 rounded-md bg-paper px-6 py-3 font-medium text-ink shadow-[4px_4px_0_#0D6E66]"
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
                Everything your agent makes, in one place that's{" "}
                <em className="text-agent">actually yours.</em>
              </h2>
            </SelectionFrame>
          </div>
          <p className="mx-auto mt-8 max-w-xl leading-relaxed text-ink/65">
            Stop copy-pasting plans out of a chat window. Ask in the chat you're already in, and the
            artifact your agent builds shows up here — open it, edit it, keep it.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <button
              onClick={() => setLauncher("create")}
              className="btn-press inline-flex items-center gap-2 rounded-md bg-ink px-6 py-3 font-medium text-paper shadow-[4px_4px_0_#0D6E66]"
            >
              Start a canvas
              <Icon name="arrow" className="h-4 w-4" />
            </button>
            <button
              onClick={onOpenMCP}
              className="btn-press rounded-md border-[1.5px] border-ink bg-surface px-6 py-3 font-medium text-ink shadow-[4px_4px_0_rgba(28,25,23,0.15)]"
            >
              Connect an agent
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-ink/10 bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 font-code text-[11px] text-ink/40 sm:flex-row">
          <div className="flex items-center gap-2">
            <TandemLogo size={18} animate={false} />
            <span>Tandem — you and your agents, in tandem.</span>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={onAbout}
              className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
            >
              About
            </button>
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
