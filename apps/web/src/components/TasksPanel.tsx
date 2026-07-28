import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import posthog from "../lib/posthog";
import { Bot, Check, ChevronDown, ChevronRight, ChevronsLeft, ChevronUp, Layers, Link2, Pencil, Plus, RotateCcw, Trash2, User, X } from "lucide-react";
import type { Action, CanvasState, EpicPayload, TaskPayload } from "../types";
import {
  approveAction,
  approveBatch,
  createTask,
  deleteTask,
  rejectAction,
  releaseTask,
  updateTask,
  type TaskDraft,
} from "../lib/api";
import { epicLifecycle } from "../lib/epicLifecycle";

/* ─────────────────────────────────────────────────────────────────────────────
   TasksPanel — the work queue.

   Tasks are Action rows of type "task" ({title, body?, linkedIds?, assignee}).
   assignee splits the queue: "agent" tasks are what agent sessions pull over
   MCP; "human" tasks are your own todos and never reach the agent queue.
   Humans author tasks here (born approved — the gate exists for agent-proposed
   work); agent-proposed ones show Approve / Reject. All mutations are REST with
   the canvas JWT; state comes back over the WS full-state broadcast like every
   other entity, so the panel just re-renders from props. Desktop-only v1.
   ──────────────────────────────────────────────────────────────────────────── */

const STATE_CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  proposed:  { label: "Proposed",  bg: "#F59E0B1A", fg: "#B45309" },
  approved:  { label: "Ready",     bg: "#0EA5E91A", fg: "#0369A1" },
  executing: { label: "Working",   bg: "#8B5CF61A", fg: "#6D28D9" },
  done:      { label: "Done",      bg: "#10B9811A", fg: "#047857" },
  failed:    { label: "Failed",    bg: "#F43F5E1A", fg: "#BE123C" },
  rejected:  { label: "Rejected",  bg: "#1111110D", fg: "#57534E" },
};

function taskPayload(a: Action): TaskPayload {
  return (a.payload ?? {}) as TaskPayload;
}

// A pickable link target: any roadmap item or note on the canvas.
interface LinkTarget {
  id: string;
  kind: "roadmap" | "note";
  label: string;
}

function linkTargets(state: CanvasState): LinkTarget[] {
  const roadmap = Object.values(state.roadmapItems ?? {}).map((r) => ({
    id: r.id,
    kind: "roadmap" as const,
    label: r.title || "Untitled goal",
  }));
  const notes = Object.values(state.notes ?? {}).map((n) => ({
    id: n.id,
    kind: "note" as const,
    label: (n.body ?? "").split("\n")[0].replace(/^#+\s*/, "").slice(0, 60) || "Untitled note",
  }));
  return [...roadmap, ...notes];
}

export default function TasksPanel({
  code,
  state,
  readOnly,
  onClose,
}: {
  code: string;
  state: CanvasState;
  readOnly: boolean;
  onClose: () => void;
}) {
  const [composing, setComposing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // TDM-9 age-out: finished/rejected epic groups collapse to a one-line
  // header; ids here are the ones the user expanded (per-session only).
  const [openEpics, setOpenEpics] = useState<Set<string>>(new Set());

  const tasks = useMemo(
    () =>
      Object.values(state.actions ?? {})
        .filter((a) => a.type === "task")
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [state.actions],
  );

  // Epics: batches of tasks approved as one unit. Tasks referencing an epic
  // (payload.epicId) render grouped under it; the rest keep the flat sections.
  const epics = useMemo(
    () =>
      Object.values(state.actions ?? {})
        .filter((a) => a.type === "epic")
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [state.actions],
  );
  const tasksByEpic = useMemo(() => {
    const m = new Map<string, Action[]>();
    for (const t of tasks) {
      const eid = taskPayload(t).epicId;
      if (eid) m.set(eid, [...(m.get(eid) ?? []), t]);
    }
    return m;
  }, [tasks]);
  const epicIds = useMemo(() => new Set(epics.map((e) => e.id)), [epics]);
  // Tasks with no epic (or a dangling epicId) flow through the classic sections.
  const ungrouped = tasks.filter((t) => {
    const eid = taskPayload(t).epicId;
    return !eid || !epicIds.has(eid);
  });

  const queue = ungrouped.filter((t) => t.state === "proposed" || t.state === "approved");
  const active = ungrouped.filter((t) => t.state === "executing");
  const finished = ungrouped.filter((t) => t.state === "done" || t.state === "failed" || t.state === "rejected");

  const targets = useMemo(() => linkTargets(state), [state]);
  const targetLabel = useMemo(() => new Map(targets.map((t) => [t.id, t.label])), [targets]);

  // ── Bulk selection + keyboard triage ───────────────────────────────────────
  // selected drives the sticky "Approve N" bar (ONE approve-batch call, not N
  // approves); focusedId is the j/k keyboard cursor; pendingApproved is the
  // optimistic overlay — cards we've told the server to approve render as
  // Ready immediately, and the WS broadcast (or the error path) settles them.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [pendingApproved, setPendingApproved] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const lastPickedRef = useRef<string | null>(null);
  // Root ref for the keyboard-triage focus guard: bare-key shortcuts must not
  // fire while the user is interacting with another surface (e.g. the Board's
  // detail panel, where a focused <button> passes the input-tag check).
  const panelRef = useRef<HTMLDivElement>(null);

  // Every still-proposed task id in display order (epic groups first, then the
  // flat queue) — the universe for select-all, shift-ranges, and j/k movement.
  const proposedIds = useMemo(() => {
    const ids: string[] = [];
    for (const e of epics) {
      for (const t of tasksByEpic.get(e.id) ?? []) if (t.state === "proposed") ids.push(t.id);
    }
    for (const t of tasks) {
      const eid = taskPayload(t).epicId;
      if ((!eid || !epicIds.has(eid)) && t.state === "proposed") ids.push(t.id);
    }
    return ids;
  }, [tasks, epics, tasksByEpic, epicIds]);

  // A card that left 'proposed' (WS confirmed the approve, or it was rejected/
  // deleted elsewhere) drops out of selection and the optimistic overlay, so
  // neither set accumulates stale ids.
  useEffect(() => {
    const live = new Set(proposedIds);
    const prune = (prev: Set<string>) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    };
    setSelected(prune);
    setPendingApproved(prune);
  }, [proposedIds]);

  function toggleSelect(id: string, shiftKey: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      const anchor = lastPickedRef.current;
      // Shift extends from the last picked card through this one (Gmail-style).
      if (shiftKey && anchor && anchor !== id) {
        const a = proposedIds.indexOf(anchor);
        const b = proposedIds.indexOf(id);
        if (a !== -1 && b !== -1) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(proposedIds[i]);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastPickedRef.current = id;
    setFocusedId(id);
  }

  async function approveMany(ids: string[]) {
    const batch = ids.filter((id) => !pendingApproved.has(id));
    if (batch.length === 0 || batchBusy || readOnly) return;
    setBatchBusy(true);
    setError(null);
    // Optimistic: flip the cards to Ready now; revert on failure.
    setPendingApproved((prev) => new Set([...prev, ...batch]));
    setSelected(new Set());
    try {
      const { approved, skipped } = await approveBatch(code, batch);
      // Skipped ids never flipped server-side — and an all-skipped batch sends
      // NO broadcast, so nothing would ever prune them from the overlay. Drop
      // them now or they render "Ready" forever.
      if (skipped.length > 0) {
        setPendingApproved((prev) => {
          const next = new Set(prev);
          for (const id of skipped) next.delete(id);
          return next;
        });
      }
      posthog.capture("agent_tasks_batch_approved", {
        canvas_code: code,
        requested: batch.length,
        approved: approved.length,
      });
    } catch (err) {
      setPendingApproved((prev) => {
        const next = new Set(prev);
        for (const id of batch) next.delete(id);
        return next;
      });
      setError(err instanceof Error ? err.message : "Could not approve tasks");
    } finally {
      setBatchBusy(false);
    }
  }

  // Keyboard triage: j/k move the focus cursor through proposed cards, x
  // toggles selection, a approves the selection (or just the focused card).
  // No deps array on purpose — re-binding each render keeps the closures fresh.
  useEffect(() => {
    if (readOnly) return;
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Only act when no OTHER surface owns focus: allow body/document focus
      // (plain browsing) or focus inside this panel; anything else — a button
      // in the Board's slide-over, a dialog — means bare keys aren't ours.
      const active = document.activeElement;
      if (
        active &&
        active !== document.body &&
        active !== document.documentElement &&
        !panelRef.current?.contains(active)
      )
        return;
      if (e.key === "j" || e.key === "k") {
        if (proposedIds.length === 0) return;
        e.preventDefault();
        const idx = focusedId ? proposedIds.indexOf(focusedId) : -1;
        const next = e.key === "j" ? Math.min(idx + 1, proposedIds.length - 1) : Math.max(idx - 1, 0);
        setFocusedId(proposedIds[next]);
      } else if (e.key === "x") {
        if (!focusedId || !proposedIds.includes(focusedId)) return;
        e.preventDefault();
        toggleSelect(focusedId, e.shiftKey);
      } else if (e.key === "a") {
        const ids =
          selected.size > 0
            ? [...selected]
            : focusedId && proposedIds.includes(focusedId)
              ? [focusedId]
              : [];
        if (ids.length === 0) return;
        e.preventDefault();
        void approveMany(ids);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Keep the keyboard cursor visible as j/k walk past the fold.
  useEffect(() => {
    if (!focusedId) return;
    document.querySelector(`[data-task-id="${focusedId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focusedId]);

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

  function renderTask(t: Action) {
    if (editingId === t.id) {
      const p = taskPayload(t);
      return (
        <div key={t.id} className="rounded-xl border border-ink/20 bg-surface p-2.5">
          <Composer
            targets={targets}
            initial={{
              title: p.title ?? "",
              body: p.body,
              linkedIds: p.linkedIds,
              assignee: p.assignee,
              // updateTask REPLACES the payload server-side — dropping these
              // would silently detach the task from its epic / void its
              // self-flag (the board editor round-trips them identically).
              epicId: p.epicId,
              requiresApproval: p.requiresApproval,
            }}
            submitLabel="Save"
            onCancel={() => setEditingId(null)}
            onSubmit={async (draft) => {
              await updateTask(code, t.id, draft);
              setEditingId(null);
            }}
          />
        </div>
      );
    }
    // Optimistic overlay: a card in a fired batch renders as Ready immediately;
    // the WS broadcast makes it real (or the approveMany error path reverts).
    const view: Action = pendingApproved.has(t.id) && t.state === "proposed" ? { ...t, state: "approved" } : t;
    const editable = !readOnly && (view.state === "proposed" || view.state === "approved");
    const selectable = !readOnly && view.state === "proposed";
    return (
      <TaskCard
        key={t.id}
        task={view}
        labelFor={targetLabel}
        selectable={selectable}
        selected={selectable && selected.has(t.id)}
        focused={focusedId === t.id}
        onToggleSelect={selectable ? (shiftKey) => toggleSelect(t.id, shiftKey) : undefined}
        onEdit={editable ? () => setEditingId(t.id) : undefined}
        onDelete={!readOnly ? () => setDeletingId(t.id) : undefined}
      >
        {deletingId === t.id ? (
          <DeleteConfirm
            busy={busyId === t.id}
            onCancel={() => setDeletingId(null)}
            onConfirm={() =>
              void run(t.id, async () => {
                await deleteTask(code, t.id);
                setDeletingId(null);
              })
            }
          />
        ) : view.state === "proposed" && !readOnly ? (
          rejectingId === t.id ? (
            <RejectForm
              busy={busyId === t.id}
              onCancel={() => setRejectingId(null)}
              onConfirm={(reason) =>
                void run(t.id, async () => {
                  await rejectAction(code, t.id, reason || undefined);
                  setRejectingId(null);
                })
              }
            />
          ) : (
            <div className="mt-2 flex gap-1.5">
              <button
                onClick={() => void run(t.id, async () => {
                  await approveAction(code, t.id);
                  posthog.capture("agent_task_approved", { canvas_code: code, task_title: taskPayload(t).title });
                })}
                disabled={busyId === t.id}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-ink px-2 py-1.5 text-xs font-semibold text-paper transition-opacity disabled:opacity-40"
              >
                <Check size={13} /> Approve
              </button>
              <button
                onClick={() => setRejectingId(t.id)}
                disabled={busyId === t.id}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-ink/15 px-2 py-1.5 text-xs font-medium text-ink/60 transition-colors hover:border-ink/30 disabled:opacity-40"
              >
                <X size={13} /> Reject
              </button>
            </div>
          )
        ) : view.state === "executing" && !readOnly ? (
          // Stuck-claim escape hatch: an executing task whose agent session
          // died goes back to the queue with its claim cleared. Human-only —
          // agents have no tool for this endpoint.
          <button
            onClick={() => void run(t.id, async () => releaseTask(code, t.id))}
            disabled={busyId === t.id}
            title="Return this task to the queue and clear its claim (for when the agent session died mid-task)"
            className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-ink/15 px-2 py-1.5 text-xs font-medium text-ink/60 transition-colors hover:border-ink/30 disabled:opacity-40"
          >
            <RotateCcw size={13} /> Release
          </button>
        ) : null}
      </TaskCard>
    );
  }

  // An epic group: header (title + state + one-shot approval) above its tasks.
  // Approving the epic server-side batch-approves its proposed tasks, so the
  // whole batch flips to Ready on the next state push.
  function renderEpicGroup(epic: Action) {
    const p = (epic.payload ?? {}) as EpicPayload;
    const children = tasksByEpic.get(epic.id) ?? [];
    const done = children.filter((t) => t.state === "done").length;
    // TDM-9 age-out: a finished (approved + all tasks terminal) or rejected
    // epic collapses to a one-line header until expanded on demand.
    const lifecycle = epicLifecycle(epic, children);
    const retired = lifecycle !== "active";
    const open = openEpics.has(epic.id);
    const chip = STATE_CHIP[lifecycle === "finished" ? "done" : epic.state] ?? STATE_CHIP.proposed;
    const toggleOpen = () =>
      setOpenEpics((prev) => {
        const next = new Set(prev);
        if (next.has(epic.id)) next.delete(epic.id);
        else next.add(epic.id);
        return next;
      });
    if (retired && !open) {
      return (
        <button
          key={epic.id}
          onClick={toggleOpen}
          title={p.body || p.title}
          className="mb-1.5 flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left opacity-60 transition-opacity hover:opacity-100"
        >
          <ChevronRight size={12} className="shrink-0 text-ink/40" />
          <Layers size={12} className="shrink-0 text-ink/40" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink/75">
            {p.title || "Untitled epic"}
          </span>
          <span className="shrink-0 text-[10px] text-ink/35">
            {done}/{children.length}
          </span>
          <span
            className="shrink-0 rounded-[4px] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em]"
            style={{ backgroundColor: chip.bg, color: chip.fg }}
          >
            {chip.label}
          </span>
        </button>
      );
    }
    return (
      <div key={epic.id} className="mb-3">
        <div className="mb-1.5 flex items-center gap-1.5 px-1">
          {retired && (
            <button
              onClick={toggleOpen}
              title="Collapse"
              className="shrink-0 text-ink/40 transition-colors hover:text-ink/70"
            >
              <ChevronDown size={12} />
            </button>
          )}
          <Layers size={12} className="shrink-0 text-ink/40" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink/75" title={p.body || p.title}>
            {p.title || "Untitled epic"}
          </span>
          {children.length > 0 && (
            <span className="shrink-0 text-[10px] text-ink/35">
              {done}/{children.length}
            </span>
          )}
          <span
            className="shrink-0 rounded-[4px] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em]"
            style={{ backgroundColor: chip.bg, color: chip.fg }}
          >
            {chip.label}
          </span>
        </div>
        {epic.state === "proposed" && !readOnly && (
          <div className="mb-1.5 px-1">
            {rejectingId === epic.id ? (
              <RejectForm
                busy={busyId === epic.id}
                onCancel={() => setRejectingId(null)}
                onConfirm={(reason) =>
                  void run(epic.id, async () => {
                    await rejectAction(code, epic.id, reason || undefined);
                    setRejectingId(null);
                  })
                }
              />
            ) : (
              <div className="flex gap-1.5">
                <button
                  onClick={() =>
                    void run(epic.id, async () => {
                      await approveAction(code, epic.id);
                      posthog.capture("epic_approved", { canvas_code: code, epic_title: p.title });
                    })
                  }
                  disabled={busyId === epic.id}
                  title="Approves the epic and every proposed task under it"
                  className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-ink px-2 py-1.5 text-xs font-semibold text-paper transition-opacity disabled:opacity-40"
                >
                  <Check size={13} /> Approve epic
                </button>
                <button
                  onClick={() => setRejectingId(epic.id)}
                  disabled={busyId === epic.id}
                  className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-ink/15 px-2 py-1.5 text-xs font-medium text-ink/60 transition-colors hover:border-ink/30 disabled:opacity-40"
                >
                  <X size={13} /> Reject
                </button>
              </div>
            )}
          </div>
        )}
        {children.length > 0 ? (
          <div className="flex flex-col gap-1.5">{children.map(renderTask)}</div>
        ) : (
          <p className="px-1 text-[11px] text-ink/35">No tasks under this epic yet.</p>
        )}
      </div>
    );
  }

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-ink/10 px-3 py-3 pl-4">
        <span className="text-sm font-semibold text-ink">Tasks</span>
        <div className="flex items-center gap-1">
          {!readOnly && !composing && (
            <button
              onClick={() => setComposing(true)}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink/80"
            >
              <Plus size={14} /> New task
            </button>
          )}
          <button
            onClick={onClose}
            title="Hide tasks"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink/35 transition-colors hover:bg-ink/5 hover:text-ink/60"
          >
            <ChevronsLeft size={16} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {composing && (
        <div className="border-b border-ink/10 p-3">
          <Composer
            targets={targets}
            onCancel={() => setComposing(false)}
            onSubmit={async (draft) => {
              await createTask(code, draft);
              setComposing(false);
            }}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && (
          <div className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[12px] text-rose-700">
            {error}
          </div>
        )}

        {/* Bulk triage entry point: with several proposed cards, select them all
            and approve in one shot. Keyboard: j/k move, x select, a approve. */}
        {!readOnly && proposedIds.length > 1 && (
          <div className="mb-2 flex items-center justify-between rounded-lg border border-ink/10 bg-ink/[0.03] px-2.5 py-1.5">
            <span className="text-[11px] text-ink/50" title="Keyboard: j/k move focus · x select · a approve">
              {proposedIds.length} awaiting approval
            </span>
            <button
              onClick={() => {
                setSelected(new Set(proposedIds));
                lastPickedRef.current = proposedIds[proposedIds.length - 1] ?? null;
              }}
              className="text-[11px] font-semibold text-ink/60 transition-colors hover:text-ink"
            >
              Select all proposed
            </button>
          </div>
        )}

        {tasks.length === 0 && epics.length === 0 && !composing && (
          <p className="px-1 py-2 text-[12px] leading-relaxed text-ink/45">
            No tasks yet. Write one here for an agent session to pick up, or ask your agent to
            draft some for your approval.
          </p>
        )}

        {epics.length > 0 && (
          <div className="mb-3">
            <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/35">
              Epics · {epics.length}
            </div>
            {epics.map(renderEpicGroup)}
          </div>
        )}

        <Section title="Queue" tasks={queue}>
          {renderTask}
        </Section>
        <Section title="In progress" tasks={active}>
          {renderTask}
        </Section>
        <Section title="Done" tasks={finished}>
          {renderTask}
        </Section>
      </div>

      {/* Sticky batch bar: ONE approve-batch request for the whole selection. */}
      {!readOnly && selected.size > 0 && (
        <div className="sticky bottom-0 flex items-center gap-1.5 border-t border-ink/10 bg-surface p-2.5">
          <button
            onClick={() => void approveMany([...selected])}
            disabled={batchBusy}
            title="Approve every selected task in one batch (keyboard: a)"
            className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-ink px-2 py-1.5 text-xs font-semibold text-paper transition-opacity disabled:opacity-40"
          >
            <Check size={13} /> {batchBusy ? "Approving…" : `Approve ${selected.size}`}
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/60 transition-colors hover:border-ink/30"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  tasks,
  children,
}: {
  title: string;
  tasks: Action[];
  children: (t: Action) => React.ReactNode;
}) {
  if (tasks.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/35">
        {title} · {tasks.length}
      </div>
      <div className="flex flex-col gap-1.5">{tasks.map(children)}</div>
    </div>
  );
}

// Who the task is FOR — the load-bearing visual split of the queue.
function AssigneeChip({ assignee }: { assignee?: "agent" | "human" }) {
  const isHuman = assignee === "human";
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-[4px] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em]"
      style={
        isHuman
          ? { backgroundColor: "#1111110A", color: "#57534E" }
          : { backgroundColor: "#0EA5E914", color: "#0369A1" }
      }
      title={isHuman ? "Your own todo — agents never pull this" : "Agent task — agent sessions pull this from the queue"}
    >
      {isHuman ? <User size={10} /> : <Bot size={10} />}
      {isHuman ? "You" : "Agent"}
    </span>
  );
}

// Task body: clamped to 3 lines by default, but expandable — the full brief
// (often a multi-paragraph spec) is otherwise unreadable. The "Show more"
// toggle only appears when the text actually overflows the clamp.
function TaskBody({ body }: { body: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return; // only measurable while clamped
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [body, expanded]);

  return (
    <div className="mt-1">
      <p
        ref={ref}
        onClick={() => overflows && setExpanded((v) => !v)}
        className={`whitespace-pre-wrap text-[12px] leading-snug text-ink/55 ${
          expanded ? "" : "line-clamp-3"
        } ${overflows ? "cursor-pointer" : ""}`}
      >
        {body}
      </p>
      {(overflows || expanded) && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 flex items-center gap-0.5 text-[11px] font-medium text-ink/40 transition-colors hover:text-ink/70"
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function TaskCard({
  task,
  labelFor,
  selectable,
  selected,
  focused,
  onToggleSelect,
  onEdit,
  onDelete,
  children,
}: {
  task: Action;
  labelFor: Map<string, string>;
  selectable?: boolean;
  selected?: boolean;
  focused?: boolean;
  onToggleSelect?: (shiftKey: boolean) => void;
  onEdit?: () => void;
  onDelete?: () => void;
  children?: React.ReactNode;
}) {
  const p = taskPayload(task);
  const chip = STATE_CHIP[task.state] ?? STATE_CHIP.proposed;
  const terminal = task.state === "done" || task.state === "failed" || task.state === "rejected";

  return (
    <div
      data-task-id={task.id}
      className={[
        "group/task rounded-xl border bg-surface p-2.5",
        selected ? "border-ink/45" : "border-ink/10",
        focused ? "ring-2 ring-ink/20" : "",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-start gap-1.5">
          {selectable && onToggleSelect && (
            <button
              onClick={(e) => onToggleSelect(e.shiftKey)}
              title={selected ? "Remove from selection" : "Select for batch approval (shift-click selects a range)"}
              className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border"
              style={{
                backgroundColor: selected ? "#111111" : "transparent",
                borderColor: selected ? "#111111" : "rgba(17,17,17,0.25)",
              }}
            >
              {selected && <Check size={10} color="#fff" />}
            </button>
          )}
          <span className={`text-[13px] font-semibold leading-snug ${terminal ? "text-ink/55" : "text-ink"}`}>
            {task.ticketId && (
              <span className="mr-1.5 font-mono text-[10px] font-medium tracking-tight text-ink/40">
                {task.ticketId}
              </span>
            )}
            {p.title || "Untitled task"}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {onEdit && (
            <button
              onClick={onEdit}
              title="Edit task"
              className="rounded-md p-0.5 text-ink/25 opacity-0 transition-opacity hover:bg-ink/5 hover:text-ink/60 group-hover/task:opacity-100"
            >
              <Pencil size={12} />
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              title="Delete task"
              className="rounded-md p-0.5 text-ink/25 opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-600 group-hover/task:opacity-100"
            >
              <Trash2 size={12} />
            </button>
          )}
          <span
            className="rounded-[4px] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em]"
            style={{ backgroundColor: chip.bg, color: chip.fg }}
          >
            {chip.label}
          </span>
        </span>
      </div>
      {p.body && <TaskBody body={p.body} />}
      {(p.linkedIds ?? []).length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {(p.linkedIds ?? []).map((id) => (
            <span
              key={id}
              className="inline-flex max-w-full items-center gap-1 rounded-[4px] border border-ink/10 bg-ink/[0.03] px-1.5 py-px text-[10px] text-ink/50"
            >
              <Link2 size={10} className="shrink-0" />
              <span className="truncate">{labelFor.get(id) ?? "missing link"}</span>
            </span>
          ))}
        </div>
      )}
      {task.state === "done" && task.result && (
        <p className="mt-1.5 rounded-lg bg-emerald-50 px-2 py-1.5 text-[12px] leading-snug text-emerald-800">
          {task.result}
        </p>
      )}
      {(task.state === "failed" || task.state === "rejected") && task.error && (
        <p className="mt-1.5 rounded-lg bg-rose-50 px-2 py-1.5 text-[12px] leading-snug text-rose-800">
          {task.error}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <AssigneeChip assignee={p.assignee} />
        <span className="text-[10px] text-ink/35">
          by {task.proposedBy}
          {task.state === "proposed" && " · awaiting approval"}
          {task.state === "executing" && task.claimedBy && ` · claimed by ${task.claimedBy}`}
        </span>
      </div>
      {children}
    </div>
  );
}

// Inline delete confirmation — a destructive action gets one guard tap, no
// native confirm() dialog (matches the reject flow's in-panel style).
function DeleteConfirm({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-2 flex items-center gap-1.5">
      <span className="flex-1 text-[12px] leading-snug text-ink/60">Delete this task?</span>
      <button
        onClick={onConfirm}
        disabled={busy}
        className="rounded-lg bg-rose-600 px-2.5 py-1.5 text-xs font-semibold text-white transition-opacity disabled:opacity-40"
      >
        Delete
      </button>
      <button
        onClick={onCancel}
        className="rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/60 hover:border-ink/30"
      >
        Cancel
      </button>
    </div>
  );
}

// Inline reject-reason form — replaces the browser's native prompt dialog.
function RejectForm({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onConfirm(reason.trim());
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Why reject? (optional)"
        className="w-full rounded-lg border border-ink/15 bg-surface px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink/30 focus:border-ink/40"
      />
      <div className="flex gap-1.5">
        <button
          onClick={() => onConfirm(reason.trim())}
          disabled={busy}
          className="flex-1 rounded-lg bg-rose-600 px-2 py-1.5 text-xs font-semibold text-white transition-opacity disabled:opacity-40"
        >
          Reject task
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/60 hover:border-ink/30"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Composer({
  targets,
  initial,
  submitLabel = "Add task",
  onSubmit,
  onCancel,
}: {
  targets: LinkTarget[];
  initial?: TaskDraft;
  submitLabel?: string;
  onSubmit: (draft: TaskDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [assignee, setAssignee] = useState<"agent" | "human">(initial?.assignee ?? "agent");
  const [linked, setLinked] = useState<Set<string>>(new Set(initial?.linkedIds ?? []));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = initial !== undefined;

  function toggleLink(id: string) {
    setLinked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        // Preserve payload fields this editor doesn't surface (epicId,
        // requiresApproval, …) — the save REPLACES the payload wholesale.
        ...initial,
        title: title.trim(),
        body: body.trim() || undefined,
        linkedIds: linked.size > 0 ? [...linked] : undefined,
        assignee,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save task");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Who is this for? Agent tasks land in the agent queue; yours don't. */}
      <div className="flex rounded-lg border border-ink/10 bg-ink/[0.03] p-0.5">
        {(["agent", "human"] as const).map((a) => {
          const active = assignee === a;
          return (
            <button
              key={a}
              onClick={() => setAssignee(a)}
              className={[
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold transition-colors",
                active ? "bg-surface text-ink shadow-sm" : "text-ink/40 hover:text-ink/65",
              ].join(" ")}
            >
              {a === "agent" ? <Bot size={13} /> : <User size={13} />}
              {a === "agent" ? "For the agent" : "For me"}
            </button>
          );
        })}
      </div>
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder={assignee === "agent" ? "What should the agent do?" : "What do you need to do?"}
        className="w-full rounded-lg border border-ink/15 bg-surface px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink/30 focus:border-ink/40"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Brief: what, why, acceptance criteria (optional)"
        rows={3}
        className="w-full resize-none rounded-lg border border-ink/15 bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink/30 focus:border-ink/40"
      />

      {targets.length > 0 && (
        <div>
          <button
            onClick={() => setPickerOpen((o) => !o)}
            className="flex items-center gap-1 text-[11px] font-medium text-ink/45 hover:text-ink/70"
          >
            <Link2 size={12} />
            {linked.size > 0 ? `${linked.size} linked` : "Link roadmap items / notes"}
          </button>
          {pickerOpen && (
            <div className="mt-1.5 max-h-40 overflow-y-auto rounded-lg border border-ink/10 bg-ink/[0.02] p-1">
              {targets.map((t) => (
                <button
                  key={t.id}
                  onClick={() => toggleLink(t.id)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-ink/70 hover:bg-ink/5"
                >
                  <span
                    className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border"
                    style={{
                      backgroundColor: linked.has(t.id) ? "#111111" : "transparent",
                      borderColor: linked.has(t.id) ? "#111111" : "rgba(17,17,17,0.2)",
                    }}
                  >
                    {linked.has(t.id) && <Check size={10} color="#fff" />}
                  </span>
                  <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-ink/35">
                    {t.kind === "roadmap" ? "goal" : "note"}
                  </span>
                  <span className="truncate">{t.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <p className="text-[11px] text-rose-600">{error}</p>}

      <div className="flex gap-1.5">
        <button
          onClick={() => void submit()}
          disabled={!title.trim() || saving}
          className="flex-1 rounded-lg bg-ink px-3 py-1.5 text-sm font-semibold text-paper transition-opacity disabled:opacity-40"
        >
          {saving ? "Saving…" : submitLabel}
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg border border-ink/15 px-3 py-1.5 text-sm font-medium text-ink/60 hover:border-ink/30"
        >
          Cancel
        </button>
      </div>
      {!editing && (
        <p className="text-[10px] leading-snug text-ink/35">
          Your tasks are ready immediately — no approval needed. Agent sessions pull only
          “For the agent” tasks from the queue.
        </p>
      )}
    </div>
  );
}
