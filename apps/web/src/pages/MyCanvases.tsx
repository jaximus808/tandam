import { useEffect, useMemo, useState } from "react";
import {
  Search,
  Plus,
  LayoutGrid,
  List as ListIcon,
  ChevronDown,
  Lock,
  Globe,
  X,
  ArrowRight,
} from "lucide-react";
import type { CanvasMeta, CanvasMode } from "../types";
import { listMyCanvases, listSharedWithMe } from "../lib/api";
import { fetchMe, type User } from "../lib/auth";
import { modeTheme } from "../lib/modeTheme";
import TandemLogo from "../components/TandemLogo";
import AccountMenu from "../components/AccountMenu";
import CanvasLauncher from "../components/CanvasLauncher";

interface Props {
  onOpenCanvas: (code: string) => void;
  onHome: () => void;
  onOpenMCP: () => void;
}

type Load =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "error"; message: string }
  | { status: "ready"; canvases: CanvasMeta[]; shared: CanvasMeta[] };

type SortKey = "updated" | "created" | "name" | "mode";
type View = "grid" | "list";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "updated", label: "Last updated" },
  { key: "created", label: "Recently created" },
  { key: "name", label: "Name (A–Z)" },
  { key: "mode", label: "Mode" },
];

const ALL_MODES: CanvasMode[] = ["map", "itinerary", "docs", "roadmap", "sheets", "charts", "welcome"];

const VIEW_KEY = "tandem.dashboard.view";

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(then).toLocaleDateString();
}

function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function sortCanvases(list: CanvasMeta[], key: SortKey): CanvasMeta[] {
  const out = [...list];
  switch (key) {
    case "name":
      out.sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
      break;
    case "created":
      out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      break;
    case "mode":
      out.sort(
        (a, b) =>
          (a.mode || "").localeCompare(b.mode || "") ||
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      );
      break;
    case "updated":
    default:
      out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      break;
  }
  return out;
}

export default function MyCanvases({ onOpenCanvas, onHome, onOpenMCP }: Props) {
  const [user, setUser] = useState<User | null>(null);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  const [modeFilter, setModeFilter] = useState<CanvasMode | "all">("all");
  const [view, setView] = useState<View>(
    () => (localStorage.getItem(VIEW_KEY) as View) || "grid",
  );
  const [launcherOpen, setLauncherOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await fetchMe();
      if (cancelled) return;
      setUser(me);
      if (!me) {
        setLoad({ status: "signedOut" });
        return;
      }
      try {
        // Shared-with-me is best-effort — a failure there shouldn't blank out the
        // owned list, so it defaults to [].
        const [canvases, shared] = await Promise.all([
          listMyCanvases(),
          listSharedWithMe().catch(() => [] as CanvasMeta[]),
        ]);
        if (!cancelled) setLoad({ status: "ready", canvases, shared });
      } catch (e) {
        if (!cancelled) setLoad({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const owned = load.status === "ready" ? load.canvases : [];

  // Which mode chips to offer: only modes that actually appear in the user's
  // canvases, so the filter never lists empty buckets.
  const presentModes = useMemo(() => {
    const set = new Set<CanvasMode>();
    for (const c of owned) set.add((c.mode as CanvasMode) ?? "welcome");
    return ALL_MODES.filter((m) => set.has(m));
  }, [owned]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = owned;
    if (modeFilter !== "all") list = list.filter((c) => (c.mode ?? "welcome") === modeFilter);
    if (q) {
      list = list.filter(
        (c) =>
          (c.name || "").toLowerCase().includes(q) || (c.code || "").toLowerCase().includes(q),
      );
    }
    return sortCanvases(list, sortKey);
  }, [owned, query, modeFilter, sortKey]);

  const firstName = user?.displayName ? user.displayName.split(" ")[0] : null;

  return (
    <div className="flex min-h-screen flex-col bg-paper font-brand text-ink">
      {/* Top chrome — breadcrumb, inbox, account, primary "New canvas" CTA. */}
      <header className="sticky top-0 z-40 flex items-center gap-2 border-b border-ink/10 bg-paper/85 px-4 py-3 backdrop-blur sm:px-6">
        <button onClick={onHome} className="group flex items-center gap-1.5" title="Back to home">
          <TandemLogo size={22} animate={false} />
          <span className="hidden font-semibold tracking-tight transition-colors group-hover:text-sky-600 sm:inline">
            Tandem
          </span>
        </button>
        <span className="text-ink/20">/</span>
        <span className="font-display text-[15px] font-medium">Dashboard</span>
        <div className="ml-auto flex items-center gap-2">
          {load.status === "ready" && (
            <button
              onClick={() => setLauncherOpen(true)}
              className="btn-press inline-flex items-center gap-1.5 rounded-md bg-ink px-3.5 py-1.5 text-sm font-medium text-paper shadow-[2px_2px_0_#C75B39]"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New canvas</span>
            </button>
          )}
          <AccountMenu onUserChange={setUser} onOpenCanvas={onOpenCanvas} />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {load.status === "loading" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-28 animate-pulse rounded-2xl border border-ink/10 bg-white/60"
              />
            ))}
          </div>
        )}

        {load.status === "signedOut" && (
          <div className="mx-auto max-w-md rounded-2xl border border-ink/10 bg-white px-8 py-10 text-center">
            <p className="font-display text-lg font-medium">Sign in to see your canvases</p>
            <p className="mt-1.5 text-sm text-ink/55">
              Canvases you create while signed in are saved to your account and show up here on every
              device.
            </p>
            <button
              onClick={onHome}
              className="mt-5 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper hover:opacity-90"
            >
              Back to home
            </button>
          </div>
        )}

        {load.status === "error" && <p className="text-sm text-red-600">{load.message}</p>}

        {load.status === "ready" && (
          <>
            {/* Title + count */}
            <div className="mb-6">
              <h1 className="font-display text-2xl font-medium tracking-tight">
                {firstName ? `${firstName}'s canvases` : "Your canvases"}
              </h1>
              <p className="mt-1 text-sm text-ink/55">
                {owned.length} {owned.length === 1 ? "canvas" : "canvases"} saved to your account
              </p>
            </div>

            {owned.length === 0 ? (
              <EmptyState onCreate={() => setLauncherOpen(true)} />
            ) : (
              <>
                <Toolbar
                  query={query}
                  onQuery={setQuery}
                  sortKey={sortKey}
                  onSort={setSortKey}
                  modeFilter={modeFilter}
                  onModeFilter={setModeFilter}
                  presentModes={presentModes}
                  view={view}
                  onView={setView}
                />

                {visible.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-ink/20 bg-white/60 px-8 py-12 text-center">
                    <p className="font-display text-base font-medium">No canvases match</p>
                    <p className="mt-1 text-sm text-ink/55">Try a different search or filter.</p>
                    <button
                      onClick={() => {
                        setQuery("");
                        setModeFilter("all");
                      }}
                      className="mt-4 rounded-lg border border-ink/20 px-3 py-1.5 text-sm font-medium text-ink/70 hover:bg-white"
                    >
                      Clear filters
                    </button>
                  </div>
                ) : view === "grid" ? (
                  <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {visible.map((c) => (
                      <CanvasCard key={c.id} c={c} onOpen={onOpenCanvas} />
                    ))}
                  </ul>
                ) : (
                  <CanvasTable canvases={visible} onOpen={onOpenCanvas} />
                )}
              </>
            )}

            {/* Shared with you — canvases other owners granted you access to. */}
            {load.shared.length > 0 && (
              <section className="mt-12">
                <h2 className="font-display text-lg font-medium tracking-tight">Shared with you</h2>
                <p className="mt-1 text-sm text-ink/55">
                  {load.shared.length} {load.shared.length === 1 ? "canvas" : "canvases"} others gave
                  you access to
                </p>
                <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {sortCanvases(load.shared, "updated").map((c) => (
                    <CanvasCard key={c.id} c={c} onOpen={onOpenCanvas} role={c.yourRole} />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>

      {launcherOpen && (
        <CanvasLauncher
          initialMode="create"
          onJoin={onOpenCanvas}
          onClose={() => setLauncherOpen(false)}
          onOpenMCP={onOpenMCP}
        />
      )}
    </div>
  );
}

/* ── toolbar: search + mode filter + sort + view toggle ─────────────────────── */

function Toolbar({
  query,
  onQuery,
  sortKey,
  onSort,
  modeFilter,
  onModeFilter,
  presentModes,
  view,
  onView,
}: {
  query: string;
  onQuery: (v: string) => void;
  sortKey: SortKey;
  onSort: (k: SortKey) => void;
  modeFilter: CanvasMode | "all";
  onModeFilter: (m: CanvasMode | "all") => void;
  presentModes: CanvasMode[];
  view: View;
  onView: (v: View) => void;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
      {/* search */}
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/35" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search by name or code…"
          className="w-full rounded-lg border border-ink/15 bg-white py-2 pl-9 pr-8 text-sm placeholder:text-ink/35 focus:border-ink/40 focus:outline-none focus:ring-1 focus:ring-ink/20"
        />
        {query && (
          <button
            onClick={() => onQuery("")}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink/35 hover:text-ink/70"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* mode filter */}
        <Select
          value={modeFilter}
          onChange={(v) => onModeFilter(v as CanvasMode | "all")}
          options={[
            { value: "all", label: "All modes" },
            ...presentModes.map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) })),
          ]}
        />
        {/* sort */}
        <Select
          value={sortKey}
          onChange={(v) => onSort(v as SortKey)}
          options={SORTS.map((s) => ({ value: s.key, label: s.label }))}
        />
        {/* view toggle */}
        <div className="flex shrink-0 overflow-hidden rounded-lg border border-ink/15 bg-white">
          <button
            onClick={() => onView("grid")}
            aria-label="Grid view"
            aria-pressed={view === "grid"}
            className={`flex h-[38px] w-9 items-center justify-center transition-colors ${
              view === "grid" ? "bg-ink text-paper" : "text-ink/45 hover:bg-ink/5"
            }`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => onView("list")}
            aria-label="List view"
            aria-pressed={view === "list"}
            className={`flex h-[38px] w-9 items-center justify-center border-l border-ink/15 transition-colors ${
              view === "list" ? "bg-ink text-paper" : "text-ink/45 hover:bg-ink/5"
            }`}
          >
            <ListIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** A styled native select — reliable, keyboard-friendly, matches the toolbar. */
function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="relative shrink-0">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-[38px] cursor-pointer appearance-none rounded-lg border border-ink/15 bg-white py-2 pl-3 pr-8 text-sm font-medium text-ink/70 focus:border-ink/40 focus:outline-none focus:ring-1 focus:ring-ink/20"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/35" />
    </div>
  );
}

/* ── empty state ────────────────────────────────────────────────────────────── */

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-ink/20 bg-white/60 px-8 py-14 text-center">
      <p className="font-display text-lg font-medium">No canvases yet</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-ink/55">
        Create a canvas while signed in and it’ll live here. Already have an anonymous canvas? Open it
        and hit <span className="font-medium">Copy to my account</span>.
      </p>
      <button
        onClick={onCreate}
        className="btn-press mt-5 inline-flex items-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper shadow-[2px_2px_0_#C75B39]"
      >
        <Plus className="h-4 w-4" />
        Create a canvas
      </button>
    </div>
  );
}

/* ── visibility chip ────────────────────────────────────────────────────────── */

function VisibilityBadge({ c }: { c: CanvasMeta }) {
  const isPrivate = c.visibility === "private";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-ink/10 bg-ink/[0.03] px-1.5 py-0.5 text-[10px] font-medium text-ink/45"
      title={isPrivate ? "Private — only people you invite can open this" : "Public — anyone with the code can open this"}
    >
      {isPrivate ? <Lock className="h-2.5 w-2.5" /> : <Globe className="h-2.5 w-2.5" />}
      {isPrivate ? "Private" : "Public"}
    </span>
  );
}

/* ── grid card ──────────────────────────────────────────────────────────────── */

// CanvasCard renders one canvas tile. For a shared canvas, pass `role` to badge
// the access level (View/Edit) instead of the mode.
function CanvasCard({
  c,
  onOpen,
  role,
}: {
  c: CanvasMeta;
  onOpen: (code: string) => void;
  role?: "read" | "write" | "none";
}) {
  const t = modeTheme((c.mode as never) ?? "welcome");
  return (
    <li>
      <button
        onClick={() => onOpen(c.code)}
        className="group relative block w-full overflow-hidden rounded-2xl border border-ink/10 bg-white p-4 text-left transition-all hover:-translate-y-0.5 hover:border-ink/20 hover:shadow-md"
      >
        <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: t.solid }} />
        <div className="flex items-start justify-between gap-3">
          <span className="font-display text-base font-medium leading-snug text-ink">
            {c.name || "Untitled canvas"}
          </span>
          {role ? (
            <span className="shrink-0 rounded-full border border-ink/15 bg-ink/[0.03] px-2 py-0.5 text-[11px] font-medium text-ink/50">
              {role === "write" ? "Edit" : "View"}
            </span>
          ) : (
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize"
              style={{ backgroundColor: t.soft, color: t.solid }}
            >
              {c.mode}
            </span>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-ink/40">
          <span className="font-code tracking-[0.15em]">{c.code}</span>
          <div className="flex items-center gap-2">
            {!role && <VisibilityBadge c={c} />}
            <span>{timeAgo(c.updatedAt)}</span>
          </div>
        </div>
      </button>
    </li>
  );
}

/* ── list / table view ──────────────────────────────────────────────────────── */

function CanvasTable({
  canvases,
  onOpen,
}: {
  canvases: CanvasMeta[];
  onOpen: (code: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-ink/10 bg-white">
      {/* header row (desktop only) */}
      <div className="hidden grid-cols-[1fr_7rem_6rem_8rem_6rem] gap-3 border-b border-ink/10 bg-paper px-4 py-2.5 font-code text-[10px] font-medium uppercase tracking-[0.14em] text-ink/40 sm:grid">
        <span>Name</span>
        <span>Mode</span>
        <span>Access</span>
        <span>Created</span>
        <span className="text-right">Updated</span>
      </div>
      <ul>
        {canvases.map((c, i) => {
          const t = modeTheme((c.mode as never) ?? "welcome");
          return (
            <li key={c.id}>
              <button
                onClick={() => onOpen(c.code)}
                className={`grid w-full grid-cols-1 gap-1 px-4 py-3 text-left transition-colors hover:bg-paper sm:grid-cols-[1fr_7rem_6rem_8rem_6rem] sm:items-center sm:gap-3 ${
                  i > 0 ? "border-t border-ink/[0.07]" : ""
                }`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    aria-hidden
                    className="h-6 w-1 shrink-0 rounded-full"
                    style={{ backgroundColor: t.solid }}
                  />
                  <div className="min-w-0">
                    <div className="truncate font-medium text-ink">{c.name || "Untitled canvas"}</div>
                    <div className="font-code text-[11px] tracking-[0.14em] text-ink/35">{c.code}</div>
                  </div>
                </div>
                <span className="hidden sm:block">
                  <span
                    className="rounded-full px-2 py-0.5 text-[11px] font-medium capitalize"
                    style={{ backgroundColor: t.soft, color: t.solid }}
                  >
                    {c.mode}
                  </span>
                </span>
                <span className="hidden sm:block">
                  <VisibilityBadge c={c} />
                </span>
                <span className="hidden text-xs text-ink/45 sm:block">{shortDate(c.createdAt)}</span>
                <span className="hidden text-right text-xs text-ink/45 sm:block">
                  {timeAgo(c.updatedAt)}
                </span>
                {/* mobile meta line */}
                <div className="flex items-center gap-2 text-xs text-ink/40 sm:hidden">
                  <span className="capitalize" style={{ color: t.solid }}>
                    {c.mode}
                  </span>
                  <span>·</span>
                  <span>{timeAgo(c.updatedAt)}</span>
                  <ArrowRight className="ml-auto h-3.5 w-3.5 text-ink/25" />
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
