import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  GitCommitHorizontal,
  Layers,
  Link2,
  Pencil,
  RotateCcw,
  Search,
  User,
  X,
  Zap,
} from "lucide-react";
import type { Action, ActionState, CanvasState, EpicPayload, TaskPayload } from "../types";
import {
  approveAction,
  rejectAction,
  releaseTask,
  requeueTask,
  updateTask,
} from "../lib/api";
import posthog from "../lib/posthog";

/* ─────────────────────────────────────────────────────────────────────────────
   TaskBoard — the full-page task surface, opened from the pinned "Board" tab.

   Two projections of the same Action rows (type "task" / "epic"):
     · By state — a kanban: Proposed / Ready / Working / Done / Failed+Rejected.
     · By epic  — swimlanes per epic with an n/m-done progress bar (the "watch
       the project move forward" view), epicless tasks in a final lane.

   A compact filter bar (search + state / epic / claimant / assignee / commit
   chips, AND-composed) sits over both projections, so the Done/Failed history
   is genuinely browsable. "/" focuses search; Escape closes the detail panel,
   then clears filters. Nothing about filters is persisted.

   Everything renders from the same version-gated canvas-state props as every
   other view, so claims/completions move cards live over WS — no polling, no
   local task cache. Mutations are the existing REST calls; fresh state comes
   back over the broadcast like everywhere else.

   Card click opens the full TaskDetail side panel (wave 2): complete body,
   linked context, result with commit chips, provenance, and the step-in
   controls per state — edit/approve/reject (proposed), release (executing),
   re-queue (failed). Destructive actions confirm inline (two-step).
   ──────────────────────────────────────────────────────────────────────────── */

const STATE_CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  proposed:  { label: "Proposed",  bg: "#F59E0B1A", fg: "#B45309" },
  approved:  { label: "Ready",     bg: "#0EA5E91A", fg: "#0369A1" },
  executing: { label: "Working",   bg: "#8B5CF61A", fg: "#6D28D9" },
  done:      { label: "Done",      bg: "#10B9811A", fg: "#047857" },
  failed:    { label: "Failed",    bg: "#F43F5E1A", fg: "#BE123C" },
  rejected:  { label: "Rejected",  bg: "#1111110D", fg: "#57534E" },
};

// Kanban columns. `dot` is the header accent; Failed + Rejected share the
// terminal "closed" column so dead work doesn't take two lanes.
const COLUMNS: { key: string; label: string; states: ActionState[]; dot: string }[] = [
  { key: "proposed", label: "Proposed", states: ["proposed"], dot: "#F59E0B" },
  { key: "ready",    label: "Ready",    states: ["approved"], dot: "#0EA5E9" },
  { key: "working",  label: "Working",  states: ["executing"], dot: "#8B5CF6" },
  { key: "done",     label: "Done",     states: ["done"], dot: "#10B981" },
  { key: "closed",   label: "Failed / Rejected", states: ["failed", "rejected"], dot: "#F43F5E" },
];

// Which board projection is showing — a viewer preference, remembered globally.
const VIEW_KEY = "tandem.board.view";
type BoardView = "state" | "epic";

function taskPayload(a: Action): TaskPayload {
  return (a.payload ?? {}) as TaskPayload;
}

function epicPayload(a: Action): EpicPayload {
  return (a.payload ?? {}) as EpicPayload;
}

// ── Commit-hash detection ─────────────────────────────────────────────────────
// A "commit" is a 7-40 char hex word in the result text that contains at least
// one digit AND one a-f letter — the heuristic keeps plain numbers (ports,
// timestamps) and ordinary words out while catching every realistic git SHA.
const COMMIT_RE = /\b[0-9a-fA-F]{7,40}\b/g;

export function extractCommits(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.match(COMMIT_RE) ?? []) {
    if (/[0-9]/.test(m) && /[a-fA-F]/.test(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

// Compact relative age ("now", "5m", "2h", "3d", "2w", "4mo"). Renders from
// props only — it refreshes on state pushes, which is exactly as live as the
// rest of the board (no timers, no polling).
function ageOf(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.floor(d / 7)}w`;
  return `${Math.floor(d / 30)}mo`;
}

function fullDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function StateChip({ state, className = "" }: { state: string; className?: string }) {
  const chip = STATE_CHIP[state] ?? STATE_CHIP.proposed;
  return (
    <span
      className={`shrink-0 rounded-[4px] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em] ${className}`}
      style={{ backgroundColor: chip.bg, color: chip.fg }}
    >
      {chip.label}
    </span>
  );
}

// The one claimant treatment everywhere: who's executing, in working-violet.
function ClaimantChip({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 text-[11px] font-medium text-violet-600 dark:text-violet-400 ${className}`}
      title={`Being worked on by ${name}`}
    >
      <Zap size={11} className="shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

// Approve / Reject pair for a proposed task or epic. Reject is two-step (the
// confirm replaces the pair) — no reason field here; the sidebar keeps the
// full reject-with-reason form. stopPropagation so the card click-through to
// the detail panel doesn't fire.
function ApproveRejectControls({
  busy,
  rejecting,
  approveLabel = "Approve",
  onApprove,
  onReject,
  setRejecting,
}: {
  busy: boolean;
  rejecting: boolean;
  approveLabel?: string;
  onApprove: () => void;
  onReject: () => void;
  setRejecting: (v: boolean) => void;
}) {
  return (
    <div className="mt-2 flex gap-1.5" onClick={(e) => e.stopPropagation()}>
      {rejecting ? (
        <>
          <button
            onClick={onReject}
            disabled={busy}
            className="flex-1 rounded-lg bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white transition-opacity disabled:opacity-40"
          >
            Confirm reject
          </button>
          <button
            onClick={() => setRejecting(false)}
            className="rounded-lg border border-ink/15 px-2 py-1 text-[11px] font-medium text-ink/60 transition-colors hover:border-ink/30"
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            onClick={onApprove}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-ink px-2 py-1 text-[11px] font-semibold text-paper transition-opacity disabled:opacity-40"
          >
            <Check size={12} /> {approveLabel}
          </button>
          <button
            onClick={() => setRejecting(true)}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-ink/15 px-2 py-1 text-[11px] font-medium text-ink/60 transition-colors hover:border-ink/30 disabled:opacity-40"
          >
            <X size={12} /> Reject
          </button>
        </>
      )}
    </div>
  );
}

// ── Filters ──────────────────────────────────────────────────────────────────

type Filters = {
  state: "all" | ActionState;
  epic: "all" | "none" | string; // "none" = epicless, otherwise an epic id
  claimant: "all" | string;
  assignee: "all" | "agent" | "human";
  hasCommit: boolean;
};

const NO_FILTERS: Filters = {
  state: "all",
  epic: "all",
  claimant: "all",
  assignee: "all",
  hasCommit: false,
};

const FILTER_SELECT_CLS =
  "h-7 max-w-[10rem] shrink-0 rounded-lg border border-ink/15 bg-surface px-1.5 text-[11px] font-medium text-ink/70 outline-none transition-colors focus:border-ink/40";

export default function TaskBoard({
  code,
  state,
  readOnly,
}: {
  code: string;
  state: CanvasState;
  readOnly: boolean;
}) {
  const [view, setView] = useState<BoardView>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "epic" ? "epic" : "state";
    } catch {
      return "state";
    }
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filter state — deliberately not persisted; every visit starts unfiltered.
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState(""); // debounced, lowercased
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(searchInput.trim().toLowerCase()), 150);
    return () => clearTimeout(t);
  }, [searchInput]);

  const filtering =
    query !== "" ||
    filters.state !== "all" ||
    filters.epic !== "all" ||
    filters.claimant !== "all" ||
    filters.assignee !== "all" ||
    filters.hasCommit;

  function clearFilters() {
    setSearchInput("");
    setQuery("");
    setFilters(NO_FILTERS);
  }

  function switchView(v: BoardView) {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* preference only */
    }
  }

  const tasks = useMemo(
    () =>
      Object.values(state.actions ?? {})
        .filter((a) => a.type === "task")
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [state.actions],
  );
  const epics = useMemo(
    () =>
      Object.values(state.actions ?? {})
        .filter((a) => a.type === "epic")
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [state.actions],
  );
  const epicIds = useMemo(() => new Set(epics.map((e) => e.id)), [epics]);
  const epicTitleById = useMemo(
    () => new Map(epics.map((e) => [e.id, epicPayload(e).title || "Untitled epic"])),
    [epics],
  );
  // Everyone who has ever held a claim — done/failed rows keep claimed_by, so
  // this doubles as the "browse one agent's history" axis.
  const claimants = useMemo(() => {
    const s = new Set<string>();
    for (const t of tasks) if (t.claimedBy) s.add(t.claimedBy);
    return [...s].sort();
  }, [tasks]);

  // One predicate, AND-composed — the same filter feeds both projections.
  function taskMatches(t: Action): boolean {
    const p = taskPayload(t);
    if (query) {
      const hay = `${p.title ?? ""}\n${p.body ?? ""}\n${t.result ?? ""}\n${t.ticketId ?? ""}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    if (filters.state !== "all" && t.state !== filters.state) return false;
    if (filters.epic === "none") {
      if (p.epicId && epicIds.has(p.epicId)) return false;
    } else if (filters.epic !== "all" && p.epicId !== filters.epic) {
      return false;
    }
    if (filters.claimant !== "all" && t.claimedBy !== filters.claimant) return false;
    if (filters.assignee !== "all" && (p.assignee ?? "agent") !== filters.assignee) return false;
    if (filters.hasCommit && extractCommits(t.result).length === 0) return false;
    return true;
  }

  const visibleTasks = useMemo(
    () => (filtering ? tasks.filter(taskMatches) : tasks),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, filtering, query, filters, epicIds],
  );

  const tasksByEpic = useMemo(() => {
    const m = new Map<string, Action[]>();
    for (const t of visibleTasks) {
      const eid = taskPayload(t).epicId;
      if (eid && epicIds.has(eid)) m.set(eid, [...(m.get(eid) ?? []), t]);
    }
    return m;
  }, [visibleTasks, epicIds]);
  // No epic, or a dangling epicId — these flow into the final "No epic" lane.
  const epicless = useMemo(
    () =>
      visibleTasks.filter((t) => {
        const eid = taskPayload(t).epicId;
        return !eid || !epicIds.has(eid);
      }),
    [visibleTasks, epicIds],
  );

  async function run(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusyId(null);
    }
  }

  function approve(a: Action) {
    void run(a.id, async () => {
      await approveAction(code, a.id);
      posthog.capture(a.type === "epic" ? "epic_approved" : "agent_task_approved", {
        canvas_code: code,
        surface: "board",
      });
    });
  }

  function reject(a: Action) {
    void run(a.id, async () => {
      await rejectAction(code, a.id);
      setRejectingId(null);
    });
  }

  // The detail panel reads the LIVE action from state (not a snapshot), so a
  // claim or completion landing over WS updates it in place; a deleted task
  // closes it. It is independent of the filters — a card filtered out of the
  // board keeps its open panel alive.
  const detail = detailId ? (state.actions ?? {})[detailId] : undefined;
  useEffect(() => {
    if (detailId && !detail) setDetailId(null);
  }, [detailId, detail]);

  // Keyboard: "/" focuses search; Escape closes the detail panel first, then
  // clears the filters. Bound per-render so the closures stay fresh.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (detailId) {
          setDetailId(null);
        } else if (filtering || searchInput) {
          clearFilters();
          searchRef.current?.blur();
        }
        return;
      }
      if (e.key === "/") {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const empty = tasks.length === 0 && epics.length === 0;

  function renderApproveReject(a: Action, approveLabel?: string) {
    if (readOnly || a.state !== "proposed") return null;
    return (
      <ApproveRejectControls
        busy={busyId === a.id}
        rejecting={rejectingId === a.id}
        approveLabel={approveLabel}
        onApprove={() => approve(a)}
        onReject={() => reject(a)}
        setRejecting={(v) => setRejectingId(v ? a.id : null)}
      />
    );
  }

  // ── Kanban card ─────────────────────────────────────────────────────────────
  function renderCard(t: Action, showState: boolean) {
    const p = taskPayload(t);
    const terminal = t.state === "done" || t.state === "failed" || t.state === "rejected";
    const epicTitle = p.epicId ? epicTitleById.get(p.epicId) : undefined;
    return (
      <div
        key={t.id}
        onClick={() => setDetailId(t.id)}
        className="cursor-pointer rounded-xl border border-ink/10 bg-surface p-2.5 transition-colors hover:border-ink/25"
      >
        <div className="flex items-start justify-between gap-2">
          <span
            className={`min-w-0 text-[13px] font-semibold leading-snug ${terminal ? "text-ink/55" : "text-ink"}`}
          >
            {t.ticketId && (
              <span className="mr-1.5 font-code text-[10px] font-medium tracking-tight text-ink/40">
                {t.ticketId}
              </span>
            )}
            {p.title || "Untitled task"}
          </span>
          {/* State is the column in this view — chip only where the column is
              ambiguous (the merged Failed / Rejected lane). */}
          {showState && <StateChip state={t.state} />}
        </div>
        {t.state === "executing" && t.claimedBy && (
          <div className="mt-1">
            <ClaimantChip name={t.claimedBy} />
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-1.5">
          {epicTitle && (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-[4px] border border-ink/10 bg-ink/[0.03] px-1.5 py-px text-[10px] text-ink/50">
              <Layers size={9} className="shrink-0" />
              <span className="max-w-[9rem] truncate">{epicTitle}</span>
            </span>
          )}
          {p.assignee === "human" && (
            <User size={11} className="shrink-0 text-ink/40" aria-label="Your own todo" />
          )}
          <span
            className="ml-auto shrink-0 font-code text-[10px] text-ink/35"
            title={fullDate(t.createdAt)}
          >
            {ageOf(t.createdAt)}
          </span>
        </div>
        {renderApproveReject(t)}
      </div>
    );
  }

  // ── Epic-view compact row ───────────────────────────────────────────────────
  function renderRow(t: Action) {
    const p = taskPayload(t);
    const terminal = t.state === "done" || t.state === "failed" || t.state === "rejected";
    return (
      <div
        key={t.id}
        onClick={() => setDetailId(t.id)}
        className="cursor-pointer rounded-lg border border-ink/10 bg-surface px-2.5 py-1.5 transition-colors hover:border-ink/25"
      >
        <div className="flex items-center gap-2">
          {t.ticketId && (
            <span className="shrink-0 font-code text-[10px] font-medium tracking-tight text-ink/40">
              {t.ticketId}
            </span>
          )}
          <span
            className={`min-w-0 flex-1 truncate text-[12.5px] font-medium ${terminal ? "text-ink/50" : "text-ink/85"}`}
          >
            {p.title || "Untitled task"}
          </span>
          {t.state === "executing" && t.claimedBy && (
            <ClaimantChip name={t.claimedBy} className="max-w-[10rem]" />
          )}
          <StateChip state={t.state} />
          <span
            className="hidden shrink-0 font-code text-[10px] text-ink/30 sm:inline"
            title={fullDate(t.createdAt)}
          >
            {ageOf(t.createdAt)}
          </span>
        </div>
        {renderApproveReject(t)}
      </div>
    );
  }

  // ── Epic swimlane (the progress bar is the anchor) ──────────────────────────
  function renderLane(epic: Action | null, laneTasks: Action[]) {
    // A lane with nothing matching the filter vanishes — filtered epic view
    // shows only the epics that still hold matching work.
    if (filtering && laneTasks.length === 0) return null;
    const total = laneTasks.length;
    const done = laneTasks.filter((t) => t.state === "done").length;
    const working = laneTasks.filter((t) => t.state === "executing").length;
    const title = epic ? epicPayload(epic).title || "Untitled epic" : "No epic";
    return (
      <section
        key={epic?.id ?? "no-epic"}
        className="rounded-xl border border-ink/10 bg-surface/60 p-3"
      >
        <div className="flex items-center gap-2">
          <Layers size={13} className={`shrink-0 ${epic ? "text-ink/45" : "text-ink/25"}`} />
          <span
            className={`min-w-0 flex-1 truncate text-[13px] font-semibold ${epic ? "text-ink" : "text-ink/50"}`}
            title={epic ? epicPayload(epic).body || title : undefined}
          >
            {title}
          </span>
          {epic && <StateChip state={epic.state} />}
          <span className="shrink-0 font-code text-[11px] text-ink/45">
            {done}/{total} done
          </span>
        </div>
        {/* Progress: done in emerald, in-flight in pulsing violet, on an ink
            track — the at-a-glance "is this moving?" signal. */}
        <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-ink/[0.08]">
          {total > 0 && done > 0 && (
            <div className="h-full bg-emerald-500" style={{ width: `${(done / total) * 100}%` }} />
          )}
          {total > 0 && working > 0 && (
            <div
              className="h-full animate-pulse bg-violet-500/80"
              style={{ width: `${(working / total) * 100}%` }}
            />
          )}
        </div>
        {epic && renderApproveReject(epic, "Approve epic")}
        {laneTasks.length > 0 ? (
          <div className="mt-2.5 flex flex-col gap-1.5">{laneTasks.map(renderRow)}</div>
        ) : (
          <p className="mt-2 text-[11px] text-ink/35">No tasks under this epic yet.</p>
        )}
      </section>
    );
  }

  const visibleLaneCount =
    epics.filter((e) => !(filtering && (tasksByEpic.get(e.id) ?? []).length === 0)).length +
    (epicless.length > 0 ? 1 : 0);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* Toolbar: projection toggle + a quiet census. */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ink/5 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-semibold text-ink">Board</span>
          {!empty && (
            <span className="hidden font-code text-[11px] text-ink/40 sm:inline">
              {filtering
                ? `${visibleTasks.length}/${tasks.length} tasks`
                : `${tasks.length} task${tasks.length === 1 ? "" : "s"}`}
              {epics.length > 0 && ` · ${epics.length} epic${epics.length === 1 ? "" : "s"}`}
            </span>
          )}
        </div>
        <div className="flex shrink-0 rounded-lg border border-ink/10 bg-ink/[0.03] p-0.5">
          {(["state", "epic"] as const).map((v) => (
            <button
              key={v}
              onClick={() => switchView(v)}
              aria-pressed={view === v}
              className={[
                "rounded-md px-2.5 py-1 text-xs font-semibold transition-colors",
                view === v ? "bg-surface text-ink shadow-sm" : "text-ink/40 hover:text-ink/65",
              ].join(" ")}
            >
              {v === "state" ? "By state" : "By epic"}
            </button>
          ))}
        </div>
      </div>

      {/* Filter bar: search + chip filters, AND-composed. Horizontal scroll on
          narrow screens rather than wrapping into the board. */}
      {!empty && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-ink/5 px-4 py-1.5">
          <div className="relative shrink-0">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink/30" />
            <input
              ref={searchRef}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder='Search tasks  ·  "/"'
              className="h-7 w-44 rounded-lg border border-ink/15 bg-surface pl-[26px] pr-2 text-[12px] text-ink outline-none placeholder:text-ink/30 focus:border-ink/40 sm:w-52"
            />
          </div>
          <select
            value={filters.state}
            onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value as Filters["state"] }))}
            aria-label="Filter by state"
            className={FILTER_SELECT_CLS}
          >
            <option value="all">All states</option>
            {Object.entries(STATE_CHIP).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          {epics.length > 0 && (
            <select
              value={filters.epic}
              onChange={(e) => setFilters((f) => ({ ...f, epic: e.target.value }))}
              aria-label="Filter by epic"
              className={FILTER_SELECT_CLS}
            >
              <option value="all">All epics</option>
              <option value="none">No epic</option>
              {epics.map((e) => (
                <option key={e.id} value={e.id}>
                  {epicTitleById.get(e.id)}
                </option>
              ))}
            </select>
          )}
          {claimants.length > 0 && (
            <select
              value={filters.claimant}
              onChange={(e) => setFilters((f) => ({ ...f, claimant: e.target.value }))}
              aria-label="Filter by claimant"
              className={FILTER_SELECT_CLS}
            >
              <option value="all">Any claimant</option>
              {claimants.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          <select
            value={filters.assignee}
            onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value as Filters["assignee"] }))}
            aria-label="Filter by assignee"
            className={FILTER_SELECT_CLS}
          >
            <option value="all">Anyone's</option>
            <option value="agent">Agent tasks</option>
            <option value="human">Your todos</option>
          </select>
          <button
            onClick={() => setFilters((f) => ({ ...f, hasCommit: !f.hasCommit }))}
            aria-pressed={filters.hasCommit}
            title="Only tasks whose result mentions a commit hash"
            className={[
              "flex h-7 shrink-0 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium transition-colors",
              filters.hasCommit
                ? "border-ink/60 bg-ink text-paper"
                : "border-ink/15 text-ink/60 hover:border-ink/30",
            ].join(" ")}
          >
            <GitCommitHorizontal size={12} /> Has commit
          </button>
          {filtering && (
            <button
              onClick={clearFilters}
              title="Clear search and filters (Esc)"
              className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-ink/45 transition-colors hover:bg-ink/5 hover:text-ink/75"
            >
              <X size={12} /> Clear
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="mx-4 mt-2 shrink-0 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[12px] text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
          {error}
        </div>
      )}

      {empty ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="max-w-sm text-center text-[13px] leading-relaxed text-ink/45">
            No tasks yet. Write one in the Tasks panel for an agent session to pick up, or ask
            your agent to draft a plan — proposed work lands here for your approval.
          </p>
        </div>
      ) : view === "state" ? (
        /* Kanban: the whole strip scrolls horizontally (usable on mobile); each
           column scrolls its own cards. Empty columns collapse to a slim rail.
           Under a filter, cards simply vanish and the header shows shown/total. */
        <div className="min-h-0 flex-1 overflow-x-auto">
          <div className="flex h-full gap-3 px-4 py-3">
            {COLUMNS.map((col) => {
              const colAll = tasks.filter((t) => col.states.includes(t.state));
              const colTasks = filtering
                ? visibleTasks.filter((t) => col.states.includes(t.state))
                : colAll;
              // Proposed EPICS surface in the Proposed column too — approving
              // an epic is the one-click gate that releases its whole batch,
              // and it must be findable without knowing about the epic view.
              const colEpics =
                col.key === "proposed" ? epics.filter((e) => e.state === "proposed") : [];
              const slim = colTasks.length === 0 && colEpics.length === 0;
              const showState = col.states.length > 1;
              return (
                <div
                  key={col.key}
                  className={`flex min-h-0 shrink-0 flex-col ${slim ? "w-44" : "w-[17rem]"}`}
                >
                  <div className="mb-2 flex shrink-0 items-center gap-1.5 px-1">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: col.dot, opacity: slim ? 0.35 : 1 }}
                    />
                    <span
                      className={`truncate text-[11px] font-semibold uppercase tracking-[0.12em] ${slim ? "text-ink/30" : "text-ink/55"}`}
                    >
                      {col.label}
                    </span>
                    <span className="shrink-0 font-code text-[10px] text-ink/35">
                      {filtering ? `${colTasks.length}/${colAll.length}` : colTasks.length}
                    </span>
                  </div>
                  {slim ? (
                    <div className="flex-1 rounded-xl border border-dashed border-ink/10" />
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2 pr-0.5">
                      {colEpics.map((e) => (
                        <div
                          key={e.id}
                          className="rounded-xl border border-ink/15 bg-ink/[0.03] p-2.5"
                        >
                          <div className="mb-1 flex items-center gap-1.5">
                            <Layers size={12} className="shrink-0 text-ink/45" />
                            <span className="truncate text-[12px] font-semibold text-ink/80">
                              {(e.payload as { title?: string })?.title ?? "Untitled epic"}
                            </span>
                          </div>
                          <p className="mb-1.5 text-[10px] uppercase tracking-[0.1em] text-ink/40">
                            Epic — approving releases every task under it
                          </p>
                          {renderApproveReject(e, "Approve epic")}
                        </div>
                      ))}
                      {colTasks.map((t) => renderCard(t, showState))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* Epic swimlanes: a centred readable column, epics newest-first,
           epicless work bringing up the rear. Filtered-empty lanes hide. */
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-3">
            {epics.map((e) => renderLane(e, tasksByEpic.get(e.id) ?? []))}
            {epicless.length > 0 && renderLane(null, epicless)}
            {visibleLaneCount === 0 && (
              <p className="py-6 text-center text-[13px] text-ink/40">
                {filtering ? "Nothing matches the current filters." : "Nothing to show."}
              </p>
            )}
          </div>
        </div>
      )}

      {detail && (
        <TaskDetail
          key={detail.id}
          code={code}
          action={detail}
          state={state}
          epicTitleById={epicTitleById}
          readOnly={readOnly}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   TaskDetail — the wave-2 detail / step-in side panel. Renders the LIVE action
   (props come from canvas state, so WS pushes update it in place) and offers
   exactly the state's legal human moves:
     · proposed  — edit title/body, toggle requiresApproval, approve / reject
     · executing — release the stuck claim
     · failed    — error shown + re-queue (failed → approved, error cleared)
     · done / rejected — read-only history
   Destructive moves (reject / release / re-queue) confirm inline, two-step.
   ──────────────────────────────────────────────────────────────────────────── */

type DetailConfirm = "reject" | "release" | "requeue" | null;

// Resolve a linked entity id to a human label using the same canvas state the
// board already receives — roadmap items by title, notes by first line.
function linkLabel(state: CanvasState, id: string): { kind: string; label: string } | null {
  const r = (state.roadmapItems ?? {})[id];
  if (r) return { kind: "goal", label: r.title || "Untitled goal" };
  const n = (state.notes ?? {})[id];
  if (n) {
    const first = (n.body ?? "").split("\n")[0].replace(/^#+\s*/, "").slice(0, 60);
    return { kind: "note", label: first || "Untitled note" };
  }
  return null;
}

function TaskDetail({
  code,
  action,
  state,
  epicTitleById,
  readOnly,
  onClose,
}: {
  code: string;
  action: Action;
  state: CanvasState;
  epicTitleById: Map<string, string>;
  readOnly: boolean;
  onClose: () => void;
}) {
  const isTask = action.type === "task";
  const p = taskPayload(action); // epics read title/body through the same shape
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DetailConfirm>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(p.title ?? "");
  const [editBody, setEditBody] = useState(p.body ?? "");

  const commits = extractCommits(action.result);
  const epicTitle = isTask && p.epicId ? epicTitleById.get(p.epicId) : undefined;

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  // Content edits REPLACE the payload server-side, so every field the editor
  // doesn't touch must round-trip or it silently disappears.
  function draftFrom(overrides: Partial<TaskPayload>): TaskPayload {
    return {
      title: p.title ?? "",
      body: p.body,
      linkedIds: p.linkedIds,
      assignee: p.assignee,
      epicId: p.epicId,
      requiresApproval: p.requiresApproval,
      ...overrides,
    };
  }

  function saveEdit() {
    const title = editTitle.trim();
    if (!title) return;
    void run(async () => {
      await updateTask(code, action.id, draftFrom({ title, body: editBody.trim() || undefined }));
      setEditing(false);
    });
  }

  function toggleRequiresApproval() {
    void run(async () => {
      await updateTask(code, action.id, draftFrom({ requiresApproval: !p.requiresApproval || undefined }));
    });
  }

  function approve() {
    void run(async () => {
      await approveAction(code, action.id);
      posthog.capture(isTask ? "agent_task_approved" : "epic_approved", {
        canvas_code: code,
        surface: "board_detail",
      });
    });
  }

  function reject() {
    void run(async () => {
      await rejectAction(code, action.id);
      setConfirm(null);
    });
  }

  function release() {
    void run(async () => {
      await releaseTask(code, action.id);
      setConfirm(null);
    });
  }

  function requeue() {
    void run(async () => {
      await requeueTask(code, action.id);
      posthog.capture("agent_task_requeued", { canvas_code: code });
      setConfirm(null);
    });
  }

  // Two-step confirm strip for a destructive move (mirrors the board's reject).
  function confirmStrip(kind: Exclude<DetailConfirm, null>, message: string, label: string, onGo: () => void) {
    if (confirm !== kind) return null;
    return (
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink/60">{message}</span>
        <button
          onClick={onGo}
          disabled={busy}
          className="shrink-0 rounded-lg bg-rose-600 px-2.5 py-1.5 text-xs font-semibold text-white transition-opacity disabled:opacity-40"
        >
          {label}
        </button>
        <button
          onClick={() => setConfirm(null)}
          className="shrink-0 rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/60 hover:border-ink/30"
        >
          Cancel
        </button>
      </div>
    );
  }

  const primaryBtn =
    "flex flex-1 items-center justify-center gap-1 rounded-lg bg-ink px-2.5 py-1.5 text-xs font-semibold text-paper transition-opacity disabled:opacity-40";
  const quietBtn =
    "flex items-center justify-center gap-1 rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/60 transition-colors hover:border-ink/30 disabled:opacity-40";

  return (
    <div
      className="fixed inset-0 z-[2000] flex justify-end bg-ink/20 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col border-l border-ink/10 bg-surface shadow-2xl shadow-ink/15"
      >
        {/* Header: ticket + state + close. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-ink/5 px-4 py-3">
          {action.ticketId && (
            <span className="shrink-0 font-code text-[12px] font-medium tracking-tight text-ink/50">
              {action.ticketId}
            </span>
          )}
          {!isTask && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-ink/10 bg-ink/[0.03] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em] text-ink/50">
              <Layers size={10} /> Epic
            </span>
          )}
          <StateChip state={action.state} />
          {isTask && p.requiresApproval && action.state === "proposed" && (
            <span
              className="shrink-0 rounded-[4px] bg-amber-500/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700 dark:text-amber-400"
              title="The agent flagged this task as needing explicit approval"
            >
              needs approval
            </span>
          )}
          <button
            onClick={onClose}
            className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink/70"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* Title + body — inline edit while proposed. */}
          {editing ? (
            <div className="flex flex-col gap-2">
              <input
                autoFocus
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                placeholder="Task title"
                className="w-full rounded-lg border border-ink/15 bg-surface px-2.5 py-1.5 text-sm font-semibold text-ink outline-none placeholder:text-ink/30 focus:border-ink/40"
              />
              <textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                placeholder="Brief: what, why, acceptance criteria (optional)"
                rows={10}
                className="w-full resize-y rounded-lg border border-ink/15 bg-surface px-2.5 py-1.5 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink/30 focus:border-ink/40"
              />
              <div className="flex gap-1.5">
                <button onClick={saveEdit} disabled={!editTitle.trim() || busy} className={primaryBtn}>
                  {busy ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setEditTitle(p.title ?? "");
                    setEditBody(p.body ?? "");
                  }}
                  className={quietBtn}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2 className="text-[16px] font-semibold leading-snug text-ink">
                {p.title || "Untitled"}
              </h2>
              {p.body && (
                <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-ink/70">
                  {p.body}
                </p>
              )}
            </>
          )}

          {/* Epic membership. */}
          {epicTitle && (
            <div className="mt-3 flex items-center gap-1.5 text-[12px] text-ink/55">
              <Layers size={12} className="shrink-0" />
              <span className="truncate">{epicTitle}</span>
            </div>
          )}

          {/* Linked context — resolved against the same canvas state the board
              renders from; ids that aren't on this canvas render raw with a
              tooltip so provenance is never silently dropped. */}
          {(p.linkedIds ?? []).length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/35">
                Linked context
              </div>
              <div className="flex flex-wrap gap-1">
                {(p.linkedIds ?? []).map((id) => {
                  const link = linkLabel(state, id);
                  return link ? (
                    <span
                      key={id}
                      className="inline-flex max-w-full items-center gap-1 rounded-[4px] border border-ink/10 bg-ink/[0.03] px-1.5 py-0.5 text-[11px] text-ink/60"
                    >
                      <Link2 size={10} className="shrink-0" />
                      <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-ink/35">
                        {link.kind}
                      </span>
                      <span className="truncate">{link.label}</span>
                    </span>
                  ) : (
                    <span
                      key={id}
                      title="Linked item is not on this canvas (deleted, or from another surface)"
                      className="inline-flex max-w-full items-center gap-1 rounded-[4px] border border-dashed border-ink/15 px-1.5 py-0.5 font-code text-[10px] text-ink/40"
                    >
                      <Link2 size={10} className="shrink-0" />
                      <span className="truncate">{id}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Claim: who holds it, and for how long. */}
          {action.claimedBy && (action.state === "executing" || action.claimedAt) && (
            <div className="mt-3 flex items-center gap-1.5">
              <ClaimantChip name={action.claimedBy} />
              {action.claimedAt && (
                <span className="text-[11px] text-ink/40" title={fullDate(action.claimedAt)}>
                  {action.state === "executing" ? "working for" : "claimed"} {ageOf(action.claimedAt)}
                  {action.state === "executing" ? "" : " ago"}
                </span>
              )}
            </div>
          )}

          {/* Result — commit hashes surfaced as monospace chips. */}
          {action.result && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/35">
                Result
              </div>
              <p className="whitespace-pre-wrap rounded-lg bg-emerald-50 px-2.5 py-2 text-[12.5px] leading-relaxed text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                {action.result}
              </p>
              {commits.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {commits.map((c) => (
                    <span
                      key={c}
                      title="Commit referenced in the result"
                      className="inline-flex items-center gap-1 rounded-[4px] border border-emerald-600/20 bg-emerald-500/10 px-1.5 py-0.5 font-code text-[10.5px] text-emerald-700 dark:text-emerald-300"
                    >
                      <GitCommitHorizontal size={10} className="shrink-0" />
                      {c.length > 12 ? c.slice(0, 12) : c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Failure / rejection detail. */}
          {(action.state === "failed" || action.state === "rejected") && action.error && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/35">
                {action.state === "failed" ? "Error" : "Rejection reason"}
              </div>
              <p className="whitespace-pre-wrap rounded-lg bg-rose-50 px-2.5 py-2 text-[12.5px] leading-relaxed text-rose-800 dark:bg-rose-950 dark:text-rose-200">
                {action.error}
              </p>
            </div>
          )}

          {/* Provenance + timestamps. */}
          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-ink/5 pt-3 text-[11px] text-ink/45">
            <span className="inline-flex items-center gap-1">
              {isTask && p.assignee === "human" ? (
                <>
                  <User size={11} /> your todo
                </>
              ) : (
                <>
                  <Bot size={11} /> proposed by {action.proposedBy}
                </>
              )}
            </span>
            {action.approvedBy && <span>→ approved by {action.approvedBy}</span>}
            <span className="ml-auto" title={fullDate(action.createdAt)}>
              created {ageOf(action.createdAt)} ago
            </span>
          </div>
        </div>

        {/* Step-in controls: exactly the current state's legal human moves. */}
        {!readOnly && !editing && (
          <div className="shrink-0 border-t border-ink/5 px-4 py-3">
            {error && (
              <div className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[12px] text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
                {error}
              </div>
            )}
            {action.state === "proposed" &&
              (confirm === "reject" ? (
                confirmStrip("reject", `Reject this ${isTask ? "task" : "epic"}?`, "Reject", reject)
              ) : (
                <div className="flex flex-col gap-2">
                  {isTask && (
                    <div className="flex cursor-pointer items-center gap-2 text-[12px] text-ink/60">
                      <button
                        onClick={toggleRequiresApproval}
                        disabled={busy}
                        role="switch"
                        aria-checked={!!p.requiresApproval}
                        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border"
                        style={{
                          backgroundColor: p.requiresApproval ? "#111111" : "transparent",
                          borderColor: p.requiresApproval ? "#111111" : "rgba(17,17,17,0.25)",
                        }}
                      >
                        {p.requiresApproval && <Check size={10} color="#fff" />}
                      </button>
                      <span onClick={toggleRequiresApproval}>
                        Requires explicit approval (won't auto-flow with its epic)
                      </span>
                    </div>
                  )}
                  <div className="flex gap-1.5">
                    <button onClick={approve} disabled={busy} className={primaryBtn}>
                      <Check size={13} /> {isTask ? "Approve" : "Approve epic"}
                    </button>
                    {isTask && (
                      <button onClick={() => setEditing(true)} disabled={busy} className={quietBtn}>
                        <Pencil size={12} /> Edit
                      </button>
                    )}
                    <button onClick={() => setConfirm("reject")} disabled={busy} className={quietBtn}>
                      <X size={13} /> Reject
                    </button>
                  </div>
                </div>
              ))}
            {isTask &&
              action.state === "executing" &&
              (confirm === "release" ? (
                confirmStrip(
                  "release",
                  `Clear ${action.claimedBy ?? "the agent"}'s claim and return this task to the queue?`,
                  "Release",
                  release,
                )
              ) : (
                <button
                  onClick={() => setConfirm("release")}
                  disabled={busy}
                  title="For when the agent session died mid-task"
                  className={`${quietBtn} w-full`}
                >
                  <RotateCcw size={13} /> Release stuck claim
                </button>
              ))}
            {isTask &&
              action.state === "failed" &&
              (confirm === "requeue" ? (
                confirmStrip(
                  "requeue",
                  "Clear the error and send this task back to the queue for another attempt?",
                  "Re-queue",
                  requeue,
                )
              ) : (
                <button
                  onClick={() => setConfirm("requeue")}
                  disabled={busy}
                  title="failed → ready: clears the error and the claim so an agent session can retry"
                  className={`${quietBtn} w-full`}
                >
                  <RotateCcw size={13} /> Re-queue for another attempt
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
