import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
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
import type {
  CanvasState,
  Sheet,
  SheetCellValue,
  SheetColumn,
  SheetColumnType,
  SheetRow,
} from "../types";
import { sendOp } from "../lib/ws";
import { MOCK_ENABLED } from "../lib/mockFixture";
import EmptyState from "../components/EmptyState";
import { modeTheme } from "../lib/modeTheme";

const ACCENT = modeTheme("sheets");

interface Props {
  state: CanvasState;
  canvasCode: string;
}

const COLUMN_TYPES: { value: SheetColumnType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "checkbox", label: "Checkbox" },
];

export default function SheetsMode({ state, canvasCode }: Props) {
  const sheets = useMemo(
    () =>
      Object.values(state.sheets).sort(
        (a, b) => a.sortOrder - b.sortOrder || a.updatedAt - b.updatedAt,
      ),
    [state.sheets],
  );

  const [activeSheetId, setActiveSheetId] = useState<string | null>(
    sheets[0]?.id ?? null,
  );

  // When sheets change (added/deleted), keep activeSheetId in sync.
  useEffect(() => {
    if (sheets.length === 0) {
      if (activeSheetId !== null) setActiveSheetId(null);
      return;
    }
    if (!activeSheetId || !state.sheets[activeSheetId]) {
      setActiveSheetId(sheets[0].id);
    }
  }, [sheets, activeSheetId, state.sheets]);

  const activeSheet = activeSheetId ? state.sheets[activeSheetId] : null;

  function nextSheetSortOrder(): number {
    if (sheets.length === 0) return 0;
    return Math.max(...sheets.map((s) => s.sortOrder)) + 1;
  }

  function handleAddSheet() {
    sendOp({
      op: "sheet.add",
      data: { name: "Untitled sheet", columns: [], sortOrder: nextSheetSortOrder() },
    });
  }

  function handleExport() {
    if (!activeSheet) return;
    // Public endpoint gated by canvas code (same model as the WS). A plain
    // <a download> click triggers the browser save dialog using the
    // Content-Disposition filename from the server.
    const url = `/api/canvas/sheets/${activeSheet.id}/export?code=${encodeURIComponent(canvasCode)}`;
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-paper">
      <div className="max-w-5xl mx-auto w-full px-6 py-6 flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-3 shrink-0">
          <h1 className="font-display text-xl font-medium tracking-tight text-gray-900">Sheets</h1>
          <div className="flex items-center gap-2">
            {activeSheet && (
              <button
                onClick={handleExport}
                disabled={MOCK_ENABLED}
                className="text-sm px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                title={MOCK_ENABLED ? "Export unavailable in mock mode" : `Download "${activeSheet.name}" as .xlsx`}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                  <path d="M7 1 L 7 9 M 4 6 L 7 9 L 10 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M2 11 L 12 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                Export
              </button>
            )}
            <button
              onClick={handleAddSheet}
              className="text-sm px-3.5 py-1.5 rounded-lg text-white font-medium shadow-sm transition-opacity hover:opacity-90"
              style={{ backgroundColor: ACCENT.solid }}
            >
              + New sheet
            </button>
          </div>
        </div>

        {sheets.length === 0 ? (
          <EmptyState
            title="No sheets yet"
            hint="Click + New sheet to start, or ask Claude to build a table for you."
          />
        ) : (
          <>
            <SheetTabs
              sheets={sheets}
              activeSheetId={activeSheetId}
              onSelect={setActiveSheetId}
              onAdd={handleAddSheet}
            />
            {activeSheet && (
              <SheetTable
                sheet={activeSheet}
                rows={Object.values(state.sheetRows).filter(
                  (r) => r.sheetId === activeSheet.id,
                )}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Tab strip ────────────────────────────────────────────────────────────────

function SheetTabs({
  sheets,
  activeSheetId,
  onSelect,
  onAdd,
}: {
  sheets: Sheet[];
  activeSheetId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-end gap-1 border-b border-gray-200 shrink-0 overflow-x-auto">
      {sheets.map((sheet) => (
        <SheetTab
          key={sheet.id}
          sheet={sheet}
          active={sheet.id === activeSheetId}
          onSelect={() => onSelect(sheet.id)}
        />
      ))}
      <button
        onClick={onAdd}
        className="ml-1 mb-1 px-2 py-1 text-sm text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
        title="New sheet"
      >
        +
      </button>
    </div>
  );
}

function SheetTab({
  sheet,
  active,
  onSelect,
}: {
  sheet: Sheet;
  active: boolean;
  onSelect: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sheet.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(sheet.name);
  }, [sheet.name]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commitName() {
    setEditing(false);
    if (draft !== sheet.name) {
      sendOp({ op: "sheet.update", id: sheet.id, partial: { name: draft } });
    }
  }

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete sheet "${sheet.name}" and all its rows?`)) return;
    sendOp({ op: "sheet.delete", id: sheet.id });
  }

  return (
    <div
      onClick={() => !editing && onSelect()}
      onDoubleClick={() => active && setEditing(true)}
      className={`group cursor-pointer flex items-center gap-1.5 px-3 py-1.5 rounded-t-md text-sm border-b-2 -mb-px ${
        active
          ? "text-gray-900 font-medium bg-white"
          : "border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50"
      }`}
      style={active ? { borderColor: ACCENT.solid } : undefined}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitName();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(sheet.name);
              setEditing(false);
            }
          }}
          className="bg-transparent border-b border-blue-300 focus:outline-none w-32"
        />
      ) : (
        <span>{sheet.name || "Untitled"}</span>
      )}
      {active && !editing && (
        <button
          onClick={handleDelete}
          className="text-gray-300 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Delete sheet"
        >
          <svg width="10" height="10" viewBox="0 0 12 12">
            <path d="M3 3 L 9 9 M 9 3 L 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────

function SheetTable({ sheet, rows }: { sheet: Sheet; rows: SheetRow[] }) {
  const columns = useMemo(
    () => [...sheet.columns].sort((a, b) => a.sortOrder - b.sortOrder),
    [sheet.columns],
  );
  const orderedRows = useMemo(
    () =>
      [...rows].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.updatedAt - b.updatedAt,
      ),
    [rows],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function nextColumnSortOrder(): number {
    if (columns.length === 0) return 0;
    return Math.max(...columns.map((c) => c.sortOrder)) + 1;
  }

  function nextRowSortOrder(): number {
    if (orderedRows.length === 0) return 0;
    return Math.max(...orderedRows.map((r) => r.sortOrder)) + 1;
  }

  function handleAddColumn() {
    sendOp({
      op: "sheet.column.add",
      sheetId: sheet.id,
      column: { name: "New column", type: "text", sortOrder: nextColumnSortOrder() },
    });
  }

  function handleAddRow() {
    sendOp({
      op: "sheet.row.add",
      sheetId: sheet.id,
      data: {},
      sortOrder: nextRowSortOrder(),
    });
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = orderedRows.findIndex((r) => r.id === active.id);
    const newIndex = orderedRows.findIndex((r) => r.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const moved = arrayMove(orderedRows, oldIndex, newIndex);
    const updates = moved
      .map((row, idx) => ({ id: row.id, sortOrder: idx }))
      .filter((u) => {
        const existing = orderedRows.find((r) => r.id === u.id);
        return existing && existing.sortOrder !== u.sortOrder;
      });
    if (updates.length === 0) return;
    sendOp({ op: "sheet.row.reorder", sheetId: sheet.id, updates });
  }

  const rowIds = useMemo(() => orderedRows.map((r) => r.id), [orderedRows]);

  return (
    <div className="flex-1 overflow-auto mt-3 border border-gray-200 rounded-md bg-white">
      <table className="w-full border-collapse">
        <thead className="bg-gray-50 sticky top-0 z-10">
          <tr>
            {/* drag-handle column header (empty) */}
            <th className="w-8 border-b border-gray-200" aria-hidden />
            {columns.map((col) => (
              <ColumnHeader key={col.id} sheetId={sheet.id} column={col} />
            ))}
            <th className="border-b border-gray-200 p-1 text-left">
              <button
                onClick={handleAddColumn}
                className="text-xs text-gray-400 hover:text-blue-600 px-2 py-0.5 rounded hover:bg-blue-50"
                title="Add column"
              >
                + col
              </button>
            </th>
          </tr>
        </thead>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={rowIds} strategy={verticalListSortingStrategy}>
            <tbody>
              {orderedRows.map((row) => (
                <SortableTableRow key={row.id} row={row} columns={columns} />
              ))}
              {orderedRows.length === 0 && (
                <tr>
                  <td
                    colSpan={columns.length + 2}
                    className="p-4 text-center text-sm text-gray-400 italic"
                  >
                    {columns.length === 0
                      ? "Add a column to get started."
                      : "No rows yet. Click + Row below."}
                  </td>
                </tr>
              )}
            </tbody>
          </SortableContext>
        </DndContext>
      </table>
      <div className="border-t border-gray-200 px-2 py-1.5 bg-gray-50/50">
        <button
          onClick={handleAddRow}
          disabled={columns.length === 0}
          className="text-xs text-gray-500 hover:text-blue-600 px-2 py-0.5 rounded hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          + Row
        </button>
      </div>
    </div>
  );
}

// ── Column header ────────────────────────────────────────────────────────────

function ColumnHeader({ sheetId, column }: { sheetId: string; column: SheetColumn }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft(column.name);
  }, [column.name]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  function commitName() {
    setEditing(false);
    if (draft !== column.name) {
      sendOp({
        op: "sheet.column.update",
        sheetId,
        columnId: column.id,
        partial: { name: draft },
      });
    }
  }

  function setType(type: SheetColumnType) {
    setMenuOpen(false);
    if (type === column.type) return;
    sendOp({
      op: "sheet.column.update",
      sheetId,
      columnId: column.id,
      partial: { type },
    });
  }

  function handleDelete() {
    setMenuOpen(false);
    if (!confirm(`Delete column "${column.name}"? Cell data in this column will be lost.`)) return;
    sendOp({ op: "sheet.column.delete", sheetId, columnId: column.id });
  }

  return (
    <th className="border-b border-gray-200 border-r last:border-r-0 px-2 py-1 text-left font-medium text-gray-700 text-xs uppercase tracking-wide min-w-[120px]">
      <div className="flex items-center gap-1">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitName();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(column.name);
                setEditing(false);
              }
            }}
            className="flex-1 bg-transparent border-b border-blue-300 focus:outline-none text-xs"
          />
        ) : (
          <span
            onDoubleClick={() => setEditing(true)}
            className="flex-1 cursor-text truncate"
            title={column.name}
          >
            {column.name || "Untitled"}
          </span>
        )}
        <span className="text-[10px] font-normal text-gray-400 lowercase">{column.type}</span>
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="text-gray-300 hover:text-gray-700 px-0.5"
            title="Column options"
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <circle cx="2.5" cy="6" r="1" fill="currentColor" />
              <circle cx="6" cy="6" r="1" fill="currentColor" />
              <circle cx="9.5" cy="6" r="1" fill="currentColor" />
            </svg>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-md shadow-lg py-1 w-40 text-xs normal-case font-normal tracking-normal">
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setEditing(true);
                }}
                className="w-full text-left px-3 py-1.5 text-gray-700 hover:bg-gray-50"
              >
                Rename
              </button>
              <div className="border-t border-gray-100 my-1" />
              <div className="px-3 py-1 text-[10px] text-gray-400 uppercase tracking-wide">Type</div>
              {COLUMN_TYPES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setType(t.value)}
                  className={`w-full text-left px-3 py-1.5 hover:bg-gray-50 ${
                    column.type === t.value ? "text-blue-600 font-medium" : "text-gray-700"
                  }`}
                >
                  {t.label}
                </button>
              ))}
              <div className="border-t border-gray-100 my-1" />
              <button
                onClick={handleDelete}
                className="w-full text-left px-3 py-1.5 text-red-600 hover:bg-red-50"
              >
                Delete column
              </button>
            </div>
          )}
        </div>
      </div>
    </th>
  );
}

// ── Sortable row + cells ────────────────────────────────────────────────────

function SortableTableRow({ row, columns }: { row: SheetRow; columns: SheetColumn[] }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  function handleDelete() {
    sendOp({ op: "sheet.row.delete", id: row.id });
  }

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className="group border-b border-gray-100 last:border-b-0 hover:bg-blue-50/30"
    >
      <td className="w-8 border-r border-gray-100 text-center align-middle">
        <DragHandle attributes={attributes} listeners={listeners} />
      </td>
      {columns.map((col) => (
        <Cell
          key={col.id}
          rowId={row.id}
          columnId={col.id}
          type={col.type}
          value={row.data[col.id] ?? null}
        />
      ))}
      <td className="border-l border-gray-100 text-center align-middle w-8">
        <button
          onClick={handleDelete}
          className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-600 px-1"
          title="Delete row"
        >
          <svg width="11" height="11" viewBox="0 0 12 12">
            <path d="M3 3 L 9 9 M 9 3 L 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </td>
    </tr>
  );
}

function DragHandle({
  attributes,
  listeners,
}: {
  attributes: DraggableAttributes;
  listeners: SyntheticListenerMap | undefined;
}) {
  return (
    <button
      {...attributes}
      {...listeners}
      className="text-gray-200 hover:text-gray-500 cursor-grab active:cursor-grabbing touch-none px-1"
      aria-label="Drag to reorder row"
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
  );
}

function Cell({
  rowId,
  columnId,
  type,
  value,
}: {
  rowId: string;
  columnId: string;
  type: SheetColumnType;
  value: SheetCellValue;
}) {
  // Local draft state so typing doesn't fight the WS echo. Commit on blur/Enter;
  // sync from server on mismatch.
  const initialDraft = formatForInput(type, value);
  const [draft, setDraft] = useState(initialDraft);

  useEffect(() => {
    setDraft(formatForInput(type, value));
  }, [value, type]);

  function commit(next: string | boolean) {
    const parsed = parseFromInput(type, next);
    if (cellEquals(parsed, value)) return;
    sendOp({
      op: "sheet.row.update",
      id: rowId,
      partial: { data: { [columnId]: parsed } },
    });
  }

  const baseCell = "border-r border-gray-100 last:border-r-0 align-middle";

  if (type === "checkbox") {
    const checked = value === true;
    return (
      <td className={`${baseCell} text-center`}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => commit(e.target.checked)}
          className="cursor-pointer"
        />
      </td>
    );
  }

  const inputType = type === "number" ? "number" : type === "date" ? "date" : "text";
  const inputClass =
    "w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 focus:ring-blue-400 px-2 py-1 text-sm " +
    (type === "number" ? "text-right tabular-nums" : "");

  return (
    <td className={baseCell}>
      <input
        type={inputType}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(formatForInput(type, value));
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        className={inputClass}
      />
    </td>
  );
}

// ── Cell value helpers ───────────────────────────────────────────────────────

function formatForInput(type: SheetColumnType, value: SheetCellValue): string {
  if (value === null || value === undefined) return "";
  if (type === "checkbox") return value === true ? "true" : "";
  if (type === "number") return typeof value === "number" ? String(value) : String(value ?? "");
  return String(value);
}

function parseFromInput(type: SheetColumnType, raw: string | boolean): SheetCellValue {
  if (type === "checkbox") return Boolean(raw);
  if (typeof raw !== "string") return null;
  if (raw === "") return null;
  if (type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return raw;
}

function cellEquals(a: SheetCellValue, b: SheetCellValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  return String(a) === String(b);
}
