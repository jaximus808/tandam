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
// APPROVED epic are born approved; 'auto' = every agent task born approved;
// 'peer' (migration 0041) = gates exactly like 'strict', except a REGISTERED
// agent may approve a task a DIFFERENT agent proposed. Nothing is born approved
// under 'peer' and epics stay human-only; what changes is WHO can open the gate,
// which is why a peer approval is stamped approved_by = "agent:<identity>" and
// never "human" — see Action.approvedBy.
export type ApprovalPolicy = "strict" | "epic" | "auto" | "peer";
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
  // The document designated as this canvas's briefing — the read-me-first an
  // agent is handed on connect (migration 0037). At most one per canvas by
  // construction (it's a column on the canvas, not a flag on documents).
  // Absent = no briefing designated.
  briefingDocId?: EntityId;
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

/* Freshness (migration 0037) — the stored half of "can this still be trusted?".
   Carried by every kind that holds durable canvas context: notes, roadmap items,
   and documents. Only the PAIR is stored; the status (unknown/fresh/aging/stale)
   is derived at read time from the pair plus the current instant, so it can
   never itself be stale. Go's DeriveFreshness is the canonical derivation; the
   web mirrors it in lib/freshness.ts. */
export interface FreshnessFields {
  // When someone last asserted this content is still TRUE — deliberately NOT
  // when the bytes last changed (that's updatedAt). ISO timestamp; the Go API
  // returns strings. Absent = never verified, which is "unknown", not "stale".
  verifiedAt?: string;
  // How long a verification stays good, in seconds. Absent = no shelf life
  // declared, which reads as verified-and-not-ageing rather than fresh-forever
  // by fiat: the author vouched and declined to say it would expire.
  staleAfterSeconds?: number;
}

/* The write side of the freshness pair. A null-able column can't tell "leave it
   alone" from "null it out" through an absent field, so clearing rides an
   explicit flag — the same shape event.update uses for clearEnd/clearCost. */
export interface FreshnessPatchFields extends FreshnessFields {
  clearVerifiedAt?: boolean;
  clearStaleAfterSeconds?: boolean;
}

export interface Note extends FreshnessFields {
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

export interface RoadmapItem extends FreshnessFields {
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
// The log holds a SECOND kind of entry (E10): a human STATE MOVE — someone
// started, finished, reopened or re-queued the task on the board. Those carry
// change: ["state"] and are always `reverted: false`, because moving a card
// never costs an approval (a proposed task cannot be moved at all; the approval
// gate is the only way out of it). One trail per task rather than two competing
// ones — tell the kinds apart by `change`.
export interface ContentAuditEntry {
  at: string;
  /** Server-derived provenance, same vocabulary as `authoredBy`. */
  actor: string;
  /**
   * Which approval-relevant fields moved — or the literal "state" for a human
   * board move, whose fromState/toState are the whole content of the entry.
   */
  change: ("title" | "body" | "state")[];
  fromState: ActionState;
  toState: ActionState;
  reverted: boolean;
  /** Compact old→new hint, e.g. `title: "Ship it" → "Ship it and rm -rf /"`. */
  summary: string;
  /**
   * The mover's own words, VERBATIM, on the entries that carry one (state
   * moves). `summary` quotes the same note excerpted at 80 runes, which is right
   * for a glance and wrong for the one case where the note IS the payload: a
   * reviewer sending finished work back for rework (TDM-154) writes the
   * instruction the author has to act on. Read this, never the excerpt.
   * Absent on content entries, and on any row written before TDM-154.
   */
  note?: string;
}

// One collision on a task (TDM-100). SERVER-OWNED like `audit` and for the same
// reason, only more so: this records what agents did to each OTHER, so an agent
// that could author or erase entries would make it a record of what agents were
// willing to admit. The API re-attaches its own copy on every payload write.
//
// Two kinds, and the difference matters:
//
//   lost_claim    `agent` asked for a task `holder` already had. It never got the
//                 work — this is the race, and the loser yielding is the protocol
//                 doing its job.
//   fenced_write  `agent` wrote to a task it no longer holds and the write was
//                 REFUSED: either the holder is someone else, or `agent` is the
//                 recorded name under a lease that has since been superseded
//                 (presented ≠ generation). This one is a would-be double
//                 execution that didn't happen.
//
// Capped at the 20 most recent, and a repeat of the newest identical collision
// coalesces onto it as `count` rather than appending — so read max(count, 1).
export interface ContentionEvent {
  at: string;
  kind: "lost_claim" | "fenced_write";
  /** The LOSER: whose claim or write was refused. */
  agent: string;
  /** Who held the task at that moment — the winner. "nobody" when the claim had
   *  already been cleared out from under a still-writing loser. */
  holder?: string;
  /** Fence code for a fenced write; absent on a lost claim, whose reason is its
   *  kind. */
  reason?: "claimed_by_other" | "stale_claim_generation";
  /** The stale fencing token the loser wrote under — the fact holder identity
   *  alone could not have caught. Absent when none was presented. */
  presented?: number;
  /** The live claim generation at the moment of the collision. */
  generation?: number;
  /** Repeats coalesced onto this entry. Absent means once. */
  count?: number;
}

export interface TaskPayload {
  title: string;
  body?: string;
  linkedIds?: EntityId[];
  assignee?: "agent" | "human";
  /** Server-owned edit log — see ContentAuditEntry. Never write this. */
  audit?: ContentAuditEntry[];
  /** Server-owned collision trail — see ContentionEvent. Never write this. */
  contention?: ContentionEvent[];
  // The epic (Action of type "epic") this task belongs to. Under the "epic"
  // approval policy, a task created under an APPROVED epic is born approved
  // (approved_by = "policy:epic").
  epicId?: EntityId;
  // Agent self-flag: true forces this task to land 'proposed' regardless of
  // the canvas approval policy (use it when deviating from the approved plan).
  requiresApproval?: boolean;
  // Completion evidence: commit / PR / branch URLs, appended (never replaced)
  // by task_complete and by the inbound status API. GitHub links get a live
  // status on the board — see components/TaskLinks.tsx. Server-maintained:
  // append through those endpoints, never rewrite the array from a client.
  links?: string[];
  // Append-only progress log written by the inbound status API (state:
  // "progress") and the MCP task_progress tool. Bounded server-side.
  progress?: TaskProgressEntry[];
}

// One mid-flight report from whoever holds the task.
export interface TaskProgressEntry {
  at: string;
  agent?: string;
  by?: string;
  note: string;
  percent?: number;
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
  // What this batch ACHIEVED (TDM-93) — the epic-level answer to the question a
  // task's `result` answers per ticket. Written by a human in the board's epic
  // panel, or by an agent via task_complete's `epicSummary` when it finishes the
  // last task in the batch.
  //
  // NOT content: `summary` is outside the approval gate's title/body pair, so
  // writing one to an approved epic is a silent bookkeeping write and does NOT
  // revert the epic (which would revoke the approval its tasks inherit).
  summary?: string;
  /** Server-stamped provenance for `summary` ("human" | "agent:<name>"), set
   *  only when the text actually changes. Never write these two — the API
   *  discards a caller's value and re-derives them. */
  summaryBy?: string;
  summaryAt?: string;
}

export interface Action {
  id: EntityId;
  kind: "action";
  type: ActionType;
  state: ActionState;
  payload: NavigatePayload | TaskPayload | EpicPayload;
  proposedBy: string;        // freeform label the CALLER sent — see authoredBy
  // WHICH GATE this row passed, server-stamped (never read off the body):
  //   "human"            a signed-in person pressed Approve
  //   "agent:<identity>" a peer agent approved it under the 'peer' policy
  //                      (TDM-145) — a different agent than the one that
  //                      proposed it, enforced from stored provenance
  //   "policy:epic"      born approved because its epic was approved
  //   "policy:auto"      born approved: this canvas has no gate
  // Older rows may carry a freeform label instead. Absent = never approved.
  // The web app parses this with lib/provenance.parseApproval — the same
  // "agent:<identity>" grammar as authoredBy, on purpose.
  approvedBy?: string;
  claimedBy?: string;        // agent holding the executing claim (task_start)
  claimedAt?: string;        // when the claim was taken
  result?: string;           // execution outcome summary
  // Failure detail — AND the reason a human gave when rejecting it (TDM-161).
  // The same column carries both because they are the same kind of fact: the
  // last thing anyone said about why this action did not go on. Which one it is
  // follows from `state` ("rejected" vs "failed"). Read it through
  // ReviewFeedback rather than case by case — the API derives that shape and it
  // covers the rework bounce, whose reason lives in the audit log instead.
  error?: string;
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

// Why a piece of work came BACK (TDM-161) — DERIVED by the API at read time
// (apps/api/internal/api/review_feedback.go), never stored and never written by
// a client.
//
// ONE SHAPE, TWO ORIGINS, because to the agent that wrote the ticket they are
// the same event:
//
//   rejected  a human said no at the gate. The reason is `error` on the action.
//             Terminal — nobody will work it.
//   rework    finished work was sent back to the queue: a reviewer agent's
//             bounce (TDM-154) or a human's reopen. The reason is the `note` on
//             the done → approved entry in `audit`. NOT terminal — the ticket is
//             live again and the reason is the brief for the second attempt.
//
// Read it off task_get / GET /api/canvas/actions/{id} (`review`) and off the
// epic rollup (each epic's `returned[]`). It is deliberately absent from the
// ready queue, which answers "what should I start?" and must not become a
// notifications feed.
//
// It reflects CURRENT state, so an undone rejection (TDM-160) simply stops being
// reported, and a bounce that has since been redone stops too.
export interface ReviewFeedback {
  outcome: "rejected" | "rework";
  /** The decider's own words. VERBATIM on a single-task read — the reason IS the
   *  correction, so nothing excerpts it there. Absent when no reason was given,
   *  which is worth showing as silence rather than hiding. */
  reason?: string;
  /** Server-derived provenance, same vocabulary as `authoredBy`. */
  by?: string;
  at?: string;
  /** Where the action sits NOW — 'rejected' is over, anything else is live. */
  state: ActionState;
  /** Set only on a LIST read (an epic's `returned[]`), where reasons are cut to
   *  keep the batch read cheap. The whole text is one task_get away. */
  reasonTruncated?: boolean;
}

// One came-back ticket as the epic rollup lists it: the feedback plus enough to
// address the ticket it is about.
export interface ReturnedTicket extends ReviewFeedback {
  id: EntityId;
  ticketId?: string;
  title: string;
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

export interface Document extends FreshnessFields {
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
  // The freshness half of the partial rides FreshnessPatchFields: setting
  // verifiedAt is VOUCHING, a separate act from editing, so a body-only patch
  // never re-certifies content nobody re-read.
  | {
      op: "note.update";
      id: EntityId;
      partial: Partial<Omit<Note, "id" | "kind">> & FreshnessPatchFields;
    }
  | { op: "note.delete"; id: EntityId }
  | { op: "roadmap.add"; data: Omit<RoadmapItem, "id" | "kind" | "createdBy" | "updatedAt"> }
  | {
      op: "roadmap.update";
      id: EntityId;
      partial: Partial<Omit<RoadmapItem, "id" | "kind">> & FreshnessPatchFields;
    }
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
      partial: {
        name?: string;
        sortOrder?: number;
        config?: Record<string, unknown>;
      } & FreshnessPatchFields;
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
