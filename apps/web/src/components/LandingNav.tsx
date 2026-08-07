import { useEffect, useState } from "react";
import { fetchMe, getCachedUser, type User } from "../lib/auth";
import { spaLink } from "../lib/spaNav";
import TandemLogo from "./TandemLogo";
import AccountMenu from "./AccountMenu";

// The marketing top nav shared by the public surfaces — Landing, MCP support,
// and About. Keeping it one component guarantees these pages present the SAME
// navbar; it only gives way to the app chrome (Dashboard / Settings use
// SiteHeader, a canvas has its live editing header). The "How it works" /
// "Quickstart" links anchor within the Landing page, so off Landing they
// navigate home first (samePageAnchors=false → absolute /#hash).
interface Props {
  // Brand click — back to the home surface. On Landing itself this just scrolls
  // to the top (already home).
  onHome: () => void;
  // Open a canvas by code (AccountMenu inbox → invite).
  onJoin: (code: string) => void;
  onOpenMCP: () => void;
  onShowCanvases: () => void;
  onShowSettings: () => void;
  onAbout: () => void;
  // /why-tandem, the research essay. Optional: the link is a real anchor, so a
  // surface that doesn't pass a handler still renders a crawlable link — the
  // browser just navigates normally instead of routing in-app.
  onWhy?: () => void;
  // /features, the capability reference. Optional for the same reason as onWhy.
  onFeatures?: () => void;
  // Landing passes its own setUser so signing in through the AccountMenu keeps
  // the hero in sync; other pages omit it.
  onUserChange?: (u: User | null) => void;
  // true only on Landing, where the section anchors live on the same page.
  samePageAnchors?: boolean;
}

function ArrowIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export default function LandingNav({
  onHome,
  onJoin,
  onOpenMCP,
  onShowCanvases,
  onShowSettings,
  onAbout,
  onWhy,
  onFeatures,
  onUserChange,
  samePageAnchors = false,
}: Props) {
  // Own copy of `me` drives the Dashboard button; sign-in/out via the
  // AccountMenu updates it (and any parent that passed onUserChange).
  const [user, setUser] = useState<User | null>(getCachedUser);
  useEffect(() => {
    let cancelled = false;
    fetchMe().then((u) => {
      if (!cancelled) setUser(u);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Solid paper chrome; the hairline only appears once the page scrolls under
  // the nav (canon: no translucency or blur effects).
  const [scrolled, setScrolled] = useState(() => typeof window !== "undefined" && window.scrollY > 4);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const howItWorksHref = samePageAnchors ? "#how-it-works" : "/#how-it-works";
  const quickstartHref = samePageAnchors ? "#quickstart" : "/#quickstart";

  return (
    <header
      className={`sticky top-0 z-40 border-b bg-paper transition-colors duration-150 ${
        scrolled ? "border-ink/10" : "border-transparent"
      }`}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-6">
        <button
          onClick={onHome}
          className="group flex items-center gap-2 text-[16px] font-semibold tracking-tight"
          title="Back to home"
        >
          <TandemLogo size={32} />
          <span>Tandem</span>
          {/* Static dot — the one-pulse motion budget is reserved for LIVE
              "working" indicators; a nav badge is decoration. */}
          {/* lg, not md: at md the nav already carries Why Tandem + About +
              CTA + Dashboard, and with wrapping now forbidden this badge is
              the ~95px that would push a signed-in header past the edge. */}
          <span className="ml-1 hidden items-center gap-1.5 whitespace-nowrap rounded border border-ink/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink/50 lg:inline-flex">
            <span className="inline-flex h-1 w-1 rounded-full bg-agent" />
            agent-native
          </span>
        </button>
        <nav className="ml-auto flex items-center gap-1 text-sm sm:gap-1.5">
          {/* Link visibility is TIERED, not all-or-nothing at sm: between
              640px and ~1000px the full set doesn't fit next to the brand +
              CTA, and flex was answering by wrapping every label into a
              2–3 line stack. Same-page anchors (How it works / Quickstart)
              are the most expendable → lg. The CTA + Dashboard + account
              survive every width. whitespace-nowrap everywhere: a label that
              doesn't fit is hidden by its tier, never folded.

              The md TIER HOLDS EXACTLY TWO page links — that is its width
              budget, not a coincidence. At 768px the brand plus CTA plus
              Dashboard plus the account control already spend ~590px of the
              ~720px of usable row, which leaves room for two labels and no
              third. So Features (TDM-209) taking a md slot means About gives
              one up: /features is the page a visitor evaluating the product
              needs, /about is the page they read after deciding, and the
              essay (/why-tandem) is what makes the case. About stays fully
              reachable at lg, from both marketing footers, and from the
              account menu at every width. */}
          <a
            href={howItWorksHref}
            className="hidden whitespace-nowrap rounded-md px-3 py-1.5 text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink lg:inline"
          >
            How it works
          </a>
          <a
            href={quickstartHref}
            className="hidden whitespace-nowrap rounded-md px-3 py-1.5 text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink lg:inline"
          >
            Quickstart
          </a>
          {/* Real anchors, not buttons — see lib/spaNav: these are the only
              internal links to /features, /why-tandem, /about and /mcp a
              crawler can follow. */}
          <a
            href="/features"
            onClick={onFeatures ? spaLink(onFeatures) : undefined}
            className="hidden whitespace-nowrap rounded-md px-3 py-1.5 text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink md:inline"
          >
            Features
          </a>
          <a
            href="/why-tandem"
            onClick={onWhy ? spaLink(onWhy) : undefined}
            className="hidden whitespace-nowrap rounded-md px-3 py-1.5 text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink md:inline"
          >
            Why Tandem
          </a>
          <a
            href="/about"
            onClick={spaLink(onAbout)}
            className="hidden whitespace-nowrap rounded-md px-3 py-1.5 text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink lg:inline"
          >
            About
          </a>
          <a
            href="/mcp"
            onClick={spaLink(onOpenMCP)}
            className="whitespace-nowrap rounded-md px-3 py-1.5 font-medium text-ink/80 transition-colors hover:bg-ink/5"
          >
            Connect an agent
          </a>
          {user && (
            <button
              onClick={onShowCanvases}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-ink/15 bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:border-ink/25"
            >
              Dashboard
              <ArrowIcon className="h-3.5 w-3.5" />
            </button>
          )}
          <AccountMenu
            onShowCanvases={onShowCanvases}
            onShowSettings={onShowSettings}
            onShowAbout={onAbout}
            onUserChange={(u) => {
              setUser(u);
              onUserChange?.(u);
            }}
            onOpenCanvas={onJoin}
          />
        </nav>
      </div>
    </header>
  );
}
