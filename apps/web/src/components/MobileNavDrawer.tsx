import { useEffect, type ReactNode } from "react";
import { FolderTree, Settings, X } from "lucide-react";
import { SURFACE_ITEMS, type SidebarView, type Surface } from "../lib/sidebar";

/* ─────────────────────────────────────────────────────────────────────────────
   MobileNavDrawer — the phone-width mirror of the workspace nav.

   Desktop has the labeled WorkspaceNav rail (Board / Documents) plus side
   panels; both are `hidden sm:flex`, so this drawer is a phone's only way to
   switch surfaces, browse the document tree, or reach settings. Two rows:

   · Primary surfaces (Board / Documents) — icon + label, mirroring the rail.
     Tapping one switches the content surface and CLOSES the drawer (it's
     navigation, not panel browsing).
   · Panels (Files / Settings) — a segmented switcher over the selected panel
     body, which the caller renders as `children` — the drawer reuses the exact
     DocumentExplorer / SettingsPanel components, not mobile copies.

   Purely additive: `sm:hidden`, so desktop layout is untouched. The panel
   bodies speak the paper/surface/ink tokens, so dark mode comes free. Closing
   on document-open is the caller's job (it wraps onOpen to also close).
   ──────────────────────────────────────────────────────────────────────────── */

const PANEL_ITEMS: { id: SidebarView; icon: typeof FolderTree; label: string }[] = [
  { id: "documents", icon: FolderTree, label: "Files" },
  { id: "settings", icon: Settings, label: "Settings" },
];

export default function MobileNavDrawer({
  open,
  surface,
  onSelectSurface,
  view,
  onSelectView,
  onClose,
  boardBadge = 0,
  children,
}: {
  open: boolean;
  /** The active content surface — lights the matching primary row item. */
  surface: Surface;
  /** Switch the content surface (the drawer closes itself after). */
  onSelectSurface: (s: Surface) => void;
  /** Which panel body is showing; also lights the matching segment. */
  view: SidebarView;
  /** Switch the drawer to another panel (does NOT close the drawer). */
  onSelectView: (view: SidebarView) => void;
  onClose: () => void;
  /** Count bubble on Board (tasks awaiting approval). */
  boardBadge?: number;
  /** The selected panel body (rendered by the caller). */
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
        {/* Primary surfaces — the mobile mirror of the desktop rail. */}
        <div className="flex items-center gap-1.5 border-b border-ink/10 p-2">
          {SURFACE_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = surface === item.id;
            const badge = item.id === "board" ? boardBadge : 0;
            return (
              <button
                key={item.id}
                onClick={() => {
                  onSelectSurface(item.id);
                  onClose();
                }}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "relative flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-md transition-colors",
                  isActive
                    ? "bg-accent/[0.08] text-accent"
                    : "text-ink/45 hover:bg-ink/5 hover:text-ink/70",
                ].join(" ")}
              >
                <span className="relative">
                  <Icon size={18} strokeWidth={isActive ? 2 : 1.75} />
                  {badge > 0 && (
                    <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-agent px-1 text-[9px] font-bold text-white">
                      {badge}
                    </span>
                  )}
                </span>
                <span className={`text-[10px] leading-none ${isActive ? "font-semibold" : "font-medium"}`}>
                  {item.label}
                </span>
              </button>
            );
          })}
          <button
            onClick={onClose}
            className="flex h-12 w-10 shrink-0 items-center justify-center rounded-md text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink/70"
            title="Close"
            aria-label="Close navigation"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        {/* Panel switcher — the drawer's secondary row (file tree / settings). */}
        <div className="flex items-center gap-1 border-b border-ink/10 px-2 py-1.5">
          {PANEL_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = view === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectView(item.id)}
                aria-pressed={isActive}
                className={[
                  "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] font-medium transition-colors",
                  isActive
                    ? "bg-accent/[0.08] text-accent"
                    : "text-ink/40 hover:bg-ink/5 hover:text-ink/70",
                ].join(" ")}
              >
                <Icon size={14} strokeWidth={1.75} />
                {item.label}
              </button>
            );
          })}
        </div>

        {/* The selected panel body — reused verbatim from the desktop dock. */}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </aside>

      {/* Local keyframes so the drawer is self-contained (mirrors QuickLog). */}
      <style>{`
        @keyframes drawer-in { from { opacity: 0; transform: translateY(24px) } to { opacity: 1; transform: translateY(0) } }
      `}</style>
    </div>
  );
}
