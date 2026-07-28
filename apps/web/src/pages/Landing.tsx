import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
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
   (auth, launcher, recents). Styling follows /DESIGN.md ("Precision Canon"):
   Inter everywhere, one indigo accent, hairline borders, no decoration.
   ───────────────────────────────────────────────────────────────────────────── */

// The cycling headline word. Rotating Claude → ChatGPT → Cursor → Codex SHOWS
// agent-agnosticism instead of telling it. Any one entry is a single-line edit
// if a client stops working. Rendered as plain accent-colored text — no box.
const HERO_AGENTS: string[] = ["Claude", "ChatGPT", "Cursor", "Codex"];

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

/** Canon section eyebrow — 12px Inter 500 uppercase tracking-wide ink/50. */
function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`text-xs font-medium uppercase tracking-wide text-ink/50 ${className}`}>
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
          className="text-accent underline underline-offset-2 hover:text-ink"
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
    // The page follows the global theme (light/dark) end to end. The dark bands
    // (sign-up slab, terminal mocks in the sections) use explicit dark grounds
    // so they read identically in both themes — no light-lock anywhere.
    <div className="min-h-screen overflow-x-clip scroll-smooth bg-paper font-sans text-ink [text-rendering:optimizeLegibility] antialiased">
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

      {/* Hero — copy left, the two-terminals-one-queue demo right. ONE fade-up
          for the whole viewport (the motion-budget contract: at most a single
          fade-up per section — the demo owns the hero's ongoing motion). */}
      <section className="relative overflow-hidden">
        <div className="tandem-rise relative mx-auto grid max-w-6xl items-center gap-14 px-6 pb-20 pt-16 lg:grid-cols-[1fr_1.05fr] lg:gap-10 lg:pb-24 lg:pt-20">
          {/* Left: copy + actions */}
          <div className="min-w-0 max-w-xl lg:pt-4">
            <div>
              <Eyebrow>One queue · every session · no collisions</Eyebrow>
            </div>

            <div className="mt-5">
              {/* All four headline variants render stacked in one grid cell, the
                  inactive ones invisible — so this block is always as tall as
                  the tallest phrase and the page below never shifts when the
                  cycling word changes line count. */}
              <h1 className="grid text-[2.75rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[3.5rem] sm:leading-[1.06]">
                {HERO_AGENTS.map((name, i) => {
                  const active = i === wordIdx;
                  return (
                    <span
                      key={name}
                      aria-hidden={!active}
                      className={`col-start-1 row-start-1 block ${active ? "" : "invisible"}`}
                    >
                      <span
                        key={active ? `${name}-on` : name}
                        className={`inline-block text-accent ${active ? "tandem-word-in" : ""}`}
                      >
                        {name}
                      </span>{" "}
                      in parallel. Nothing collides.
                    </span>
                  );
                })}
              </h1>
            </div>

            <p className="mt-6 text-base leading-relaxed text-ink/65">
              A shared task queue for parallel agent sessions. Every session claims its own work,
              you approve once per epic, and a live board shows who's doing what. The spec stays
              in git — the churn moves here.
            </p>

            {/* Primary actions — the create / join forms live in the launcher modal.
                Signed in, the primary path is the dashboard (like Supabase's
                "start your project"); signed out, it's straight to create. */}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {user ? (
                <>
                  <button
                    onClick={onShowCanvases}
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-5 text-[13px] font-medium text-white transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
                  >
                    Go to your dashboard
                    <Icon name="arrow" className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setLauncher("create")}
                    className="inline-flex h-9 items-center justify-center rounded-md border border-ink/15 bg-surface px-5 text-[13px] font-medium text-ink transition-colors hover:border-ink/25"
                  >
                    Create a canvas
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setLauncher("create")}
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-5 text-[13px] font-medium text-white transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
                  >
                    Create a canvas
                    <Icon name="arrow" className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setLauncher("join")}
                    className="inline-flex h-9 items-center justify-center rounded-md border border-ink/15 bg-surface px-5 text-[13px] font-medium text-ink transition-colors hover:border-ink/25"
                  >
                    Join with a code
                  </button>
                </>
              )}
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink/50">
              {/* anchor, not a button — the hero link to /mcp is the strongest
                  internal link on the site (see lib/spaNav) */}
              <a
                href="/mcp"
                onClick={spaLink(onOpenMCP)}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent transition-[filter] hover:brightness-90"
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
          <div className="min-w-0">
            <HeroBoardDemo />
          </div>
        </div>
      </section>

      {/* Recent canvases — returning-visitor utility, kept out of the story */}
      {hasRecents && (
        <section className="mx-auto max-w-6xl px-6 py-10">
          <div className="max-w-md">
            <h2 className="mb-2">
              <Eyebrow>Jump back in</Eyebrow>
            </h2>
            <ul className="overflow-hidden rounded-lg border border-ink/10 bg-surface">
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
                      <div className="text-[11px] text-ink/50">{relativeTime(r.lastOpenedAt)}</div>
                    </div>
                    <span className="font-code text-[11px] text-ink/50">{r.code}</span>
                  </button>
                  {/* Always reachable: visible on touch (no hover), revealed on
                      row hover or its own keyboard focus on sm+. */}
                  <button
                    onClick={() => handleForgetRecent(r.code)}
                    aria-label={`Remove ${r.name} from recents`}
                    title="Remove from recents"
                    className="rounded p-1 text-ink/25 transition-opacity hover:text-ink/60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:opacity-0 sm:group-hover:opacity-100"
                  >
                    <X size={14} />
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
      <section id="modes" className="mx-auto max-w-6xl px-6 py-24">
        <div className="max-w-2xl">
          <Eyebrow>Beyond the queue</Eyebrow>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink">
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
                className="rounded border border-ink/10 bg-surface px-2 py-0.5 text-[11px] font-medium text-ink/60"
              >
                {m.toLowerCase()}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Sign-up pitch — only for visitors who aren't already signed in.
          A full-bleed dark band on an explicit dark ground so it reads the same
          in both themes; white/10 hairlines give it a seam against dark paper. */}
      {showSignUp && (
        <section className="relative overflow-hidden border-y border-white/10 bg-[#0A0A0B] text-zinc-200">
          <div className="relative mx-auto max-w-6xl px-6 py-24 sm:px-12">
            <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.1fr]">
              <div>
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Free account
                </span>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-100 sm:text-[2rem]">
                  Start free. Sign up to unlock more.
                </h2>
                <p className="mt-4 leading-relaxed text-zinc-400">
                  Anyone can spin up a canvas and share the code. Create a free account to keep
                  your canvases, get to them from any device, and copy any shared canvas to make it
                  your own.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => setSignInOpen(true)}
                    className="inline-flex h-9 items-center justify-center rounded-md bg-accent px-5 text-[13px] font-medium text-white transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0A0B]"
                  >
                    Create your free account
                  </button>
                  <button
                    onClick={() => setLauncher("create")}
                    className="inline-flex h-9 items-center justify-center rounded-md border border-white/15 px-5 text-[13px] font-medium text-zinc-200 transition-colors hover:bg-white/5"
                  >
                    Try it without signing up
                  </button>
                </div>
              </div>

              <div className="divide-y divide-white/10 rounded-lg border border-white/10">
                {ACCOUNT_PERKS.map((perk) => (
                  <div key={perk.title} className="flex gap-4 p-5">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-white/10 bg-white/5 text-accent">
                      <Icon name={perk.icon} className="h-[18px] w-[18px]" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-zinc-100">{perk.title}</h3>
                      <p className="mt-1 text-xs leading-relaxed text-zinc-400">{perk.desc}</p>
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
          <Eyebrow>Questions</Eyebrow>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-[2rem]">
            Shared state for humans and agent sessions
          </h2>
          <p className="mt-3 leading-relaxed text-ink/65">
            Tandem is a durable task queue your agent sessions work over MCP while you watch and
            steer from the browser. The short version, in plain terms:
          </p>

          <dl className="mt-12 space-y-9">
            {FAQS.map((f) => (
              <div key={f.q} className="border-t border-ink/10 pt-6">
                <dt className="text-base font-semibold tracking-tight text-ink">{f.q}</dt>
                <dd className="mt-2 leading-relaxed text-ink/65">{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Manifesto / closing CTA — back on the open surface */}
      <section className="relative overflow-hidden">
        <div className="relative mx-auto max-w-3xl px-6 py-28 text-center">
          <TandemLogo size={44} />
          <h2 className="mt-8 text-2xl font-semibold leading-tight tracking-tight text-ink sm:text-[2rem]">
            Every session on the same queue,{" "}
            <em className="not-italic text-accent">every task traced to a commit.</em>
          </h2>
          <p className="mx-auto mt-6 max-w-xl leading-relaxed text-ink/65">
            Stop coordinating parallel sessions through a markdown file they all fight over. Keep
            the spec in git, put the queue where every session and every teammate can see it, and
            watch the work move.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => setLauncher("create")}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-5 text-[13px] font-medium text-white transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
            >
              Start a canvas
              <Icon name="arrow" className="h-4 w-4" />
            </button>
            <a
              href="/mcp"
              onClick={spaLink(onOpenMCP)}
              className="inline-flex h-9 items-center justify-center rounded-md border border-ink/15 bg-surface px-5 text-[13px] font-medium text-ink transition-colors hover:border-ink/25"
            >
              Connect an agent
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-ink/10 bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 text-xs text-ink/45 sm:flex-row">
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
              made by{" "}
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
