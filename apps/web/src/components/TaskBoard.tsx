import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  GitCommitHorizontal,
  Layers,
  Link2,
  Milestone,
  PanelLeft,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SquareKanban,
  Trash2,
  User,
  X,
  Zap,
} from "lucide-react";
import type { Action, ActionState, CanvasState, EpicPayload, TaskPayload } from "../types";
import {
  approveAction,
  approveBatch,
  createTask,
  deleteTask,
  rejectAction,
  releaseTask,
  requeueTask,
  updateTask,
} from "../lib/api";
import posthog from "../lib/posthog";
import TaskComposer, { linkTargets } from "./TaskComposer";
import { epicLifecycle, TERMINAL_STATES } from "../lib/epicLifecycle";
import { CHIP_BASE, STATE_CHIP } from "../lib/stateChips";

/* ─────────────────────────────────────────────────────────────────────────────
   TaskBoard — the Board surface: the one home for tasks on a canvas. Humans
   author tasks here (the toolbar's "New task" composer), triage agent-proposed
   work, and watch cards move as agent sessions claim and finish them.

   Epics are the NAVIGATION LENS, not items on the board. A left sidebar lists
   the epic timeline in creation order (oldest first — it reads as the
   project's sequence): state chip, n/m-done mini progress bar, an elapsed
   "drained in Xm" annotation once an approved epic's tasks all reach a
   terminal state, and inline Approve / Reject on proposed epics — the sidebar
   doubles as the approval inbox. Two sticky pseudo-entries sit on top:
   "All tasks" and "No epic" (no or dangling epicId). The selection persists
   in localStorage and falls back to All tasks if the stored epic vanished.

   Age-out (TDM-9): epics whose lifecycle (lib/epicLifecycle) is finished
   (approved + all tasks terminal) or archived (rejected) leave the timeline
   for a collapsed "Done · N" bucket at the bottom — dimmed entries, still
   selectable, so history stays browsable. The one exception is the epic you
   are currently viewing: it holds its timeline slot if it finishes under you.

   The main area is ONE kanban (Proposed / Ready / Working / Done /
   Failed+Rejected), always scoped to the sidebar selection. Scoped to an
   epic, a compact header shows the epic's title / clamped body / progress /
   Approve-Reject, and cards drop the (now redundant) epic chip; in All-tasks
   scope the chip stays and clicking it jumps the sidebar to that epic.

   A compact filter bar (search + state / claimant / assignee / commit chips,
   AND-composed) applies within the selected scope, so the Done/Failed history
   is genuinely browsable. "/" focuses search; Escape closes the detail panel,
   then clears filters. Filters are not persisted; the scope is.

   Everything renders from the same version-gated canvas-state props as every
   other view, so claims/completions move cards live over WS — no polling, no
   local task cache. Mutations are the existing REST calls; fresh state comes
   back over the broadcast like everywhere else.

   Card click opens the full TaskDetail side panel (wave 2): complete body,
   linked context, result with commit chips, provenance, and the step-in
   controls per state — edit/approve/reject (proposed), release (executing),
   re-queue (failed). Destructive actions confirm inline (two-step).
   ──────────────────────────────────────────────────────────────────────────── */

// Kanban columns. `dot` is the header hue (from the shared six-hue state set);
// Failed + Rejected share the terminal "closed" column so dead work doesn't
// take two lanes.
const COLUMNS: { key: string; label: string; states: ActionState[]; dot: string }[] = [
  { key: "proposed", label: "Proposed", states: ["proposed"], dot: STATE_CHIP.proposed.dot },
  { key: "ready",    label: "Ready",    states: ["approved"], dot: STATE_CHIP.approved.dot },
  { key: "working",  label: "Working",  states: ["executing"], dot: STATE_CHIP.executing.dot },
  { key: "done",     label: "Done",     states: ["done"], dot: STATE_CHIP.done.dot },
  { key: "closed",   label: "Failed / Rejected", states: ["failed", "rejected"], dot: STATE_CHIP.failed.dot },
];

// Sidebar scope — which lens the kanban shows: "all" | "none" | an epic id.
// Persisted so the board reopens where you left it.
const SCOPE_KEY = "tandem.board.epic";
// Whether the sidebar's Done bucket (finished + rejected epics) is expanded.
const DONE_OPEN_KEY = "tandem.board.epicsDoneOpen";

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

// Human duration for the epic elapsed annotation ("22m", "1h 4m", "3d 2h").
function elapsedLabel(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

// "drained in 22m" — how long an epic took to empty once approved. Epics only
// move proposed → approved and are never claimed or executed, so an approved
// epic's updatedAt IS its approval timestamp; the end is the newest updatedAt
// among its tasks (the moment each hit its terminal state). Only shown when
// every task is terminal and the span is trustworthy (positive, parseable).
function epicDrain(epic: Action, epicTasks: Action[]): string | null {
  if (epic.state !== "approved" || epicTasks.length === 0) return null;
  if (!epicTasks.every((t) => TERMINAL_STATES.includes(t.state))) return null;
  const start = new Date(epic.updatedAt).getTime();
  const end = Math.max(...epicTasks.map((t) => new Date(t.updatedAt).getTime()));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return `drained in ${elapsedLabel(end - start)}`;
}

// Segmented progress: done in emerald, in-flight in pulsing violet, on an ink
// track — the at-a-glance "is this moving?" signal, shared by the sidebar
// entries and the scoped-epic header.
function ProgressBar({
  done,
  working,
  total,
  className = "",
}: {
  done: number;
  working: number;
  total: number;
  className?: string;
}) {
  return (
    <div className={`flex overflow-hidden rounded-full bg-ink/[0.08] ${className}`}>
      {total > 0 && done > 0 && (
        <div className={`h-full ${STATE_CHIP.done.dot}`} style={{ width: `${(done / total) * 100}%` }} />
      )}
      {total > 0 && working > 0 && (
        <div
          className={`h-full animate-pulse opacity-80 ${STATE_CHIP.executing.dot}`}
          style={{ width: `${(working / total) * 100}%` }}
        />
      )}
    </div>
  );
}

function StateChip({ state, className = "" }: { state: string; className?: string }) {
  const chip = STATE_CHIP[state] ?? STATE_CHIP.proposed;
  return (
    <span className={`${CHIP_BASE} ${chip.chip} ${className}`}>
      {chip.label}
    </span>
  );
}

// The one claimant treatment everywhere: who's executing, in working-violet.
function ClaimantChip({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 text-[11px] font-medium ${STATE_CHIP.executing.text} ${className}`}
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
            className="flex-1 rounded-md bg-rose-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-40"
          >
            Confirm reject
          </button>
          <button
            onClick={() => setRejecting(false)}
            className="rounded-md border border-ink/15 px-2 py-1 text-[11px] font-medium text-ink/60 transition-colors hover:border-ink/30"
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            onClick={onApprove}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          >
            <Check size={12} /> {approveLabel}
          </button>
          <button
            onClick={() => setRejecting(true)}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1 rounded-md border border-ink/15 px-2 py-1 text-[11px] font-medium text-ink/60 transition-colors hover:border-ink/30 disabled:opacity-40"
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
  claimant: "all" | string;
  assignee: "all" | "agent" | "human";
  hasCommit: boolean;
};

const NO_FILTERS: Filters = {
  state: "all",
  claimant: "all",
  assignee: "all",
  hasCommit: false,
};

const FILTER_SELECT_CLS =
  "h-7 max-w-[10rem] shrink-0 rounded-md border border-ink/15 bg-surface px-1.5 text-[11px] font-medium text-ink/70 outline-none transition-colors focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40";

export default function TaskBoard({
  code,
  state,
  readOnly,
  focusTaskId,
  onFocusHandled,
  focusEpicId,
  onScopeHandled,
  onOpenConnect,
  onOpenDocuments,
  onOpenRoadmapDoc,
}: {
  code: string;
  state: CanvasState;
  readOnly: boolean;
  /** First-run empty state: open the agent connect dialog. */
  onOpenConnect?: () => void;
  /** First-run empty state: switch to the Documents surface. */
  onOpenDocuments?: () => void;
  /** Scoped-epic header's plan chip: open the roadmap document an epic's
      linked goal lives in (switches to the Documents surface). */
  onOpenRoadmapDoc?: (docId: string) => void;
  // TDM-14 one-shot focus handoff (from the header agent presence): when a
  // task id arrives, scope to its epic, scroll its card into view, open its
  // detail — then hand the token back via onFocusHandled.
  focusTaskId?: string | null;
  onFocusHandled?: () => void;
  // One-shot EPIC-scope handoff (roadmap chip → "open the Board scoped to this
  // epic"): same pattern as focusTaskId, needed because the board stays
  // mounted after first visit so a localStorage write alone never re-scopes.
  focusEpicId?: string | null;
  onScopeHandled?: () => void;
}) {
  // Sidebar scope — raw as stored; validated against the live epic set below.
  const [scope, setScope] = useState<string>(() => {
    try {
      return localStorage.getItem(SCOPE_KEY) ?? "all";
    } catch {
      return "all";
    }
  });
  // Mobile only — on md+ the sidebar is always visible.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Done-bucket expansion (finished + rejected epics) — persisted preference.
  const [doneOpen, setDoneOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DONE_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The "New task" composer (toolbar button / empty-state CTA) — humans author
  // tasks HERE; the Board is the one home for task work.
  const [composing, setComposing] = useState(false);
  // One in-flight "Approve all" batch (the Proposed column header button).
  const [batchBusy, setBatchBusy] = useState(false);

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
    filters.claimant !== "all" ||
    filters.assignee !== "all" ||
    filters.hasCommit;

  function clearFilters() {
    setSearchInput("");
    setQuery("");
    setFilters(NO_FILTERS);
  }

  function toggleDoneOpen() {
    setDoneOpen((v) => {
      try {
        localStorage.setItem(DONE_OPEN_KEY, v ? "0" : "1");
      } catch {
        /* preference only */
      }
      return !v;
    });
  }

  function selectScope(s: string) {
    setScope(s);
    setSidebarOpen(false); // mobile: picking a scope dismisses the drawer
    // Scoping to an AGED epic (finished/rejected — filed in the Done bucket)
    // must reveal its sidebar entry: without this the selection highlights
    // nothing and the board looks scoped to a ghost (QA wave-3 finding 5).
    if (s !== "all" && s !== "none") {
      const epic = (state.actions ?? {})[s];
      if (epic && epic.type === "epic") {
        const own = Object.values(state.actions ?? {}).filter(
          (a) => a.type === "task" && taskPayload(a).epicId === s,
        );
        if (epicLifecycle(epic, own) !== "active") {
          setDoneOpen(true);
          try {
            localStorage.setItem(DONE_OPEN_KEY, "1");
          } catch {
            /* preference only */
          }
        }
      }
    }
    try {
      localStorage.setItem(SCOPE_KEY, s);
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
  // Creation order, OLDEST first — the sidebar timeline reads as the
  // project's sequence, top to bottom.
  const epics = useMemo(
    () =>
      Object.values(state.actions ?? {})
        .filter((a) => a.type === "epic")
        .sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1)),
    [state.actions],
  );
  const epicIds = useMemo(() => new Set(epics.map((e) => e.id)), [epics]);
  const epicTitleById = useMemo(
    () => new Map(epics.map((e) => [e.id, epicPayload(e).title || "Untitled epic"])),
    [epics],
  );
  // Epics are the bridge between the plans and the queue: an epic that links a
  // roadmap goal (payload.linkedIds, TDM-10) belongs to that goal's roadmap
  // DOCUMENT — one plan per stream, one Board running them all. Attribution is
  // best-effort: the first linked id that still resolves to a roadmap item
  // whose document still exists wins; dangling ids (deleted goals, deleted
  // docs) are skipped, and an epic with nothing resolvable stays unlinked.
  const epicPlan = useMemo(() => {
    const m = new Map<string, { goalTitle: string; docId: string; docName: string }>();
    for (const e of epics) {
      for (const id of epicPayload(e).linkedIds ?? []) {
        const item = (state.roadmapItems ?? {})[id];
        if (!item) continue;
        const doc = (state.documents ?? {})[item.documentId ?? ""];
        if (!doc) continue;
        m.set(e.id, {
          goalTitle: item.title || "Untitled goal",
          docId: doc.id,
          docName: doc.name || "Roadmap",
        });
        break;
      }
    }
    return m;
  }, [epics, state.roadmapItems, state.documents]);
  // Everyone who has ever held a claim — done/failed rows keep claimed_by, so
  // this doubles as the "browse one agent's history" axis.
  const claimants = useMemo(() => {
    const s = new Set<string>();
    for (const t of tasks) if (t.claimedBy) s.add(t.claimedBy);
    return [...s].sort();
  }, [tasks]);

  // Every task grouped under its (valid) epic — unfiltered, feeds the sidebar
  // progress bars and the scoped kanban alike.
  const tasksByEpic = useMemo(() => {
    const m = new Map<string, Action[]>();
    for (const t of tasks) {
      const eid = taskPayload(t).epicId;
      if (eid && epicIds.has(eid)) m.set(eid, [...(m.get(eid) ?? []), t]);
    }
    return m;
  }, [tasks, epicIds]);
  // No epic, or a dangling epicId — the "No epic" scope.
  const epiclessAll = useMemo(
    () =>
      tasks.filter((t) => {
        const eid = taskPayload(t).epicId;
        return !eid || !epicIds.has(eid);
      }),
    [tasks, epicIds],
  );

  // The stored scope may point at an epic that no longer exists — fall back to
  // All tasks. Derived (not an effect) so a state push that still holds the
  // epic recovers the selection instead of clobbering it.
  const effectiveScope =
    scope === "all" || scope === "none" || epicIds.has(scope) ? scope : "all";
  const scopedEpic =
    effectiveScope !== "all" && effectiveScope !== "none"
      ? epics.find((e) => e.id === effectiveScope)
      : undefined;

  const scopedTasks = useMemo(() => {
    if (effectiveScope === "none") return epiclessAll;
    if (scopedEpic) return tasksByEpic.get(scopedEpic.id) ?? [];
    return tasks;
  }, [effectiveScope, scopedEpic, tasks, epiclessAll, tasksByEpic]);

  // ── Epic age-out (TDM-9) ────────────────────────────────────────────────────
  // Finished (approved + ≥1 task, all terminal) and rejected epics leave the
  // timeline and file into a collapsed "Done" bucket at the bottom. No
  // rug-pull: an epic that finishes WHILE it is the selected scope stays
  // pinned in its timeline slot for the rest of the session — it files under
  // Done on the next visit. Pure derived state; pin held via functional update.
  const [pinnedActiveId, setPinnedActiveId] = useState<string | null>(null);
  useEffect(() => {
    const lc = scopedEpic
      ? epicLifecycle(scopedEpic, tasksByEpic.get(scopedEpic.id) ?? [])
      : null;
    setPinnedActiveId((prev) => {
      if (scopedEpic && lc === "active") return scopedEpic.id; // viewing an active epic — pin it
      if (scopedEpic && prev === scopedEpic.id) return prev; // it finished under us — hold
      return null; // navigated away (or no epic scope) — release
    });
  }, [scopedEpic, tasksByEpic]);

  const { activeEpics, agedEpics } = useMemo(() => {
    const act: Action[] = [];
    const aged: Action[] = [];
    for (const e of epics) {
      const lc = epicLifecycle(e, tasksByEpic.get(e.id) ?? []);
      if (lc === "active" || e.id === pinnedActiveId) act.push(e);
      else aged.push(e);
    }
    return { activeEpics: act, agedEpics: aged };
  }, [epics, tasksByEpic, pinnedActiveId]);

  // Sidebar grouping: the ACTIVE timeline splits into one group per roadmap
  // document with linked epics (plans, in the docs' sortOrder) plus the
  // unlinked rest. Age-out wins — a finished epic files under the Done bucket,
  // never under its plan. A canvas with no plan-linked epics gets zero groups
  // and renders the flat timeline exactly as before.
  const planGroups = useMemo(() => {
    const byDoc = new Map<string, Action[]>();
    const unlinked: Action[] = [];
    for (const e of activeEpics) {
      const plan = epicPlan.get(e.id);
      if (plan) byDoc.set(plan.docId, [...(byDoc.get(plan.docId) ?? []), e]);
      else unlinked.push(e);
    }
    const groups = [...byDoc.entries()]
      .map(([docId, list]) => {
        const doc = (state.documents ?? {})[docId];
        return { docId, name: doc?.name || "Roadmap", sortOrder: doc?.sortOrder ?? 0, list };
      })
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return { groups, unlinked };
  }, [activeEpics, epicPlan, state.documents]);

  // One predicate, AND-composed — applied WITHIN the selected scope.
  function taskMatches(t: Action): boolean {
    const p = taskPayload(t);
    if (query) {
      const hay = `${p.title ?? ""}\n${p.body ?? ""}\n${t.result ?? ""}\n${t.ticketId ?? ""}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    if (filters.state !== "all" && t.state !== filters.state) return false;
    if (filters.claimant !== "all" && t.claimedBy !== filters.claimant) return false;
    if (filters.assignee !== "all" && (p.assignee ?? "agent") !== filters.assignee) return false;
    if (filters.hasCommit && extractCommits(t.result).length === 0) return false;
    return true;
  }

  const visibleTasks = useMemo(
    () => (filtering ? scopedTasks.filter(taskMatches) : scopedTasks),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopedTasks, filtering, query, filters],
  );

  // Link targets for the composer (roadmap items + notes on this canvas).
  const targets = useMemo(() => linkTargets(state), [state]);

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

  // ONE approve-batch call for every proposed task in the current scope (the
  // Proposed column header's "Approve all"). No optimistic overlay — the WS
  // broadcast moves the cards, and batchBusy labels the in-flight window.
  async function approveAllProposed(ids: string[]) {
    if (ids.length === 0 || batchBusy || readOnly) return;
    setBatchBusy(true);
    setError(null);
    try {
      const { approved } = await approveBatch(code, ids);
      posthog.capture("agent_tasks_batch_approved", {
        canvas_code: code,
        requested: ids.length,
        approved: approved.length,
        surface: "board",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve tasks");
    } finally {
      setBatchBusy(false);
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

  // TDM-14: consume the one-shot focus handoff from the header agent presence.
  // Scope the board to the task's epic (or "No epic" for epicless tasks, unless
  // the All-tasks lens already shows it), open its detail slide-over, and scroll
  // its card into view — then hand the token back so normal browsing resumes.
  // If the task left `executing` meanwhile, this still opens it wherever it now
  // sits; a task that vanished entirely just clears the handoff.
  useEffect(() => {
    if (!focusTaskId) return;
    const t = (state.actions ?? {})[focusTaskId];
    if (t) {
      // "Follow this agent" is an unconditional jump: stale filters (a state
      // or claimant filter from earlier browsing) would hide the very card we
      // are about to scroll to (QA wave-3 finding 6).
      clearFilters();
      const eid = taskPayload(t).epicId;
      if (eid && epicIds.has(eid)) selectScope(eid);
      else if (effectiveScope !== "all") selectScope("none");
      setDetailId(focusTaskId);
      // The card renders into the (possibly new) scope on the next paint —
      // scroll once the DOM has settled. Deliberately not cleaned up: the
      // handoff reset below re-runs this effect immediately, and a cleanup
      // would cancel the scroll before it fires.
      setTimeout(() => {
        document
          .querySelector(`[data-task-id="${CSS.escape(focusTaskId)}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 80);
    }
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTaskId]);

  // Epic-scope handoff: a roadmap chip asked for this epic. One-shot, mirrors
  // the task-focus effect above (the board stays mounted, so props are the
  // only reliable channel — a bare localStorage write never re-scopes).
  useEffect(() => {
    if (!focusEpicId) return;
    if (epicIds.has(focusEpicId)) selectScope(focusEpicId);
    onScopeHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEpicId]);

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
  // Whether the canvas has any real documents (folders only nest them) — the
  // teaching empty state only points at Documents when there's something there.
  const hasDocs = Object.values(state.documents ?? {}).some((d) => d.type !== "folder");

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
  // withEpicChip: only the All-tasks scope shows the epic chip (clicking it
  // jumps the sidebar to that epic); inside an epic scope it's redundant.
  function renderCard(t: Action, showState: boolean, withEpicChip: boolean) {
    const p = taskPayload(t);
    const terminal = t.state === "done" || t.state === "failed" || t.state === "rejected";
    const epicId = p.epicId;
    const epicTitle = withEpicChip && epicId ? epicTitleById.get(epicId) : undefined;
    return (
      <div
        key={t.id}
        data-task-id={t.id}
        role="button"
        tabIndex={0}
        onClick={() => setDetailId(t.id)}
        onKeyDown={(ev: ReactKeyboardEvent) => {
          // Keyboard parity with the sidebar rows: Enter/Space opens the detail
          // slide-over. Only when the card itself is focused — keys on inner
          // controls (approve/reject, epic chip) keep their own behaviour.
          if ((ev.key === "Enter" || ev.key === " ") && ev.target === ev.currentTarget) {
            ev.preventDefault();
            setDetailId(t.id);
          }
        }}
        className="cursor-pointer rounded-lg border border-ink/10 bg-surface p-2.5 transition-[border-color,box-shadow] hover:border-ink/25 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <div className="flex items-start justify-between gap-2">
          <span
            className={`min-w-0 text-[13px] font-semibold leading-snug ${terminal ? "text-ink/55" : "text-ink"}`}
          >
            {t.ticketId && (
              <span className="mr-1.5 font-code text-[10px] font-medium tracking-tight text-ink/50">
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
          {epicTitle && epicId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                selectScope(epicId);
              }}
              title={`Scope the board to "${epicTitle}"`}
              className="inline-flex min-w-0 items-center gap-1 rounded-[4px] border border-ink/10 bg-ink/[0.03] px-1.5 py-px text-[10px] text-ink/50 transition-colors hover:border-ink/30 hover:text-ink/75"
            >
              <Layers size={9} className="shrink-0" />
              <span className="max-w-[9rem] truncate">{epicTitle}</span>
            </button>
          )}
          {p.assignee === "human" && (
            <User size={11} className="shrink-0 text-ink/40" aria-label="Your own todo" />
          )}
          <span
            className="ml-auto shrink-0 font-code text-[10px] text-ink/50"
            title={fullDate(t.createdAt)}
          >
            {ageOf(t.createdAt)}
          </span>
        </div>
        {renderApproveReject(t)}
      </div>
    );
  }

  // ── Sidebar: epic timeline entries ──────────────────────────────────────────
  // Deliberately a different shape from task cards — full-width rows with a
  // left selection accent, a Layers icon, and no ticket badge. Epics are the
  // lens, not the work.

  function epicStats(e: Action) {
    const list = tasksByEpic.get(e.id) ?? [];
    return {
      list,
      total: list.length,
      done: list.filter((t) => t.state === "done").length,
      working: list.filter((t) => t.state === "executing").length,
      drain: epicDrain(e, list),
    };
  }

  const entryCls = (selected: boolean) =>
    [
      "cursor-pointer border-l-2 px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40",
      selected ? "border-accent bg-accent/[0.08]" : "border-transparent hover:bg-ink/[0.03]",
    ].join(" ");

  function entryKeyDown(s: string) {
    return (ev: ReactKeyboardEvent) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        selectScope(s);
      }
    };
  }

  function renderPseudoEntry(key: "all" | "none", label: string, count: number) {
    const selected = effectiveScope === key;
    return (
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => selectScope(key)}
        onKeyDown={entryKeyDown(key)}
        className={`flex items-center gap-1.5 ${entryCls(selected)}`}
      >
        <span
          className={`min-w-0 flex-1 truncate text-[12.5px] font-semibold ${selected ? "text-accent" : "text-ink/70"}`}
        >
          {label}
        </span>
        <span className="shrink-0 font-code text-[10px] text-ink/50">{count}</span>
      </div>
    );
  }

  // aged: rendered inside the Done bucket — dimmed, lifecycle chip (Done for
  // finished, Rejected for archived), drained-in annotation where it applies.
  function renderEpicEntry(e: Action, aged = false) {
    const p = epicPayload(e);
    const { list, total, done, working, drain } = epicStats(e);
    const lifecycle = epicLifecycle(e, list);
    const selected = effectiveScope === e.id;
    const plan = epicPlan.get(e.id);
    return (
      <div
        key={e.id}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => selectScope(e.id)}
        onKeyDown={entryKeyDown(e.id)}
        className={`${entryCls(selected)}${aged ? " opacity-60 hover:opacity-90" : ""}`}
      >
        <div className="flex items-center gap-1.5">
          <Layers size={12} className="shrink-0 text-ink/45" />
          <span
            className={`min-w-0 flex-1 truncate text-[12.5px] font-semibold ${selected ? "text-accent" : "text-ink/80"}`}
            title={p.title || "Untitled epic"}
          >
            {p.title || "Untitled epic"}
          </span>
          <StateChip state={lifecycle === "finished" ? "done" : e.state} />
        </div>
        {/* The goal this epic delivers — quiet provenance, not a control (the
            plan chip in the scoped header is the interactive route). */}
        {plan && (
          <div className="mt-0.5 truncate pl-[18px] text-[11px] text-ink/45" title={plan.goalTitle}>
            {plan.goalTitle}
          </div>
        )}
        <ProgressBar done={done} working={working} total={total} className="mt-1.5 h-1.5" />
        <div className="mt-1 flex items-center justify-between font-code text-[10px] text-ink/50">
          <span>
            {done}/{total} done
          </span>
          {drain && <span className="text-emerald-600 dark:text-emerald-400">{drain}</span>}
        </div>
        {/* The sidebar doubles as the approval inbox. */}
        {renderApproveReject(e, "Approve epic")}
      </div>
    );
  }

  // ── Scoped-epic header above the kanban ─────────────────────────────────────
  function renderScopeHeader(e: Action) {
    const p = epicPayload(e);
    const { list, total, done, working, drain } = epicStats(e);
    // Finished epics read as history: Done chip, full emerald bar, prominent
    // drained-in — no approve-era chrome.
    const finished = epicLifecycle(e, list) === "finished";
    const plan = epicPlan.get(e.id);
    return (
      <div className="shrink-0 border-b border-ink/10 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Layers size={14} className="shrink-0 text-ink/45" />
          <button
            onClick={() => setDetailId(e.id)}
            title="Open epic details"
            className="min-w-0 truncate text-left text-[14px] font-semibold text-ink hover:underline"
          >
            {p.title || "Untitled epic"}
          </button>
          <StateChip state={finished ? "done" : e.state} />
          {/* The plan this epic delivers: goal + roadmap doc. Clicking jumps to
              the roadmap on the Documents surface — the reverse of the roadmap's
              epic chips pointing here. */}
          {plan && onOpenRoadmapDoc && (
            <button
              onClick={() => onOpenRoadmapDoc(plan.docId)}
              title="Open the roadmap this epic belongs to"
              aria-label="Open the roadmap this epic belongs to"
              className="inline-flex min-w-0 shrink items-center gap-1 rounded-[4px] border border-ink/10 bg-ink/[0.03] px-1.5 py-px text-[10px] text-ink/50 transition-colors hover:border-ink/30 hover:text-ink/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Milestone size={9} className="shrink-0" />
              <span className="truncate">
                {plan.goalTitle} · {plan.docName}
              </span>
            </button>
          )}
          {finished && drain && (
            <span className="shrink-0 text-[12px] font-semibold text-emerald-600 dark:text-emerald-400">
              {drain}
            </span>
          )}
          <span className="ml-auto shrink-0 font-code text-[11px] text-ink/50">
            {done}/{total} done
          </span>
        </div>
        {p.body && (
          <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-ink/60">{p.body}</p>
        )}
        {finished ? (
          <div className="mt-2 h-1.5 rounded-full bg-emerald-500" />
        ) : (
          <>
            <ProgressBar done={done} working={working} total={total} className="mt-2 h-1.5" />
            <div className="max-w-xs">{renderApproveReject(e, "Approve epic")}</div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* Toolbar: mobile sidebar toggle + a quiet census of the current scope. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-ink/10 px-4 py-2">
        {!empty && (
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label="Toggle epic sidebar"
            aria-expanded={sidebarOpen}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink/80 md:hidden"
          >
            <PanelLeft size={15} />
          </button>
        )}
        <span className="text-sm font-semibold text-ink">Board</span>
        {!empty && (
          <span className="hidden font-code text-[11px] text-ink/50 sm:inline">
            {filtering
              ? `${visibleTasks.length}/${scopedTasks.length} tasks`
              : `${scopedTasks.length} task${scopedTasks.length === 1 ? "" : "s"}`}
            {effectiveScope !== "all" && " in scope"}
            {epics.length > 0 && ` · ${epics.length} epic${epics.length === 1 ? "" : "s"}`}
          </span>
        )}
        {!readOnly && !empty && (
          <button
            onClick={() => setComposing((v) => !v)}
            aria-expanded={composing}
            className="ml-auto flex h-7 shrink-0 items-center gap-1 rounded-md bg-accent pl-2 pr-2.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <Plus size={13} /> New task
          </button>
        )}
      </div>

      {/* The composer — task authoring lives on the Board. Human-authored tasks
          are born approved; agent sessions pull "For the agent" ones from the
          queue. A new task files under the scoped epic, if one is selected. */}
      {composing && !readOnly && (
        <div className="shrink-0 border-b border-ink/10 px-4 py-3">
          <div className="max-w-xl">
            <TaskComposer
              targets={targets}
              onCancel={() => setComposing(false)}
              onSubmit={async (draft) => {
                await createTask(code, scopedEpic ? { ...draft, epicId: scopedEpic.id } : draft);
                posthog.capture("agent_task_created", { canvas_code: code, surface: "board" });
                setComposing(false);
              }}
            />
          </div>
        </div>
      )}

      {/* Filter bar: search + chip filters, AND-composed. Horizontal scroll on
          narrow screens rather than wrapping into the board. */}
      {!empty && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-ink/10 px-4 py-1.5">
          <div className="relative shrink-0">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink/30" />
            <input
              ref={searchRef}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder='Search tasks  ·  "/"'
              className="h-7 w-44 rounded-md border border-ink/15 bg-surface pl-[26px] pr-2 text-[12px] text-ink outline-none placeholder:text-ink/30 focus:border-accent/50 focus:ring-2 focus:ring-accent/40 sm:w-52"
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
              "flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
              filters.hasCommit
                ? "border-accent/40 bg-accent/[0.08] text-accent"
                : "border-ink/15 text-ink/60 hover:border-ink/30",
            ].join(" ")}
          >
            <GitCommitHorizontal size={12} /> Has commit
          </button>
          {filtering && (
            <button
              onClick={clearFilters}
              title="Clear search and filters (Esc)"
              className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink/75"
            >
              <X size={12} /> Clear
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="mx-4 mt-2 shrink-0 rounded-md border border-rose-500/20 bg-rose-500/10 px-2.5 py-1.5 text-[12px] text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {empty && !composing ? (
        /* First-run teaching state: the loop this product is built around —
           write a task, an agent claims it, you review. ONE primary action. */
        <div className="tandem-scroll flex flex-1 items-center justify-center overflow-y-auto p-8">
          <div className="w-full max-w-md text-center">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-ink/10 bg-surface">
              <SquareKanban size={20} className="text-ink/45" />
            </span>
            <h2 className="mt-4 text-xl font-semibold tracking-tight text-ink">
              This is where the work happens
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-ink/55">
              Tasks move across this board as agent sessions pick them up and finish them —
              with you approving what runs.
            </p>
            <ol className="mx-auto mt-5 flex max-w-xs flex-col gap-2.5 text-left">
              {[
                "Write a task — or ask a connected agent to propose a plan.",
                "Approve it so an agent session can claim it from the queue.",
                "Review the result when the card lands in Done.",
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-ink/60">
                  <span className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border border-ink/15 bg-surface font-code text-[10px] font-medium text-ink/55">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
            {readOnly ? (
              <p className="mt-6 font-code text-[11px] text-ink/40">
                view only — tasks will appear here as they're written
              </p>
            ) : (
              <>
                <button
                  onClick={() => setComposing(true)}
                  className="mt-6 inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
                >
                  <Plus size={15} /> Write the first task
                </button>
                {(onOpenConnect || (onOpenDocuments && hasDocs)) && (
                  <p className="mt-4 font-code text-[11px] text-ink/40">
                    {onOpenConnect && (
                      <button onClick={onOpenConnect} className="font-medium text-accent hover:underline">
                        open the connect dialog
                      </button>
                    )}
                    {onOpenConnect && onOpenDocuments && hasDocs && <span aria-hidden> · </span>}
                    {onOpenDocuments && hasDocs && (
                      <button onClick={onOpenDocuments} className="font-medium text-accent hover:underline">
                        browse the documents
                      </button>
                    )}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Epic navigator: the timeline sidebar. Hidden on mobile unless
              toggled from the toolbar; always visible on md+. */}
          <aside
            className={`${sidebarOpen ? "flex" : "hidden"} w-64 shrink-0 flex-col border-r border-ink/10 md:flex`}
          >
            <div className="min-h-0 flex-1 overflow-y-auto pb-2">
              <div className="sticky top-0 z-10 border-b border-ink/10 bg-paper py-1">
                {renderPseudoEntry("all", "All tasks", tasks.length)}
                {renderPseudoEntry("none", "No epic", epiclessAll.length)}
              </div>
              {/* Roadmaps are the plans, one per stream; the Board is the single
                  execution queue; epics are the bridge. Plan-linked epics group
                  under their roadmap doc's name; the rest keep the plain
                  timeline (which is ALL of them on a canvas with no links —
                  zero visual change there). */}
              {planGroups.groups.map((g) => (
                <div key={g.docId}>
                  <div className="px-3 pb-0.5 pt-2.5 text-[10px] font-medium uppercase tracking-wide text-ink/50">
                    {g.name}
                  </div>
                  {g.list.map((e) => renderEpicEntry(e))}
                </div>
              ))}
              {(planGroups.groups.length === 0 || planGroups.unlinked.length > 0) && (
                <div className="px-3 pb-0.5 pt-2.5 text-[10px] font-medium uppercase tracking-wide text-ink/50">
                  Epic timeline
                </div>
              )}
              {planGroups.unlinked.map((e) => renderEpicEntry(e))}
              {epics.length === 0 && (
                <p className="px-3 py-1.5 text-[11px] leading-relaxed text-ink/50">
                  No epics yet — agents propose them as named batches of tasks.
                </p>
              )}
              {/* Done bucket: finished + rejected epics, collapsed by default.
                  History stays browsable — entries still scope the kanban. */}
              {agedEpics.length > 0 && (
                <div className="mt-2 border-t border-ink/10">
                  <button
                    onClick={toggleDoneOpen}
                    aria-expanded={doneOpen}
                    className="flex w-full items-center gap-1 px-3 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-wide text-ink/50 transition-colors hover:text-ink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                  >
                    <ChevronRight
                      size={10}
                      className={`shrink-0 transition-transform ${doneOpen ? "rotate-90" : ""}`}
                    />
                    Done · {agedEpics.length}
                  </button>
                  {doneOpen && agedEpics.map((e) => renderEpicEntry(e, true))}
                </div>
              )}
            </div>
          </aside>

          {/* Main area: ONE kanban, always scoped to the sidebar selection. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {scopedEpic && renderScopeHeader(scopedEpic)}
            {/* Kanban: the whole strip scrolls horizontally (usable on mobile);
                each column scrolls its own cards. Empty columns collapse to a
                slim rail. Under a filter, cards simply vanish and the header
                shows shown/total (within the scope). */}
            <div className="min-h-0 flex-1 overflow-x-auto">
              {/* pr on sm+: the QuickLog chip rail floats over the right gutter
                  (App.tsx renders it absolutely at right-4, z-20). The extra
                  end-padding lets the last kanban column scroll fully clear of
                  the rail instead of ending underneath it. */}
              <div className="flex h-full gap-3 py-3 pl-4 pr-4 sm:pr-24">
                {COLUMNS.map((col) => {
                  const colAll = scopedTasks.filter((t) => col.states.includes(t.state));
                  const colTasks = filtering
                    ? visibleTasks.filter((t) => col.states.includes(t.state))
                    : colAll;
                  const slim = colTasks.length === 0;
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
                          className={`truncate text-[11px] font-medium uppercase tracking-wide ${slim ? "text-ink/50" : "text-ink/60"}`}
                        >
                          {col.label}
                        </span>
                        <span className="shrink-0 font-code text-[10px] text-ink/50">
                          {filtering ? `${colTasks.length}/${colAll.length}` : colTasks.length}
                        </span>
                        {/* Bulk triage: one approve-batch call for the whole
                            proposed column (within the current scope). */}
                        {col.key === "proposed" && !readOnly && colAll.length > 1 && (
                          <button
                            onClick={() => approveAllProposed(colAll.map((t) => t.id))}
                            disabled={batchBusy}
                            title="Approve every proposed task in this scope in one batch"
                            className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
                          >
                            {batchBusy ? "Approving…" : `Approve all ${colAll.length}`}
                          </button>
                        )}
                      </div>
                      {slim ? (
                        <div className="flex-1 rounded-lg border border-dashed border-ink/10" />
                      ) : (
                        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2 pr-0.5">
                          {colTasks.map((t) =>
                            renderCard(t, showState, effectiveScope === "all"),
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
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

type DetailConfirm = "reject" | "release" | "requeue" | "delete" | null;

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DetailConfirm>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(p.title ?? "");
  const [editBody, setEditBody] = useState(p.body ?? "");

  const commits = extractCommits(action.result);
  const epicTitle = isTask && p.epicId ? epicTitleById.get(p.epicId) : undefined;

  // aria-modal contract: move focus INTO the dialog on open, keep Tab cycling
  // inside it, and hand focus back to the opener on close. The component
  // remounts per action (key={detail.id} upstream), so mount/unmount is
  // exactly open/close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  function trapTab(e: ReactKeyboardEvent) {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const current = document.activeElement;
    if (e.shiftKey) {
      if (current === first || current === root) {
        e.preventDefault();
        last.focus();
      }
    } else if (current === last) {
      e.preventDefault();
      first.focus();
    }
  }

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

  function doDelete() {
    void run(async () => {
      await deleteTask(code, action.id);
      posthog.capture("agent_task_deleted", { canvas_code: code });
      onClose();
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
          className="shrink-0 rounded-md bg-rose-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-40"
        >
          {label}
        </button>
        <button
          onClick={() => setConfirm(null)}
          className="shrink-0 rounded-md border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/60 hover:border-ink/30"
        >
          Cancel
        </button>
      </div>
    );
  }

  const primaryBtn =
    "flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40";
  const quietBtn =
    "flex items-center justify-center gap-1 rounded-md border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/60 transition-colors hover:border-ink/30 disabled:opacity-40";

  return (
    <div
      className="fixed inset-0 z-[2000] flex justify-end bg-ink/25"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${action.ticketId ? `${action.ticketId} — ` : ""}${p.title || "Task detail"}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
        className="flex h-full w-full max-w-xl flex-col border-l border-ink/10 bg-surface shadow-lg focus-visible:outline-none"
      >
        {/* Header: ticket + state + close. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-ink/10 px-4 py-3">
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
              className={`${CHIP_BASE} bg-amber-500/10 text-amber-600 dark:text-amber-400`}
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
                className="w-full rounded-md border border-ink/15 bg-surface px-2.5 py-1.5 text-sm font-semibold text-ink outline-none placeholder:text-ink/30 focus:border-accent/50 focus:ring-2 focus:ring-accent/40"
              />
              <textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                placeholder="Brief: what, why, acceptance criteria (optional)"
                rows={10}
                className="w-full resize-y rounded-md border border-ink/15 bg-surface px-2.5 py-1.5 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink/30 focus:border-accent/50 focus:ring-2 focus:ring-accent/40"
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
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink/50">
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
                      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-ink/50">
                        {link.kind}
                      </span>
                      <span className="truncate">{link.label}</span>
                    </span>
                  ) : (
                    <span
                      key={id}
                      title="Linked item is not on this canvas (deleted, or from another surface)"
                      className="inline-flex max-w-full items-center gap-1 rounded-[4px] border border-dashed border-ink/15 px-1.5 py-0.5 font-code text-[10px] text-ink/50"
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
                <span className="text-[11px] text-ink/50" title={fullDate(action.claimedAt)}>
                  {action.state === "executing" ? "working for" : "claimed"} {ageOf(action.claimedAt)}
                  {action.state === "executing" ? "" : " ago"}
                </span>
              )}
            </div>
          )}

          {/* Result — commit hashes surfaced as monospace chips. */}
          {action.result && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink/50">
                Result
              </div>
              <p className="whitespace-pre-wrap rounded-md bg-emerald-500/10 px-2.5 py-2 text-[12.5px] leading-relaxed text-emerald-700 dark:text-emerald-300">
                {action.result}
              </p>
              {commits.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {commits.map((c) => (
                    <span
                      key={c}
                      title="Commit referenced in the result"
                      className="inline-flex items-center gap-1 rounded-[4px] border border-emerald-600/20 bg-emerald-500/10 px-1.5 py-0.5 font-code text-[10.5px] text-emerald-600 dark:text-emerald-400"
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
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink/50">
                {action.state === "failed" ? "Error" : "Rejection reason"}
              </div>
              <p className="whitespace-pre-wrap rounded-md bg-rose-500/10 px-2.5 py-2 text-[12.5px] leading-relaxed text-rose-700 dark:text-rose-300">
                {action.error}
              </p>
            </div>
          )}

          {/* Provenance + timestamps. */}
          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-ink/10 pt-3 text-[11px] text-ink/50">
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
          <div className="shrink-0 border-t border-ink/10 px-4 py-3">
            {error && (
              <div className="mb-2 rounded-md border border-rose-500/20 bg-rose-500/10 px-2.5 py-1.5 text-[12px] text-rose-600 dark:text-rose-400">
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
                        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                          p.requiresApproval
                            ? "border-accent bg-accent"
                            : "border-ink/25 bg-transparent"
                        }`}
                      >
                        {p.requiresApproval && <Check size={10} className="text-white" />}
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
            {/* Delete — available in every state. Quiet by default, two-step
                like the other destructive moves. */}
            {isTask &&
              (confirm === "delete" ? (
                <div className="mt-2">
                  {confirmStrip("delete", "Delete this task for everyone?", "Delete", doDelete)}
                </div>
              ) : (
                <button
                  onClick={() => setConfirm("delete")}
                  disabled={busy}
                  className="mt-2 flex w-full items-center justify-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-ink/40 transition-colors hover:bg-rose-500/10 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 dark:hover:text-rose-400"
                >
                  <Trash2 size={12} /> Delete task
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
