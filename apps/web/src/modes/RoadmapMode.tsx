import { useEffect, useMemo, useRef, useState } from "react";
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

const INDENT_PX = 20;

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

  // While dragging, hide descendants of the active item — they ride along with
  // the moved subtree implicitly (parent_id doesn't change), so they shouldn't
  // appear in the flat sortable list.
  const flat = useMemo(
    () => flattenTree(items, collapsed, activeId),
    [items, collapsed, activeId],
  );

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

    if (updates.length > 0) {
      sendOp({ op: "roadmap.reorder", updates });
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

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto w-full px-6 py-6">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-semibold text-gray-900">Roadmap</h1>
          <button
            onClick={handleAddRoot}
            className="text-sm px-3 py-1.5 rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700 transition-colors"
          >
            + New item
          </button>
        </div>

        <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mb-4 px-2 py-1.5 text-xs text-gray-500 bg-gray-100/70 rounded-md border border-gray-200">
          <span className="font-medium text-gray-600">Legend:</span>
          {STATUS_CYCLE.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <StatusIcon status={s} />
              <span>{STATUS_LABELS[s]}</span>
            </span>
          ))}
          <span className="ml-auto text-gray-400">Drag rows to reorder · click icon to cycle</span>
        </div>

        {flat.length === 0 ? (
          <EmptyState
            title="No roadmap items yet"
            hint="Click + New item to start, or ask Claude to outline a plan."
          />
        ) : (
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
              <ul className="text-sm">
                {flat.map((f) => {
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
            </SortableContext>
          </DndContext>
        )}
      </div>
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

// ── Tree helpers ─────────────────────────────────────────────────────────────

function flattenTree(
  items: Record<string, RoadmapItem>,
  collapsedIds: Set<string>,
  excludeDescendantsOf: string | null,
): FlatItem[] {
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

  const out: FlatItem[] = [];
  function walk(parentId: string | null, depth: number) {
    const kids = byParent.get(parentId) ?? [];
    for (const kid of kids) {
      const hasChildren = (byParent.get(kid.id) ?? []).length > 0;
      out.push({ id: kid.id, item: kid, depth, parentId, hasChildren });
      if (kid.id === excludeDescendantsOf) continue;
      if (collapsedIds.has(kid.id)) continue;
      walk(kid.id, depth + 1);
    }
  }
  walk(null, 0);
  return out;
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
