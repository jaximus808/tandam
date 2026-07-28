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
  MoreVertical,
  Trash2,
} from "lucide-react";
import type { CanvasMeta, CanvasMode } from "../types";
import { listMyCanvases, listSharedWithMe, deleteCanvas } from "../lib/api";
import { fetchMe, getCachedUser, type User } from "../lib/auth";
import TandemLogo from "../components/TandemLogo";
import AccountMenu from "../components/AccountMenu";
import CanvasLauncher from "../components/CanvasLauncher";
import DeleteCanvasModal from "../components/DeleteCanvasModal";

interface Props {
  onOpenCanvas: (code: string) => void;
  onHome: () => void;
  onOpenMCP: () => void;
  onShowSettings: () => void;
  onShowAbout: () => void;
}

type Load =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "error"; message: string }
  | { status: "ready"; canvases: CanvasMeta[]; shared: CanvasMeta[] };

type SortKey = "updated" | "created" | "name";
type View = "grid" | "list";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "updated", label: "Last updated" },
  { key: "created", label: "Recently created" },
  { key: "name", label: "Name (A–Z)" },
];

const ALL_MODES: CanvasMode[] = ["map", "itinerary", "docs", "roadmap", "sheets", "charts", "welcome"];

// What a canvas actually *contains*, in canonical order — not `c.mode`, which is
// only whichever view was open last and changes as you click around. A canvas
// with nothing enabled yet has no content to describe, so it falls back to its
// active mode (i.e. "welcome" for a fresh one).
function modesOf(c: CanvasMeta): CanvasMode[] {
  const enabled = c.enabledModes ?? [];
  if (enabled.length === 0) return [(c.mode as CanvasMode) ?? "welcome"];
  return ALL_MODES.filter((m) => enabled.includes(m));
}

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
    case "updated":
    default:
      out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      break;
  }
  return out;
}

export default function MyCanvases({ onOpenCanvas, onHome, onOpenMCP, onShowSettings, onShowAbout }: Props) {
  const [user, setUser] = useState<User | null>(getCachedUser);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  const [modeFilter, setModeFilter] = useState<CanvasMode | "all">("all");
  const [view, setView] = useState<View>(
    () => (localStorage.getItem(VIEW_KEY) as View) || "grid",
  );
  const [launcherOpen, setLauncherOpen] = useState(false);
  // The canvas queued for deletion (drives the confirm modal), plus in-flight +
  // error state for the destructive call.
  const [pendingDelete, setPendingDelete] = useState<CanvasMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  // Permanently delete the queued canvas, then drop it from the list. Only
  // reachable for owned canvases (the menu is rendered on owned cards/rows only,
  // and the API is owner-only), so this never touches shared canvases.
  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteCanvas(target.code);
      setLoad((prev) =>
        prev.status === "ready"
          ? { ...prev, canvases: prev.canvases.filter((c) => c.id !== target.id) }
          : prev,
      );
      setPendingDelete(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

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
    for (const c of owned) for (const m of modesOf(c)) set.add(m);
    return ALL_MODES.filter((m) => set.has(m));
  }, [owned]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = owned;
    // Membership, not equality: a canvas with sheets matches "Sheets" even if it
    // was last left on the docs tab.
    if (modeFilter !== "all") list = list.filter((c) => modesOf(c).includes(modeFilter));
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
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      {/* Top chrome — breadcrumb, inbox, account, primary "New canvas" CTA. */}
      <header className="sticky top-0 z-40 flex items-center gap-2 border-b border-ink/10 bg-paper px-4 py-3 sm:px-6">
        <button onClick={onHome} className="group flex items-center gap-1.5" title="Back to home">
          <TandemLogo size={28} animate={false} />
          <span className="hidden font-semibold tracking-tight transition-colors group-hover:text-accent sm:inline">
            Tandem
          </span>
        </button>
        <span className="text-ink/20">/</span>
        <span className="text-[15px] font-medium">Dashboard</span>
        <div className="ml-auto flex items-center gap-2">
          {load.status === "ready" && (
            <button
              onClick={() => setLauncherOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New canvas</span>
            </button>
          )}
          <AccountMenu onShowSettings={onShowSettings} onShowAbout={onShowAbout} onUserChange={setUser} onOpenCanvas={onOpenCanvas} />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {load.status === "loading" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-28 animate-pulse rounded-lg border border-ink/10 bg-surface/60"
              />
            ))}
          </div>
        )}

        {load.status === "signedOut" && (
          <div className="mx-auto max-w-md rounded-lg border border-ink/10 bg-surface px-8 py-10 text-center">
            <p className="text-lg font-semibold tracking-tight">Sign in to see your canvases</p>
            <p className="mt-1.5 text-sm text-ink/55">
              Canvases you create while signed in are saved to your account and show up here on every
              device.
            </p>
            <button
              onClick={onHome}
              className="mt-5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Back to home
            </button>
          </div>
        )}

        {load.status === "error" && (
          <p className="text-sm text-rose-600 dark:text-rose-400">{load.message}</p>
        )}

        {load.status === "ready" && (
          <>
            {/* Title + count */}
            <div className="mb-6">
              <h1 className="text-2xl font-semibold tracking-tight">
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
                  <div className="rounded-lg border border-dashed border-ink/20 bg-surface/60 px-8 py-12 text-center">
                    <p className="text-base font-semibold tracking-tight">No canvases match</p>
                    <p className="mt-1 text-sm text-ink/55">Try a different search or filter.</p>
                    <button
                      onClick={() => {
                        setQuery("");
                        setModeFilter("all");
                      }}
                      className="mt-4 rounded-md border border-ink/15 bg-surface px-3 py-1.5 text-sm font-medium text-ink/70 hover:bg-ink/5"
                    >
                      Clear filters
                    </button>
                  </div>
                ) : view === "grid" ? (
                  <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {visible.map((c) => (
                      <CanvasCard key={c.id} c={c} onOpen={onOpenCanvas} onDelete={setPendingDelete} />
                    ))}
                  </ul>
                ) : (
                  <CanvasTable canvases={visible} onOpen={onOpenCanvas} onDelete={setPendingDelete} />
                )}
              </>
            )}

            {/* Shared with you — canvases other owners granted you access to. */}
            {load.shared.length > 0 && (
              <section className="mt-12">
                <h2 className="text-lg font-semibold tracking-tight">Shared with you</h2>
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

      {pendingDelete && (
        <DeleteCanvasModal
          canvas={pendingDelete}
          deleting={deleting}
          error={deleteError}
          onCancel={() => {
            if (deleting) return;
            setPendingDelete(null);
            setDeleteError(null);
          }}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

/* ── per-canvas options menu (owned canvases only) ──────────────────────────── */

// A small kebab menu rendered on owned canvas cards/rows. Sits above the card's
// stretched open-button (z-10) so its clicks don't fall through to "open"; a
// full-screen backdrop closes it on an outside click. Delete is the only action
// today, but the menu leaves room for more (rename, share…).
function CanvasMenu({ onDelete, label }: { onDelete: () => void; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pointer-events-auto relative z-10">
      <button
        aria-label={`Options for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`flex h-7 w-7 items-center justify-center rounded-md text-ink/40 transition-colors hover:bg-ink/10 hover:text-ink focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-ink/20 ${
          open ? "bg-ink/10 opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        }`}
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <>
          <button
            aria-hidden
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-ink/10 bg-surface py-1 shadow-lg"
          >
            <button
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onDelete();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-rose-600 transition-colors hover:bg-rose-500/10 dark:text-rose-400"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </button>
          </div>
        </>
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
          className="w-full rounded-md border border-ink/15 bg-surface py-2 pl-9 pr-8 text-sm placeholder:text-ink/35 focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20"
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
        <div className="flex shrink-0 overflow-hidden rounded-md border border-ink/15 bg-surface">
          <button
            onClick={() => onView("grid")}
            aria-label="Grid view"
            aria-pressed={view === "grid"}
            className={`flex h-[38px] w-9 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
              view === "grid" ? "bg-accent text-white" : "text-ink/45 hover:bg-ink/5"
            }`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => onView("list")}
            aria-label="List view"
            aria-pressed={view === "list"}
            className={`flex h-[38px] w-9 items-center justify-center border-l border-ink/15 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
              view === "list" ? "bg-accent text-white" : "text-ink/45 hover:bg-ink/5"
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
        className="h-[38px] cursor-pointer appearance-none rounded-md border border-ink/15 bg-surface py-2 pl-3 pr-8 text-sm font-medium text-ink/70 focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20"
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
    <div className="rounded-lg border border-dashed border-ink/20 bg-surface/60 px-8 py-14 text-center">
      <p className="text-lg font-semibold tracking-tight">No canvases yet</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-ink/55">
        Create a canvas while signed in and it’ll live here. Already have an anonymous canvas? Open it
        and hit <span className="font-medium">Copy to my account</span>.
      </p>
      <button
        onClick={onCreate}
        className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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

/* ── mode chips ─────────────────────────────────────────────────────────────── */

// The modes a canvas has enabled, as quiet neutral chips (Design v2: no per-mode
// rainbow accents in chrome). Caps at `max` chips and rolls the rest into a "+N"
// so a canvas using every mode can't blow out the card.
function ModeBadges({ modes, max = 2 }: { modes: CanvasMode[]; max?: number }) {
  const shown = modes.slice(0, max);
  const rest = modes.length - shown.length;
  return (
    <span className="flex items-center gap-1">
      {shown.map((m) => (
        <span
          key={m}
          className="rounded-full bg-ink/5 px-2 py-0.5 text-[11px] font-medium capitalize text-ink/60"
        >
          {m}
        </span>
      ))}
      {rest > 0 && (
        <span
          className="rounded-full border border-ink/15 bg-ink/10 px-1.5 py-0.5 text-[10px] font-medium text-ink/70"
          title={modes.join(", ")}
        >
          +{rest}
        </span>
      )}
    </span>
  );
}

/* ── grid card ──────────────────────────────────────────────────────────────── */

// CanvasCard renders one canvas tile. For a shared canvas, pass `role` to badge
// the access level (View/Edit) instead of the mode. Pass `onDelete` (owned
// canvases only) to surface the options menu with a destructive delete.
//
// The whole tile opens the canvas via a stretched overlay button (absolute
// inset-0) so the options menu can be a real sibling — no nested <button> — that
// sits above it (z-10) and catches its own clicks.
function CanvasCard({
  c,
  onOpen,
  role,
  onDelete,
}: {
  c: CanvasMeta;
  onOpen: (code: string) => void;
  role?: "read" | "write" | "none";
  onDelete?: (c: CanvasMeta) => void;
}) {
  const modes = modesOf(c);
  return (
    <li className="group relative overflow-hidden rounded-lg border border-ink/10 bg-surface transition-all hover:border-ink/20 hover:shadow-sm">
      {/* Stretched click target — transparent, covers the whole tile. */}
      <button
        onClick={() => onOpen(c.code)}
        aria-label={`Open ${c.name || "canvas"}`}
        className="absolute inset-0"
      />
      {/* Content sits above the stretched button (same stacking level, later in
          DOM), so it must not eat its clicks — the options menu opts back in. */}
      <div className="pointer-events-none relative p-4">
        <div className="flex items-start justify-between gap-3">
          <span className="text-base font-semibold leading-snug tracking-tight text-ink">
            {c.name || "Untitled canvas"}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {role ? (
              <span className="rounded-full border border-ink/15 bg-ink/[0.03] px-2 py-0.5 text-[11px] font-medium text-ink/50">
                {role === "write" ? "Edit" : "View"}
              </span>
            ) : (
              <ModeBadges modes={modes} />
            )}
            {onDelete && <CanvasMenu label={c.name || "canvas"} onDelete={() => onDelete(c)} />}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-ink/40">
          <span className="font-code">{c.code}</span>
          <div className="flex items-center gap-2">
            {!role && <VisibilityBadge c={c} />}
            <span>{timeAgo(c.updatedAt)}</span>
          </div>
        </div>
      </div>
    </li>
  );
}

/* ── list / table view ──────────────────────────────────────────────────────── */

function CanvasTable({
  canvases,
  onOpen,
  onDelete,
}: {
  canvases: CanvasMeta[];
  onOpen: (code: string) => void;
  onDelete?: (c: CanvasMeta) => void;
}) {
  // The modes column is wide enough for two chips + a "+N" overflow.
  const cols = "sm:grid-cols-[1fr_10rem_6rem_8rem_6rem_2.5rem]";
  return (
    <div className="overflow-hidden rounded-lg border border-ink/10 bg-surface">
      {/* header row (desktop only) */}
      <div
        className={`hidden gap-3 border-b border-ink/10 bg-paper px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-ink/50 sm:grid ${cols}`}
      >
        <span>Name</span>
        <span>Modes</span>
        <span>Access</span>
        <span>Created</span>
        <span className="text-right">Updated</span>
        <span aria-hidden />
      </div>
      <ul>
        {canvases.map((c, i) => {
          const modes = modesOf(c);
          return (
            <li
              key={c.id}
              className={`group relative transition-colors hover:bg-paper ${
                i > 0 ? "border-t border-ink/[0.07]" : ""
              }`}
            >
              {/* Stretched click target so the options menu can sit above it. */}
              <button
                onClick={() => onOpen(c.code)}
                aria-label={`Open ${c.name || "canvas"}`}
                className="absolute inset-0"
              />
              <div
                className={`pointer-events-none relative grid grid-cols-1 gap-1 px-4 py-3 sm:items-center sm:gap-3 ${cols}`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-ink">{c.name || "Untitled canvas"}</div>
                    <div className="font-code text-[11px] text-ink/35">{c.code}</div>
                  </div>
                </div>
                <span className="hidden sm:block">
                  <ModeBadges modes={modes} />
                </span>
                <span className="hidden sm:block">
                  <VisibilityBadge c={c} />
                </span>
                <span className="hidden text-xs text-ink/45 sm:block">{shortDate(c.createdAt)}</span>
                <span className="hidden text-right text-xs text-ink/45 sm:block">
                  {timeAgo(c.updatedAt)}
                </span>
                {/* options menu (owned canvases) — trailing column on desktop */}
                <div className="hidden justify-end sm:flex">
                  {onDelete && <CanvasMenu label={c.name || "canvas"} onDelete={() => onDelete(c)} />}
                </div>
                {/* mobile meta line */}
                <div className="flex items-center gap-2 text-xs text-ink/40 sm:hidden">
                  <ModeBadges modes={modes} />
                  <span>·</span>
                  <span>{timeAgo(c.updatedAt)}</span>
                  {onDelete ? (
                    <div className="ml-auto">
                      <CanvasMenu label={c.name || "canvas"} onDelete={() => onDelete(c)} />
                    </div>
                  ) : (
                    <ArrowRight className="ml-auto h-3.5 w-3.5 text-ink/25" />
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
