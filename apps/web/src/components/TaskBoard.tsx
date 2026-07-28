import { useEffect, useMemo, useState } from "react";
import { Bot, Check, Layers, User, X, Zap } from "lucide-react";
import type { Action, ActionState, CanvasState, EpicPayload, TaskPayload } from "../types";
import { approveAction, rejectAction } from "../lib/api";
import posthog from "../lib/posthog";

/* ─────────────────────────────────────────────────────────────────────────────
   TaskBoard — the full-page task surface, opened from the pinned "Board" tab.

   Two projections of the same Action rows (type "task" / "epic"):
     · By state — a kanban: Proposed / Ready / Working / Done / Failed+Rejected.
     · By epic  — swimlanes per epic with an n/m-done progress bar (the "watch
       the project move forward" view), epicless tasks in a final lane.

   Everything renders from the same version-gated canvas-state props as every
   other view, so claims/completions move cards live over WS — no polling, no
   local task cache. Mutations (approve / reject) are the existing REST calls;
   fresh state comes back over the broadcast like everywhere else.

   Card click opens a thin READ-ONLY detail popover (wave 1) — a later task
   builds the full detail / step-in view, so keep TaskDetail small and cleanly
   replaceable.
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
// the detail popover doesn't fire.
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
  const tasksByEpic = useMemo(() => {
    const m = new Map<string, Action[]>();
    for (const t of tasks) {
      const eid = taskPayload(t).epicId;
      if (eid && epicIds.has(eid)) m.set(eid, [...(m.get(eid) ?? []), t]);
    }
    return m;
  }, [tasks, epicIds]);
  // No epic, or a dangling epicId — these flow into the final "No epic" lane.
  const epicless = useMemo(
    () =>
      tasks.filter((t) => {
        const eid = taskPayload(t).epicId;
        return !eid || !epicIds.has(eid);
      }),
    [tasks, epicIds],
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

  // The popover reads the LIVE action from state (not a snapshot), so a claim
  // or completion landing over WS updates it in place; a deleted task closes it.
  const detail = detailId ? (state.actions ?? {})[detailId] : undefined;
  useEffect(() => {
    if (detailId && !detail) setDetailId(null);
  }, [detailId, detail]);
  useEffect(() => {
    if (!detailId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailId]);

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

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* Toolbar: projection toggle + a quiet census. */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ink/5 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-semibold text-ink">Board</span>
          {!empty && (
            <span className="hidden font-code text-[11px] text-ink/40 sm:inline">
              {tasks.length} task{tasks.length === 1 ? "" : "s"}
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
           column scrolls its own cards. Empty columns collapse to a slim rail. */
        <div className="min-h-0 flex-1 overflow-x-auto">
          <div className="flex h-full gap-3 px-4 py-3">
            {COLUMNS.map((col) => {
              const colTasks = tasks.filter((t) => col.states.includes(t.state));
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
                      className={`truncate text-[11px] font-semibold uppercase tracking-[0.12em] ${slim ? "text-ink/30" : "text-ink/55"}`}
                    >
                      {col.label}
                    </span>
                    <span className="shrink-0 font-code text-[10px] text-ink/35">
                      {colTasks.length}
                    </span>
                  </div>
                  {slim ? (
                    <div className="flex-1 rounded-xl border border-dashed border-ink/10" />
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2 pr-0.5">
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
           epicless work bringing up the rear. */
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-3">
            {epics.map((e) => renderLane(e, tasksByEpic.get(e.id) ?? []))}
            {epicless.length > 0 && renderLane(null, epicless)}
            {epics.length === 0 && epicless.length === 0 && (
              <p className="py-6 text-center text-[13px] text-ink/40">Nothing to show.</p>
            )}
          </div>
        </div>
      )}

      {/* Thin read-only detail popover (wave 1) — replaced by the full detail /
          step-in view in a later task. Deliberately small. */}
      {detail && (
        <div
          className="fixed inset-0 z-[2000] flex items-center justify-center bg-ink/20 p-4 backdrop-blur-[2px]"
          onClick={() => setDetailId(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl border border-ink/10 bg-surface p-4 shadow-xl shadow-ink/10"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                {detail.ticketId && (
                  <span className="shrink-0 font-code text-[11px] font-medium tracking-tight text-ink/45">
                    {detail.ticketId}
                  </span>
                )}
                <StateChip state={detail.state} />
              </div>
              <button
                onClick={() => setDetailId(null)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink/70"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
            <h2 className="mt-1.5 text-[15px] font-semibold leading-snug text-ink">
              {(taskPayload(detail).title ?? epicPayload(detail).title) || "Untitled"}
            </h2>
            {(detail.payload as TaskPayload | EpicPayload | undefined)?.body && (
              <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink/65">
                {(detail.payload as TaskPayload).body}
              </p>
            )}
            {detail.type === "task" && taskPayload(detail).epicId && (
              <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-ink/50">
                <Layers size={11} className="shrink-0" />
                <span className="truncate">
                  {epicTitleById.get(taskPayload(detail).epicId!) ?? "Unknown epic"}
                </span>
              </div>
            )}
            {detail.state === "executing" && detail.claimedBy && (
              <div className="mt-2.5">
                <ClaimantChip name={detail.claimedBy} />
                {detail.claimedAt && (
                  <span className="ml-1.5 text-[10px] text-ink/35">
                    since {ageOf(detail.claimedAt)} ago
                  </span>
                )}
              </div>
            )}
            {detail.state === "done" && detail.result && (
              <p className="mt-2.5 rounded-lg bg-emerald-50 px-2.5 py-2 text-[12px] leading-snug text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                {detail.result}
              </p>
            )}
            {(detail.state === "failed" || detail.state === "rejected") && detail.error && (
              <p className="mt-2.5 rounded-lg bg-rose-50 px-2.5 py-2 text-[12px] leading-snug text-rose-800 dark:bg-rose-950 dark:text-rose-200">
                {detail.error}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-ink/5 pt-2.5 text-[10.5px] text-ink/40">
              <span className="inline-flex items-center gap-1">
                {detail.type === "task" && taskPayload(detail).assignee === "human" ? (
                  <>
                    <User size={10} /> your todo
                  </>
                ) : (
                  <>
                    <Bot size={10} /> by {detail.proposedBy}
                  </>
                )}
              </span>
              {detail.approvedBy && <span>· approved by {detail.approvedBy}</span>}
              <span className="ml-auto" title={fullDate(detail.createdAt)}>
                created {ageOf(detail.createdAt)} ago
              </span>
            </div>
            {renderApproveReject(detail, detail.type === "epic" ? "Approve epic" : "Approve")}
          </div>
        </div>
      )}
    </div>
  );
}
