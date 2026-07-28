import type { SidebarView } from "../lib/sidebar";
import { SIDEBAR_ITEMS } from "../lib/sidebar";

/* ─────────────────────────────────────────────────────────────────────────────
   ActivityBar — the far-left icon rail (VS Code style).

   One icon per registered view (lib/sidebar). Clicking one opens its panel in
   the shared side dock; clicking the active one collapses it. The active view
   gets a left accent bar + full-strength icon. Desktop-only, like the panels it
   drives. This is a dumb, presentational holder — App owns which view is open.
   ──────────────────────────────────────────────────────────────────────────── */

export default function ActivityBar({
  active,
  onSelect,
  badges,
}: {
  active: SidebarView | null;
  onSelect: (view: SidebarView) => void;
  /** Per-view count badges (e.g. tasks awaiting approval). */
  badges?: Partial<Record<SidebarView, number>>;
}) {
  const top = SIDEBAR_ITEMS.filter((i) => i.slot === "top");
  const bottom = SIDEBAR_ITEMS.filter((i) => i.slot === "bottom");

  const renderItem = (item: (typeof SIDEBAR_ITEMS)[number]) => {
    const Icon = item.icon;
    const isActive = active === item.id;
    const badge = badges?.[item.id] ?? 0;
    return (
      <div key={item.id} className="relative flex justify-center">
        {isActive && (
          <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r bg-accent" />
        )}
        <button
          onClick={() => onSelect(item.id)}
          className={[
            "relative flex h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
            isActive ? "bg-accent/[0.08] text-accent" : "text-ink/40 hover:bg-ink/5 hover:text-ink/70",
          ].join(" ")}
          title={item.label}
          aria-label={item.label}
          aria-pressed={isActive}
        >
          <Icon size={20} strokeWidth={1.75} />
          {badge > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-agent px-1 text-[9px] font-bold text-white">
              {badge}
            </span>
          )}
        </button>
      </div>
    );
  };

  return (
    <div className="z-20 hidden w-12 shrink-0 flex-col items-stretch border-r border-ink/10 bg-paper py-2 sm:flex">
      <div className="flex flex-col gap-0.5">{top.map(renderItem)}</div>
      <div className="mt-auto flex flex-col gap-0.5">{bottom.map(renderItem)}</div>
    </div>
  );
}
