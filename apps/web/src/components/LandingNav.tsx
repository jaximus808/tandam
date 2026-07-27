import { useEffect, useState } from "react";
import { fetchMe, getCachedUser, type User } from "../lib/auth";
import { spaLink } from "../lib/spaNav";
import TandemLogo from "./TandemLogo";
import AccountMenu from "./AccountMenu";

// The marketing top nav shared by the public surfaces — Landing, MCP support,
// and About. Keeping it one component guarantees these pages present the SAME
// navbar; it only gives way to the app chrome (Dashboard / Settings use
// SiteHeader, a canvas has its live editing header). The "Use cases" / "Modes"
// links anchor within the Landing page, so off Landing they navigate home first
// (samePageAnchors=false → absolute /#hash).
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

  const useCasesHref = samePageAnchors ? "#use-cases" : "/#use-cases";
  const modesHref = samePageAnchors ? "#modes" : "/#modes";

  return (
    <header className="sticky top-0 z-40 border-b border-ink/10 bg-paper/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-6">
        <button
          onClick={onHome}
          className="group flex items-center gap-2 text-[16px] font-semibold tracking-tight"
          title="Back to home"
        >
          <TandemLogo size={32} />
          <span>Tandem</span>
          <span className="ml-1 hidden items-center gap-1.5 rounded-[3px] border border-ink/10 px-1.5 py-0.5 font-code text-[9px] uppercase tracking-[0.14em] text-ink/40 md:inline-flex">
            <span className="relative flex h-1 w-1">
              <span className="tandem-ping absolute inline-flex h-full w-full rounded-full bg-agent opacity-70" />
              <span className="relative inline-flex h-1 w-1 rounded-full bg-agent" />
            </span>
            agent-native
          </span>
        </button>
        <nav className="ml-auto flex items-center gap-1 text-sm sm:gap-1.5">
          <a
            href={useCasesHref}
            className="hidden rounded-md px-3 py-1.5 text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink sm:inline"
          >
            Use cases
          </a>
          <a
            href={modesHref}
            className="hidden rounded-md px-3 py-1.5 text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink sm:inline"
          >
            Modes
          </a>
          {/* Real anchors, not buttons — see lib/spaNav: these are the only
              internal links to /about and /mcp a crawler can follow. */}
          <a
            href="/about"
            onClick={spaLink(onAbout)}
            className="hidden rounded-md px-3 py-1.5 text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink sm:inline"
          >
            About
          </a>
          <a
            href="/mcp"
            onClick={spaLink(onOpenMCP)}
            className="rounded-md px-3 py-1.5 font-medium text-ink/80 transition-colors hover:bg-ink/5"
          >
            Connect an agent
          </a>
          {user && (
            <button
              onClick={onShowCanvases}
              className="inline-flex items-center gap-1.5 rounded-md border-[1.5px] border-ink bg-surface px-3 py-1.5 font-medium text-ink shadow-[2px_2px_0_rgba(28,25,23,0.15)] transition-transform hover:-translate-y-px"
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
