import { useEffect, useMemo, useState } from "react";
import { listRecent, removeRecent } from "../lib/recentCanvases";
import { fetchMe, getCachedUser, GOOGLE_CLIENT_ID, type User } from "../lib/auth";
import { spaLink } from "../lib/spaNav";
import TandemLogo from "../components/TandemLogo";
import LandingNav from "../components/LandingNav";
import CanvasLauncher from "../components/CanvasLauncher";
import SignInModal from "../components/SignInModal";
import HeroBoardDemo from "../components/landing/HeroBoardDemo";
import VillainSection from "../components/landing/VillainSection";
import HowItWorksSection from "../components/landing/HowItWorksSection";
import DogfoodProofSection from "../components/landing/DogfoodProofSection";
import ReceiptsSection from "../components/landing/ReceiptsSection";
import QuickstartSection from "../components/landing/QuickstartSection";

interface Props {
  onJoin: (code: string) => void;
  onOpenMCP: () => void;
  onShowCanvases: () => void;
  onShowSettings: () => void;
  onAbout: () => void;
}

/* ─────────────────────────────────────────────────────────────────────────────
   The page is one story, top to bottom:

     hero proof (HeroBoardDemo: two sessions drain one queue, a claim bounces)
     → the pain (VillainSection: agents fighting over TODO.md)
     → the mechanism (HowItWorksSection: the five-step loop, real tool names)
     → live proof (DogfoodProofSection: Tandem is built on its own queue)
     → receipts (ReceiptsSection: every task traced to a commit)
     → try it (QuickstartSection: copy-paste setup)
     → a modest "the board is a full workspace" note
     → FAQ → closing CTA.

   The section components live in components/landing/ and are self-contained;
   this file owns only the hero copy, the connective tissue, and the page state
   (auth, launcher, recents). Humans are ink; agents are terracotta.
   ───────────────────────────────────────────────────────────────────────────── */

const AGENT = "#C75B39";

// The cycling headline word. Rotating Claude → ChatGPT → Cursor → Codex SHOWS
// agent-agnosticism instead of telling it. Any one entry is a single-line edit
// if a client stops working.
const HERO_AGENTS: { name: string; solid: string; soft: string; line: string }[] = [
  { name: "Claude", solid: "#F43F5E", soft: "rgba(244,63,94,0.10)", line: "rgba(244,63,94,0.24)" },
  { name: "ChatGPT", solid: "#0EA5E9", soft: "rgba(14,165,233,0.10)", line: "rgba(14,165,233,0.24)" },
  { name: "Cursor", solid: "#F59E0B", soft: "rgba(245,158,11,0.12)", line: "rgba(245,158,11,0.26)" },
  { name: "Codex", solid: "#10B981", soft: "rgba(16,185,129,0.10)", line: "rgba(16,185,129,0.24)" },
];

const HERO_WORD_MS = 4200;

// Only show the public "N canvases created" counter once it's real social
// proof — a tiny number reads as anti-proof. Bump down as adoption grows.
const CANVAS_COUNT_FLOOR = 50;

// The board's view modes, name-dropped once in the workspace note below —
// deliberately NOT a full section of demos; the queue is the story.
const MODE_NAMES = ["Roadmap", "Sheets", "Docs", "Charts", "Map", "Itinerary"];

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

/* ── content data for the lower sections ─────────────────────────────────────── */

// Answers to the questions people actually type into a search box ("how do I
// coordinate parallel Claude Code sessions", "agent task queue"). This is the
// page's only block of plain, category-level prose — the rest of the landing
// speaks in brand voice, which only ever matched people already searching for
// Tandem by name.
//
// KEEP IN SYNC with the FAQPage JSON-LD in apps/web/index.html: structured data
// that doesn't appear on the page is a manual-action risk, so the answers below
// and the ones in the <head> are the same sentences.
const FAQS: { q: string; a: React.ReactNode }[] = [
  {
    q: "What is a shared state layer for agent sessions?",
    a: (
      <>
        A place outside any single session where the coordination state lives: which tasks exist,
        which session claimed which, what's approved, what's done. In Tandem that's a durable task
        queue every agent session reads and writes over the{" "}
        <a
          href="https://modelcontextprotocol.io"
          target="_blank"
          rel="noopener noreferrer"
          className="text-agent underline underline-offset-2 hover:text-ink"
        >
          Model Context Protocol
        </a>
        , while you watch the same board live in a browser.
      </>
    ),
  },
  {
    q: "Which AI agents can connect to Tandem?",
    a: (
      <>
        Any MCP-aware client. Claude Code, Claude Desktop, and claude.ai connect through the hosted
        connector or the npm package <span className="font-code text-[13px]">@jaximus/tandem-mcp</span>;
        Cursor, agent frameworks, and custom orchestrators spawn the same stdio server. Many
        sessions can work the same queue at the same time.
      </>
    ),
  },
  {
    q: "Why not just keep a TODO.md in the repo?",
    a: (
      <>
        A markdown file is fine for one session. With several running in parallel it becomes the
        collision point: sessions clobber each other's edits, claims go stale, and nothing tells
        you who is doing what right now. Tandem splits it: intent lives in the repo — the spec
        stays in git — while the churn (claims, statuses, results) moves into a shared queue with
        per-task state.
      </>
    ),
  },
  {
    q: "Do I need an account to use Tandem?",
    a: (
      <>
        No. Create a canvas, get a short code, and share it — anyone with the code can open it in
        the browser and any agent session can join with the same code. Signing in with Google is
        only needed if you want to keep canvases in a dashboard or make one private.
      </>
    ),
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
  const [wordIdx, setWordIdx] = useState(0);
  const [launcher, setLauncher] = useState<null | "create" | "join">(null);
  const [recents, setRecents] = useState(() => listRecent());
  const [user, setUser] = useState<User | null>(getCachedUser);
  const [signInOpen, setSignInOpen] = useState(false);
  const [canvasCount, setCanvasCount] = useState<number | null>(null);

  const hasRecents = useMemo(() => recents.length > 0, [recents]);

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

  // Auto-advance the cycling headline word (and with it the accent colour).
  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setWordIdx((wordIdx + 1) % HERO_AGENTS.length), HERO_WORD_MS);
    return () => clearTimeout(t);
  }, [wordIdx, reduced]);

  function handleForgetRecent(c: string) {
    removeRecent(c);
    setRecents(listRecent());
  }

  return (
    // The page follows the global theme (light/dark). What stays pinned with
    // `theme-light`: the intentionally-dark bands (bg-ink text-paper, and the
    // terminal blocks inside the landing sections) that would otherwise INVERT
    // to light in dark mode.
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

      {/* Hero — copy left, the two-terminals-one-queue demo right */}
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

        <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-6 pb-20 pt-16 lg:grid-cols-[1fr_1.05fr] lg:gap-10 lg:pb-24 lg:pt-20">
          {/* Left: copy + actions */}
          <div className="min-w-0 max-w-xl lg:pt-4">
            <div className="tandem-rise">
              <SysLabel>One queue · every session · no collisions</SysLabel>
            </div>

            {/* mt-12 leaves headroom for the frame's "you" tag above the h1.
                z-10: tandem-rise's lingering transform makes this and the demo
                column stacking contexts; without it the hero cursor paints
                behind the demo when it overhangs the column gap. */}
            <div className="tandem-rise relative z-10 mt-12" style={{ animationDelay: "60ms" }}>
              {/* All four headline variants render stacked in one grid cell, the
                  inactive ones invisible — so this block is always as tall as
                  the tallest phrase and the page below never shifts when the
                  cycling word changes line count. */}
              <SelectionFrame tag="you" className="inline-block">
                <h1 className="grid font-display text-[2.3rem] font-medium leading-[1.08] tracking-tight text-ink sm:text-[3.5rem] sm:leading-[1.06]">
                  {HERO_AGENTS.map((a, i) => {
                    const active = i === wordIdx;
                    return (
                      <span
                        key={a.name}
                        aria-hidden={!active}
                        className={`col-start-1 row-start-1 block ${active ? "" : "invisible"}`}
                      >
                        <span
                          key={active ? `${a.name}-on` : a.name}
                          className={`inline-block px-1 italic ${active ? "tandem-word-in" : ""}`}
                          style={{
                            color: a.solid,
                            backgroundColor: a.soft,
                            boxShadow: `inset 0 0 0 1.5px ${a.line}`,
                          }}
                        >
                          {a.name}
                        </span>{" "}
                        in parallel. Nothing collides.
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
              You already run several agent sessions at once. Coordinating them through a TODO.md
              they all fight over is the part that breaks. Tandem is the shared state layer
              instead: a durable task queue every session claims from, approval you grant once per
              epic, and a live board of who's doing what. The spec stays in git; the churn moves
              here.
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
              {/* anchor, not a button — the hero link to /mcp is the strongest
                  internal link on the site (see lib/spaNav) */}
              <a
                href="/mcp"
                onClick={spaLink(onOpenMCP)}
                className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-agent transition-colors hover:text-ink"
              >
                <Icon name="spark" className="h-3.5 w-3.5" />
                connect an AI agent →
              </a>
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

          {/* Right: two Claude Code terminals draining one queue — the product's
              whole argument, animated (HeroBoardDemo loops ~20s). */}
          <div className="tandem-rise min-w-0" style={{ animationDelay: "140ms" }}>
            <HeroBoardDemo />
          </div>
        </div>
      </section>

      {/* Recent canvases — returning-visitor utility, kept out of the story */}
      {hasRecents && (
        <section className="mx-auto max-w-6xl px-6 py-10">
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

      {/* The pain: two sessions colliding on TODO.md (full-bleed surface band) */}
      <VillainSection />

      {/* The mechanism: the five-step loop, real MCP tool names (plain paper) */}
      <div id="how-it-works">
        <HowItWorksSection />
      </div>

      {/* Live proof: Tandem is planned and built on its own public queue (band) */}
      <DogfoodProofSection />

      {/* Receipts: ticket → commit, provenance in both directions (plain paper) */}
      <ReceiptsSection />

      {/* Try it: copy-paste setup for Claude Code / CLAUDE.md / hosted (band) */}
      <div id="quickstart">
        <QuickstartSection />
      </div>

      {/* The board is a full workspace — one modest mention, not a section of
          demos. The queue is the story; this is the "and there's more" aside. */}
      <section id="modes" className="mx-auto max-w-6xl px-6 py-20">
        <div className="max-w-2xl">
          <SysLabel>Beyond the queue</SysLabel>
          <h2 className="mt-3 font-display text-2xl font-medium tracking-tight text-ink">
            The board is a full workspace.
          </h2>
          <p className="mt-3 leading-relaxed text-ink/65">
            Everything your sessions write lands as structured state you can actually read — the
            epic as a roadmap, results as a sheet, findings as a doc. Same data the agents see,
            rendered for humans.
          </p>
          <div className="mt-5 flex flex-wrap gap-1.5">
            {MODE_NAMES.map((m) => (
              <span
                key={m}
                className="rounded-[3px] border border-ink/10 bg-surface px-2 py-0.5 font-code text-[10.5px] font-medium text-ink/50"
              >
                {m.toLowerCase()}
              </span>
            ))}
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

      {/* FAQ — the plain-language, category-level pass over the same product.
          Mirrored by the FAQPage JSON-LD in index.html; edit both together. */}
      <section id="faq" className="border-t border-ink/10">
        <div className="mx-auto max-w-3xl px-6 py-24">
          <SysLabel>Questions</SysLabel>
          <h2 className="mt-3 font-display text-3xl font-medium tracking-tight text-ink sm:text-4xl">
            Shared state for humans and agent sessions
          </h2>
          <p className="mt-3 leading-relaxed text-ink/65">
            Tandem is a durable task queue your agent sessions work over MCP while you watch and
            steer from the browser. The short version, in plain terms:
          </p>

          <dl className="mt-12 space-y-9">
            {FAQS.map((f) => (
              <div key={f.q} className="border-t border-ink/10 pt-6">
                <dt className="font-display text-lg font-medium text-ink">{f.q}</dt>
                <dd className="mt-2 leading-relaxed text-ink/65">{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

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
                Every session on the same queue,{" "}
                <em className="text-agent">every task traced to a commit.</em>
              </h2>
            </SelectionFrame>
          </div>
          <p className="mx-auto mt-8 max-w-xl leading-relaxed text-ink/65">
            Stop coordinating parallel sessions through a markdown file they all fight over. Keep
            the spec in git, put the queue where every session and every teammate can see it, and
            watch the work move.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <button
              onClick={() => setLauncher("create")}
              className="btn-press inline-flex items-center gap-2 rounded-md bg-ink px-6 py-3 font-medium text-paper shadow-[4px_4px_0_#0D6E66]"
            >
              Start a canvas
              <Icon name="arrow" className="h-4 w-4" />
            </button>
            <a
              href="/mcp"
              onClick={spaLink(onOpenMCP)}
              className="btn-press rounded-md border-[1.5px] border-ink bg-surface px-6 py-3 font-medium text-ink shadow-[4px_4px_0_rgba(28,25,23,0.15)]"
            >
              Connect an agent
            </a>
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
            <a
              href="/about"
              onClick={spaLink(onAbout)}
              className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
            >
              About
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
