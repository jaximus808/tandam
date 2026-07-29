import type { CanvasMeta } from "../types";
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

// ── Form submit (direct-input layer) ─────────────────────────────────────────
// Submitting a form is an HTTP POST that needs a canvas JWT. We obtain one with
// the same code→JWT exchange the MCP gateway uses (no Google login needed) and
// cache it per canvas code for the session. The backend broadcasts the resulting
// state over WS, so the board updates itself — we just need the call to land.
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

export async function submitForm(
  code: string,
  formId: string,
  values: Record<string, unknown>,
  submissionId?: string,
): Promise<void> {
  await authedFetch(
    code,
    `/api/canvas/forms/${formId}/submit`,
    { method: "POST", body: { values, submissionId } },
    "Submit failed",
  );
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

// Release a stuck claim: an executing task whose agent session died goes back
// to the queue (approved) with claimedBy/claimedAt cleared. Human-only by
// surface — this endpoint is deliberately not exposed through the MCP gateway.
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
