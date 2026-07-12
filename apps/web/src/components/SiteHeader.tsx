import type { ReactNode } from "react";
import TandemLogo from "./TandemLogo";
import AccountMenu from "./AccountMenu";

// The persistent top nav shared by every non-canvas page (Landing has its own
// richer marketing header; the canvas view has the live editing chrome). Keeps
// the brand-home link, an optional breadcrumb label, page-specific actions, and
// the account menu present everywhere so navigating between pages never drops
// the nav. Mirrors the Dashboard/Settings header styling.
interface Props {
  // Brand click — back to the home surface.
  onHome: () => void;
  // Breadcrumb after the brand ("About", "By the numbers", …).
  label?: ReactNode;
  // Page-specific right-side actions (e.g. a Refresh button), rendered before
  // the account menu.
  children?: ReactNode;
  onOpenMCP?: () => void;
  onShowCanvases?: () => void;
  onShowSettings?: () => void;
  onShowAbout?: () => void;
  onOpenCanvas?: (code: string) => void;
}

export default function SiteHeader({
  onHome,
  label,
  children,
  onOpenMCP,
  onShowCanvases,
  onShowSettings,
  onShowAbout,
  onOpenCanvas,
}: Props) {
  return (
    <header className="sticky top-0 z-40 flex items-center gap-2 border-b border-ink/10 bg-paper/85 px-4 py-3 backdrop-blur sm:px-6">
      <button onClick={onHome} className="group flex items-center gap-1.5" title="Back to home">
        <TandemLogo size={28} animate={false} />
        <span className="hidden font-semibold tracking-tight transition-colors group-hover:text-sky-600 sm:inline">
          Tandem
        </span>
      </button>
      {label != null && (
        <>
          <span className="text-ink/20">/</span>
          <span className="font-display text-[15px] font-medium">{label}</span>
        </>
      )}
      <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
        {onOpenMCP && (
          <button
            onClick={onOpenMCP}
            className="hidden rounded-md px-3 py-1.5 text-sm font-medium text-ink/80 transition-colors hover:bg-ink/5 sm:inline"
          >
            Connect an agent
          </button>
        )}
        {children}
        <AccountMenu
          onShowCanvases={onShowCanvases}
          onShowSettings={onShowSettings}
          onShowAbout={onShowAbout}
          onOpenCanvas={onOpenCanvas}
        />
      </div>
    </header>
  );
}
