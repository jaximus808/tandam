import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DraggableAttributes,
} from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Bot, Check, Link2, Plus } from "lucide-react";
import type { Action, CanvasState, RoadmapItem, RoadmapStatus, TaskPayload } from "../types";
import { sendOp } from "../lib/ws";
import { createTask } from "../lib/api";
import EmptyState from "../components/EmptyState";
import { modeTheme } from "../lib/modeTheme";

const ACCENT = modeTheme("roadmap");

const INDENT_PX = 20;

const STATUS_LABELS: Record<RoadmapStatus, string> = {
  todo: "Todo",
  in_progress: "In progress",
  done: "Done",
  blocked: "Blocked",
};

const STATUS_CYCLE: RoadmapStatus[] = ["todo", "in_progress", "done", "blocked"];

// A task (action of type "task") linked back to a roadmap item, projected down to
// what the roadmap UI needs to show "has an open task" vs "still taskless".
interface LinkedTask {
  id: string;
  state: string;
}

// Shared down the tree so any roadmap row can offer "create agent task from this"
// without threading code/readOnly/handlers through every layer. openCreateTask
// pops the dialog at the RoadmapMode root; linkedTasks maps a roadmap item id to
// the tasks already pointing at it.
interface RoadmapTaskCtx {
  code: string;
  readOnly: boolean;
  linkedTasks: Map<string, LinkedTask[]>;
  openCreateTask: (item: RoadmapItem) => void;
}

const RoadmapTaskContext = createContext<RoadmapTaskCtx | null>(null);

// An agent-marked item is "taskless" until a still-actionable task links it — a
// done/failed/rejected task doesn't count, so the item can be re-tasked.
function hasOpenTask(linked: LinkedTask[]): boolean {
  return linked.some(
    (t) => t.state === "proposed" || t.state === "approved" || t.state === "executing",
  );
}

// In-app replacement for window.prompt when naming a phase — the native browser
// dialog shows "localhost says…" chrome and can't be styled or branded.
function PhaseNameDialog({
  title,
  hint,
  initial = "",
  submitLabel = "Save",
  allowEmpty = false,
  onSubmit,
  onClose,
}: {
  title: string;
  hint?: string;
  initial?: string;
  submitLabel?: string;
  allowEmpty?: boolean;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const canSubmit = allowEmpty || value.trim() !== "";
  function submit() {
    if (!canSubmit) return;
    onSubmit(value.trim());
    onClose();
  }
  return (
    <div className="fixed inset-0 z-[2000] flex items-start justify-center pt-[18vh]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink/25 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative w-[340px] max-w-[92vw] rounded-2xl border border-ink/10 bg-white p-4 shadow-[4px_6px_0_rgba(17,17,17,0.08)]">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
          placeholder="e.g. Now, Next, Later, v1, v2"
          className="mt-2.5 w-full rounded-lg border border-ink/15 bg-white px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink/30 focus:border-ink/40"
        />
        {hint && <p className="mt-1.5 text-[11px] leading-snug text-ink/40">{hint}</p>}
        <div className="mt-3 flex justify-end gap-1.5">
          <button
            onClick={onClose}
            className="rounded-lg border border-ink/15 px-3 py-1.5 text-sm font-medium text-ink/60 hover:border-ink/30"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-lg px-3.5 py-1.5 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
            style={{ backgroundColor: ACCENT.solid }}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface FlatItem {
  id: string;
  item: RoadmapItem;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  // Which phase section this row is rendered under (the root's stage). Used to
  // re-assign a goal's stage when it's dragged into a different section.
  sectionStage: string | null;
}

interface StageSection {
  stage: string | null;
  roots: RoadmapItem[];
  rows: FlatItem[];
}

interface Projection {
  parentId: string | null;
  depth: number;
}

interface Props {
  state: CanvasState;
  code: string;
  readOnly: boolean;
}

export default function RoadmapMode({ state, code, readOnly }: Props) {
  const items = state.roadmapItems;

  // Which roadmap items already have tasks pointing at them (via task
  // payload.linkedIds). Drives the "＋ Task" vs "✓ Task" affordance so a human
  // doesn't double-author and can see at a glance what's still taskless.
  const linkedTasks = useMemo(() => {
    const map = new Map<string, LinkedTask[]>();
    for (const a of Object.values(state.actions ?? {}) as Action[]) {
      if (a.type !== "task") continue;
      const p = a.payload as TaskPayload;
      for (const rid of p.linkedIds ?? []) {
        const arr = map.get(rid) ?? [];
        arr.push({ id: a.id, state: a.state });
        map.set(rid, arr);
      }
    }
    return map;
  }, [state.actions]);

  // The item a "create agent task" dialog is currently open for (null = closed).
  const [taskFor, setTaskFor] = useState<RoadmapItem | null>(null);

  const taskCtx = useMemo<RoadmapTaskCtx>(
    () => ({ code, readOnly, linkedTasks, openCreateTask: setTaskFor }),
    [code, readOnly, linkedTasks],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetX, setOffsetX] = useState(0);
  const [view, setView] = useState<"list" | "board">("board");

  // Top-level goals group into phase sections (by `stage`); each section's
  // subtree is flattened beneath its header. `flat` is the concatenation in
  // section order — dnd-kit sorts over it, headers render between sections.
  // While dragging, descendants of the active item are hidden — they ride along
  // with the moved subtree implicitly, so they shouldn't appear in the list.
  const sections = useMemo(
    () => flattenByStage(items, collapsed, activeId),
    [items, collapsed, activeId],
  );

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const flatIds = useMemo(() => flat.map((f) => f.id), [flat]);

  // Projected drop position — depth derived from horizontal drag offset, parent
  // inferred from depth + neighbors. Recomputed on every drag move.
  const projected: Projection | null = useMemo(() => {
    if (!activeId || !overId) return null;
    return projectDrop(flat, activeId, overId, offsetX, INDENT_PX);
  }, [activeId, overId, offsetX, flat]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveId(e.active.id as string);
    setOverId(e.active.id as string);
    setOffsetX(0);
  }

  function handleDragMove(e: DragMoveEvent) {
    setOffsetX(e.delta.x);
  }

  function handleDragOver(e: DragOverEvent) {
    setOverId((e.over?.id as string | undefined) ?? null);
  }

  function handleDragEnd(e: DragEndEvent) {
    const activeIdLocal = e.active.id as string;
    const overIdLocal = (e.over?.id as string | undefined) ?? null;
    const deltaX = e.delta.x;

    setActiveId(null);
    setOverId(null);
    setOffsetX(0);

    if (!overIdLocal) return;

    const activeIndex = flat.findIndex((f) => f.id === activeIdLocal);
    const overIndex = flat.findIndex((f) => f.id === overIdLocal);
    if (activeIndex < 0 || overIndex < 0) return;

    const proj = projectDrop(flat, activeIdLocal, overIdLocal, deltaX, INDENT_PX);

    // Cycle protection: can't make active a child of itself (or its descendants —
    // but descendants are already excluded from flat during drag, so the only
    // real case is parentId === active.id).
    if (proj.parentId === activeIdLocal) return;

    // Build a hypothetical "after-drop" flat list to renumber sort_orders.
    const moved = arrayMove(flat, activeIndex, overIndex).map((f) =>
      f.id === activeIdLocal
        ? { ...f, parentId: proj.parentId, depth: proj.depth }
        : f,
    );

    // Renumber sort_order per parent group, in the new flat order.
    const updates: { id: string; parentId: string | null; sortOrder: number }[] = [];
    const idxByParent = new Map<string | null, number>();
    for (const f of moved) {
      const idx = idxByParent.get(f.parentId) ?? 0;
      idxByParent.set(f.parentId, idx + 1);
      const existing = items[f.id];
      if (!existing) continue;
      const sameParent = (existing.parentId ?? null) === f.parentId;
      const sameOrder = existing.sortOrder === idx;
      if (!sameParent || !sameOrder) {
        updates.push({ id: f.id, parentId: f.parentId, sortOrder: idx });
      }
    }

    // If a top-level goal landed in a different phase section, re-file it under
    // that phase. Section membership is read off the neighbour in the new order
    // (every row carries its sectionStage); children inherit, so only roots move.
    let stageUpdate: string | undefined;
    if (proj.parentId === null) {
      const movedIdx = moved.findIndex((f) => f.id === activeIdLocal);
      const neighbour = movedIdx > 0 ? moved[movedIdx - 1] : moved[movedIdx + 1];
      const target = (neighbour?.sectionStage ?? "").trim() || null;
      const existing = (items[activeIdLocal]?.stage ?? "").trim() || null;
      if (target !== existing) stageUpdate = target ?? "";
    }

    if (updates.length > 0) {
      sendOp({ op: "roadmap.reorder", updates });
    }
    if (stageUpdate !== undefined) {
      sendOp({ op: "roadmap.update", id: activeIdLocal, partial: { stage: stageUpdate } });
    }
  }

  function handleDragCancel() {
    setActiveId(null);
    setOverId(null);
    setOffsetX(0);
  }

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function nextSortOrderFor(parentId: string | null): number {
    const siblings = Object.values(items).filter((i) => (i.parentId ?? null) === parentId);
    if (siblings.length === 0) return 0;
    return Math.max(...siblings.map((s) => s.sortOrder)) + 1;
  }

  function handleAddRoot() {
    sendOp({
      op: "roadmap.add",
      data: { title: "", body: "", status: "todo", sortOrder: nextSortOrderFor(null) },
    });
  }

  function handleAddChild(parentId: string) {
    setCollapsed((prev) => {
      if (!prev.has(parentId)) return prev;
      const next = new Set(prev);
      next.delete(parentId);
      return next;
    });
    sendOp({
      op: "roadmap.add",
      data: {
        parentId,
        title: "",
        body: "",
        status: "todo",
        sortOrder: nextSortOrderFor(parentId),
      },
    });
  }

  // Add a top-level goal directly into a phase section (or unstaged when null).
  function handleAddRootInStage(stage: string | null) {
    sendOp({
      op: "roadmap.add",
      data: {
        title: "",
        body: "",
        status: "todo",
        sortOrder: nextSortOrderFor(null),
        ...(stage ? { stage } : {}),
      },
    });
  }

  // Create a brand-new phase by seeding it with one (empty) goal.
  const [addPhaseOpen, setAddPhaseOpen] = useState(false);

  // Rename a phase: rewrite the stage on every top-level goal currently in it.
  function renameStage(oldStage: string, newStage: string) {
    const target = newStage.trim();
    for (const it of Object.values(items)) {
      if (!it.parentId && (it.stage ?? "").trim() === oldStage) {
        sendOp({ op: "roadmap.update", id: it.id, partial: { stage: target } });
      }
    }
  }

  // Dissolve a phase: unstage every goal in it (they fall into "No phase").
  function clearStage(stage: string) {
    for (const it of Object.values(items)) {
      if (!it.parentId && (it.stage ?? "").trim() === stage) {
        sendOp({ op: "roadmap.update", id: it.id, partial: { stage: "" } });
      }
    }
  }

  const isEmpty = Object.keys(items).length === 0;

  return (
    <RoadmapTaskContext.Provider value={taskCtx}>
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <div className="shrink-0 max-w-5xl mx-auto w-full px-4 pt-6 pb-3 sm:px-6">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <h1 className="font-display text-xl font-medium tracking-tight text-gray-900">Roadmap</h1>
            <ViewToggle view={view} onChange={setView} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => setAddPhaseOpen(true)}
              className="whitespace-nowrap text-sm px-3 py-1.5 rounded-lg font-medium border transition-colors"
              style={{ color: ACCENT.hover, borderColor: ACCENT.line, backgroundColor: ACCENT.soft }}
              title="Create a new phase (e.g. Now, Next, Later, v1, v2)"
            >
              + Phase
            </button>
            {addPhaseOpen && (
              <PhaseNameDialog
                title="New phase"
                hint="Phases group top-level goals into bands on the board."
                submitLabel="Create phase"
                onSubmit={handleAddRootInStage}
                onClose={() => setAddPhaseOpen(false)}
              />
            )}
            <button
              onClick={handleAddRoot}
              className="whitespace-nowrap text-sm px-3.5 py-1.5 rounded-lg text-white font-medium shadow-sm transition-opacity hover:opacity-90"
              style={{ backgroundColor: ACCENT.solid }}
            >
              + New item
            </button>
          </div>
        </div>

        <div className="flex items-center flex-wrap gap-x-4 gap-y-1 px-2 py-1.5 text-xs text-gray-500 bg-gray-100/70 rounded-md border border-gray-200">
          <span className="font-medium text-gray-600">Legend:</span>
          {STATUS_CYCLE.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <StatusIcon status={s} />
              <span>{STATUS_LABELS[s]}</span>
            </span>
          ))}
          <span className="ml-auto text-gray-400">
            {view === "board"
              ? "Click a title to edit · click a status icon to cycle · + adds a sub-item"
              : "Drag rows to reorder · drag across a phase to re-file · click icon to cycle"}
          </span>
        </div>
      </div>

      {isEmpty ? (
        <div className="max-w-3xl mx-auto w-full px-6">
          <EmptyState
            title="No roadmap items yet"
            hint="Click + New item to start, or ask Claude to outline a plan."
          />
        </div>
      ) : view === "board" ? (
        <RoadmapBoard items={items} />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto w-full px-6 pb-6">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragMove={handleDragMove}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <SortableContext items={flatIds} strategy={verticalListSortingStrategy}>
                <div className="text-sm">
                  {sections.map((section) => {
                    // Hide the header in the trivial "nothing staged yet" case so
                    // an unphased roadmap looks exactly like before.
                    const showHeader = sections.length > 1 || section.stage !== null;
                    return (
                      <div key={section.stage ?? "__none__"} className="mb-1">
                        {showHeader && (
                          <SectionHeader
                            stage={section.stage}
                            count={section.roots.length}
                            onRename={
                              section.stage
                                ? (name) => renameStage(section.stage as string, name)
                                : undefined
                            }
                            onClear={
                              section.stage ? () => clearStage(section.stage as string) : undefined
                            }
                            onAddGoal={() => handleAddRootInStage(section.stage)}
                          />
                        )}
                        <ul>
                          {section.rows.map((f) => {
                            const isActive = f.id === activeId;
                            const displayDepth = isActive && projected ? projected.depth : f.depth;
                            return (
                              <SortableRow
                                key={f.id}
                                flat={f}
                                displayDepth={displayDepth}
                                isActive={isActive}
                                collapsed={collapsed.has(f.id)}
                                onToggleCollapse={() => toggleCollapse(f.id)}
                                onAddChild={() => handleAddChild(f.id)}
                              />
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        </div>
      )}
    </div>
    {taskFor && (
      <CreateTaskDialog item={taskFor} code={code} onClose={() => setTaskFor(null)} />
    )}
    </RoadmapTaskContext.Provider>
  );
}

// ── View toggle ──────────────────────────────────────────────────────────────

function ViewToggle({
  view,
  onChange,
}: {
  view: "list" | "board";
  onChange: (v: "list" | "board") => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-xs font-medium">
      {(["board", "list"] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`px-2.5 py-1 capitalize transition-colors ${
            view === v ? "text-white" : "bg-white text-gray-600 hover:bg-gray-50"
          }`}
          style={view === v ? { backgroundColor: ACCENT.solid } : undefined}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

// ── Sortable row ─────────────────────────────────────────────────────────────

function SortableRow({
  flat,
  displayDepth,
  isActive,
  collapsed,
  onToggleCollapse,
  onAddChild,
}: {
  flat: FlatItem;
  displayDepth: number;
  isActive: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onAddChild: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: flat.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <li
      ref={setNodeRef}
      data-agent-target={flat.id}
      style={style}
      className={`relative ${isActive ? "z-10" : ""}`}
    >
      <Row
        item={flat.item}
        depth={displayDepth}
        hasChildren={flat.hasChildren}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        onAddChild={onAddChild}
        dragAttributes={attributes}
        dragListeners={listeners}
      />
    </li>
  );
}

function Row({
  item,
  depth,
  hasChildren,
  collapsed,
  onToggleCollapse,
  onAddChild,
  dragAttributes,
  dragListeners,
}: {
  item: RoadmapItem;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onAddChild: () => void;
  dragAttributes: DraggableAttributes;
  dragListeners: SyntheticListenerMap | undefined;
}) {
  const [editing, setEditing] = useState(item.title === "");
  const [draft, setDraft] = useState(item.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(item.title);
  }, [item.title]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const status = item.status as RoadmapStatus;

  function commit() {
    if (draft !== item.title) {
      sendOp({ op: "roadmap.update", id: item.id, partial: { title: draft } });
    }
    setEditing(false);
  }

  function cancel() {
    setDraft(item.title);
    setEditing(false);
  }

  const [phaseOpen, setPhaseOpen] = useState(false);

  function cycleStatus() {
    const i = STATUS_CYCLE.indexOf(status);
    const next = STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length];
    sendOp({ op: "roadmap.update", id: item.id, partial: { status: next } });
  }

  function handleDelete() {
    const msg = hasChildren
      ? "Delete this item and all its descendants?"
      : "Delete this item?";
    if (!confirm(msg)) return;
    sendOp({ op: "roadmap.delete", id: item.id });
  }

  return (
    <div
      className="group relative flex items-center gap-1.5 py-1 pr-2 rounded hover:bg-gray-50"
      style={{ paddingLeft: depth * INDENT_PX + 4 }}
    >
      {/* Indent guide lines for each ancestor depth */}
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          aria-hidden
          className="absolute top-0 bottom-0 w-px bg-gray-200"
          style={{ left: i * INDENT_PX + 14 }}
        />
      ))}
      {/* Horizontal tee connecting to this row */}
      {depth > 0 && (
        <span
          aria-hidden
          className="absolute h-px w-3 bg-gray-300"
          style={{ left: (depth - 1) * INDENT_PX + 14, top: 14 }}
        />
      )}

      {/* Drag handle */}
      <button
        {...dragAttributes}
        {...dragListeners}
        className="shrink-0 w-4 h-4 flex items-center justify-center text-gray-300 hover:text-gray-600 cursor-grab active:cursor-grabbing touch-none"
        aria-label="Drag to reorder"
        title="Drag to reorder"
      >
        <svg width="10" height="14" viewBox="0 0 10 14">
          <circle cx="3" cy="3" r="1" fill="currentColor" />
          <circle cx="7" cy="3" r="1" fill="currentColor" />
          <circle cx="3" cy="7" r="1" fill="currentColor" />
          <circle cx="7" cy="7" r="1" fill="currentColor" />
          <circle cx="3" cy="11" r="1" fill="currentColor" />
          <circle cx="7" cy="11" r="1" fill="currentColor" />
        </svg>
      </button>

      {/* Chevron disclosure (or spacer) */}
      {hasChildren ? (
        <button
          onClick={onToggleCollapse}
          className="shrink-0 w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-700"
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
          >
            <path
              d="M3 1.5 L 7 5 L 3 8.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : (
        <span className="shrink-0 w-4 h-4 inline-block" aria-hidden />
      )}

      <button
        onClick={cycleStatus}
        className="shrink-0 hover:opacity-80 transition-opacity"
        title={`${STATUS_LABELS[status]} — click to cycle`}
      >
        <StatusIcon status={status} />
      </button>

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          placeholder="Untitled item"
          className="flex-1 text-sm text-gray-900 bg-transparent focus:outline-none border-b border-blue-300"
        />
      ) : (
        <span
          onClick={() => setEditing(true)}
          className={`flex-1 cursor-text ${
            status === "done" ? "text-gray-500 line-through decoration-gray-400" : "text-gray-900"
          } ${hasChildren ? "font-medium" : ""}`}
        >
          {item.title || <span className="text-gray-400 italic font-normal">Untitled item</span>}
        </span>
      )}

      <AgentControls item={item} />

      {depth === 0 && (
        <button
          onClick={() => setPhaseOpen(true)}
          className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded transition-colors ${
            item.stage?.trim()
              ? ""
              : "opacity-0 group-hover:opacity-100 border border-dashed border-gray-300 text-gray-400 hover:text-gray-700"
          }`}
          style={item.stage?.trim() ? { backgroundColor: ACCENT.soft, color: ACCENT.hover } : undefined}
          title="Set the phase for this goal"
        >
          {item.stage?.trim() ? item.stage : "+ phase"}
        </button>
      )}
      {phaseOpen && (
        <PhaseNameDialog
          title="Phase for this goal"
          hint="Leave blank to remove it from its phase."
          initial={item.stage?.trim() ?? ""}
          allowEmpty
          onSubmit={(name) => sendOp({ op: "roadmap.update", id: item.id, partial: { stage: name } })}
          onClose={() => setPhaseOpen(false)}
        />
      )}

      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onAddChild}
          className="text-xs text-gray-500 hover:text-blue-600 px-1.5 py-0.5 rounded hover:bg-blue-50"
          title="Add child item"
        >
          + child
        </button>
        <button
          onClick={handleDelete}
          className="text-gray-400 hover:text-red-600 px-1.5 py-0.5 rounded hover:bg-red-50"
          title="Delete item"
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M3 3 L 9 9 M 9 3 L 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Board view (swimlanes) ───────────────────────────────────────────────────
//
// Each top-level goal is a column; its descendants are an indented list inside.
// Containment instead of drawn edges → no crossing-connector problem, and the
// horizontal axis is used by the (few) top-level goals while tasks stack down.
// A second view over the same roadmap items — no schema change.

const STATUS_ACCENT: Record<RoadmapStatus, string> = {
  todo: "bg-gray-300",
  in_progress: "bg-blue-400",
  done: "bg-green-400",
  blocked: "bg-red-400",
};

function childIndex(items: Record<string, RoadmapItem>): Map<string | null, RoadmapItem[]> {
  const byParent = new Map<string | null, RoadmapItem[]>();
  for (const it of Object.values(items)) {
    const key = it.parentId ?? null;
    const arr = byParent.get(key) ?? [];
    arr.push(it);
    byParent.set(key, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.sortOrder - b.sortOrder || a.updatedAt - b.updatedAt);
  }
  return byParent;
}

// Group top-level goals by their `stage` (phase) label. Staged bands come
// first, ordered by the smallest sortOrder among their members (so dragging a
// goal earlier pulls its phase up); the unstaged band sorts last. With nothing
// staged this returns a single null group → the board renders exactly as before.
function groupRootsByStage(
  roots: RoadmapItem[],
): { stage: string | null; roots: RoadmapItem[] }[] {
  const groups = new Map<string | null, RoadmapItem[]>();
  for (const r of roots) {
    const key = r.stage && r.stage.trim() ? r.stage.trim() : null;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  return Array.from(groups.entries())
    .map(([stage, rs]) => ({
      stage,
      roots: rs,
      minOrder: Math.min(...rs.map((r) => r.sortOrder)),
    }))
    .sort((a, b) => {
      if (a.stage === null) return 1;
      if (b.stage === null) return -1;
      return a.minOrder - b.minOrder || a.stage.localeCompare(b.stage);
    })
    .map(({ stage, roots: rs }) => ({ stage, roots: rs }));
}

function RoadmapBoard({ items }: { items: Record<string, RoadmapItem> }) {
  const byParent = useMemo(() => childIndex(items), [items]);
  const roots = byParent.get(null) ?? [];
  const groups = useMemo(() => groupRootsByStage(roots), [roots]);
  const stages = useMemo(
    () =>
      Array.from(
        new Set(roots.map((r) => (r.stage ?? "").trim()).filter(Boolean)),
      ).sort(),
    [roots],
  );

  // Nothing staged yet → keep the original single-row layout so the feature is
  // invisible until someone actually files goals into phases.
  const unstagedOnly = groups.length <= 1 && (groups[0]?.stage ?? null) === null;

  if (unstagedOnly) {
    return (
      <div className="tandem-scroll flex-1 min-h-0 min-w-0 overflow-x-auto overflow-y-hidden bg-paper">
        <div className="flex gap-4 px-6 py-4 h-full items-start min-w-min">
          {roots.map((root) => (
            <RoadmapColumn key={root.id} root={root} byParent={byParent} stages={stages} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="tandem-scroll flex-1 min-h-0 min-w-0 overflow-y-auto bg-paper">
      <div className="flex flex-col gap-5 px-6 py-4">
        {groups.map((g) => (
          <section key={g.stage ?? "__none__"}>
            <div className="flex items-center gap-2 mb-2">
              <h2
                className="text-xs font-semibold uppercase tracking-wider"
                style={{ color: g.stage ? ACCENT.solid : "#9ca3af" }}
              >
                {g.stage ?? "No stage"}
              </h2>
              <span className="text-[11px] text-gray-400">
                {g.roots.length} {g.roots.length === 1 ? "goal" : "goals"}
              </span>
              <span
                className="flex-1 h-px"
                style={{ backgroundColor: g.stage ? ACCENT.line : "#e5e7eb" }}
              />
            </div>
            <div className="tandem-scroll flex gap-4 overflow-x-auto pb-1 items-start">
              {g.roots.map((root) => (
                <RoadmapColumn
                  key={root.id}
                  root={root}
                  byParent={byParent}
                  stages={stages}
                  compact
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

// Phase picker on a goal column: set/clear/create the stage band a top-level
// goal lives in. Free-text so a new phase is one prompt away.
function StageSelect({ item, stages }: { item: RoadmapItem; stages: string[] }) {
  const current = item.stage?.trim() ?? "";
  const [newPhaseOpen, setNewPhaseOpen] = useState(false);
  function apply(stage: string) {
    sendOp({ op: "roadmap.update", id: item.id, partial: { stage } });
  }
  function onChange(e: ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    if (v === "__new__") {
      setNewPhaseOpen(true);
      return;
    }
    apply(v); // "" clears (unstage)
  }
  const options = current && !stages.includes(current) ? [current, ...stages] : stages;
  return (
    <>
      <select
        value={current}
        onChange={onChange}
        title="Phase / stage for this goal"
        className="max-w-full text-[11px] rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-gray-600 hover:border-gray-300 focus:outline-none"
        style={current ? { color: ACCENT.hover, borderColor: ACCENT.line } : undefined}
      >
        <option value="">No stage</option>
        {options.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
        <option value="__new__">+ New phase…</option>
      </select>
      {newPhaseOpen && (
        <PhaseNameDialog
          title="New phase"
          hint="This goal moves into the new phase band."
          submitLabel="Create phase"
          onSubmit={apply}
          onClose={() => setNewPhaseOpen(false)}
        />
      )}
    </>
  );
}

function RoadmapColumn({
  root,
  byParent,
  stages,
  compact,
}: {
  root: RoadmapItem;
  byParent: Map<string | null, RoadmapItem[]>;
  stages: string[];
  compact?: boolean;
}) {
  // Flatten the subtree (excluding the root) into indented rows, in order.
  const rows = useMemo(() => {
    const out: { item: RoadmapItem; depth: number }[] = [];
    function walk(id: string, depth: number) {
      for (const kid of byParent.get(id) ?? []) {
        out.push({ item: kid, depth });
        walk(kid.id, depth + 1);
      }
    }
    walk(root.id, 0);
    return out;
  }, [root.id, byParent]);

  const done = rows.filter((r) => r.item.status === "done").length;
  const total = rows.length;
  const status = root.status as RoadmapStatus;

  function addSubItem() {
    const kids = byParent.get(root.id) ?? [];
    sendOp({
      op: "roadmap.add",
      data: { parentId: root.id, title: "", body: "", status: "todo", sortOrder: nextSortOrder(kids) },
    });
  }
  function deleteGoal() {
    const hasKids = (byParent.get(root.id) ?? []).length > 0;
    if (!confirm(hasKids ? "Delete this goal and all its sub-items?" : "Delete this goal?")) return;
    sendOp({ op: "roadmap.delete", id: root.id });
  }

  return (
    <div
      data-agent-target={root.id}
      className={`w-72 shrink-0 flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden ${
        compact ? "max-h-[26rem]" : "max-h-full"
      }`}
    >
      <div className={`h-1 shrink-0 ${STATUS_ACCENT[status]}`} />
      <div className="group shrink-0 px-3 pt-2.5 pb-3 border-b border-gray-100">
        <div className="flex items-start gap-2">
          <StatusButton item={root} className="mt-0.5" />
          <EditableTitle
            item={root}
            placeholder="Untitled goal"
            className={`flex-1 min-w-0 text-sm font-semibold leading-snug ${
              status === "done" ? "line-through decoration-gray-400 text-gray-500" : "text-gray-900"
            }`}
          />
          <div className="flex shrink-0 items-center gap-1">
            <AgentControls item={root} />
            <button
              onClick={deleteGoal}
              title="Delete goal"
              aria-label="Delete goal"
              className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-600 transition-opacity"
            >
              <svg width="12" height="12" viewBox="0 0 12 12">
                <path d="M3 3 L 9 9 M 9 3 L 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        <div className="mt-2">
          <StageSelect item={root} stages={stages} />
        </div>
        {total > 0 && <ProgressBar done={done} total={total} />}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5 flex flex-col gap-0.5">
        {rows.map((r) => (
          <BoardRow key={r.item.id} item={r.item} depth={r.depth} byParent={byParent} />
        ))}
        <button
          onClick={addSubItem}
          className="mt-0.5 flex items-center gap-1 self-start rounded px-2 py-1 text-xs text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-700"
        >
          + Add sub-item
        </button>
      </div>
    </div>
  );
}

function BoardRow({
  item,
  depth,
  byParent,
}: {
  item: RoadmapItem;
  depth: number;
  byParent: Map<string | null, RoadmapItem[]>;
}) {
  const status = item.status as RoadmapStatus;

  function addChild() {
    const kids = byParent.get(item.id) ?? [];
    sendOp({
      op: "roadmap.add",
      data: { parentId: item.id, title: "", body: "", status: "todo", sortOrder: nextSortOrder(kids) },
    });
  }
  function del() {
    const hasKids = (byParent.get(item.id) ?? []).length > 0;
    if (!confirm(hasKids ? "Delete this item and all its sub-items?" : "Delete this item?")) return;
    sendOp({ op: "roadmap.delete", id: item.id });
  }

  return (
    <div
      data-agent-target={item.id}
      className="group flex items-start gap-1.5 py-1 pr-1.5 rounded hover:bg-gray-50"
      style={{ paddingLeft: 6 + depth * 16 }}
    >
      {depth > 0 && <span aria-hidden className="self-stretch w-px bg-gray-200 ml-0.5 mr-0.5" />}
      <StatusButton item={item} className="mt-0.5" />
      <EditableTitle
        item={item}
        className={`flex-1 min-w-0 text-xs leading-snug ${
          status === "done" ? "line-through decoration-gray-400 text-gray-400" : "text-gray-700"
        }`}
      />
      <AgentControls item={item} size="xs" />
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={addChild}
          title="Add sub-item"
          aria-label="Add sub-item"
          className="rounded px-1 text-xs text-gray-400 hover:bg-blue-50 hover:text-blue-600"
        >
          +
        </button>
        <button
          onClick={del}
          title="Delete item"
          aria-label="Delete item"
          className="rounded px-0.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
        >
          <svg width="11" height="11" viewBox="0 0 12 12">
            <path d="M3 3 L 9 9 M 9 3 L 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-[10px] text-gray-400 mb-0.5">
        <span>
          {done}/{total} done
        </span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full bg-green-400 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function StatusButton({ item, className }: { item: RoadmapItem; className?: string }) {
  const status = item.status as RoadmapStatus;
  function cycleStatus() {
    const i = STATUS_CYCLE.indexOf(status);
    const next = STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length];
    sendOp({ op: "roadmap.update", id: item.id, partial: { status: next } });
  }
  return (
    <button
      onClick={cycleStatus}
      className={`shrink-0 hover:opacity-80 transition-opacity ${className ?? ""}`}
      title={`${STATUS_LABELS[status]} — click to cycle`}
    >
      <StatusIcon status={status} />
    </button>
  );
}

// Mark a roadmap item as an agent task (assignee "agent") or clear it back to a
// human goal. Agent-marked items are what an agent session pulls off the roadmap
// via canvas_roadmap_task_list. When marked it renders as a persistent chip;
// unmarked it's a hover affordance (the parent row needs a `group` class).
function AgentTaskToggle({ item, size = "sm" }: { item: RoadmapItem; size?: "sm" | "xs" }) {
  const isAgent = item.assignee === "agent";
  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    sendOp({
      op: "roadmap.update",
      id: item.id,
      partial: { assignee: isAgent ? "human" : "agent" },
    });
  }
  const pad = size === "xs" ? "px-1 py-0.5 text-[9px]" : "px-1.5 py-0.5 text-[10px]";
  return (
    <button
      onClick={toggle}
      className={`shrink-0 inline-flex items-center gap-1 font-medium rounded transition-colors ${pad} ${
        isAgent
          ? ""
          : "opacity-0 group-hover:opacity-100 border border-dashed border-gray-300 text-gray-400 hover:text-gray-700"
      }`}
      style={isAgent ? { backgroundColor: "#0EA5E914", color: "#0369A1" } : undefined}
      title={isAgent ? "Agent task — click to unmark" : "Mark as an agent task"}
    >
      <Bot size={size === "xs" ? 10 : 11} />
      Agent
    </button>
  );
}

// The agent affordances on a roadmap row: the mark-as-agent chip, plus — the
// moment an item is marked agent — a "create agent task from this" button. The
// button is the whole point of the feature: marking agent is cheap intent that
// surfaces the promote action; nothing is forced. Once an open task links the
// item the button flips to a "✓ Task" marker so you don't double-author.
function AgentControls({ item, size = "sm" }: { item: RoadmapItem; size?: "sm" | "xs" }) {
  const ctx = useContext(RoadmapTaskContext);
  const isAgent = item.assignee === "agent";
  const linked = ctx?.linkedTasks.get(item.id) ?? [];
  const tasked = hasOpenTask(linked);
  const icon = size === "xs" ? 10 : 11;

  return (
    <span className="flex shrink-0 items-center gap-1">
      <AgentTaskToggle item={item} size={size} />
      {isAgent && ctx && !ctx.readOnly && (
        tasked ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"
            title={`${linked.length} agent task${linked.length > 1 ? "s" : ""} linked — open the Tasks panel to see ${linked.length > 1 ? "them" : "it"}`}
          >
            <Check size={icon} />
            Task
          </span>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              ctx.openCreateTask(item);
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-dashed border-sky-300 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 transition-colors hover:bg-sky-50 hover:text-sky-700"
            title="Create an agent task from this item — born ready, no approval needed"
          >
            <Plus size={icon} />
            Task
          </button>
        )
      )}
    </span>
  );
}

// The pre-filled "create agent task" dialog, popped from AgentControls. Seeds
// title/body from the roadmap item, auto-links it, and — being human-authored —
// creates the task born approved (skips the proposed gate). State comes back
// over WS, so linkedTasks recomputes and the row flips to "✓ Task" on its own.
function CreateTaskDialog({
  item,
  code,
  onClose,
}: {
  item: RoadmapItem;
  code: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(item.title || "");
  const [body, setBody] = useState(item.body ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await createTask(code, {
        title: title.trim(),
        body: body.trim() || undefined,
        linkedIds: [item.id],
        assignee: "agent",
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create task");
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-start justify-center pt-[16vh]"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-ink/25 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative w-[440px] max-w-[92vw] rounded-2xl border border-ink/10 bg-white p-4 shadow-[4px_6px_0_rgba(17,17,17,0.08)]">
        <div className="flex items-center gap-2">
          <Bot size={15} style={{ color: ACCENT.solid }} />
          <h3 className="text-sm font-semibold text-ink">Create agent task</h3>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-ink/45">
          Born ready — an agent session can pick this up immediately. Linked back to this roadmap item.
        </p>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
          placeholder="What should the agent do?"
          className="mt-2.5 w-full rounded-lg border border-ink/15 bg-white px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink/30 focus:border-ink/40"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Brief: what, why, acceptance criteria (optional)"
          rows={4}
          className="mt-2 w-full resize-none rounded-lg border border-ink/15 bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink/30 focus:border-ink/40"
        />
        <div className="mt-2 inline-flex max-w-full items-center gap-1 rounded-[4px] border border-ink/10 bg-ink/[0.03] px-1.5 py-0.5 text-[10px] text-ink/50">
          <Link2 size={10} className="shrink-0" />
          <span className="truncate">Linked to “{item.title || "this item"}”</span>
        </div>
        {error && <p className="mt-2 text-[11px] text-rose-600">{error}</p>}
        <div className="mt-3 flex justify-end gap-1.5">
          <button
            onClick={onClose}
            className="rounded-lg border border-ink/15 px-3 py-1.5 text-sm font-medium text-ink/60 hover:border-ink/30"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!title.trim() || saving}
            className="rounded-lg px-3.5 py-1.5 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
            style={{ backgroundColor: ACCENT.solid }}
          >
            {saving ? "Creating…" : "Create task"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Next sort_order for a new sibling among `siblings` (append to the end).
function nextSortOrder(siblings: RoadmapItem[]): number {
  return siblings.length ? Math.max(...siblings.map((s) => s.sortOrder)) + 1 : 0;
}

// Inline-editable roadmap item title. Click to edit; Enter/blur commits, Escape
// reverts. Auto-enters edit mode for a freshly-added (empty-title) item so the
// board's "+ sub-item" flows straight into typing — same feel as the list view.
function EditableTitle({
  item,
  className = "",
  placeholder = "Untitled item",
}: {
  item: RoadmapItem;
  className?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(item.title === "");
  const [draft, setDraft] = useState(item.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(item.title), [item.title]);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commit() {
    if (draft !== item.title) {
      sendOp({ op: "roadmap.update", id: item.id, partial: { title: draft } });
    }
    setEditing(false);
  }
  function cancel() {
    setDraft(item.title);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        placeholder={placeholder}
        className={`bg-transparent focus:outline-none border-b border-blue-300 ${className}`}
      />
    );
  }
  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      className={`cursor-text ${className}`}
    >
      {item.title || <span className="text-gray-400 italic font-normal">{placeholder}</span>}
    </span>
  );
}

// ── Tree helpers ─────────────────────────────────────────────────────────────

// Flatten the tree into phase sections: top-level goals grouped by `stage`,
// each section carrying its goals' flattened subtrees. Rows are tagged with the
// section's stage so a drag across sections can re-file the goal's phase.
function flattenByStage(
  items: Record<string, RoadmapItem>,
  collapsedIds: Set<string>,
  excludeDescendantsOf: string | null,
): StageSection[] {
  const byParent = new Map<string | null, RoadmapItem[]>();
  for (const it of Object.values(items)) {
    const key = it.parentId ?? null;
    const arr = byParent.get(key) ?? [];
    arr.push(it);
    byParent.set(key, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.sortOrder - b.sortOrder || a.updatedAt - b.updatedAt);
  }

  const roots = byParent.get(null) ?? [];
  const groups = groupRootsByStage(roots);

  return groups.map((g) => {
    const rows: FlatItem[] = [];
    function walk(parentId: string | null, depth: number) {
      for (const kid of byParent.get(parentId) ?? []) {
        const hasChildren = (byParent.get(kid.id) ?? []).length > 0;
        rows.push({ id: kid.id, item: kid, depth, parentId, hasChildren, sectionStage: g.stage });
        if (kid.id === excludeDescendantsOf) continue;
        if (collapsedIds.has(kid.id)) continue;
        walk(kid.id, depth + 1);
      }
    }
    for (const root of g.roots) {
      const hasChildren = (byParent.get(root.id) ?? []).length > 0;
      rows.push({
        id: root.id,
        item: root,
        depth: 0,
        parentId: null,
        hasChildren,
        sectionStage: g.stage,
      });
      if (root.id !== excludeDescendantsOf && !collapsedIds.has(root.id)) {
        walk(root.id, 1);
      }
    }
    return { stage: g.stage, roots: g.roots, rows };
  });
}

// Phase section header in the list view — the group title on top, with rename /
// dissolve / add-goal affordances.
function SectionHeader({
  stage,
  count,
  onRename,
  onClear,
  onAddGoal,
}: {
  stage: string | null;
  count: number;
  onRename?: (name: string) => void;
  onClear?: () => void;
  onAddGoal: () => void;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  return (
    <div className="group/hdr sticky top-0 z-[1] -mx-1 mb-0.5 mt-3 flex items-center gap-2 bg-paper/95 px-1 py-1 backdrop-blur first:mt-0">
      {renameOpen && stage !== null && onRename && (
        <PhaseNameDialog
          title="Rename phase"
          hint="Every goal in this phase moves to the new name."
          initial={stage}
          submitLabel="Rename"
          onSubmit={(name) => {
            if (name !== stage) onRename(name);
          }}
          onClose={() => setRenameOpen(false)}
        />
      )}
      <button
        onClick={() => setRenameOpen(true)}
        disabled={!onRename}
        className={`text-xs font-semibold uppercase tracking-wider ${onRename ? "hover:underline" : "cursor-default"}`}
        style={{ color: stage ? ACCENT.solid : "#9ca3af" }}
        title={onRename ? "Rename phase" : undefined}
      >
        {stage ?? "No phase"}
      </button>
      <span className="text-[11px] text-gray-400">
        {count} {count === 1 ? "goal" : "goals"}
      </span>
      <span
        className="h-px flex-1"
        style={{ backgroundColor: stage ? ACCENT.line : "#e5e7eb" }}
      />
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/hdr:opacity-100">
        <button
          onClick={onAddGoal}
          className="rounded px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100 hover:text-gray-800"
          title="Add a goal to this phase"
        >
          + goal
        </button>
        {onClear && (
          <button
            onClick={onClear}
            className="rounded px-1.5 py-0.5 text-[11px] text-gray-400 hover:bg-red-50 hover:text-red-600"
            title="Dissolve phase (unstage its goals)"
          >
            dissolve
          </button>
        )}
      </div>
    </div>
  );
}

// Compute the drop target's projected (parentId, depth) given the current flat
// list, the drag's over target, and the horizontal offset.
//
// Algorithm (matches the standard dnd-kit tree pattern):
//   1. Imagine the active item moved to over's position.
//   2. Projected depth = active's original depth + (horizontalDelta / indent).
//   3. Clamp depth to be at most prev.depth + 1 and at least next.depth.
//   4. Derive parentId from depth + the previous item in the new order.
function projectDrop(
  flat: FlatItem[],
  activeId: string,
  overId: string,
  offsetX: number,
  indentPx: number,
): Projection {
  const overIndex = flat.findIndex((f) => f.id === overId);
  const activeIndex = flat.findIndex((f) => f.id === activeId);
  if (overIndex < 0 || activeIndex < 0) {
    return { parentId: null, depth: 0 };
  }
  const newItems = arrayMove(flat, activeIndex, overIndex);
  const active = flat[activeIndex];
  const prev = newItems[overIndex - 1];
  const next = newItems[overIndex + 1];

  const dragDepth = Math.round(offsetX / indentPx);
  let projectedDepth = active.depth + dragDepth;

  const maxDepth = prev ? prev.depth + 1 : 0;
  const minDepth = next ? next.depth : 0;
  if (projectedDepth > maxDepth) projectedDepth = maxDepth;
  if (projectedDepth < minDepth) projectedDepth = minDepth;
  if (projectedDepth < 0) projectedDepth = 0;

  let parentId: string | null;
  if (projectedDepth === 0 || !prev) {
    parentId = null;
  } else if (projectedDepth === prev.depth) {
    parentId = prev.parentId;
  } else if (projectedDepth > prev.depth) {
    parentId = prev.id;
  } else {
    // Walk back through earlier items at the target depth and use that one's parent.
    const ancestor = newItems
      .slice(0, overIndex)
      .reverse()
      .find((f) => f.depth === projectedDepth);
    parentId = ancestor?.parentId ?? null;
  }

  return { parentId, depth: projectedDepth };
}

// ── Icons ────────────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: RoadmapStatus }) {
  switch (status) {
    case "todo":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-label="Todo">
          <circle cx="8" cy="8" r="6" fill="none" stroke="#9ca3af" strokeWidth="1.5" />
        </svg>
      );
    case "in_progress":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-label="In progress">
          <circle cx="8" cy="8" r="6" fill="none" stroke="#3b82f6" strokeWidth="1.5" />
          <path d="M 8 2 A 6 6 0 0 1 8 14 Z" fill="#3b82f6" />
        </svg>
      );
    case "done":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-label="Done">
          <circle cx="8" cy="8" r="7" fill="#22c55e" />
          <path
            d="M 4.5 8 L 7 10.4 L 11.5 5.6"
            fill="none"
            stroke="white"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "blocked":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-label="Blocked">
          <circle cx="8" cy="8" r="7" fill="#ef4444" />
          <path
            d="M 5.5 5.5 L 10.5 10.5 M 10.5 5.5 L 5.5 10.5"
            stroke="white"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}
