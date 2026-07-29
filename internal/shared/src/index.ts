export type EntityId = string;
export type CanvasMode = "welcome" | "map" | "itinerary" | "docs" | "roadmap" | "sheets" | "charts";
export type RoadmapStatus = "todo" | "in_progress" | "done" | "blocked";
export type TravelMode = "flight" | "train" | "drive";
export type SheetColumnType = "text" | "number" | "date" | "checkbox";
export type ChartType = "bar" | "line" | "area" | "pie";
// v1 (Tandem × ANDR) execution primitive. "epic" = a batch of related tasks
// approved as one unit (lifecycle proposed → approved only; never executed —
// progress is derived from its tasks).
export type ActionType = "navigate" | "task" | "epic";
// How much human gating agent-proposed tasks get on a canvas (migration 0033):
// 'strict' = every agent task lands proposed; 'epic' (default) = tasks under an
// APPROVED epic are born approved; 'auto' = every agent task born approved.
export type ApprovalPolicy = "strict" | "epic" | "auto";
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
  mode: string;      // the ACTIVE mode — what's on screen now, not what the canvas is
  enabledModes?: CanvasMode[]; // every mode turned on for this canvas; what it actually contains
  mapId?: string;    // Phase 3: active map preset (only meaningful in map mode)
  ownerUserId?: string; // set when a logged-in user owns the canvas; absent = anonymous
  visibility?: "public" | "private"; // access posture (migration 0021); absent treated as public
  publicRole?: "read" | "write";     // when public, what the code grants
  approvalPolicy?: ApprovalPolicy;   // agent-task gating (migration 0033); absent treated as "epic"
  yourRole?: "write" | "read" | "none"; // requester's resolved role; set per-connection on the state push
  version: number;
  createdAt: string; // ISO timestamp (Go API returns strings)
  updatedAt: string;
}

export interface Pin {
  id: EntityId;
  kind: "pin";
  documentId?: EntityId; // the map document this pin belongs to (see Document)
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
  documentId?: EntityId; // the itinerary document this event belongs to
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
  // Optional cost of this event (flights, hotels, activities…), in the trip's
  // currency. The itinerary sums these into live per-day + grand totals, so the
  // total spend always tracks the plan without a separate sheet to maintain.
  cost?: number;
  createdBy: "agent" | "user";
  updatedAt: number;
}

export interface Note {
  id: EntityId;
  kind: "note";
  documentId?: EntityId; // the notes document this note belongs to
  body: string;
  imageRefs: string[];
  parentId?: EntityId;
  // Position within the notes document. Authored via the Docs outline sidebar;
  // the server appends new notes at max+1 so writing never reorders the page.
  sortOrder: number;
  createdBy: "agent" | "user";
  // Server-derived provenance (migration 0039) — see Action.authoredBy.
  authoredBy?: string;
  updatedAt: number;
}

export interface RoadmapItem {
  id: EntityId;
  kind: "roadmap";
  documentId?: EntityId; // the roadmap document this item belongs to
  parentId?: EntityId;
  title: string;
  body: string;
  status: RoadmapStatus;
  // Free-text phase label ("Now"/"Next"/"Later", "v1"/"v2", …) used to group
  // top-level goals into bands on the board. Empty/absent = unstaged.
  stage?: string;
  // Who this item is FOR. "agent" marks it as an agent task — work an agent
  // session pulls (canvas_roadmap_task_list) and executes. Absent/"human" = a
  // human goal, the default.
  assignee?: "agent" | "human";
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
  documentId?: EntityId; // the sheet document this sheet backs (1:1)
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
  documentId?: EntityId;   // the chart document this chart backs (1:1)
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

// Payload for `type: "task"` — a unit of work an agent session picks up.
// linkedIds reference roadmap items / notes that carry the heavy context.
// assignee says who the work is FOR: "agent" tasks are what agent sessions
// pull from the queue; "human" tasks are the human's own todos. Defaults to
// "agent" server-side.
// One entry in an action payload's `audit` log (TDM-41). SERVER-OWNED: the API
// re-attaches its own copy on every payload write and discards whatever the
// caller sent under this key, so an agent can neither forge an entry nor erase
// the one recording its own edit. Capped at the 20 most recent.
//
// `reverted: true` marks the entries that cost an approval — a content edit on
// an approved or executing task sends it back to 'proposed' with its claim
// released, and this is the record of why. See apps/api/internal/store/
// content_gate.go for the full rule.
export interface ContentAuditEntry {
  at: string;
  /** Server-derived provenance, same vocabulary as `authoredBy`. */
  actor: string;
  /** Which approval-relevant fields moved. */
  change: ("title" | "body")[];
  fromState: ActionState;
  toState: ActionState;
  reverted: boolean;
  /** Compact old→new hint, e.g. `title: "Ship it" → "Ship it and rm -rf /"`. */
  summary: string;
}

export interface TaskPayload {
  title: string;
  body?: string;
  linkedIds?: EntityId[];
  assignee?: "agent" | "human";
  /** Server-owned edit log — see ContentAuditEntry. Never write this. */
  audit?: ContentAuditEntry[];
  // The epic (Action of type "epic") this task belongs to. Under the "epic"
  // approval policy, a task created under an APPROVED epic is born approved
  // (approved_by = "policy:epic").
  epicId?: EntityId;
  // Agent self-flag: true forces this task to land 'proposed' regardless of
  // the canvas approval policy (use it when deviating from the approved plan).
  requiresApproval?: boolean;
}

// Payload for `type: "epic"` — a named batch of related tasks approved as one
// unit. Tasks point back via their payload epicId. Epics only ever move
// proposed → approved (or rejected); they are never claimed/executed.
export interface EpicPayload {
  title: string;
  body?: string;
  linkedIds?: EntityId[];
  /** Server-owned edit log — see ContentAuditEntry. Never write this. */
  audit?: ContentAuditEntry[];
}

export interface Action {
  id: EntityId;
  kind: "action";
  type: ActionType;
  state: ActionState;
  payload: NavigatePayload | TaskPayload | EpicPayload;
  proposedBy: string;        // freeform label the CALLER sent — see authoredBy
  approvedBy?: string;       // human/agent id that approved
  claimedBy?: string;        // agent holding the executing claim (task_start)
  claimedAt?: string;        // when the claim was taken
  result?: string;           // execution outcome summary
  error?: string;            // failure detail
  linkedPinIds: EntityId[];  // pins this action references
  ticket?: number;           // per-canvas sequential task number (type "task" only)
  ticketId?: string;         // display form, "TDM-<n>" — built server-side from `ticket`
  // Server-derived provenance (migration 0039): "human" | "agent:<identity>" |
  // "anonymous". Stamped from the request's auth context on create and never
  // read off the body, so unlike proposedBy it can't be spoofed. Absent = the
  // row predates provenance; render nothing for it.
  authoredBy?: string;
  createdAt: string;
  updatedAt: string;
}

// Minimal identity so the canvas knows who is writing (provenance) and who is
// connected. `parentAgentId` links an executor subagent to the orchestrator
// (planner) that spawned it — the structural signal the swarm view groups on.
// Absent = unparented (renders flat).
export interface Agent {
  id: EntityId;
  kind: "agent";
  name: string;
  role: AgentRole;
  model?: string;
  parentAgentId?: EntityId;
  status: AgentStatus;
  lastSeen: string;
}

// ── Forms (direct-input layer) ───────────────────────────────────────────────
// A Form is an agent-defined recipe a human fills from a lightweight surface to
// mutate the canvas directly (no agent in the submit loop). `fields` is the input
// schema the dock renders; `actions` is the compiled fan-out the server runs at
// submit (opaque to the web — the dock only needs `fields`). See
// docs/DESIGN_DIRECT_INPUT.md.
export type FormFieldType = "text" | "number" | "date" | "select" | "checkbox";

export interface FormField {
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  options?: string[];
  default?: string | number | boolean;
  placeholder?: string;
}

export interface FormAction {
  op: "sheet.row.append" | "sheet.row.upsert" | "pin.patch";
  target: { sheet?: string; pin?: string };
  set: { column: string; value: unknown }[];
  match?: { column: string; value: unknown }[];
  inc?: string[];
}

export interface Form {
  id: EntityId;
  kind: "form";
  name: string;
  description: string;
  fields: FormField[];
  actions: FormAction[];
  sortOrder: number;
  createdBy: "agent" | "user";
  updatedAt: number;
}

// A Document is a named, multi-instance tab on a canvas (migration 0024). It
// generalizes what sheets already do to every view type: a canvas is a bag of
// documents, each an instance of a `type`, with a `name` and `sortOrder`. Child
// entities (pins/events/notes/roadmap items/sheets/charts) point back via their
// `documentId`. `config` carries type-specific settings — e.g. { mapId } for a
// map document. `parentId` nests a document under a `folder` document (roadmap
// item 8.5) — the document explorer renders these as a tree. A folder holds no
// content; it exists only to group other documents (and nested folders).
export type DocumentType = "map" | "notes" | "itinerary" | "roadmap" | "sheet" | "chart" | "folder";

export interface Document {
  id: EntityId;
  kind: "document";
  type: DocumentType;
  name: string;
  // Folder membership: the id of the `folder` document this one lives under, or
  // absent for a root-level document (item 8.5).
  parentId?: EntityId;
  sortOrder: number;
  config: Record<string, unknown>;
  createdBy: "agent" | "user";
  // Server-derived provenance (migration 0039) — see Action.authoredBy. Absent
  // on the document a sheet mints for itself (store-side; no request context).
  authoredBy?: string;
  updatedAt: number;
}

export interface CanvasState {
  version: number;
  mode: CanvasMode;
  // Modes a user explicitly turned on via the "+" tab, even before they hold
  // content. The tab bar shows the union of these and content-derived modes;
  // the agent sees them in state.read as "the user wants a tab here".
  enabledModes: CanvasMode[];
  // Named document instances — the source of truth for the tab strip (item 8)
  // and document explorer (item 9). Keyed by Document.id.
  documents: Record<EntityId, Document>;
  pins: Record<EntityId, Pin>;
  events: Record<EntityId, CanvasEvent>;
  notes: Record<EntityId, Note>;
  roadmapItems: Record<EntityId, RoadmapItem>;
  sheets: Record<EntityId, Sheet>;
  sheetRows: Record<EntityId, SheetRow>;
  charts: Record<EntityId, Chart>;
  forms: Record<EntityId, Form>;
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
  | {
      op: "event.update";
      id: EntityId;
      // clearEnd / clearCost remove an optional field (a nil pointer can't be
      // told from JSON null server-side, so clearing rides an explicit flag).
      partial: Partial<Omit<CanvasEvent, "id" | "kind">> & {
        clearEnd?: boolean;
        clearCost?: boolean;
      };
    }
  | { op: "event.delete"; id: EntityId }
  | { op: "note.add"; data: Omit<Note, "id" | "kind" | "createdBy" | "updatedAt" | "sortOrder"> }
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
  // `id` is normally minted server-side, but the client may supply one so a
  // paste that creates several columns can immediately key row data to them
  // without waiting for a round-trip (item 13 — paste power).
  | { op: "sheet.column.add"; sheetId: EntityId; column: Omit<SheetColumn, "id"> & { id?: string } }
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
  | {
      op: "document.add";
      data: {
        type: DocumentType;
        name?: string;
        config?: Record<string, unknown>;
        sortOrder?: number;
        // Create the document inside this folder (item 8.5); omit for root level.
        parentId?: EntityId;
      };
    }
  | {
      op: "document.update";
      id: EntityId;
      partial: { name?: string; sortOrder?: number; config?: Record<string, unknown> };
    }
  | { op: "document.delete"; id: EntityId }
  // Reorder AND re-parent in one op (mirrors roadmap.reorder): parentId is always
  // interpreted — a folder id to move the document into, or null for the root.
  | {
      op: "document.reorder";
      updates: { id: EntityId; parentId: EntityId | null; sortOrder: number }[];
    }
  | { op: "mode.set"; mode: CanvasMode }
  | { op: "mode.enable"; mode: CanvasMode }
  | { op: "map.set"; mapId: string }
  | { op: "template.apply"; templateId: string; mode: CanvasMode; mapId?: string }
  | { op: "scoped_edit_request"; entityId: EntityId; instruction: string }
  // Generic batch envelope: apply several ops as one WS message with ONE state
  // broadcast at the end, instead of one broadcast per op. Introduced for grid
  // paste (item 13 — a 10x20 paste is ~30 column/row ops) but works for any mix
  // of ops. Ops are applied in order; a sub-op that fails is logged and skipped,
  // the rest still apply. Not nested — a "batch" op inside `ops` is ignored.
  | { op: "batch"; ops: WSClientMessage[] };

export type WSServerMessage =
  | { type: "state"; canvas: CanvasMeta; canvases: CanvasMeta[]; state: CanvasState; pendingEdits: PendingEdit[] }
  // A stateless live-presence pulse (e.g. an agent reading the canvas). Carries
  // no canvas data — purely a signal to animate "the agent is here, looking".
  | { type: "activity"; action: "read"; actor?: "agent" }
  | { type: "error"; message: string };
