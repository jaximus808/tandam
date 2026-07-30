/**
 * The INTENT FACADE — Tandem's default MCP surface (TDM-32 / E2.1).
 *
 * The CRUD surface in tools.ts is ~80 tools that mirror the API one endpoint at
 * a time. That's a fine machine interface and a bad agent interface: it costs a
 * large slice of the context window before the session does anything, and it
 * leaves the model to invent the workflow. This file replaces it as the DEFAULT
 * manifest with 12 tools shaped like the things an agent session actually wants
 * to do, in the order it wants to do them:
 *
 *     canvas_connect (+ role: register) → context_get → queue_next → task_get
 *              → task_claim → (work, task_progress) → doc_write → task_complete
 *
 * …or, with subagents, the same queue forks at queue_next: every ready task
 * comes back with a `handoff` block (TDM-62) the orchestrator pastes into one
 * subagent per task. It dispatches; the workers claim. See buildHandoff.
 *
 * agent_register is here too, but only as the SECOND chance: identity is meant
 * to be minted by canvas_connect's `role` argument (TDM-61), because a separate
 * registration call is a step a subagent can skip — and then the fleet tree the
 * board draws never forms.
 *
 * Implementation rule: these are a FACADE, not a second backend. Every tool
 * either delegates to the matching CRUD handler in tools.ts (so claim
 * atomicity, identity handling, and error shaping stay single-sourced) or
 * composes a couple of existing endpoints into one round trip. Nothing here
 * talks to a route that the CRUD surface doesn't already use.
 *
 * SECURITY INVARIANT: there is NO webhook tool here, and there must never be
 * one in ANY manifest. Outbound HTTP configured through an agent-facing tool is
 * a prompt-injection exfiltration primitive — canvas content is attacker-
 * influenced, so a tool that posts it anywhere is a data-exfil channel with
 * extra steps. Webhooks are configured by a human in the web UI only.
 *
 * The full CRUD surface stays one env var away: TANDEM_FULL_TOOLS=1 (or
 * `tandem-mcp --full-tools`) advertises it ALONGSIDE this facade.
 */

import type { Gateway } from "./gateway.js";
import { RAW_TOOL_BY_NAME, adoptCarriedSession, handleTool, type RawTool } from "./tools.js";
import {
  alreadyFinishedMessage,
  fenceRejectionMessage,
  findAnyLoss,
  forgetLoss,
  notYourClaimMessage,
  readConflict,
  recordLoss,
  tapOutBlock,
  writeReason,
  type ConflictBody,
} from "./tapout.js";

type Args = Record<string, unknown>;

/** Reuse a CRUD tool's input schema verbatim, so the two can't drift. */
function schemaOf(name: string) {
  return rawOf(name).inputSchema;
}

/**
 * Reuse a CRUD tool's description verbatim. Facade tools normally get their own
 * (intent-shaped) prose; this is for the few tools the facade advertises but
 * does not reimplement, where one description serves both surfaces.
 */
function descriptionOf(name: string) {
  return rawOf(name).description;
}

function rawOf(name: string): RawTool {
  const raw = RAW_TOOL_BY_NAME.get(name);
  if (!raw) throw new Error(`facade: no CRUD tool named ${name} to borrow from`);
  return raw;
}

/**
 * task_complete's schema is the CRUD one PLUS `epicSummary` (TDM-93) — the
 * epic-level write path. Added here rather than on canvas_task_complete because
 * the facade composes it: the CRUD tool finishes the task and knows nothing
 * about the batch it belonged to.
 */
function withEpicSummaryArg(schema: RawTool["inputSchema"]) {
  return {
    ...schema,
    properties: {
      ...(schema as { properties?: Record<string, unknown> }).properties,
      epicSummary: {
        type: "string",
        description:
          "What the whole EPIC achieved, when this completion finishes the batch — the epic-level " +
          "counterpart of `result`. One short paragraph a human can read instead of opening every " +
          "ticket: what shipped, what changed, what was decided. It is stored on the epic (and " +
          "shown on the board above its tickets), NOT on this task, and writing it does not " +
          "disturb the epic's approval. Omit it when tasks in the epic are still open — the answer " +
          "tells you how many are left. Rewriting an existing summary replaces it.",
      },
    },
  };
}

// The one line every facade description repeats, because the handle is the
// single thing a session must carry and the most common cause of a dead call.
const SESSION_CONVENTION =
  "Pass the `session` handle from canvas_connect on this call (the hosted MCP " +
  "connection can reset between calls; the handle re-binds you without reconnecting).";

// ── Composed reads ───────────────────────────────────────────────────────────

type TaskRow = {
  id: string;
  ticketId?: string;
  state: string;
  proposedBy?: string;
  claimedBy?: string;
  // When the current claim was taken (or last heartbeated). The board's whole
  // "is anyone actually working this?" question is answered from this field.
  claimedAt?: string;
  result?: string;
  createdAt?: string;
  payload?: {
    title?: string;
    body?: string;
    assignee?: string;
    epicId?: string;
    progress?: unknown;
  };
};

/** Every agent task on the canvas, in one read. The basis of queue/board views. */
async function listAgentTasks(gateway: Gateway): Promise<TaskRow[]> {
  const res = (await gateway.get("/api/canvas/actions?type=task&assignee=agent")) as {
    actions?: TaskRow[];
  };
  return res.actions ?? [];
}

function compactTask(a: TaskRow) {
  return {
    id: a.id,
    ...(a.ticketId ? { ticketId: a.ticketId } : {}),
    title: a.payload?.title ?? "",
    state: a.state,
    ...(a.claimedBy ? { claimedBy: a.claimedBy } : {}),
    ...(a.payload?.epicId ? { epicId: a.payload.epicId } : {}),
  };
}

function countByState(tasks: TaskRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  return counts;
}

// ── Epic rollups (TDM-93) ────────────────────────────────────────────────────

/**
 * What GET /api/canvas/epics answers: every batch with its SUMMARY (what it
 * achieved) and its server-derived rollup. Composed API-side so a board-level
 * question costs one round trip instead of one read per ticket.
 */
type EpicRollup = {
  id: string;
  title: string;
  state: string;
  summary?: string;
  summaryBy?: string;
  summaryAt?: string;
  tasks: { total: number; byState: Record<string, number> };
  firstActivity?: string;
  lastActivity?: string;
  done: Array<{ id: string; ticketId?: string; title: string; state: string; result?: string }>;
  drained: boolean;
  /** Drained with nobody saying what it delivered — the story is about to be lost. */
  summaryNeeded: boolean;
  truncated?: number;
};

/**
 * Read the rollups, or null on an API deployed before the endpoint existed
 * (same getIfAvailable contract context_get uses for /api/canvas/context).
 */
async function fetchEpicRollups(gateway: Gateway): Promise<EpicRollup[] | null> {
  try {
    const res = await gateway.getIfAvailable<{ epics?: EpicRollup[] }>("/api/canvas/epics");
    return res?.epics ?? null;
  } catch {
    // SUPPLEMENTARY, so it fails soft. Every caller of this asks its real
    // question through another endpoint (the board census, a task read, a
    // completion) and uses the rollup to enrich the answer — so a rollup that
    // 500s, times out, or isn't deployed must degrade the answer, never replace
    // it with an error. A completion in particular has already written to the
    // board by the time we get here: throwing would report a finished task as
    // failed.
    return null;
  }
}

/** One rollup by id, or null when the endpoint or the epic is absent. */
async function fetchEpicRollup(gateway: Gateway, epicId: string): Promise<EpicRollup | null> {
  const all = await fetchEpicRollups(gateway);
  return all?.find((e) => e.id === epicId) ?? null;
}

/**
 * Terminal states, mirroring the API's epicTerminalStates (epic_rollup.go) and
 * the web's TERMINAL_STATES. Duplicated across the three surfaces because each
 * needs it locally; they must agree on WHICH states are over, or the three will
 * disagree about whether a batch is finished.
 */
const EPIC_TERMINAL_STATES = ["done", "failed", "rejected"] as const;

/** How many of an epic's tasks will never move again on their own. */
function terminalCount(e: EpicRollup): number {
  return EPIC_TERMINAL_STATES.reduce((n, s) => n + (e.tasks.byState[s] ?? 0), 0);
}

/**
 * The compact epic block a task-shaped answer carries: what the batch is, what
 * it achieved so far, and where it stands. Deliberately drops `done[]` — a
 * worker finishing ONE ticket doesn't need forty of its siblings quoted back;
 * board_status is where the full account belongs.
 */
function epicSnapshot(e: EpicRollup) {
  return {
    id: e.id,
    title: e.title,
    state: e.state,
    ...(e.summary ? { summary: e.summary, ...(e.summaryBy ? { summaryBy: e.summaryBy } : {}) } : {}),
    tasks: e.tasks,
    drained: e.drained,
    summaryNeeded: e.summaryNeeded,
  };
}

/**
 * Merge a summary into an epic's payload and PATCH it back.
 *
 * A payload PATCH REPLACES the payload, so the existing fields have to be read
 * and carried — the same read-merge-write task_amend does. Safe against the
 * approval gate by construction: `summary` is not a content field (title/body),
 * so this write does NOT revert an approved epic to 'proposed', which is the
 * only reason an agent can be trusted with it at all.
 *
 * summaryBy / summaryAt are deliberately NOT sent: the API stamps them from
 * request provenance and discards anything a caller puts there.
 */
async function writeEpicSummary(
  gateway: Gateway,
  epicId: string,
  summary: string
): Promise<{ title: string; state: string }> {
  const { action } = (await gateway.get(`/api/canvas/actions/${encodeURIComponent(epicId)}`)) as {
    action?: { type?: string; state?: string; payload?: Record<string, unknown> };
  };
  if (!action) throw new Error(`No epic "${epicId}" found on this canvas.`);
  if (action.type !== "epic") {
    throw new Error(
      `"${epicId}" is a ${action.type ?? "unknown"}, not an epic — epicId must name an epic ` +
        `(board_status lists them). For a TASK's outcome use task_complete's \`result\`.`
    );
  }
  const payload: Record<string, unknown> = { ...(action.payload ?? {}), summary };
  await gateway.patch(`/api/canvas/actions/${encodeURIComponent(epicId)}`, {
    payload,
    agentName: gateway.claimant(),
  });
  return {
    title: typeof action.payload?.title === "string" ? action.payload.title : "",
    state: action.state ?? "",
  };
}

// ── In-flight reporting (TDM-95) ─────────────────────────────────────────────

/**
 * How long the API honours a claim before another session may take the task over
 * (CLAIM_TTL_MINUTES on the server, default 15). The gateway cannot read the
 * server's setting, so this is only used to LABEL a claim as stale in
 * board_status — it enforces nothing, and the server remains the authority on
 * whether a lease actually lapsed.
 */
const DEFAULT_CLAIM_LEASE_MINUTES = 15;

/** How long a progress note may be in a board read before it gets trimmed. */
const BOARD_PROGRESS_CHARS = 200;

type ProgressEntry = { at?: string; agent?: string; note?: string };

/** Whole minutes since an ISO timestamp; undefined if it isn't usable. */
function minutesSince(iso: string | undefined, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.round((now - at) / 60_000));
}

/**
 * The task's most recent progress note, trimmed. This is what makes a board read
 * a REPORT rather than a list of names: without it an orchestrator asked "how is
 * the fleet doing?" had to task_get every executing task to find out. It costs
 * nothing extra — progress is stored on the task payload the board read already
 * fetched.
 */
function lastProgressOf(task: TaskRow) {
  const hist: ProgressEntry[] = Array.isArray(task.payload?.progress)
    ? (task.payload?.progress as ProgressEntry[])
    : [];
  const last = hist[hist.length - 1];
  const note = typeof last?.note === "string" ? last.note.trim() : "";
  if (!note) return undefined;
  const ageMinutes = minutesSince(last?.at);
  return {
    note: note.length > BOARD_PROGRESS_CHARS ? `${note.slice(0, BOARD_PROGRESS_CHARS)}…` : note,
    ...(last?.at ? { at: last.at } : {}),
    ...(ageMinutes === undefined ? {} : { ageMinutes }),
    entries: hist.length,
  };
}

/**
 * One executing task, as a fleet report line: who holds it, how long they have
 * held it, whether that claim has outlived its lease, and the last thing they
 * said. `ticketId` is absent only for a task created before ticket numbering
 * (migration 0034) — those are still addressable by `id`.
 */
function inFlightRow(task: TaskRow) {
  const claimAgeMinutes = minutesSince(task.claimedAt);
  const progress = lastProgressOf(task);
  return {
    ...compactTask(task),
    claimedBy: task.claimedBy ?? "agent",
    ...(task.claimedAt ? { claimedAt: task.claimedAt } : {}),
    ...(claimAgeMinutes === undefined ? {} : { claimAgeMinutes }),
    // Past the default lease with no heartbeat since: the holder has probably
    // gone dark, and the server will let the task be reclaimed.
    ...(claimAgeMinutes !== undefined && claimAgeMinutes >= DEFAULT_CLAIM_LEASE_MINUTES
      ? { staleClaim: true }
      : {}),
    ...(progress ? { lastProgress: progress } : {}),
  };
}

const BRIEFING_NAMES_PER_KIND = 20;

/** Trim the summary's per-kind name lists to briefing size, marking what's hidden. */
function capNames(names: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [kind, list] of Object.entries(names)) {
    out[kind] =
      list.length > BRIEFING_NAMES_PER_KIND
        ? [...list.slice(0, BRIEFING_NAMES_PER_KIND), `…(+${list.length - BRIEFING_NAMES_PER_KIND} more)`]
        : list;
  }
  return out;
}

/** Canvas identity block shared by context_get and board_status. */
function canvasBlock(gateway: Gateway) {
  const s = gateway.getSession();
  return {
    id: s.canvasId,
    name: s.canvasName,
    code: s.canvasCode,
    url: gateway.canvasUrl(s.canvasCode),
  };
}

/**
 * The briefing bundle, composed from endpoints that exist TODAY: the canvas
 * state SUMMARY (counts + capped names — never the full board), the document
 * tabs, and the agent task queue.
 *
 * TODO(TDM-29 / E1.3): a server-built `GET /api/canvas/context` is landing in a
 * parallel epic and will return a better-curated briefing (pinned context,
 * conventions, recent activity). context_get already probes for it first and
 * returns it untouched when present; this composition is the fallback for any
 * API deployed before that endpoint. When the endpoint's contract is final,
 * decide whether to keep this fallback or drop it with a min-API-version check.
 */
async function composeContext(gateway: Gateway) {
  const [summary, docs, tasks] = await Promise.all([
    gateway.get("/api/canvas/state") as Promise<{
      mode?: string;
      version?: number;
      counts?: Record<string, number>;
      names?: Record<string, string[]>;
    }>,
    gateway.get("/api/canvas/documents") as Promise<{
      documents?: Array<{ id: string; type: string; name: string; parentId?: string }>;
    }>,
    listAgentTasks(gateway),
  ]);

  const byState = countByState(tasks);
  const ready = tasks.filter((t) => t.state === "approved").map(compactTask);

  return {
    source: "composed" as const,
    canvas: canvasBlock(gateway),
    mode: summary.mode,
    version: summary.version,
    // Counts + names only — a briefing must never cost a full-canvas read.
    // The API already caps names per kind (at 200); cap harder here, because a
    // briefing is meant to orient, not to enumerate.
    contents: { counts: summary.counts ?? {}, names: capNames(summary.names ?? {}) },
    documents: (docs.documents ?? []).map((d) => ({
      id: d.id,
      type: d.type,
      name: d.name,
      ...(d.parentId ? { parentId: d.parentId } : {}),
    })),
    queue: {
      byState,
      ready: ready.slice(0, 10),
      ...(ready.length > 10 ? { readyTruncated: ready.length - 10 } : {}),
    },
    _next:
      ready.length > 0
        ? "There is approved work waiting. Call queue_next: it returns a paste-ready `handoff` per " +
          "task to dispatch a subagent with, or task_get + task_claim the one you'll do yourself."
        : "No approved work. Ask the human what to do, or draft tasks with task_propose (they land as 'proposed' for approval).",
  };
}

// ── Lookup by name (TDM-95) ──────────────────────────────────────────────────

/**
 * THE LAST REASON TO READ THE WHOLE BOARD, removed.
 *
 * A ticket ref reaches a task in one call (every task_* tool accepts "TDM-21").
 * A NAME did not: told "finish the constraints task", a session had to list every
 * task and scan titles itself — the exact full-board read the queue-first surface
 * exists to avoid, and it burned the context window on rows it threw away.
 *
 * So: search server-side-ish (one list read, no bodies returned) and hand back
 * only the matches. Matching is deliberately dumb and predictable — substring,
 * then all-words-in-title, then all-words-in-title-or-body — because a model that
 * cannot tell why something matched will not trust the answer. `matchedIn` says
 * which rule fired.
 */
const FIND_MATCH_SUBSTRING = 3;
const FIND_MATCH_TITLE_WORDS = 2;
const FIND_MATCH_BODY = 1;

/** Ticket forms a human/model writes: "TDM-21", "tdm-21", "#21", "21". */
function asTicketRef(query: string): string | undefined {
  const m = /^(?:tdm-|#)?(\d{1,9})$/i.exec(query.trim());
  return m ? `TDM-${Number(m[1])}` : undefined;
}

/** Score one task against a query. undefined = not a match. */
function scoreTask(
  task: TaskRow,
  needle: string,
  words: string[]
): { score: number; matchedIn: "title" | "body" } | undefined {
  const title = (task.payload?.title ?? "").toLowerCase();
  const body = (task.payload?.body ?? "").toLowerCase();
  if (title.includes(needle)) return { score: FIND_MATCH_SUBSTRING, matchedIn: "title" };
  if (words.length > 0 && words.every((w) => title.includes(w))) {
    return { score: FIND_MATCH_TITLE_WORDS, matchedIn: "title" };
  }
  if (words.length > 0 && words.every((w) => title.includes(w) || body.includes(w))) {
    return { score: FIND_MATCH_BODY, matchedIn: "body" };
  }
  return undefined;
}

/** A match row: enough to act on (claim it, get it), never a body. */
function findRow(task: TaskRow, matchedIn?: "title" | "body") {
  return {
    ...compactTask(task),
    assignee: task.payload?.assignee ?? "agent",
    ...(task.claimedAt ? { claimedAt: task.claimedAt } : {}),
    ...(matchedIn ? { matchedIn } : {}),
  };
}

// ── Composed writes ──────────────────────────────────────────────────────────

/**
 * Resolve the notes document to write into, CREATING it when the name is new.
 * The raw API rejects an unknown document name (only the unnamed default is
 * created on demand), which makes "leave a note in a doc called X" a 3-call
 * dance. doc_write does that dance here so the agent gets one call.
 */
async function resolveNotesDocument(gateway: Gateway, ref: string): Promise<string> {
  const { documents = [] } = (await gateway.get("/api/canvas/documents")) as {
    documents?: Array<{ id: string; type: string; name: string }>;
  };
  const wanted = ref.trim().toLowerCase();
  const hit = documents.find(
    (d) => d.id.toLowerCase() === wanted || d.name.trim().toLowerCase() === wanted
  );
  if (hit) {
    if (hit.type !== "notes") {
      throw new Error(
        `Document "${ref}" is a ${hit.type} document, not a notes document — doc_write writes ` +
          `markdown notes. Pick a notes document (or a new name to create one).`
      );
    }
    return hit.id;
  }
  const created = (await gateway.post("/api/canvas/documents", {
    type: "notes",
    name: ref.trim(),
    createdBy: "agent",
  })) as { document?: { id: string } };
  if (!created.document?.id) throw new Error(`Could not create notes document "${ref}"`);
  return created.document.id;
}

// ── Dispatch handoff (TDM-62 / E9.2) ─────────────────────────────────────────

/**
 * THE DELEGATION CONTRACT, made machine-readable.
 *
 * An agent claims only what it will personally do. An orchestrator dispatches:
 * it never claims, never completes on a worker's behalf, and never transports
 * its `session` handle — that handle is ~700 base64 characters of JWT + identity
 * and handing it over makes every worker claim as the planner, collapsing the
 * fleet tree the board draws.
 *
 * So queue_next attaches a `handoff` to every ready task: the 8-char canvas
 * CODE, the task's id/ticket/title, the planner's agentId to parent under, and
 * the literal steps the worker follows. The orchestrator pastes it into a
 * subagent spawn verbatim — nothing to compose, nothing to leak.
 */
type Handoff = {
  canvasCode: string;
  taskId: string;
  ticketId?: string;
  title: string;
  /** The planner's registered id, or null when the caller never registered. */
  parentAgentId: string | null;
  /** The literal instruction sequence, in order. */
  steps: string[];
};

/**
 * What goes where the planner's agentId should be when the caller of queue_next
 * isn't registered. Spelled out rather than omitted, because a handoff missing
 * its parent link silently produces an orphaned worker — the exact failure the
 * fleet tree exists to make visible.
 */
const UNREGISTERED_PARENT =
  '<the planner\'s agentId — you have none yet: reconnect with canvas_connect role "planner" to get one>';

function buildHandoff(
  task: Record<string, unknown>,
  canvasCode: string,
  parentAgentId?: string
): Handoff {
  const taskId = String(task.id ?? "");
  const ticketId = typeof task.ticketId === "string" ? task.ticketId : undefined;
  const title = typeof task.title === "string" ? task.title : "";
  const parent = parentAgentId ?? UNREGISTERED_PARENT;
  const ticketSuffix = ticketId ? ` (${ticketId})` : "";
  return {
    canvasCode,
    taskId,
    ...(ticketId ? { ticketId } : {}),
    title,
    parentAgentId: parentAgentId ?? null,
    steps: [
      `canvas_connect with code "${canvasCode}", role "executor", a name for yourself, and parentAgentId "${parent}" — one call, connects AND registers you under the planner that sent you.`,
      `task_claim id "${taskId}"${ticketSuffix} — "${title}". Claim it yourself; the planner deliberately did not claim it for you.`,
      `If it comes back claimed:false, another session got there first — call queue_next and take a different ready task. Never work a task you did not claim.`,
      `task_get id "${taskId}" for the full brief (linked notes and roadmap items), then do the work.`,
      `task_progress on long work — one line per meaningful step, so the board shows movement instead of silence.`,
      `task_complete with a result summary (what changed, which files) plus \`links\` to any commit or PR.`,
    ],
  };
}

/** `## title` + blank line + body, when a title was given. */
function composeMarkdown(title: unknown, body: unknown): string {
  const t = typeof title === "string" ? title.trim() : "";
  const b = typeof body === "string" ? body : "";
  return t ? `## ${t}\n\n${b}` : b;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

const FACADE_NAMES = new Set([
  "canvas_connect",
  "agent_register",
  "context_get",
  "queue_next",
  "task_find",
  "task_get",
  "task_claim",
  "task_progress",
  "task_complete",
  "task_propose",
  "task_amend",
  "epic_propose",
  "doc_write",
  "board_status",
]);

/**
 * Advertised on the facade but IMPLEMENTED on the CRUD surface (tools.ts), so
 * both manifests run one implementation. canvas_connect and agent_register are
 * the identity pair: connect takes the registration fields (TDM-61) and
 * agent_register re-registers afterwards — the same handler serves both
 * surfaces, only the description differs.
 */
const IMPLEMENTED_BY_CRUD = new Set(["canvas_connect", "agent_register"]);

/** Does this tool name route to handleFacadeTool? (Some facade names don't.) */
export function isFacadeTool(name: string): boolean {
  return FACADE_NAMES.has(name) && !IMPLEMENTED_BY_CRUD.has(name);
}

/**
 * Reject a missing/empty `id` BEFORE any request (TDM-133). The pass-through
 * delegators (task_get / task_claim / task_complete) used to skip this, so an
 * empty id built a URL with an empty segment — the API mounts the SPA on `/*`, so
 * `/api/canvas/actions/` is answered with index.html (200), which the gateway then
 * JSON-parsed and threw an opaque `SyntaxError: Unexpected token '<'` on. Mirror
 * task_progress's clean validation instead. Returns the trimmed id.
 */
function requireTaskId(args: Args): string {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    throw new Error(
      "`id` (string) is required — pass the task's ticket ref (e.g. \"TDM-21\") or its uuid."
    );
  }
  return id;
}

export async function handleFacadeTool(
  gateway: Gateway,
  toolName: string,
  args: Args
): Promise<unknown> {
  // Same model-carried binding contract as the CRUD surface.
  adoptCarriedSession(gateway, toolName, args);

  switch (toolName) {
    case "context_get": {
      // Prefer the server-built briefing when the API has it (TDM-29 / E1.3);
      // fall back to composing one from endpoints that exist today. See
      // Gateway.getIfAvailable for why "absent" is broader than a 404 here.
      const served = await gateway.getIfAvailable<Record<string, unknown>>("/api/canvas/context");
      if (served) return { source: "api", canvas: canvasBlock(gateway), ...served };
      return composeContext(gateway);
    }

    case "queue_next": {
      // Thin intent rename of canvas_task_list pinned to the ready queue, plus
      // the per-task dispatch handoff (TDM-62) — the reason an orchestrator
      // never has to improvise a subagent brief, or reach for its session handle.
      const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 10;
      const listed = (await handleTool(gateway, "canvas_task_list", {
        state: "approved",
        assignee: "agent",
        ...(args.epicId ? { epicId: args.epicId } : {}),
      })) as { tasks?: unknown[]; hint?: string };
      const tasks = listed.tasks ?? [];
      const session = gateway.getSession();

      // ANTI-LOOP, the queue half (TDM-99). A task THIS session was told to let
      // go of must not be offered back to it as fresh work — that round trip
      // (queue_next → claim → lose → queue_next) is the loop the tap-out contract
      // exists to break, and the ready queue is where it closes.
      //
      // Annotated rather than hidden: a vanishing task is worse than a marked
      // one — the session (and the human reading its transcript) can still see
      // the work exists and who holds it. What it does NOT get is a `handoff`,
      // because a handoff is a dispatch instruction and dispatching a task you
      // just lost is the loop with extra steps.
      //
      // And this is the SELF-HEALING path: if the server now lists the task as
      // ready with NO holder, the winner's claim is over (release clears
      // claimed_by), so the loss is stale and gets forgotten right here — the
      // task comes back with a handoff, claimable again.
      const lostByYou: Array<Record<string, unknown>> = [];
      const shown = tasks.slice(0, Math.max(1, limit)).map((t) => {
        const row = (t ?? {}) as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id : undefined;
        const ticketId = typeof row.ticketId === "string" ? row.ticketId : undefined;
        const loss = findAnyLoss(gateway, [id, ticketId]);
        if (loss) {
          const holder = typeof row.claimedBy === "string" ? row.claimedBy : undefined;
          if (!holder) {
            // Ready and unheld: proof the claim that beat us is gone.
            forgetLoss(gateway, id, ticketId);
          } else {
            const marked = {
              ...row,
              lostByYou: true,
              ...(loss.holder ? { lostTo: loss.holder } : {}),
              _tapOut:
                `You already lost this task to "${loss.holder ?? holder}" — it is NOT yours to ` +
                `claim or dispatch. No handoff is attached on purpose. Take a different task.`,
            };
            lostByYou.push({ id, ...(ticketId ? { ticketId } : {}) });
            return marked;
          }
        }
        return { ...row, handoff: buildHandoff(row, session.canvasCode, session.agentId) };
      });
      // canvas_task_list's fan-out `hint` is deliberately NOT passed through:
      // it says the same thing as `_dispatch` below, and the handoffs make it
      // concrete. The hint stays for sessions calling canvas_task_list directly
      // on the CRUD surface, which get no handoffs.
      return {
        tasks: shown,
        ...(tasks.length > limit ? { truncated: tasks.length - limit } : {}),
        ...(lostByYou.length > 0
          ? {
              lostByYou,
              _lostByYou:
                `${lostByYou.length} task(s) in this list are marked lostByYou — you already ` +
                `raced for them and lost, so they carry no handoff and you must not claim them ` +
                `again. If every task is marked, there is nothing here for you: report that ` +
                `instead of re-claiming.`,
            }
          : {}),
        ...(shown.length > 0
          ? {
              _dispatch:
                "If you have subagents, dispatch — do not claim these yourself. Spawn one " +
                "subagent per task and paste that task's `handoff` into it verbatim; each " +
                "worker registers under you and claims its own task. Working alone? Pick ONE, " +
                "task_get it, task_claim it, then work. Either way your `session` handle stays " +
                "with you — the canvas CODE in the handoff is what travels." +
                (session.agentId
                  ? ""
                  : " You are not registered, so the handoffs carry a placeholder parent: " +
                    'reconnect with canvas_connect role "planner" and call queue_next again ' +
                    "so your workers show up under you on the board."),
            }
          : {
              _next:
                "Nothing approved. Tasks you propose land as 'proposed' and need a human to " +
                "approve them on the board — check board_status, or ask the human.",
            }),
      };
    }

    case "task_find": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        throw new Error(
          "`query` (string) is required — part of the task's title (e.g. \"constraints\"), or " +
            "its ticket ref (\"TDM-21\")."
        );
      }
      const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Number(args.limit)) : 10;
      const state = typeof args.state === "string" ? args.state.trim() : "";
      const assignee = typeof args.assignee === "string" ? args.assignee.trim() : "any";

      // A ticket ref is not a search — it is an address. Resolve it directly
      // rather than scanning titles for a number that isn't in them. Absent is an
      // ANSWER here (no matches), not an error: the API 404s an unknown ref
      // (TDM-95) and getIfAvailable turns that into null.
      const ticketRef = asTicketRef(query);
      if (ticketRef) {
        const hit = await gateway.getIfAvailable<{ action?: TaskRow }>(
          `/api/canvas/actions/${encodeURIComponent(ticketRef)}`
        );
        const action = hit?.action;
        return {
          query,
          resolvedAs: ticketRef,
          matches: action ? [findRow(action)] : [],
          _next: action
            ? `That ref addresses a task directly — pass "${ticketRef}" to task_get / task_claim / ` +
              `task_complete as \`id\`, no lookup needed.`
            : `No task ${ticketRef} on this canvas. Either the number is wrong or you are on a ` +
              `different canvas than the one it belongs to — check board_status, or search by title.`,
        };
      }

      const params = ["type=task"];
      if (state) params.push(`state=${encodeURIComponent(state)}`);
      if (assignee && assignee !== "any") params.push(`assignee=${encodeURIComponent(assignee)}`);
      const listed = (await gateway.get(`/api/canvas/actions?${params.join("&")}`)) as {
        actions?: TaskRow[];
      };
      const rows = listed.actions ?? [];

      const needle = query.toLowerCase();
      const words = needle.split(/\s+/).filter((w) => w.length > 1);
      const scored = rows
        .map((task) => ({ task, hit: scoreTask(task, needle, words) }))
        .filter((r): r is { task: TaskRow; hit: { score: number; matchedIn: "title" | "body" } } =>
          Boolean(r.hit)
        )
        // Best rule first, then newest — a repeated title is usually the recent one.
        .sort(
          (a, b) =>
            b.hit.score - a.hit.score ||
            Date.parse(b.task.createdAt ?? "") - Date.parse(a.task.createdAt ?? "")
        );

      const matches = scored.slice(0, limit).map((r) => findRow(r.task, r.hit.matchedIn));
      return {
        query,
        matches,
        ...(scored.length > limit ? { truncated: scored.length - limit } : {}),
        searched: rows.length,
        _next:
          matches.length === 0
            ? "Nothing matched. Try fewer words (matching is substring-then-all-words over the " +
              "title, then bodies), drop the `state` filter, or read board_status for what is here."
            : "Take the `id` (or `ticketId`) of the right one straight to task_get for the full " +
              "brief, then task_claim if it is approved and you will do it yourself. Matching is " +
              "textual, so confirm the title is the task you meant before claiming.",
      };
    }

    case "task_get": {
      requireTaskId(args);
      const got = (await handleTool(gateway, "canvas_task_get", args)) as {
        epic?: { id?: string };
      };
      // The API hydrates {id, title, state} for the task's epic. Deepen it into
      // the batch's rollup (TDM-93) so the worker learns, BEFORE it starts, how
      // much of the batch is left and whether finishing this task finishes the
      // epic — which is the moment to say what the whole batch achieved. Told
      // only afterwards, the answer arrives when there is no call left to put it
      // on. One extra read, and only for a task that HAS an epic.
      const epicId = typeof got?.epic?.id === "string" ? got.epic.id : "";
      if (!epicId) return got;
      const rollup = await fetchEpicRollup(gateway, epicId);
      if (!rollup) return got;
      const open = rollup.tasks.total - terminalCount(rollup);
      return {
        ...got,
        epic: { ...got.epic, ...epicSnapshot(rollup), openTasks: open },
        ...(open <= 1
          ? {
              _epic:
                `This is the LAST unfinished task in "${rollup.title}". When you complete it, pass ` +
                `\`epicSummary\` to task_complete — a short account of what the whole BATCH achieved, ` +
                `not just this ticket. Nothing else records that, and after this completion there is ` +
                `no call left to put it on.`,
            }
          : {}),
      };
    }

    case "task_claim":
      requireTaskId(args);
      return handleTool(gateway, "canvas_task_start", args);

    case "task_progress": {
      // Progress is a HEARTBEAT, not just a note (TDM-67). It goes through the
      // inbound status endpoint — POST /api/canvas/{code}/tasks/{id}/status with
      // state "progress" — and NOT the payload-only PATCH this used to do, for
      // two reasons the client-side version could not give us:
      //
      //   1. The lease. A claim expires ~15 min after claimed_at, and the server
      //      only refreshes it (TouchActionClaim, TDM-64) for the holder who
      //      reports through this endpoint. Over the old PATCH a worker doing an
      //      hour of real work heartbeated the whole time and still had its task
      //      reclaimed underneath it.
      //   2. The guard. The PATCH carries no caller identity, so the "is this
      //      yours?" check had to be a client-side read-modify-write that any
      //      other client could simply not do. Now the server enforces it.
      //
      // The append-to-payload.progress[] behaviour is unchanged — the endpoint
      // does the same merge server-side (capped, additive), so progress still
      // travels WITH the task and comes back from task_get.
      const id = String(args.id ?? "");
      const note = typeof args.note === "string" ? args.note.trim() : "";
      if (!id) throw new Error("`id` (string) is required");
      if (!note) throw new Error("`note` (string) is required — say what changed since last time");

      const claimant = (args.agentName as string | undefined) ?? gateway.claimant();
      const percent = typeof args.percent === "number" ? args.percent : undefined;
      // The stored entry is {at, agent, note} — there is no percent field on the
      // wire. Fold it into the line rather than dropping the caller's number.
      const summary = percent === undefined ? note : `${note} (${Math.round(percent)}%)`;
      const code = gateway.getSession().canvasCode;

      const { data, conflict } = await gateway.postWithConflict<
        { action?: { claimedBy?: string; claimedAt?: string; payload?: Record<string, unknown> } },
        ConflictBody
      >(`/api/canvas/${encodeURIComponent(code)}/tasks/${encodeURIComponent(id)}/status`, {
        state: "progress",
        agent: claimant,
        summary,
        // Present the claim's fencing token (TDM-121) so a heartbeat from a lease
        // that has been superseded is refused by generation, not just by name.
        ...(gateway.claimGeneration() ? { claimGeneration: gateway.claimGeneration() } : {}),
      });

      // A rejected heartbeat is an ANSWER, not a crash: the model should route on
      // it (go take a task that is actually yours) rather than see a thrown
      // protocol error mid-work. Same shape the old client-side guard returned.
      //
      // TDM-99: when the rejection is CONTENTION — another agent holds it, our
      // claim was fenced, or the work is already over — it also carries the
      // tap-out block, so a worker heartbeating into a task that moved on beneath
      // it gets the same machine-readable "stop" a lost claim gets, and the loss
      // is remembered so it cannot follow up with a claim attempt.
      //
      // A task that is merely NOT CLAIMED is not a tap-out: nobody beat this
      // caller, and the answer is task_claim, not queue_next. `reason` is a
      // TapOutReason on a tap-out response and the API's own error code otherwise
      // (`apiError` always carries the raw code, whichever branch you are in).
      if (conflict) {
        const c = readConflict(conflict);
        const holder = c.holder;
        const reason = writeReason(c);
        if (reason) {
          const loss = recordLoss(gateway, id, { holder, reason, claimGeneration: c.claimGeneration });
          return {
            recorded: false,
            id,
            by: claimant,
            ...(c.code ? { apiError: c.code } : {}),
            ...(holder ? { claimedBy: holder } : {}),
            ...(c.state ? { state: c.state } : {}),
            ...tapOutBlock(loss),
            message: c.fenced
              ? fenceRejectionMessage(id, holder)
              : reason === "already_finished"
                ? alreadyFinishedMessage(c.state ?? "finished")
                : notYourClaimMessage(holder ?? "another agent", "report on"),
          };
        }
        return {
          recorded: false,
          id,
          by: claimant,
          reason: c.code ?? "rejected",
          ...(c.code ? { apiError: c.code } : {}),
          ...(c.state ? { state: c.state } : {}),
          message: c.state
            ? `This task is "${c.state}", not executing — only the agent currently ` +
              `working a task can report on it. Claim it with task_claim first.`
            : (c.message ?? "The API rejected this progress report."),
        };
      }

      const action = data?.action ?? {};
      const stored = Array.isArray(action.payload?.progress)
        ? (action.payload?.progress as unknown[])
        : [];
      return {
        recorded: true,
        id,
        by: claimant,
        entries: stored.length,
        ...(percent === undefined ? {} : { percent }),
        // The fresh claimed_at IS the lease extension — hand it back so a worker
        // (and the human reading the board) can see the clock reset. The server
        // refreshes it holder-only, and its predicate is exactly "claimed_by =
        // this agent", so mirror that rather than claiming an extension for a
        // report accepted against a non-exclusive holder ("" / "agent").
        ...(action.claimedAt ? { claimedAt: action.claimedAt } : {}),
        leaseExtended: Boolean(action.claimedBy) && action.claimedBy === claimant,
        note:
          "Progress is stored on the task and comes back from task_get. Reporting also " +
          "extends your claim, so keep heartbeating on long work and no one can reclaim it.",
      };
    }

    case "task_complete": {
      requireTaskId(args);
      // `epicSummary` is the EPIC-level write path (TDM-93), and it is an
      // argument here rather than a tool of its own on purpose: the moment an
      // agent knows what a batch achieved is the moment it finishes the last
      // task in it, and a write that costs a second call at that moment is a
      // write that doesn't happen. So the account of the batch rides the same
      // call as the account of the ticket.
      const epicSummary = typeof args.epicSummary === "string" ? args.epicSummary.trim() : "";
      const { epicSummary: _omit, ...forward } = args;
      const done = (await handleTool(gateway, "canvas_task_complete", forward)) as
        | { completed?: boolean; action?: { payload?: { epicId?: string } } }
        | undefined;

      // A refused completion (tap-out: someone else holds it, our lease was
      // fenced, the work is already over) is not ours to summarize. Return it
      // untouched — the model must route on that shape, not read past it.
      if (!done || done.completed === false) return done;

      const epicId =
        typeof done.action?.payload?.epicId === "string" ? done.action.payload.epicId : "";
      if (!epicId) {
        if (epicSummary) {
          // Honesty over silence: the caller wrote a batch summary and there is
          // no batch. Saying nothing would let it believe the write landed.
          return {
            ...done,
            epicSummary: {
              written: false,
              reason: "This task belongs to no epic, so there was no batch to summarize.",
            },
          };
        }
        return done;
      }

      let written: Record<string, unknown> | undefined;
      if (epicSummary) {
        try {
          const epic = await writeEpicSummary(gateway, epicId, epicSummary);
          written = { written: true, epicId, title: epic.title };
        } catch (err) {
          // The TASK is done — that write already landed and must not be
          // reported as failed because the summary didn't. Degrade loudly.
          written = {
            written: false,
            epicId,
            error: err instanceof Error ? err.message : String(err),
            note: "The task completed; only the epic summary failed to save.",
          };
        }
      }

      const rollup = await fetchEpicRollup(gateway, epicId);
      if (!rollup) return { ...done, ...(written ? { epicSummary: written } : {}) };
      const open = rollup.tasks.total - terminalCount(rollup);
      return {
        ...done,
        ...(written ? { epicSummary: written } : {}),
        epic: { ...epicSnapshot(rollup), openTasks: open },
        ...(rollup.summaryNeeded
          ? {
              _epic:
                `"${rollup.title}" has now DRAINED — every task in it is finished — and nothing ` +
                `records what the batch achieved. You still hold the context: if any work in this ` +
                `epic is yours, say so in your report to the human so they can write it on the ` +
                `board, and pass \`epicSummary\` on your next task_complete in this epic if one is ` +
                `left. Reading it back later costs a read of every ticket.`,
            }
          : open > 0
            ? {
                _epic:
                  `${open} task(s) left in "${rollup.title}". Whoever finishes the last one should ` +
                  `pass \`epicSummary\` to task_complete to record what the batch achieved.`,
              }
            : {}),
      };
    }

    case "task_propose": {
      // One tool, both shapes: a single task, or a whole plan in one round trip.
      const many = args.tasks;
      if (Array.isArray(many) && many.length > 0) {
        // Spread the CALL-LEVEL defaults onto every item (TDM-116). The batch
        // branch used to forward only `tasks`, silently dropping a top-level
        // epicId / assignee / requiresApproval — so a whole plan proposed under an
        // epic landed unparented and the response still said "created". The
        // single-task branch below never had this bug (it passes `args` whole), and
        // epic_propose already merges its epic id this way. Item-level fields WIN,
        // so a task may still override a call-level default.
        for (const [i, t] of (many as Args[]).entries()) {
          if (!t || typeof t.title !== "string" || !t.title.trim()) {
            throw new Error(`tasks[${i}] needs a \`title\` — one line saying what to do`);
          }
        }
        return handleTool(gateway, "canvas_task_add_batch", {
          tasks: (many as Args[]).map((t) => ({
            ...(args.epicId ? { epicId: args.epicId } : {}),
            ...(args.assignee ? { assignee: args.assignee } : {}),
            ...(args.requiresApproval !== undefined
              ? { requiresApproval: args.requiresApproval }
              : {}),
            ...t,
          })),
        });
      }
      if (typeof args.title !== "string" || !args.title.trim()) {
        throw new Error("Pass `title` (one task) or `tasks` (an array of them)");
      }
      return handleTool(gateway, "canvas_task_add", args);
    }

    case "task_amend": {
      // Self-correction for a PROPOSAL, deliberately narrow (TDM-117). An agent may
      // amend or withdraw a task IT proposed — but ONLY while it is still `proposed`
      // and unclaimed. Once a human approves it, it is theirs (ask, don't edit);
      // once someone claims it, the claim fence owns it. The three-way guard below
      // is checked against the SERVER's view of the task, never anything
      // self-reported: authoredBy is server-derived provenance (TDM-40). This lets
      // the default surface self-heal a mis-proposed plan without opening a hole to
      // rewrite approved or in-flight work.
      const id = requireTaskId(args);
      const withdraw = args.withdraw === true;
      const amendable = ["title", "body", "epicId", "linkedIds"] as const;
      if (!withdraw && !amendable.some((k) => args[k] !== undefined)) {
        throw new Error(
          "Nothing to amend — pass at least one of title / body / epicId / linkedIds, or " +
            "`withdraw: true` to retract the proposal."
        );
      }

      const { action } = (await gateway.get(
        `/api/canvas/actions/${encodeURIComponent(id)}`
      )) as {
        action?: {
          state?: string;
          claimedBy?: string;
          authoredBy?: string;
          type?: string;
          payload?: Record<string, unknown>;
        };
      };
      if (!action) throw new Error(`No task "${id}" found on this canvas.`);

      // GUARD 1 — still a proposal. Approved / executing / done are off-limits.
      if (action.state !== "proposed") {
        throw new Error(
          `This task is "${action.state}", not "proposed" — you cannot amend it. Once a human ` +
            `approves a task it is theirs: propose a follow-up, or ask the human to reject this one.`
        );
      }
      // GUARD 2 — unclaimed. A proposed task normally has no holder; refuse if it does.
      const holder = action.claimedBy;
      if (holder && holder !== "agent") {
        throw new Error(
          `This task is held by "${holder}", so it is not yours to amend. Take a different task.`
        );
      }
      // GUARD 3 — you proposed it. authoredBy is server-derived "agent:<identity>";
      // compare to this session's claim identity (the same string X-Tandem-Agent
      // carried when the proposal was created). A task predating provenance has no
      // authoredBy — allow it rather than strand it (best-effort, matches TDM-40).
      const me = `agent:${gateway.claimant()}`;
      if (action.authoredBy && action.authoredBy !== me) {
        throw new Error(
          `You did not propose this task (authored by "${action.authoredBy}"), so it is not yours ` +
            `to amend. Only the agent that proposed a task may correct it.`
        );
      }

      // Withdraw: delete the proposal outright (unclaimed + no holder ⇒ unfenced).
      if (withdraw) {
        await gateway.del(`/api/canvas/actions/${encodeURIComponent(id)}`);
        return { withdrawn: true, id, url: canvasBlock(gateway).url };
      }

      // Amend: merge the changed fields onto the existing payload and PATCH the
      // whole thing. The payload-only PATCH replaces + canonicalizes (title
      // required), so carry the existing values forward for anything not changed.
      const payload: Record<string, unknown> = { ...(action.payload ?? {}) };
      if (typeof args.title === "string" && args.title.trim()) payload.title = args.title.trim();
      if (typeof args.body === "string") payload.body = args.body;
      if (args.epicId !== undefined) payload.epicId = args.epicId;
      if (args.linkedIds !== undefined) payload.linkedIds = args.linkedIds;
      if (typeof payload.title !== "string" || !(payload.title as string).trim()) {
        throw new Error("A task needs a non-empty `title` — pass a new one, or leave the existing.");
      }
      await gateway.patch(`/api/canvas/actions/${encodeURIComponent(id)}`, {
        payload,
        agentName: gateway.claimant(),
      });
      return { amended: true, id, url: canvasBlock(gateway).url };
    }

    case "epic_propose": {
      // The container a plan hangs off. Without this on the facade an agent
      // asked to "write an epic" could only propose loose tasks, which land
      // unparented and each need their own approval.
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) throw new Error("`title` (string) is required — name the batch of work");

      // Validate the optional plan BEFORE writing the epic: a batch rejected by
      // the API after the epic landed would leave an empty epic on the board.
      const many = Array.isArray(args.tasks) ? (args.tasks as Args[]) : [];
      for (const [i, t] of many.entries()) {
        if (!t || typeof t.title !== "string" || !t.title.trim()) {
          throw new Error(`tasks[${i}] needs a \`title\` — one line saying what to do`);
        }
      }

      const epic = (await handleTool(gateway, "canvas_epic_add", {
        title,
        body: args.body,
        linkedIds: args.linkedIds,
      })) as { id?: string; state?: string };
      if (!epic?.id) throw new Error("The epic was not created — no id came back");

      // Then the plan under it, in one write. The epic's id WINS over any
      // epicId an item carried: this call's whole point is the new container.
      let tasks: Array<Record<string, unknown>> = [];
      if (many.length > 0) {
        const batch = (await handleTool(gateway, "canvas_task_add_batch", {
          tasks: many.map((t) => ({ ...t, epicId: epic.id })),
        })) as { actions?: Array<{ id: string; ticketId?: string; state: string; payload?: { title?: string } }> };
        // Project: ids and titles are what a session needs to refer back to
        // these; the bodies it just wrote are not.
        tasks = (batch.actions ?? []).map((a) => ({
          id: a.id,
          ...(a.ticketId ? { ticketId: a.ticketId } : {}),
          title: a.payload?.title ?? "",
          state: a.state,
        }));
      }

      return {
        created: true,
        epicId: epic.id,
        state: epic.state ?? "proposed",
        ...(many.length > 0 ? { tasks } : {}),
        url: canvasBlock(gateway).url,
        _next:
          "The epic is 'proposed'. A HUMAN approves it once on the board and that approval " +
          "cascades to every task under it — do not try to approve it yourself. NOW LISTEN FOR " +
          "THAT APPROVAL instead of ending your turn: unless the user told you otherwise, poll " +
          "queue_next with this `epicId` on a backing-off interval (start ~15s, double to a ~2min " +
          "cap) and the moment tasks come back approved, work them — with subagents, dispatch one " +
          "per task using the `handoff` blocks queue_next returns. The human approving on the " +
          "board IS the go signal; they should not have to prompt you again. Add more tasks to " +
          "the batch later with task_propose and this `epicId`.",
      };
    }

    case "doc_write": {
      const body = typeof args.body === "string" ? args.body : "";
      if (!body.trim() && !args.title) throw new Error("`body` (string) is required");
      const markdown = composeMarkdown(args.title, body);

      // Update in place when an id was given — same note, new content.
      if (typeof args.noteId === "string" && args.noteId.trim()) {
        const noteId = args.noteId.trim();
        // The note PATCH 200s for ANY id: the API does not existence-check it and
        // returns no documentId to confirm a write landed (TDM-137). Relaying that
        // as updated:true tells an agent rewriting a stale/wrong noteId that its
        // content was saved when it was silently dropped. So confirm the note
        // exists FIRST (a cheap notes-only state read, which also gives us the
        // documentId to echo back); only then is updated:true honest.
        const resp = (await gateway.get(`/api/canvas/state?fields=notes`)) as {
          state?: { notes?: Record<string, { id?: string; documentId?: string }> };
        };
        const note = resp.state?.notes?.[noteId];
        if (!note) {
          throw new Error(
            `No note with id "${noteId}" exists on this canvas, so there was nothing to update — ` +
              `your content was NOT saved. Re-check the noteId, or omit it to create a new note ` +
              `(optionally with a \`document\` name to place it).`
          );
        }
        // Project the response: echoing the note body back would just spend the
        // model's context on text it wrote a moment ago.
        await gateway.patch(`/api/canvas/notes/${noteId}`, { body: markdown });
        return {
          updated: true,
          noteId,
          ...(note.documentId ? { documentId: note.documentId } : {}),
          url: canvasBlock(gateway).url,
        };
      }

      // Otherwise create. A named document is created on demand (see
      // resolveNotesDocument); an unnamed one lands in the canvas default.
      const ref = typeof args.document === "string" ? args.document.trim() : "";
      const documentId = ref ? await resolveNotesDocument(gateway, ref) : undefined;
      const created = (await gateway.post("/api/canvas/notes", {
        body: markdown,
        imageRefs: [],
        ...(documentId ? { document: documentId } : {}),
        createdBy: "agent",
      })) as { id?: string; documentId?: string };
      return {
        created: true,
        noteId: created.id,
        documentId: created.documentId ?? documentId,
        url: canvasBlock(gateway).url,
      };
    }

    case "board_status": {
      // Deliberately NOT canvas_state_read: the whole point is a board-shaped
      // answer (states, epics, who holds what) without pulling the canvas.
      //
      // The epic half comes from the server's ROLLUP endpoint (TDM-93) when the
      // API has it: each batch's persisted `summary` — what it ACHIEVED — plus
      // counts, the activity window, and one line per finished ticket. That is
      // the answer this tool could not give before: counting task states says
      // how MUCH happened in an epic and nothing about what, so "what did E5
      // deliver?" meant opening all six of its tickets.
      const [tasks, rollups, epicsRes] = await Promise.all([
        listAgentTasks(gateway),
        fetchEpicRollups(gateway),
        // The fallback list, for an API deployed before /api/canvas/epics
        // existed. Read in the same wave so the fallback costs no extra round
        // trip when the rollup turns out to be absent.
        gateway.get("/api/canvas/actions?type=epic") as Promise<{
          actions?: Array<{ id: string; state: string; payload?: { title?: string } }>;
        }>,
      ]);

      const epics =
        rollups ??
        (epicsRes.actions ?? []).map((e) => {
          const mine = tasks.filter((t) => t.payload?.epicId === e.id);
          return {
            id: e.id,
            title: e.payload?.title ?? "",
            state: e.state,
            tasks: countByState(mine),
          };
        });

      // Batches that drained with nobody recording what they delivered. Named
      // rather than left for the reader to notice: an unwritten summary only
      // ever gets written while somebody still remembers the work.
      const unsummarized = (rollups ?? [])
        .filter((e) => e.summaryNeeded)
        .map((e) => ({ id: e.id, title: e.title, doneTasks: e.tasks.byState.done ?? 0 }));

      // Each in-flight row is a REPORT line, not just a name (TDM-95): ticket,
      // holder, how long they have held it, whether the claim outlived its lease,
      // and their last progress note. An orchestrator asked "where does the fleet
      // stand?" used to have to task_get every executing task to say anything
      // concrete; now the one board read answers it.
      const inFlight = tasks.filter((t) => t.state === "executing").map(inFlightRow);
      const stale = inFlight.filter((t) => "staleClaim" in t);

      return {
        canvas: canvasBlock(gateway),
        tasks: { total: tasks.length, byState: countByState(tasks) },
        inFlight,
        epics,
        unassignedTasks: tasks.filter((t) => !t.payload?.epicId).length,
        ...(unsummarized.length > 0 ? { unsummarizedEpics: unsummarized } : {}),
        ...(stale.length > 0
          ? {
              _staleClaims:
                `${stale.length} in-flight task(s) are marked staleClaim: nothing has been ` +
                `reported on them for over ${DEFAULT_CLAIM_LEASE_MINUTES} minutes, so their ` +
                `holder has probably gone dark and the task is reclaimable. Report them as at ` +
                `risk — do NOT complete them on the holder's behalf.`,
            }
          : {}),
        ...(unsummarized.length > 0
          ? {
              _unsummarizedEpics:
                `${unsummarized.length} epic(s) have DRAINED with nothing recording what the batch ` +
                `achieved. Report them: the account only gets written while someone still remembers ` +
                `the work. An agent finishing remaining work in one passes \`epicSummary\` to ` +
                `task_complete; otherwise the human writes it on the board.`,
            }
          : {}),
        _next:
          "Ready work is the 'approved' count — call queue_next to see it. Tasks stuck at " +
          "'proposed' are waiting on a human (and tasks under a 'proposed' epic wait on that " +
          "epic). Looking for one specific task by name? task_find.",
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ── Manifest ─────────────────────────────────────────────────────────────────

export const FACADE_RAW_TOOLS: RawTool[] = [
  {
    name: "canvas_connect",
    description:
      "STEP 1 of every session: bind this session to a canvas by its code (e.g. 'TEGLQFXR'), " +
      "given to you by the human. Nothing else works until you do. Returns the shareable web " +
      "`url` — give it to the user IMMEDIATELY, before you start work, so they can watch your " +
      "changes land live — and a `session` handle. Pass that handle as `session` on EVERY later " +
      "call. ALSO REGISTER HERE: pass `role` ('planner' if you'll dispatch work to subagents, " +
      "'executor' if you'll claim and do tasks yourself), a `name`, and — if an orchestrator " +
      "spawned you — the `parentAgentId` it gave you. That registers you in the SAME call and " +
      "returns `agentId` plus a `session` handle already carrying it, so your claims show as you " +
      "on the fleet view instead of an anonymous session. If a `parentAgentId` is rejected you " +
      "still connect: the result carries `agent.problem` saying so. " +
      "Next: context_get to learn the canvas, or queue_next to go straight to the work.",
    inputSchema: schemaOf("canvas_connect"),
  },
  {
    name: "agent_register",
    description: descriptionOf("agent_register") + " " + SESSION_CONVENTION,
    inputSchema: schemaOf("agent_register"),
  },
  {
    name: "context_get",
    description:
      "The canvas briefing: what this canvas IS and what's on it — identity, mode, the document " +
      "tabs, per-kind counts and names, and the state of the task queue — in ONE cheap call that " +
      "never pulls the full board. Call it once after canvas_connect to orient yourself, or when " +
      "you're picking up a canvas you haven't touched this session. If you already know the " +
      "canvas and just want work, skip it and call queue_next. " +
      SESSION_CONVENTION,
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "queue_next",
    description:
      SESSION_CONVENTION +
      " " +
      "THE ENTRY POINT FOR WORK: the approved tasks ready to be picked up right now, compact " +
      "({id, ticketId, title, state, epicId}) — no bodies. Start here rather than reading the " +
      "canvas. IF YOU HAVE SUBAGENTS, DISPATCH — do NOT claim these yourself: spawn one subagent " +
      "per ready task and paste that task's `handoff` block into it VERBATIM. The handoff carries " +
      "the 8-char canvas CODE, the task's id/ticket/title, and the steps its worker follows " +
      "(connect+register as an executor under you → claim ITS task → work → task_complete), so " +
      "there is nothing for you to compose. An orchestrator never claims, never completes on a " +
      "worker's behalf, and never passes on its `session` handle — the handle stays with you, the " +
      "CODE is what travels. WORKING ALONE: pick ONE, task_get it for the full brief, task_claim " +
      "it, then work. Empty means nothing is approved: tasks you propose sit at 'proposed' until " +
      "a human approves them on the board. A task marked `lostByYou: true` carries NO handoff: you " +
      "raced for it and lost, so it is neither yours to claim nor yours to dispatch — take another.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max tasks to return. Default 10." },
        epicId: { type: "string", description: "Only ready tasks under this epic." },
      },
    },
  },
  {
    name: "task_find",
    description:
      "FIND a task by NAME when you don't have its id — \"the constraints task\", \"dark mode " +
      "rollout\". Returns only the matches ({id, ticketId, title, state, claimedBy, epicId}), so " +
      "you never have to read the whole board to turn a description into an id. Matching is " +
      "textual and predictable: the query as a substring of the title, then all its words in the " +
      "title, then all its words in title-or-body — `matchedIn` says which fired, so CHECK the " +
      "title is the task you meant before acting on it. Filter with `state` (e.g. 'approved' for " +
      "ready work, 'executing' for in flight). A ticket ref ('TDM-21', '#21') is resolved directly " +
      "instead of searched — though you can also just pass a ref straight to task_get / task_claim " +
      "as `id`, with no lookup at all. Then: task_get for the brief, task_claim to take it. " +
      SESSION_CONVENTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "What you know: part of the title (\"constraints\"), or a ticket ref (\"TDM-21\").",
        },
        state: {
          type: "string",
          description:
            "Only tasks in this state — 'proposed' | 'approved' | 'executing' | 'done' | " +
            "'failed'. Omit to search every state.",
        },
        assignee: {
          type: "string",
          description:
            "'agent' for agent work, 'human' for the human's own todos, 'any' (default) for both.",
        },
        limit: { type: "number", description: "Max matches to return. Default 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "task_get",
    description:
      "Read ONE task with its context hydrated: { action, linked, epic? } — `linked` carries the " +
      "referenced roadmap items and notes (title, body, status), which is where the real brief " +
      "lives, and `epic` says which batch it belongs to. Call this on the task you chose from " +
      "queue_next; it is all the context you need to start, so you never have to read the whole " +
      "canvas. Progress reported via task_progress comes back here too. " +
      SESSION_CONVENTION,
    inputSchema: schemaOf("canvas_task_get"),
  },
  {
    name: "task_claim",
    description:
      SESSION_CONVENTION +
      " " +
      "Claim a task you are about to do YOURSELF (approved → executing), so parallel sessions " +
      "skip it. Claim only what you will personally work: if you are dispatching subagents, do " +
      "NOT claim here — hand each worker the task's `handoff` from queue_next and let it claim " +
      "its own. A task claimed by an orchestrator that never touches it reads on the board as " +
      "in-flight work nobody is doing. The claim is ATOMIC and losing is NORMAL: " +
      "{ claimed: false, claimedBy } means another session got there first — do NOT work on it, " +
      "go back to queue_next and take the next one. Every losing answer also carries " +
      "`tapOut: true` with a `reason` and `next: \"queue_next\"` — that flag is the one thing to " +
      "branch on, and it means STOP TOUCHING THIS TASK, not try again. Asking a second time for a " +
      "task you already lost is refused without even reaching the server. On success you get the task's `ticketId` " +
      "(e.g. 'TDM-142'); put it in your commit messages so the work traces back.",
    inputSchema: schemaOf("canvas_task_start"),
  },
  {
    name: "task_progress",
    description:
      "Report progress on a task you claimed, mid-flight. Use it on long work so the human (and " +
      "other sessions) can see movement instead of silence — after a meaningful step, or when you " +
      "hit a blocker and change approach. One short line per call: what changed since last time. " +
      "The entry is stored ON the task and comes back from task_get. It is also a HEARTBEAT: each " +
      "report extends your claim, so on work longer than ~15 minutes report as you go or the task " +
      "becomes reclaimable and another session can take it out from under you. This is NOT the " +
      "finish line — call task_complete for that. " +
      SESSION_CONVENTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "The task you claimed." },
        note: {
          type: "string",
          description: "One line: what you just did, found, or got blocked on.",
        },
        percent: { type: "number", description: "Optional rough completion, 0-100." },
        agentName: {
          type: "string",
          description: "Identity to report as — the same one you claimed with. Defaults to this session's.",
        },
      },
      required: ["id", "note"],
    },
  },
  {
    name: "task_complete",
    description:
      SESSION_CONVENTION +
      " " +
      "FINISH a task with a result summary — the last step of every task you claim; leaving one " +
      "'executing' blocks the queue. `result` is a short human-readable account of what was done " +
      "and where: files, commit hashes, PR. It shows on the board, so it is the human's whole view " +
      "of your work. Back it with `links`: the GitHub URLs the work produced (commit / pull " +
      "request / branch). The board resolves those live — merged, open, checks failing — so the " +
      "human reads what HAPPENED, not just what you said. " +
      "Failed? pass status:'failed' with `error` rather than leaving it hanging. " +
      "Complete under the SAME identity you claimed with. " +
      "FINISHING A BATCH: if this is the last unfinished task in its epic (task_get says so, and " +
      "the answer here reports what is left), also pass `epicSummary` — what the whole BATCH " +
      "achieved. A task's `result` is per-ticket; without an epic summary the only way to learn " +
      "what an epic delivered is to open every ticket in it.",
    inputSchema: withEpicSummaryArg(schemaOf("canvas_task_complete")),
  },
  {
    name: "task_propose",
    description:
      SESSION_CONVENTION +
      " " +
      "Propose work for LATER sessions — one task, or a whole plan at once via `tasks` (strongly " +
      "preferred over calling this repeatedly). Proposals land as 'proposed' and a human approves " +
      "them on the board before any session can claim them, so this is how you hand off work " +
      "instead of doing it. Keep `body` a tight brief (what to do, acceptance criteria) and put " +
      "the heavy context in notes/roadmap items referenced by `linkedIds` — task_get hydrates " +
      "those for whoever picks it up. For a whole plan, prefer epic_propose: it creates the epic " +
      "AND its tasks in one call, so the human approves once instead of task by task.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short imperative title, e.g. 'Add CSV export to sheets'." },
        body: { type: "string", description: "Concise brief: what to do, acceptance criteria." },
        linkedIds: {
          type: "array",
          items: { type: "string" },
          description: "Ids of notes / roadmap items carrying the detailed context.",
        },
        epicId: {
          type: "string",
          description:
            "Epic this task belongs to (from epic_propose, task_get or board_status). Under the " +
            "default approval policy, a task added to an already-approved epic is born approved " +
            "instead of waiting for its own approval; under a still-proposed epic it waits for " +
            "that epic's single approval. Without one the task is unparented and needs its own. " +
            "When you pass `tasks`, a call-level epicId here applies to EVERY item (an item's own " +
            "epicId still wins), so you can parent a whole plan in one call.",
        },
        assignee: {
          type: "string",
          enum: ["agent", "human"],
          description: "'agent' (default) = for an agent session; 'human' = the human's own todo.",
        },
        requiresApproval: {
          type: "boolean",
          description:
            "Force the human gate even under an auto-approving policy. Set it when the task " +
            "deviates from what was agreed.",
        },
        tasks: {
          type: "array",
          description:
            "Propose MANY at once — each item takes the same fields as above. Use this for a " +
            "whole plan; it is one write instead of N.",
          items: {
            type: "object" as const,
            properties: {
              title: { type: "string" },
              body: { type: "string" },
              linkedIds: { type: "array", items: { type: "string" } },
              epicId: {
                type: "string",
                description:
                  "Epic this task belongs to — set it per item, or use epic_propose to create " +
                  "the epic and its tasks together.",
              },
              assignee: { type: "string", enum: ["agent", "human"] },
              requiresApproval: { type: "boolean" },
            },
            required: ["title"],
          },
        },
      },
    },
  },
  {
    name: "task_amend",
    description:
      "Correct or retract a task YOU proposed — the self-heal for a mis-proposed plan (wrong " +
      "epic, typo'd title, a duplicate). Deliberately narrow: it works ONLY while the task is " +
      "still 'proposed' AND unclaimed AND was authored by you. Pass the fields to change " +
      "(title / body / epicId / linkedIds) to edit it, or `withdraw: true` to delete it. Once a " +
      "human has approved a task it is THEIRS — this tool refuses, and the move is to propose a " +
      "follow-up or ask the human to reject it; once another agent has claimed it, its claim " +
      "owns it. Use this to re-parent tasks that landed unparented, not to rewrite work already " +
      "approved or in flight. " +
      SESSION_CONVENTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The task to amend — its ticket ref (e.g. 'TDM-21') or uuid.",
        },
        title: { type: "string", description: "New title. Omit to keep the current one." },
        body: { type: "string", description: "New brief. Omit to keep the current one." },
        epicId: {
          type: "string",
          description:
            "Re-parent the task to this epic (from epic_propose / board_status). Omit to leave " +
            "its parent unchanged.",
        },
        linkedIds: {
          type: "array",
          items: { type: "string" },
          description: "Replace the linked context ids. Omit to leave them unchanged.",
        },
        withdraw: {
          type: "boolean",
          description:
            "Set true to RETRACT (delete) the proposal instead of editing it — for a task " +
            "proposed by mistake or a duplicate. Ignores the edit fields.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "epic_propose",
    description:
      SESSION_CONVENTION +
      " " +
      "Propose an EPIC — the named container a plan hangs off — and, in the SAME call, the tasks " +
      "under it via `tasks` (same item shape as task_propose). Use this whenever you're asked to " +
      "'write an epic' or plan a feature: tasks proposed without one are unparented and each need " +
      "their own approval. The epic lands as 'proposed'; a HUMAN approves it ONCE on the board " +
      "and that single approval cascades to every task under it. You must NOT try to approve " +
      "it yourself — that gate is the human's, and the gateway refuses agent approval of epics. " +
      "After proposing, do not end your turn: LISTEN for the approval by polling queue_next with " +
      "the returned `epicId` on a backing-off interval, so the human's approval on the board — " +
      "not another prompt — is what starts the work. " +
      "Returns `epicId`: pass it as `epicId` on later task_propose calls to add work to the same " +
      "batch (once the epic is approved, those tasks are born approved).",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short name for the batch, e.g. 'Dark mode rollout'." },
        body: { type: "string", description: "What this batch achieves; scope and intent." },
        linkedIds: {
          type: "array",
          items: { type: "string" },
          description: "Ids of notes / roadmap items carrying the detailed context.",
        },
        tasks: {
          type: "array",
          description:
            "The plan, created under the new epic in one write — each item takes the same fields " +
            "as task_propose. Any `epicId` on an item is overridden with the new epic's id.",
          items: {
            type: "object" as const,
            properties: {
              title: { type: "string" },
              body: { type: "string" },
              linkedIds: { type: "array", items: { type: "string" } },
              assignee: { type: "string", enum: ["agent", "human"] },
              requiresApproval: { type: "boolean" },
            },
            required: ["title"],
          },
        },
      },
      required: ["title"],
    },
  },
  {
    name: "doc_write",
    description:
      "LEAVE CONTEXT BEHIND: write a markdown note onto the canvas — findings, a decision and why, " +
      "a design sketch, anything the next session (or the human) needs and would otherwise have to " +
      "rediscover. This is the main write path; use it as you go, not only at the end. `document` " +
      "names the tab to write into and IS CREATED if it doesn't exist yet, so you can organise as " +
      "you write; omit it to use the canvas's default notes tab. Pass `noteId` to rewrite an " +
      "existing note instead of adding another. Returns `noteId` — keep it if you'll update this " +
      "note again. For task outcomes use task_complete's `result`, not this. " +
      SESSION_CONVENTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        body: { type: "string", description: "The note content, markdown." },
        title: {
          type: "string",
          description: "Optional heading, prepended to the body as '## title'.",
        },
        document: {
          type: "string",
          description:
            "Notes tab to write into — an existing document's name or id, or a NEW name to " +
            "create that tab. Omit for the canvas's default notes tab.",
        },
        noteId: {
          type: "string",
          description: "Rewrite this existing note (from an earlier doc_write) instead of creating one.",
        },
      },
      required: ["body"],
    },
  },
  {
    name: "board_status",
    description:
      "A compact read of the BOARD, not the canvas: task counts by state, epics with their approval " +
      "state, per-epic task counts and — the batch-level answer — each epic's `summary` of what it " +
      "ACHIEVED plus one line per finished ticket, so 'what did E5 deliver?' costs this one call " +
      "instead of opening all six of its tasks. An epic marked `summaryNeeded` has drained with " +
      "nobody recording that. And every in-flight task as a report line — ticketId, " +
      "holder, how many minutes they have held the claim, their last progress note, and " +
      "`staleClaim: true` once nothing has been reported for longer than the claim lease (~15 min), " +
      "meaning the holder has probably gone dark. THIS IS THE ORCHESTRATOR'S REPORT: it is enough " +
      "to say where every worker stands without reading a single task. Also how you check whether " +
      "your proposals got approved. Cheap — it never dumps canvas contents. For the work you can " +
      "actually start, use queue_next; to find one task by name, task_find. " +
      SESSION_CONVENTION,
    inputSchema: { type: "object" as const, properties: {} },
  },
];
