// In-memory replacement for the WS + REST layers, used when VITE_MOCK=1.
// Lets you iterate on the UI with hot reload and no backend.

import type { CanvasMeta, CanvasState, PendingEdit, WSClientMessage, Pin, CanvasEvent, Note } from "../types";
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
  }

  // Auto-leave welcome on any entity write (matches server behavior).
  if (s.mode === "welcome") {
    if (op.op.startsWith("pin.")) next.mode = "map";
    else if (op.op.startsWith("event.")) next.mode = "itinerary";
    else if (op.op.startsWith("note.")) next.mode = "docs";
  }

  return next;
}
