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
import AudienceSection from "../components/landing/AudienceSection";
import SolvesSection from "../components/landing/SolvesSection";
import PlanReviewSection from "../components/landing/PlanReviewSection";
import DogfoodProofSection from "../components/landing/DogfoodProofSection";
import ReceiptsSection from "../components/landing/ReceiptsSection";
import QuickstartSection from "../components/landing/QuickstartSection";

interface Props {
  onJoin: (code: string) => void;
  onOpenMCP: () => void;
  onShowCanvases: () => void;
  onShowSettings: () => void;
  onAbout: () => void;
  onWhy?: () => void;
}

/* ─────────────────────────────────────────────────────────────────────────────
   The page is one story, top to bottom — why / how / who / what it solves:

     hero (the claim + HeroBoardDemo: two sessions drain one queue, a claim
       bounces — the product's whole argument, running)
     → WHY (VillainSection: a fleet spanning machines has no shared filesystem)
     → HOW (HowItWorksSection: the loop, step by step, in real tool names)
     → WHO (AudienceSection: the fleet shapes this is built for)
     → WHAT IT SOLVES (SolvesSection: four failure modes → four mechanisms)
     → THE GATE (PlanReviewSection: triage the plan before the code exists)
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

// Clients that speak MCP, named under the hero CTAs. Static, not cycling: "any
// model, any machine" is a claim better made by showing the names at once than
// by animating one. Any entry is a single-line edit if a client stops working.
const HERO_CLIENTS: string[] = ["Claude Code", "claude.ai", "Codex", "Cursor"];

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
    q: "What is a coordination plane for agents?",
    a: (
      <>
        A place outside any single agent where the coordination state lives: which tasks exist,
        which are approved, who claimed what, what's done, and the shared context everyone works
        from. In Tandem that's a hosted queue every agent reads and writes over the{" "}
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
        Codex, Cursor, agent frameworks, CI jobs, and custom orchestrators spawn the same stdio
        server. Sessions on different machines, from different vendors, can work the same queue at
        the same time.
      </>
    ),
  },
  {
    q: "Why not just keep a TODO.md in the repo?",
    a: (
      <>
        A file works while everything runs in one checkout. It stops working the moment part of
        your fleet runs in cloud sandboxes with their own clone, or you're supervising from a
        different machine: there is no shared disk to write the claim to, and a file has no notion
        of who holds what right now. Tandem splits it — intent stays in git, and the churn
        (claims, statuses, results) moves to a queue every machine can reach.
      </>
    ),
  },
  {
    q: "How does Tandem stop agents from acting without approval?",
    a: (
      <>
        Tasks land as proposed. Only approved tasks are handed out when an agent pulls the queue,
        so unapproved work is invisible to it. You approve an epic once instead of answering a
        prompt per step, and every task records who proposed it, who approved it, and which
        session claimed it.
      </>
    ),
  },
  {
    q: "Why review agent plans instead of their code?",
    a: (
      <>
        Because a plan is a paragraph and the code it produces is a diff. Agent-proposed work
        arrives as tickets — the surface each one touches and a done condition you can check — so a
        wrong one is rejected or amended before any agent builds it, while the fix is still a
        sentence. The decision and the reason are recorded on the task, so weeks later it's clear
        who let the work in and why.
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

export default function Landing({ onJoin, onOpenMCP, onShowCanvases, onShowSettings, onAbout, onWhy }: Props) {
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
        onWhy={onWhy}
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
              <Eyebrow>The coordination plane for agent fleets</Eyebrow>
            </div>

            <div className="mt-5">
              <h1 className="text-[2.75rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[3.5rem] sm:leading-[1.06]">
                One queue.
                <br />
                Every agent.
                <br />
                <span className="text-accent">Any machine.</span>
              </h1>
            </div>

            <p className="mt-6 text-base leading-relaxed text-ink/65">
              Your fleet spans machines and models — laptop terminals, cloud sandboxes, CI jobs
              that share no filesystem with each other or with you. Tandem gives them one hosted
              queue to claim work from, one briefing they all read, and one gate you hold — where
              you approve the plan, before a line of code exists.
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

            <p className="mt-6 text-[13px] leading-relaxed text-ink/50">
              Any MCP client: {HERO_CLIENTS.join(", ")}, or your own CI script. No SDK, no adapter
              per vendor.
            </p>

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

      {/* WHY: a fleet spanning machines has no shared filesystem (surface band) */}
      <VillainSection />

      {/* HOW: the loop, call by call, in real MCP tool names (plain paper) */}
      <div id="how-it-works">
        <HowItWorksSection />
      </div>

      {/* WHO: the fleet manifest — four places work happens, none of them
          aware of the others (surface band) */}
      <AudienceSection />

      {/* WHAT IT SOLVES: four failure modes → four mechanisms (plain paper) */}
      <SolvesSection />

      {/* THE GATE: review the plan, not the diffs — triage a proposed epic
          before any code exists, and the reason travels back (plain paper) */}
      <PlanReviewSection />

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
            Everything your agents write lands as structured state you can actually read — the
            epic as a roadmap, results as a sheet, findings as a doc. Same data they see, rendered
            for the human who has to review it.
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
            Coordination for agents that don't share a machine
          </h2>
          <p className="mt-3 leading-relaxed text-ink/65">
            Tandem is a hosted queue your agents work over MCP while you watch and steer from the
            browser. The short version, in plain terms:
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
            Every agent on the same queue,{" "}
            <em className="not-italic text-accent">every task behind your approval.</em>
          </h2>
          <p className="mx-auto mt-6 max-w-xl leading-relaxed text-ink/65">
            Your fleet already spans machines and models. Give it one place to find the work, claim
            it without collisions, and hand it back with receipts — while you stay the one who says
            go, reviewing the plan instead of the diff.
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
              href="/why-tandem"
              onClick={onWhy ? spaLink(onWhy) : undefined}
              className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
            >
              Why Tandem
            </a>
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
