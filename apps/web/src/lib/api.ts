import type { Action, ActionState, CanvasMeta } from "../types";
import type { FleetActivityAction } from "./ws";

// Image upload is disabled for v1 (no durable-storage story yet). Reading
// stays available so any imageRefs left from dev still render via the
// `/canvas-images/*` route.
export function imageUrl(canvasId: string, filename: string): string {
  return `/canvas-images/${canvasId}/${filename}`;
}

// The signed-in user's owned canvases (newest-edited first). Needs the session
// cookie — 401 if not signed in.
export async function listMyCanvases(): Promise<CanvasMeta[]> {
  const res = await fetch("/api/me/canvases", { credentials: "same-origin" });
  if (!res.ok) throw new Error("Failed to load your canvases");
  return (await res.json()) as CanvasMeta[];
}

// Canvases other owners have shared with the signed-in user (each carries the
// granted role in yourRole). The recipient side of sharing.
export async function listSharedWithMe(): Promise<CanvasMeta[]> {
  const res = await fetch("/api/me/shared", { credentials: "same-origin" });
  if (!res.ok) throw new Error("Failed to load canvases shared with you");
  return (await res.json()) as CanvasMeta[];
}

// ── Inbox / notifications (migration 0022) ───────────────────────────────────

export type AppNotification = {
  id: string;
  kind: "canvas_shared" | string;
  canvasId?: string;
  canvasCode?: string;
  canvasName?: string;
  actorName?: string;
  role?: "read" | "write";
  read: boolean;
  createdAt: string;
};

export async function listNotifications(): Promise<{
  notifications: AppNotification[];
  unread: number;
}> {
  const res = await fetch("/api/me/notifications", { credentials: "same-origin" });
  if (!res.ok) throw new Error("Failed to load notifications");
  return (await res.json()) as { notifications: AppNotification[]; unread: number };
}

export async function markNotificationsRead(): Promise<void> {
  const res = await fetch("/api/me/notifications/read", {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error("Failed to mark notifications read");
}

// ── Canvas-JWT writes ────────────────────────────────────────────────────────
// The mutating calls below are HTTP POSTs that need a canvas JWT. We obtain one
// with the same code→JWT exchange the MCP gateway uses (no Google login needed)
// and cache it per canvas code for the session. The backend broadcasts the
// resulting state over WS, so the board updates itself — we just need the call
// to land.
const tokenCache = new Map<string, string>();

async function canvasToken(code: string): Promise<string> {
  const cached = tokenCache.get(code);
  if (cached) return cached;
  const res = await fetch("/api/mcp/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error("Could not authenticate to this canvas");
  const { token } = (await res.json()) as { token: string };
  tokenCache.set(code, token);
  return token;
}

// Canvas-JWT fetch with a single retry on 401 (cached token gone stale).
async function authedFetch(
  code: string,
  path: string,
  init: { method: string; body?: unknown },
  fallbackError: string,
): Promise<Response> {
  const doFetch = async (token: string) =>
    fetch(path, {
      method: init.method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  let res = await doFetch(await canvasToken(code));
  if (res.status === 401) {
    tokenCache.delete(code);
    res = await doFetch(await canvasToken(code));
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let msg = detail;
    try {
      msg = (JSON.parse(detail) as { error?: string }).error ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(msg || fallbackError);
  }
  return res;
}

// ── Tasks (actions of type "task") ───────────────────────────────────────────
// Human-created tasks are born approved — the approval gate exists only for
// agent-proposed work. State updates come back over WS like everything else.

export type TaskDraft = {
  title: string;
  body?: string;
  linkedIds?: string[];
  assignee?: "agent" | "human";
  // Preserved on edit: updateTask REPLACES the payload, so an editor that
  // doesn't round-trip these would silently detach the task from its epic /
  // drop its approval self-flag.
  epicId?: string;
  requiresApproval?: boolean;
};

export async function createTask(code: string, task: TaskDraft): Promise<void> {
  await authedFetch(
    code,
    "/api/canvas/actions",
    {
      method: "POST",
      body: { type: "task", state: "approved", proposedBy: "human", payload: task },
    },
    "Could not create task",
  );
}

// Payload-only PATCH: rewrite a task's content without touching its state.
export async function updateTask(code: string, id: string, task: TaskDraft): Promise<void> {
  await authedFetch(
    code,
    `/api/canvas/actions/${id}`,
    { method: "PATCH", body: { payload: task } },
    "Could not update task",
  );
}

// Delete a task outright (any state). Removes the action row; state comes back
// over WS so the panel drops it on the next broadcast.
export async function deleteTask(code: string, id: string): Promise<void> {
  await authedFetch(
    code,
    `/api/canvas/actions/${id}`,
    { method: "DELETE" },
    "Could not delete task",
  );
}

// ── Fleet roster (TDM-46) ────────────────────────────────────────────────────
// GET /api/canvas/agents — "who is on this canvas, and what are they holding".
// A canvas-JWT read like the task calls above (any role), joined server-side in
// two round trips, so the cost is flat whether the fleet is 2 agents or 40.
//
// The roster is deliberately WIDER than state.agents: it also lists claimants
// that never called agent_register (registered:false), because a roster that
// hides whoever actually holds your tasks is worse than useless.

export type FleetTask = {
  id: string;
  ticketId?: string;
  title?: string;
  type: string;
  state: string;
  epicId?: string;
  claimedAt?: string;
};

export type FleetAgent = {
  /** Absent for an unregistered claimant — it has no `agents` row. */
  id?: string;
  name: string;
  role?: string;
  /** Free-text model string ("claude-opus-4-6", "gpt-5-codex", …) when declared. */
  model?: string;
  parentAgentId?: string;
  /** "online" | "offline" for a registered agent; "unknown" for a claimant. */
  status: string;
  registered: boolean;
  registeredAt?: string;
  lastSeen?: string;
  /** max(registeredAt, lastSeen, claimedAt) — newest provable activity. */
  lastActivityAt?: string;
  tasks: FleetTask[];
};

export type FleetCounts = {
  agents: number;
  registered: number;
  unregistered: number;
  working: number;
  idle: number;
  claims: number;
};

export type FleetRoster = {
  type: "agents.roster";
  generatedAt: string;
  counts: FleetCounts;
  agents: FleetAgent[];
};

export async function fetchAgentRoster(code: string): Promise<FleetRoster> {
  const res = await authedFetch(
    code,
    "/api/canvas/agents",
    { method: "GET" },
    "Could not load the fleet",
  );
  return (await res.json()) as FleetRoster;
}

// ── Activity feed (TDM-48) ───────────────────────────────────────────────────
// GET /api/canvas/activity — "what has the fleet done here, newest first".
//
// One fact per event, and deliberately the SAME shape the WS lifecycle ping
// pushes (ws.ts `FleetActivity`), so a surface loads history over REST and then
// appends live messages onto the very same list with one renderer.
//
// The backfill is DERIVED from action rows, not an event log: it can't show
// claim expiries, releases, requeues, or anything about a deleted action. Those
// exist only in the live stream — which is exactly why the feed merges both.

export type ActivityEvent = {
  type?: "activity";
  action: FleetActivityAction;
  /** Who did it: an agent name, "human", or "agent" when the surface was anonymous. */
  actor?: string;
  at: string;
  actionId: string;
  actionType: string;
  ticketId?: string;
  title?: string;
  epicId?: string;
  /** The action's state AT this fact — not necessarily its state now. */
  state?: string;
  result?: string;
  error?: string;
};

export type ActivityFeed = {
  type: "activity.feed";
  generatedAt: string;
  limit: number;
  truncated: boolean;
  events: ActivityEvent[];
};

export async function fetchActivityFeed(code: string, limit = 50): Promise<ActivityFeed> {
  const res = await authedFetch(
    code,
    `/api/canvas/activity?limit=${encodeURIComponent(String(limit))}`,
    { method: "GET" },
    "Could not load the activity feed",
  );
  return (await res.json()) as ActivityFeed;
}

// ── GitHub ground truth (TDM-45) ─────────────────────────────────────────────
// GET /api/canvas/github/status?url= — resolve ONE evidence link into what
// GitHub currently says about it. Read-only, server-side, cached there; the
// browser never talks to api.github.com (no token in a bundle, no CORS, and one
// shared cache instead of one per tab).

export type GitHubLinkStatus = {
  kind: "commit" | "pr" | "branch";
  /** merged | open | closed | draft | ok | failure | pending | unknown */
  state: string;
  title?: string;
  /** pass | fail | pending — only when the ref has checks. */
  checks?: "pass" | "fail" | "pending";
  url: string;
  /** Why the state is unknown: not_found | rate_limited | unavailable. */
  reason?: string;
};

export async function fetchGitHubStatus(code: string, url: string): Promise<GitHubLinkStatus> {
  const res = await authedFetch(
    code,
    `/api/canvas/github/status?url=${encodeURIComponent(url)}`,
    { method: "GET" },
    "Could not read the GitHub status",
  );
  return (await res.json()) as GitHubLinkStatus;
}

// ── Epics (actions of type "epic") ───────────────────────────────────────────
// Same born-approved rule as human tasks: the approval gate exists for
// agent-proposed work, and the human author IS the gate. Under the default
// "epic" approval policy an approved epic also lets agent tasks filed under it
// flow straight to the queue.

export type EpicDraft = {
  title: string;
  body?: string;
  linkedIds?: string[];
};

export async function createEpic(code: string, epic: EpicDraft): Promise<void> {
  await authedFetch(
    code,
    "/api/canvas/actions",
    {
      method: "POST",
      body: { type: "epic", state: "approved", proposedBy: "human", payload: epic },
    },
    "Could not create epic",
  );
}

// ── Human board moves (E10) ──────────────────────────────────────────────────

// POST /api/canvas/actions/{id}/move — walk a task through its lifecycle as a
// PERSON: start it, finish it, mark it failed, or rewind it (release / re-queue
// / reopen / reconsider). One endpoint for all of them; the legal moves out of
// each state live in lib/taskMoves.ts and are re-validated server-side.
//
// It CANNOT approve. A proposed task has no move targets at all — the approval
// gate (approveAction / rejectAction) is the only way out of triage, and the
// server refuses anything else with a 400 that says so.
//
// `note` is optional: on 'done' it becomes the task's result, on 'failed' the
// error, and on a rewind it lives in the audit trail (a rewind clears both
// columns — a card back in Ready must not advertise the run being undone).
export async function moveTask(
  code: string,
  id: string,
  to: ActionState,
  note?: string,
): Promise<Action> {
  const res = await authedFetch(
    code,
    `/api/canvas/actions/${id}/move`,
    { method: "POST", body: { to, note } },
    "Could not move this task",
  );
  return ((await res.json()) as { action: Action }).action;
}

// Release a stuck claim: an executing task whose agent session died goes back
// to the queue (approved) with claimedBy/claimedAt cleared. Human-only by
// surface — this endpoint is deliberately not exposed through the MCP gateway.
//
// Superseded by moveTask(code, id, "approved") on an executing task, which the
// board now calls for every move; kept because the dedicated route is what
// older clients call and because "release" is a verb worth its own URL.
export async function releaseTask(code: string, id: string): Promise<void> {
  await authedFetch(
    code,
    `/api/canvas/actions/${id}/release`,
    { method: "POST" },
    "Could not release task",
  );
}

// Re-queue a FAILED task: failed → approved with claim AND error cleared, so
// an agent session can pick it up fresh. Human-only by surface — like release,
// this endpoint is deliberately not exposed through the MCP gateway (an agent
// must never requeue its own failures).
export async function requeueTask(code: string, id: string): Promise<void> {
  await authedFetch(
    code,
    `/api/canvas/actions/${id}/requeue`,
    { method: "POST" },
    "Could not re-queue task",
  );
}

export async function approveAction(code: string, id: string): Promise<void> {
  await authedFetch(
    code,
    `/api/canvas/actions/${id}/approve`,
    { method: "POST", body: { approvedBy: "human" } },
    "Could not approve",
  );
}

// Bulk human gate: approve many proposed actions in ONE request (single bulk
// conditional UPDATE + one broadcast server-side). Ids that no longer match
// (already moved on, or deleted) come back in `skipped` instead of failing the
// whole batch. Epics in the batch cascade to their proposed tasks server-side
// under the canvas approval policy, same as the single approve.
export async function approveBatch(
  code: string,
  ids: string[],
): Promise<{ approved: string[]; skipped: string[] }> {
  const res = await authedFetch(
    code,
    "/api/canvas/actions/approve-batch",
    { method: "POST", body: { ids, approvedBy: "human" } },
    "Could not approve tasks",
  );
  return (await res.json()) as { approved: string[]; skipped: string[] };
}

export async function rejectAction(code: string, id: string, reason?: string): Promise<void> {
  await authedFetch(
    code,
    `/api/canvas/actions/${id}/reject`,
    { method: "POST", body: { reason } },
    "Could not reject",
  );
}

// Take ownership of an unowned (agent-created) canvas using its private claim
// token. Unlike copyCanvas this transfers THE canvas itself — the same one the
// agent keeps editing — and the API voids the token on success (single-use).
// Needs the session cookie (must be signed in).
export async function claimCanvas(code: string, claimToken: string): Promise<CanvasMeta> {
  const res = await fetch(`/api/canvases/${code}/claim`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claimToken }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let msg = detail;
    try {
      msg = (JSON.parse(detail) as { error?: string }).error ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(msg || "Claim failed");
  }
  return (await res.json()) as CanvasMeta;
}

// Deep-copy a canvas into the signed-in user's account; returns the new canvas.
export async function copyCanvas(code: string): Promise<CanvasMeta> {
  const res = await fetch(`/api/canvases/${code}/copy`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || "Copy failed");
  }
  return (await res.json()) as CanvasMeta;
}

// ── Briefing (TDM-30) ────────────────────────────────────────────────────────
// The briefing is the document GET /api/canvas/context hands every agent on
// connect. Importing an AGENTS.md is one call: it creates (or reuses, by name) a
// notes document, writes the file into it, and designates it — so the human
// never assembles those three steps by hand.

export type BriefingImport = {
  // Pasted text. When empty, the SERVER fetches sourceUrl instead — the browser
  // can't read raw.githubusercontent.com itself (CORS).
  content?: string;
  // Optional document name; the API defaults to "Briefing".
  name?: string;
  sourceUrl?: string;
};

export type BriefingImportResult = {
  briefingDocId: string;
  noteId: string;
  createdDocument: boolean;
  bytes: number;
};

export async function importBriefing(
  code: string,
  body: BriefingImport,
): Promise<BriefingImportResult> {
  const res = await authedFetch(
    code,
    "/api/canvas/briefing/import",
    { method: "POST", body },
    "Could not import the briefing",
  );
  return (await res.json()) as BriefingImportResult;
}

// Designate (or clear) this canvas's briefing document — the bare act, for a
// document that already exists and holds the right words. Import is the
// three-steps-in-one path; this is the one-step path for "actually, THIS doc is
// the briefing". Pass null to clear: a canvas with no briefing is a normal
// state, not an error to be avoided.
//
// The server broadcasts fresh canvas state, so every open board (and the tab
// strip's briefing marker) follows without the caller updating anything.
export async function setBriefing(code: string, docId: string | null): Promise<void> {
  await authedFetch(
    code,
    "/api/canvas/briefing",
    { method: "PUT", body: { docId } },
    docId === null ? "Could not clear the briefing" : "Could not set the briefing",
  );
}

// ── Sharing (owner-only; Google-Docs access model, migration 0021) ───────────

export type CanvasAccessEntry = {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string;
  role: "read" | "write";
};

// Pull the human-readable error out of an API response ({"error": "..."} or raw).
async function apiError(res: Response, fallback: string): Promise<Error> {
  const detail = await res.text().catch(() => "");
  let msg = detail;
  try {
    msg = (JSON.parse(detail) as { error?: string }).error ?? detail;
  } catch {
    /* not json */
  }
  return new Error(msg || fallback);
}

export async function setCanvasVisibility(
  code: string,
  visibility: "public" | "private",
  publicRole: "read" | "write",
): Promise<void> {
  const res = await fetch(`/api/canvases/${code}/visibility`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility, publicRole }),
  });
  if (!res.ok) throw await apiError(res, "Could not update visibility");
}

// Set the canvas approval policy for agent-proposed tasks (owner-only,
// migration 0033): 'strict' = every agent task awaits approval; 'epic'
// (default) = approving an epic lets its tasks flow; 'auto' = no gate.
export async function setCanvasApprovalPolicy(
  code: string,
  approvalPolicy: "strict" | "epic" | "auto",
): Promise<void> {
  const res = await fetch(`/api/canvases/${code}/approval-policy`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approvalPolicy }),
  });
  if (!res.ok) throw await apiError(res, "Could not update approval policy");
}

// Rename a canvas (owner-only). The backend broadcasts fresh state over WS, so
// connected boards pick up the new name live; the caller updates optimistically.
export async function setCanvasName(code: string, name: string): Promise<void> {
  const res = await fetch(`/api/canvases/${code}/name`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw await apiError(res, "Could not rename canvas");
}

// Permanently delete a canvas (owner-only). The backend cascades all content and
// boots any live viewers; the caller drops it from the list optimistically.
export async function deleteCanvas(code: string): Promise<void> {
  const res = await fetch(`/api/canvases/${code}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok) throw await apiError(res, "Could not delete canvas");
}

export async function listCanvasAccess(code: string): Promise<CanvasAccessEntry[]> {
  const res = await fetch(`/api/canvases/${code}/access`, { credentials: "same-origin" });
  if (!res.ok) throw await apiError(res, "Could not load who this is shared with");
  return (await res.json()) as CanvasAccessEntry[];
}

export async function addCanvasAccess(
  code: string,
  email: string,
  role: "read" | "write",
): Promise<CanvasAccessEntry> {
  const res = await fetch(`/api/canvases/${code}/access`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) throw await apiError(res, "Could not share");
  return (await res.json()) as CanvasAccessEntry;
}

export async function removeCanvasAccess(code: string, userId: string): Promise<void> {
  const res = await fetch(`/api/canvases/${code}/access/${userId}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok) throw await apiError(res, "Could not remove access");
}

// ── Metrics history (TDM-94 / migration 0040) ────────────────────────────────
//
// The persisted series behind /api/metrics. Owner-gated (METRICS_OWNER_EMAILS on
// the API), which is why these throw a MetricsAccessError the page can tell apart
// instead of one opaque Error: 404 means the console is not configured on this
// deployment at all, 401 means sign in, 403 means signed in but not an owner, and
// those three want three different screens rather than one red box.

export type MetricsSnapshot = {
  capturedAt: string;
  // The boot time of the process that produced this row. Where it CHANGES between
  // consecutive snapshots, the counters below reset and the latency histograms
  // emptied — so lines must break there rather than diff across, and a change is
  // also exactly what a deploy looks like.
  processStartedAt: string;
  uptimeSeconds: number;
  windowSeconds: number;
  // Cumulative since processStartedAt — plot deltas, not the raw value.
  requestsTotal: number;
  routeP95Ms: number;
  routeP95Route: string;
  routeP95Method: string;
  fanoutP95Ms: number;
  claims: number;
  claimConflicts: number;
  ttlExpiries: number;
  fencedWrites: number;
  webhookOk: number;
  webhookFailed: number;
  webhookDead: number;
  // A gauge — plot as-is.
  wsClients: number;
};

export type MetricsRestart = {
  at: string;
  processStartedAt: string;
  index: number;
};

export type MetricsHistory = {
  since: string;
  until: string;
  windowHours: number;
  count: number;
  truncated: boolean;
  restarts: MetricsRestart[];
  snapshots: MetricsSnapshot[];
};

export type LoadtestRun = {
  runId: string;
  scenario: string;
  schemaVersion: string;
  startedAt: string;
  finishedAt: string;
  api: string;
  gitRev: string;
  gitDirty: boolean;
  liveAgents: number;
  measuredSeconds: number;
  taskOpsPerSec: number;
  errorRate: number;
  claimP95Ms: number;
  queueP95Ms: number;
  assertionsPassed: number;
  assertionsFailed: number;
  aborted: boolean;
  skipped: boolean;
  notes: string;
};

// MetricsAccessError carries the status so the page can render the right thing
// for "not configured" vs "not signed in" vs "not you".
export class MetricsAccessError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MetricsAccessError";
    this.status = status;
  }
}

async function metricsFetch(path: string): Promise<Response> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    throw new MetricsAccessError(res.status, (await apiError(res, "")).message);
  }
  if (!res.ok) throw await apiError(res, "Could not load metrics history");
  return res;
}

export async function fetchMetricsHistory(hours: number): Promise<MetricsHistory> {
  const res = await metricsFetch(`/api/metrics/history?hours=${hours}`);
  return (await res.json()) as MetricsHistory;
}

export async function fetchLoadtestRuns(): Promise<LoadtestRun[]> {
  const res = await metricsFetch("/api/metrics/loadtest");
  return ((await res.json()) as { runs: LoadtestRun[] | null }).runs ?? [];
}

// Export URLs are plain links rather than fetch+blob: the point of export is that
// the data can leave the app, and a URL is scriptable (curl with a PAT) where a
// client-built blob is only reachable from this page.
export function metricsHistoryExportUrl(hours: number, format: "csv" | "json"): string {
  return format === "csv"
    ? `/api/metrics/history?hours=${hours}&format=csv`
    : `/api/metrics/history?hours=${hours}`;
}

export function loadtestExportUrl(format: "csv" | "json"): string {
  return format === "csv" ? "/api/metrics/loadtest?format=csv" : "/api/metrics/loadtest";
}
