export type EntityId = string;
export type CanvasMode = "welcome" | "map" | "itinerary" | "docs" | "roadmap" | "sheets" | "charts";
export type RoadmapStatus = "todo" | "in_progress" | "done" | "blocked";
export type TravelMode = "flight" | "train" | "drive";
export type SheetColumnType = "text" | "number" | "date" | "checkbox";
export type ChartType = "bar" | "line" | "area" | "pie";
// v1 (Tandem × ANDR) execution primitive.
export type ActionType = "navigate";
export type ActionState =
  | "proposed"
  | "approved"
  | "rejected"
  | "executing"
  | "done"
  | "failed";
export type AgentRole = "planner" | "executor";
export type AgentStatus = "online" | "offline";
// A cell value is the JSON shape stored in sheet_rows.data[columnId].
// `null` means cleared/empty. Date stored as ISO-8601 "YYYY-MM-DD" string.
export type SheetCellValue = string | number | boolean | null;

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
  start: string;     // true UTC instant (ISO-8601)
  end?: string;
  // IANA timezone of this event's location (e.g. "America/Chicago"). The
  // itinerary formats + day-groups `start`/`end` in this zone. Per-event so
  // cross-timezone trips render correctly. Absent → viewer's local zone.
  timezone?: string;
  // Pins this entry covers. A single entry can span multiple stops (e.g. a
  // "check-in errands" entry hitting several places). The API populates this
  // from pinId for legacy single-pin events, so prefer reading pinIds.
  pinIds?: EntityId[];
  pinId?: EntityId;
  // Travel segment: set fromPinId + toPinId + travelMode together to render
  // this event as a route between two pins on the map (e.g. a flight).
  fromPinId?: EntityId;
  toPinId?: EntityId;
  travelMode?: TravelMode;
  // Optional short prefix the map renders before the day-cluster label
  // (e.g. "DAY 1" → "DAY 1 · Friday, May 29"). Any event on a given day can
  // carry the tag; the renderer picks the first non-empty one (sorted by
  // start) so agents typically set it on the first event of each day.
  dayTag?: string;
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

export interface RoadmapItem {
  id: EntityId;
  kind: "roadmap";
  parentId?: EntityId;
  title: string;
  body: string;
  status: RoadmapStatus;
  // Free-text phase label ("Now"/"Next"/"Later", "v1"/"v2", …) used to group
  // top-level goals into bands on the board. Empty/absent = unstaged.
  stage?: string;
  sortOrder: number;
  createdBy: "agent" | "user";
  updatedAt: number;
}

export interface SheetColumn {
  id: string; // uuid, stable across renames so row data keys don't break
  name: string;
  type: SheetColumnType;
  sortOrder: number;
}

export interface Sheet {
  id: EntityId;
  kind: "sheet";
  name: string;
  columns: SheetColumn[];
  sortOrder: number;
  createdBy: "agent" | "user";
  updatedAt: number;
}

export interface SheetRow {
  id: EntityId;
  kind: "sheetRow";
  sheetId: EntityId;
  data: Record<string, SheetCellValue>; // keyed by SheetColumn.id
  sortOrder: number;
  createdBy: "agent" | "user";
  updatedAt: number;
}

// A chart visualizes data from a sheet. The agent (or user) picks a source
// sheet, a category column for the x-axis, and one or more numeric columns to
// plot as series. Column refs are stored as SheetColumn.id; the API resolves
// column NAMES → ids on write so agents can pass human-readable names.
export interface Chart {
  id: EntityId;
  kind: "chart";
  name: string;
  sheetId: EntityId;       // source sheet
  chartType: ChartType;
  xColumn: string;          // SheetColumn.id used for category / x-axis labels
  yColumns: string[];       // SheetColumn.ids plotted as series (numeric)
  sortOrder: number;
  createdBy: "agent" | "user";
  updatedAt: number;
}

// An Action is the unit two agents coordinate on and a human approves before
// anything moves. `payload` shape depends on `type`; for "navigate":
// { goalLabel?, goal?: {lat,lng}, waypoints?: {lat,lng}[] }.
export interface NavigatePayload {
  goalLabel?: string;
  goal?: { lat: number; lng: number };
  waypoints?: { lat: number; lng: number }[];
}

export interface Action {
  id: EntityId;
  kind: "action";
  type: ActionType;
  state: ActionState;
  payload: NavigatePayload;
  proposedBy: string;        // agent id (provenance)
  approvedBy?: string;       // human/agent id that approved
  result?: string;           // execution outcome summary
  error?: string;            // failure detail
  linkedPinIds: EntityId[];  // pins this action references
  createdAt: string;
  updatedAt: string;
}

// Minimal identity so the canvas knows who is writing (provenance) and who is
// connected. Exactly one planner + one executor in v1.
export interface Agent {
  id: EntityId;
  kind: "agent";
  name: string;
  role: AgentRole;
  model?: string;
  status: AgentStatus;
  lastSeen: string;
}

export interface CanvasState {
  version: number;
  mode: CanvasMode;
  pins: Record<EntityId, Pin>;
  events: Record<EntityId, CanvasEvent>;
  notes: Record<EntityId, Note>;
  roadmapItems: Record<EntityId, RoadmapItem>;
  sheets: Record<EntityId, Sheet>;
  sheetRows: Record<EntityId, SheetRow>;
  charts: Record<EntityId, Chart>;
  actions: Record<EntityId, Action>;
  agents: Record<EntityId, Agent>;
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
  | { op: "roadmap.add"; data: Omit<RoadmapItem, "id" | "kind" | "createdBy" | "updatedAt"> }
  | { op: "roadmap.update"; id: EntityId; partial: Partial<Omit<RoadmapItem, "id" | "kind">> }
  | { op: "roadmap.delete"; id: EntityId }
  | {
      op: "roadmap.reorder";
      updates: { id: EntityId; parentId: EntityId | null; sortOrder: number }[];
    }
  | { op: "sheet.add"; data: { name?: string; columns?: Omit<SheetColumn, "id">[]; sortOrder?: number } }
  | { op: "sheet.update"; id: EntityId; partial: { name?: string; sortOrder?: number } }
  | { op: "sheet.delete"; id: EntityId }
  | { op: "sheet.column.add"; sheetId: EntityId; column: Omit<SheetColumn, "id"> }
  | { op: "sheet.column.update"; sheetId: EntityId; columnId: string; partial: Partial<Omit<SheetColumn, "id">> }
  | { op: "sheet.column.delete"; sheetId: EntityId; columnId: string }
  | { op: "sheet.row.add"; sheetId: EntityId; data?: Record<string, SheetCellValue>; sortOrder?: number }
  | { op: "sheet.row.update"; id: EntityId; partial: { data?: Record<string, SheetCellValue>; sortOrder?: number } }
  | { op: "sheet.row.delete"; id: EntityId }
  | { op: "sheet.row.reorder"; sheetId: EntityId; updates: { id: EntityId; sortOrder: number }[] }
  | {
      op: "chart.add";
      data: {
        name?: string;
        sheetId: EntityId;
        chartType?: ChartType;
        xColumn?: string;
        yColumns?: string[];
        sortOrder?: number;
      };
    }
  | {
      op: "chart.update";
      id: EntityId;
      partial: Partial<Pick<Chart, "name" | "sheetId" | "chartType" | "xColumn" | "yColumns" | "sortOrder">>;
    }
  | { op: "chart.delete"; id: EntityId }
  | { op: "mode.set"; mode: CanvasMode }
  | { op: "map.set"; mapId: string }
  | { op: "template.apply"; templateId: string; mode: CanvasMode; mapId?: string }
  | { op: "scoped_edit_request"; entityId: EntityId; instruction: string };

export type WSServerMessage =
  | { type: "state"; canvas: CanvasMeta; canvases: CanvasMeta[]; state: CanvasState; pendingEdits: PendingEdit[] }
  | { type: "error"; message: string };
