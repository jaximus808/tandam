export type EntityId = string;
export type CanvasMode = "welcome" | "map" | "itinerary" | "docs";

export interface CanvasMeta {
  id: string;
  code: string;      // 8-char shareable code, e.g. "TOKYO7X3K"
  name: string;
  mode: string;
  mapId?: string;    // Phase 3: active map preset (only meaningful in map mode)
  version: number;
  createdAt: string; // ISO timestamp (Go API returns strings)
  updatedAt: string;
}

export interface Pin {
  id: EntityId;
  kind: "pin";
  pinType: "marker" | "annotation";
  lat: number;
  lng: number;
  label?: string;
  body?: string;
  color?: string;
  createdBy: "agent" | "user";
  updatedAt: number;
}

export interface CanvasEvent {
  id: EntityId;
  kind: "event";
  title: string;
  start: string;
  end?: string;
  pinId?: EntityId;
  createdBy: "agent" | "user";
  updatedAt: number;
}

export interface Note {
  id: EntityId;
  kind: "note";
  body: string;
  imageRefs: string[];
  parentId?: EntityId;
  createdBy: "agent" | "user";
  updatedAt: number;
}

export interface CanvasState {
  version: number;
  mode: CanvasMode;
  pins: Record<EntityId, Pin>;
  events: Record<EntityId, CanvasEvent>;
  notes: Record<EntityId, Note>;
}

export interface PendingEdit {
  id: string;
  entityId: EntityId;
  instruction: string;
  createdAt: number;
}

export type WSClientMessage =
  | { op: "pin.add"; data: Omit<Pin, "id" | "kind" | "createdBy" | "updatedAt"> }
  | { op: "pin.update"; id: EntityId; partial: Partial<Omit<Pin, "id" | "kind">> }
  | { op: "pin.delete"; id: EntityId }
  | { op: "event.add"; data: Omit<CanvasEvent, "id" | "kind" | "createdBy" | "updatedAt"> }
  | { op: "event.update"; id: EntityId; partial: Partial<Omit<CanvasEvent, "id" | "kind">> }
  | { op: "event.delete"; id: EntityId }
  | { op: "note.add"; data: Omit<Note, "id" | "kind" | "createdBy" | "updatedAt"> }
  | { op: "note.update"; id: EntityId; partial: Partial<Omit<Note, "id" | "kind">> }
  | { op: "note.delete"; id: EntityId }
  | { op: "mode.set"; mode: CanvasMode }
  | { op: "map.set"; mapId: string }
  | { op: "template.apply"; templateId: string; mode: CanvasMode; mapId?: string }
  | { op: "scoped_edit_request"; entityId: EntityId; instruction: string };

export type WSServerMessage =
  | { type: "state"; canvas: CanvasMeta; canvases: CanvasMeta[]; state: CanvasState; pendingEdits: PendingEdit[] }
  | { type: "error"; message: string };
