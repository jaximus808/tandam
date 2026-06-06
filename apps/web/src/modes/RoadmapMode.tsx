import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
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
import type { CanvasState, RoadmapItem, RoadmapStatus } from "../types";
import { sendOp } from "../lib/ws";
import EmptyState from "../components/EmptyState";
import { modeTheme } from "../lib/modeTheme";

const ACCENT = modeTheme("roadmap");

const INDENT_PX = 20;
const LIST_HINT_KEY = "tandem.roadmapListHint.dismissed";

const STATUS_LABELS: Record<RoadmapStatus, string> = {
  todo: "Todo",
  in_progress: "In progress",
  done: "Done",
  blocked: "Blocked",
};

const STATUS_CYCLE: RoadmapStatus[] = ["todo", "in_progress", "done", "blocked"];

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
}

export default function RoadmapMode({ state }: Props) {
  const items = state.roadmapItems;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetX, setOffsetX] = useState(0);
  const [view, setView] = useState<"list" | "board">("board");
  const [listHintDismissed, setListHintDismissed] = useState(() => {
    try {
      return localStorage.getItem(LIST_HINT_KEY) === "1";
    } catch {
      return false;
    }
  });

  function dismissListHint() {
    setListHintDismissed(true);
    try {
      localStorage.setItem(LIST_HINT_KEY, "1");
    } catch {
      /* ignore (private mode / disabled storage) */
    }
  }

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
  function handleAddPhase() {
    const name = window.prompt("New phase name (e.g. Now, Next, Later, v1, v2):", "")?.trim();
    if (!name) return;
    handleAddRootInStage(name);
  }

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
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <div className="shrink-0 max-w-5xl mx-auto w-full px-4 pt-6 pb-3 sm:px-6">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <h1 className="font-display text-xl font-medium tracking-tight text-gray-900">Roadmap</h1>
            <ViewToggle
              view={view}
              onChange={(v) => {
                setView(v);
                if (v === "list") dismissListHint();
              }}
            />
            {view === "board" && !listHintDismissed && (
              <div
                className="hidden items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg border text-xs lg:inline-flex"
                style={{ backgroundColor: ACCENT.soft, borderColor: ACCENT.line, color: ACCENT.hover }}
              >
                <span aria-hidden style={{ color: ACCENT.solid }}>←</span>
                <span>Switch to List to edit &amp; reorder</span>
                <button
                  onClick={dismissListHint}
                  className="shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-black/5"
                  title="Dismiss"
                  aria-label="Dismiss hint"
                >
                  <svg width="9" height="9" viewBox="0 0 12 12">
                    <path d="M3 3 L 9 9 M 9 3 L 3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={handleAddPhase}
              className="whitespace-nowrap text-sm px-3 py-1.5 rounded-lg font-medium border transition-colors"
              style={{ color: ACCENT.hover, borderColor: ACCENT.line, backgroundColor: ACCENT.soft }}
              title="Create a new phase (e.g. Now, Next, Later, v1, v2)"
            >
              + Phase
            </button>
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
              ? "Click a status icon to cycle · edit items in list view"
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

  function setPhase() {
    const current = item.stage?.trim() ?? "";
    const name = window.prompt("Phase for this goal (blank to clear):", current);
    if (name === null) return; // cancelled
    sendOp({ op: "roadmap.update", id: item.id, partial: { stage: name.trim() } });
  }

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

      {depth === 0 && (
        <button
          onClick={setPhase}
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
  function apply(stage: string) {
    sendOp({ op: "roadmap.update", id: item.id, partial: { stage } });
  }
  function onChange(e: ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    if (v === "__new__") {
      const name = window.prompt("New phase name (e.g. Now, Next, Later, v1, v2):", "")?.trim();
      if (name) apply(name);
      return;
    }
    apply(v); // "" clears (unstage)
  }
  const options = current && !stages.includes(current) ? [current, ...stages] : stages;
  return (
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

  return (
    <div
      data-agent-target={root.id}
      className={`w-72 shrink-0 flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden ${
        compact ? "max-h-[26rem]" : "max-h-full"
      }`}
    >
      <div className={`h-1 shrink-0 ${STATUS_ACCENT[status]}`} />
      <div className="shrink-0 px-3 pt-2.5 pb-3 border-b border-gray-100">
        <div className="flex items-start gap-2">
          <StatusButton item={root} className="mt-0.5" />
          <span
            className={`text-sm font-semibold leading-snug ${
              status === "done" ? "line-through decoration-gray-400 text-gray-500" : "text-gray-900"
            }`}
          >
            {root.title || <span className="text-gray-400 italic font-normal">Untitled goal</span>}
          </span>
        </div>
        <div className="mt-2">
          <StageSelect item={root} stages={stages} />
        </div>
        {total > 0 && <ProgressBar done={done} total={total} />}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5 flex flex-col gap-0.5">
        {rows.length === 0 ? (
          <div className="px-2 py-3 text-xs text-gray-400 italic">No sub-items</div>
        ) : (
          rows.map((r) => <BoardRow key={r.item.id} item={r.item} depth={r.depth} />)
        )}
      </div>
    </div>
  );
}

function BoardRow({ item, depth }: { item: RoadmapItem; depth: number }) {
  const status = item.status as RoadmapStatus;
  return (
    <div
      data-agent-target={item.id}
      className="group flex items-start gap-1.5 py-1 pr-1.5 rounded hover:bg-gray-50"
      style={{ paddingLeft: 6 + depth * 16 }}
    >
      {depth > 0 && <span aria-hidden className="self-stretch w-px bg-gray-200 ml-0.5 mr-0.5" />}
      <StatusButton item={item} className="mt-0.5" />
      <span
        className={`text-xs leading-snug ${
          status === "done" ? "line-through decoration-gray-400 text-gray-400" : "text-gray-700"
        }`}
        title={item.body || undefined}
      >
        {item.title || <span className="text-gray-400 italic">Untitled item</span>}
      </span>
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
  function rename() {
    if (!onRename || stage === null) return;
    const name = window.prompt("Rename phase:", stage)?.trim();
    if (name && name !== stage) onRename(name);
  }
  return (
    <div className="group/hdr sticky top-0 z-[1] -mx-1 mb-0.5 mt-3 flex items-center gap-2 bg-paper/95 px-1 py-1 backdrop-blur first:mt-0">
      <button
        onClick={rename}
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
