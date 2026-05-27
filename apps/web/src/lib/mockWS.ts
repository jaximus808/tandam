// In-memory replacement for the WS + REST layers, used when VITE_MOCK=1.
// Lets you iterate on the UI with hot reload and no backend.

import type {
  CanvasMeta,
  CanvasState,
  PendingEdit,
  WSClientMessage,
  Pin,
  CanvasEvent,
  Note,
  RoadmapItem,
  Sheet,
  SheetColumn,
  SheetRow,
} from "../types";
import { mockCanvas, mockState, mockNewId } from "./mockFixture";

type StateHandler = (canvas: CanvasMeta, canvases: CanvasMeta[], state: CanvasState, pendingEdits: PendingEdit[]) => void;

let canvas: CanvasMeta = { ...mockCanvas };
let state: CanvasState = JSON.parse(JSON.stringify(mockState));
const handlers: StateHandler[] = [];

function broadcast() {
  // Async tick so handlers run after the current render flush, mimicking
  // network round-trip ordering.
  queueMicrotask(() => {
    handlers.forEach((h) => h(canvas, [], state, []));
  });
}

export function mockConnect(_code: string) {
  // Schedule an initial state push so App.tsx can render.
  broadcast();
}

export function mockOnStateUpdate(fn: StateHandler): () => void {
  handlers.push(fn);
  // Replay current state on subscribe.
  queueMicrotask(() => fn(canvas, [], state, []));
  return () => {
    const i = handlers.indexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
  };
}

export function mockSendOp(op: WSClientMessage) {
  state = applyOp(state, op);
  canvas = applyToCanvas(canvas, op);
  canvas.version = state.version;
  broadcast();
}

function applyToCanvas(c: CanvasMeta, op: WSClientMessage): CanvasMeta {
  switch (op.op) {
    case "mode.set":
      return { ...c, mode: op.mode };
    case "map.set":
      return { ...c, mapId: op.mapId, mode: c.mode === "welcome" ? "map" : c.mode };
    case "template.apply":
      return { ...c, mode: op.mode, mapId: op.mapId ?? c.mapId };
    default:
      return c;
  }
}

function applyOp(s: CanvasState, op: WSClientMessage): CanvasState {
  const next: CanvasState = {
    ...s,
    version: s.version + 1,
    pins: { ...s.pins },
    events: { ...s.events },
    notes: { ...s.notes },
    roadmapItems: { ...s.roadmapItems },
    sheets: { ...s.sheets },
    sheetRows: { ...s.sheetRows },
  };

  switch (op.op) {
    case "mode.set":
      next.mode = op.mode;
      break;
    case "map.set":
      if (next.mode === "welcome") next.mode = "map";
      break;
    case "template.apply":
      next.mode = op.mode;
      break;

    case "pin.add": {
      const id = mockNewId();
      const data = op.data as Omit<Pin, "id" | "kind" | "createdBy" | "updatedAt">;
      next.pins[id] = {
        id,
        kind: "pin",
        createdBy: "user",
        updatedAt: Date.now(),
        ...data,
      } as Pin;
      break;
    }
    case "pin.update":
      if (next.pins[op.id]) {
        next.pins[op.id] = { ...next.pins[op.id], ...op.partial, updatedAt: Date.now() };
      }
      break;
    case "pin.delete":
      delete next.pins[op.id];
      break;

    case "event.add": {
      const id = mockNewId();
      const data = op.data as Omit<CanvasEvent, "id" | "kind" | "createdBy" | "updatedAt">;
      next.events[id] = {
        id,
        kind: "event",
        createdBy: "user",
        updatedAt: Date.now(),
        ...data,
      } as CanvasEvent;
      break;
    }
    case "event.update":
      if (next.events[op.id]) {
        next.events[op.id] = { ...next.events[op.id], ...op.partial, updatedAt: Date.now() };
      }
      break;
    case "event.delete":
      delete next.events[op.id];
      break;

    case "note.add": {
      const id = mockNewId();
      const data = (op.data ?? { body: "", imageRefs: [] }) as Omit<Note, "id" | "kind" | "createdBy" | "updatedAt">;
      next.notes[id] = {
        id,
        kind: "note",
        createdBy: "user",
        updatedAt: Date.now(),
        body: data.body ?? "",
        imageRefs: data.imageRefs ?? [],
        parentId: data.parentId,
        ...(data as object),
      } as Note;
      break;
    }
    case "note.update":
      if (next.notes[op.id]) {
        next.notes[op.id] = { ...next.notes[op.id], ...op.partial, updatedAt: Date.now() };
      }
      break;
    case "note.delete":
      delete next.notes[op.id];
      break;

    case "roadmap.add": {
      const id = mockNewId();
      const data = op.data as Omit<RoadmapItem, "id" | "kind" | "createdBy" | "updatedAt">;
      next.roadmapItems[id] = {
        id,
        kind: "roadmap",
        createdBy: "user",
        updatedAt: Date.now(),
        title: data.title ?? "",
        body: data.body ?? "",
        status: data.status ?? "todo",
        sortOrder: data.sortOrder ?? 0,
        parentId: data.parentId,
      };
      break;
    }
    case "roadmap.update":
      if (next.roadmapItems[op.id]) {
        next.roadmapItems[op.id] = { ...next.roadmapItems[op.id], ...op.partial, updatedAt: Date.now() };
      }
      break;
    case "roadmap.delete": {
      // Mirror the DB CASCADE on parent_id: deleting an item drops its descendants too.
      const toDelete = new Set<string>([op.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const it of Object.values(next.roadmapItems)) {
          if (it.parentId && toDelete.has(it.parentId) && !toDelete.has(it.id)) {
            toDelete.add(it.id);
            grew = true;
          }
        }
      }
      for (const id of toDelete) delete next.roadmapItems[id];
      break;
    }
    case "roadmap.reorder": {
      for (const u of op.updates) {
        const existing = next.roadmapItems[u.id];
        if (!existing) continue;
        next.roadmapItems[u.id] = {
          ...existing,
          parentId: u.parentId ?? undefined,
          sortOrder: u.sortOrder,
          updatedAt: Date.now(),
        };
      }
      break;
    }

    case "sheet.add": {
      const id = mockNewId();
      const data = op.data ?? {};
      const cols: SheetColumn[] = (data.columns ?? []).map((c) => ({
        id: mockNewId(),
        name: c.name,
        type: c.type,
        sortOrder: c.sortOrder ?? 0,
      }));
      next.sheets[id] = {
        id,
        kind: "sheet",
        name: data.name ?? "Untitled sheet",
        columns: cols,
        sortOrder: data.sortOrder ?? 0,
        createdBy: "user",
        updatedAt: Date.now(),
      } as Sheet;
      break;
    }
    case "sheet.update":
      if (next.sheets[op.id]) {
        next.sheets[op.id] = { ...next.sheets[op.id], ...op.partial, updatedAt: Date.now() };
      }
      break;
    case "sheet.delete": {
      // Cascade: drop the sheet and all its rows.
      const sheetId = op.id;
      delete next.sheets[sheetId];
      for (const rid of Object.keys(next.sheetRows)) {
        if (next.sheetRows[rid].sheetId === sheetId) delete next.sheetRows[rid];
      }
      break;
    }

    case "sheet.column.add": {
      const sheet = next.sheets[op.sheetId];
      if (!sheet) break;
      const newCol: SheetColumn = { id: mockNewId(), ...op.column };
      next.sheets[op.sheetId] = {
        ...sheet,
        columns: [...sheet.columns, newCol],
        updatedAt: Date.now(),
      };
      break;
    }
    case "sheet.column.update": {
      const sheet = next.sheets[op.sheetId];
      if (!sheet) break;
      next.sheets[op.sheetId] = {
        ...sheet,
        columns: sheet.columns.map((c) =>
          c.id === op.columnId ? { ...c, ...op.partial } : c,
        ),
        updatedAt: Date.now(),
      };
      break;
    }
    case "sheet.column.delete": {
      const sheet = next.sheets[op.sheetId];
      if (!sheet) break;
      next.sheets[op.sheetId] = {
        ...sheet,
        columns: sheet.columns.filter((c) => c.id !== op.columnId),
        updatedAt: Date.now(),
      };
      // Strip the column from every row's data (mirror server-side cascade).
      for (const rid of Object.keys(next.sheetRows)) {
        const r = next.sheetRows[rid];
        if (r.sheetId !== op.sheetId) continue;
        if (!(op.columnId in r.data)) continue;
        const { [op.columnId]: _drop, ...rest } = r.data;
        next.sheetRows[rid] = { ...r, data: rest, updatedAt: Date.now() };
      }
      break;
    }

    case "sheet.row.add": {
      const id = mockNewId();
      next.sheetRows[id] = {
        id,
        kind: "sheetRow",
        sheetId: op.sheetId,
        data: op.data ?? {},
        sortOrder: op.sortOrder ?? 0,
        createdBy: "user",
        updatedAt: Date.now(),
      } as SheetRow;
      break;
    }
    case "sheet.row.update": {
      const existing = next.sheetRows[op.id];
      if (!existing) break;
      const merged: SheetRow = { ...existing, updatedAt: Date.now() };
      if (op.partial.data) {
        const data = { ...existing.data };
        for (const [k, v] of Object.entries(op.partial.data)) {
          if (v === null) delete data[k];
          else data[k] = v;
        }
        merged.data = data;
      }
      if (op.partial.sortOrder !== undefined) merged.sortOrder = op.partial.sortOrder;
      next.sheetRows[op.id] = merged;
      break;
    }
    case "sheet.row.delete":
      delete next.sheetRows[op.id];
      break;
    case "sheet.row.reorder": {
      for (const u of op.updates) {
        const existing = next.sheetRows[u.id];
        if (!existing) continue;
        next.sheetRows[u.id] = { ...existing, sortOrder: u.sortOrder, updatedAt: Date.now() };
      }
      break;
    }
  }

  // Auto-leave welcome on any entity write (matches server behavior).
  if (s.mode === "welcome") {
    if (op.op.startsWith("pin.")) next.mode = "map";
    else if (op.op.startsWith("event.")) next.mode = "itinerary";
    else if (op.op.startsWith("note.")) next.mode = "docs";
    else if (op.op.startsWith("roadmap.")) next.mode = "roadmap";
    else if (op.op.startsWith("sheet.")) next.mode = "sheets";
  }

  return next;
}
