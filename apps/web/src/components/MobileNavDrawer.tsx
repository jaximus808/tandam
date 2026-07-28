import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import type { SidebarView } from "../lib/sidebar";
import { SIDEBAR_ITEMS } from "../lib/sidebar";

/* ─────────────────────────────────────────────────────────────────────────────
   MobileNavDrawer — the phone-width home for the left dock.

   On desktop the sidebar is an always-present icon rail (ActivityBar) plus one
   swappable SidePanel; both are `hidden sm:flex`, so on a phone there's no way to
   reach the document explorer, agent tasks, or settings. This is that dock as an
   off-canvas drawer: a segmented switcher (the same SIDEBAR_ITEMS registry) over
   the SELECTED view's panel body, which the caller renders as `children` — so the
   drawer reuses the exact DocumentExplorer / TasksPanel / SettingsPanel
   components, not mobile copies of them.

   Purely additive: `sm:hidden`, so desktop layout is untouched. The panel bodies
   already speak the paper/surface/ink theme tokens, so the drawer follows dark
   mode for free. Closing on selection (opening a document) is the caller's job —
   it wraps the panel's onOpen to also call onClose.
   ──────────────────────────────────────────────────────────────────────────── */

export default function MobileNavDrawer({
  open,
  view,
  onSelectView,
  onClose,
  badges,
  children,
}: {
  open: boolean;
  /** Which view's panel is showing; also lights the matching segment. */
  view: SidebarView;
  /** Switch the drawer to another view (does NOT close the drawer). */
  onSelectView: (view: SidebarView) => void;
  onClose: () => void;
  /** Per-view count badges (e.g. tasks awaiting approval). */
  badges?: Partial<Record<SidebarView, number>>;
  /** The selected view's panel body (rendered by the caller). */
  children: ReactNode;
}) {
  // Close on Escape — a hardware keyboard (tablet) or a11y affordance.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] sm:hidden">
      {/* Scrim — tap outside the panel to dismiss. */}
      <div
        className="absolute inset-0 bg-ink/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="absolute inset-x-0 bottom-0 flex max-h-[80vh] flex-col rounded-t-[10px] border-t border-ink/10 bg-surface shadow-lg animate-[drawer-in_180ms_ease-out]"
        role="dialog"
        aria-modal="true"
        aria-label="Canvas navigation"
      >
        {/* Segmented switcher — one icon per registered view, mirroring the
            desktop ActivityBar. Tapping a segment swaps the panel; the drawer
            stays open (that's navigation within the dock, not a selection). */}
        <div className="flex items-center gap-1 border-b border-ink/10 p-2">
          {SIDEBAR_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = view === item.id;
            const badge = badges?.[item.id] ?? 0;
            return (
              <button
                key={item.id}
                onClick={() => onSelectView(item.id)}
                className={[
                  "relative flex h-9 flex-1 items-center justify-center rounded-md transition-colors",
                  isActive
                    ? "bg-accent/[0.08] text-accent"
                    : "text-ink/40 hover:bg-ink/5 hover:text-ink/70",
                ].join(" ")}
                title={item.label}
                aria-label={item.label}
                aria-pressed={isActive}
              >
                <Icon size={19} strokeWidth={1.75} />
                {badge > 0 && (
                  <span className="absolute right-2 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-agent px-1 text-[9px] font-bold text-white">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
          <button
            onClick={onClose}
            className="ml-1 flex h-9 w-9 items-center justify-center rounded-md text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink/70"
            title="Close"
            aria-label="Close navigation"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        {/* The selected view's panel body — reused verbatim from the desktop dock. */}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </aside>

      {/* Local keyframes so the drawer is self-contained (mirrors QuickLog). */}
      <style>{`
        @keyframes drawer-in { from { opacity: 0; transform: translateY(24px) } to { opacity: 1; transform: translateY(0) } }
      `}</style>
    </div>
  );
}
