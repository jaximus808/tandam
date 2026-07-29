/**
 * The INTENT FACADE — Tandem's default MCP surface (TDM-32 / E2.1).
 *
 * The CRUD surface in tools.ts is ~80 tools that mirror the API one endpoint at
 * a time. That's a fine machine interface and a bad agent interface: it costs a
 * large slice of the context window before the session does anything, and it
 * leaves the model to invent the workflow. This file replaces it as the DEFAULT
 * manifest with 10 tools shaped like the things an agent session actually wants
 * to do, in the order it wants to do them:
 *
 *     canvas_connect → context_get → queue_next → task_get → task_claim
 *                    → (work, task_progress) → doc_write → task_complete
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

type Args = Record<string, unknown>;

/** Reuse a CRUD tool's input schema verbatim, so the two can't drift. */
function schemaOf(name: string) {
  const raw = RAW_TOOL_BY_NAME.get(name);
  if (!raw) throw new Error(`facade: no CRUD tool named ${name} to borrow a schema from`);
  return raw.inputSchema;
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
  result?: string;
  createdAt?: string;
  payload?: { title?: string; assignee?: string; epicId?: string };
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
        ? "There is approved work waiting. Call queue_next, then task_get + task_claim on the one you'll do."
        : "No approved work. Ask the human what to do, or draft tasks with task_propose (they land as 'proposed' for approval).",
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

/** `## title` + blank line + body, when a title was given. */
function composeMarkdown(title: unknown, body: unknown): string {
  const t = typeof title === "string" ? title.trim() : "";
  const b = typeof body === "string" ? body : "";
  return t ? `## ${t}\n\n${b}` : b;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

const FACADE_NAMES = new Set([
  "canvas_connect",
  "context_get",
  "queue_next",
  "task_get",
  "task_claim",
  "task_progress",
  "task_complete",
  "task_propose",
  "doc_write",
  "board_status",
]);

/** Does this tool name belong to the facade? (canvas_connect is shared.) */
export function isFacadeTool(name: string): boolean {
  return FACADE_NAMES.has(name) && name !== "canvas_connect";
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
      // Thin intent rename of canvas_task_list pinned to the ready queue.
      const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 10;
      const listed = (await handleTool(gateway, "canvas_task_list", {
        state: "approved",
        assignee: "agent",
        ...(args.epicId ? { epicId: args.epicId } : {}),
      })) as { tasks?: unknown[]; hint?: string };
      const tasks = listed.tasks ?? [];
      return {
        tasks: tasks.slice(0, Math.max(1, limit)),
        ...(tasks.length > limit ? { truncated: tasks.length - limit } : {}),
        ...(listed.hint ? { hint: listed.hint } : {}),
        ...(tasks.length === 0
          ? {
              _next:
                "Nothing approved. Tasks you propose land as 'proposed' and need a human to " +
                "approve them on the board — check board_status, or ask the human.",
            }
          : {}),
      };
    }

    case "task_get":
      return handleTool(gateway, "canvas_task_get", args);

    case "task_claim":
      return handleTool(gateway, "canvas_task_start", args);

    case "task_progress": {
      // No dedicated progress endpoint exists. DESIGN CHOICE: append to the
      // task's own payload under `progress[]` via the payload-only PATCH
      // (/api/canvas/actions/{id} with no `state`), so progress travels WITH the
      // task and comes back from task_get — rather than scattering loose notes
      // on the canvas that no one links back. Read-modify-write, because that
      // PATCH replaces the payload wholesale.
      const id = String(args.id ?? "");
      const note = typeof args.note === "string" ? args.note.trim() : "";
      if (!id) throw new Error("`id` (string) is required");
      if (!note) throw new Error("`note` (string) is required — say what changed since last time");

      const claimant = (args.agentName as string | undefined) ?? gateway.claimant();
      const { action } = (await gateway.get(`/api/canvas/actions/${id}`)) as {
        action: { state: string; claimedBy?: string; payload?: Record<string, unknown> };
      };
      // Mirror task_complete's guard: the payload PATCH has no server-side claim
      // check, so don't let a session narrate progress on someone else's task.
      const holder = action.claimedBy;
      if (action.state === "executing" && holder && holder !== "agent" && holder !== claimant) {
        return {
          recorded: false,
          claimedBy: holder,
          message:
            `This task is claimed by "${holder}" — it is not yours to report on. ` +
            `Call queue_next and pick a task you can claim.`,
        };
      }

      const payload = { ...(action.payload ?? {}) };
      const prior = Array.isArray(payload.progress) ? (payload.progress as unknown[]) : [];
      const entry = {
        at: new Date().toISOString(),
        by: claimant,
        note,
        ...(typeof args.percent === "number" ? { percent: args.percent } : {}),
      };
      // Bounded: a long-running task must not grow its payload without limit.
      payload.progress = [...prior, entry].slice(-20);

      await gateway.patch(`/api/canvas/actions/${id}`, { payload });
      return {
        recorded: true,
        id,
        by: claimant,
        entries: (payload.progress as unknown[]).length,
        note: "Progress is stored on the task payload and comes back from task_get.",
      };
    }

    case "task_complete":
      return handleTool(gateway, "canvas_task_complete", args);

    case "task_propose": {
      // One tool, both shapes: a single task, or a whole plan in one round trip.
      const many = args.tasks;
      if (Array.isArray(many) && many.length > 0) {
        return handleTool(gateway, "canvas_task_add_batch", { tasks: many });
      }
      if (typeof args.title !== "string" || !args.title.trim()) {
        throw new Error("Pass `title` (one task) or `tasks` (an array of them)");
      }
      return handleTool(gateway, "canvas_task_add", args);
    }

    case "doc_write": {
      const body = typeof args.body === "string" ? args.body : "";
      if (!body.trim() && !args.title) throw new Error("`body` (string) is required");
      const markdown = composeMarkdown(args.title, body);

      // Update in place when an id was given — same note, new content.
      if (typeof args.noteId === "string" && args.noteId.trim()) {
        const noteId = args.noteId.trim();
        // Project the response: echoing the note body back would just spend the
        // model's context on text it wrote a moment ago.
        const updated = (await gateway.patch(`/api/canvas/notes/${noteId}`, {
          body: markdown,
        })) as { documentId?: string };
        return {
          updated: true,
          noteId,
          ...(updated?.documentId ? { documentId: updated.documentId } : {}),
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
      const [tasks, epicsRes] = await Promise.all([
        listAgentTasks(gateway),
        gateway.get("/api/canvas/actions?type=epic") as Promise<{
          actions?: Array<{ id: string; state: string; payload?: { title?: string } }>;
        }>,
      ]);

      const epics = (epicsRes.actions ?? []).map((e) => {
        const mine = tasks.filter((t) => t.payload?.epicId === e.id);
        return {
          id: e.id,
          title: e.payload?.title ?? "",
          state: e.state,
          tasks: countByState(mine),
        };
      });

      const inFlight = tasks
        .filter((t) => t.state === "executing")
        .map((t) => ({ ...compactTask(t), claimedBy: t.claimedBy ?? "agent" }));

      return {
        canvas: canvasBlock(gateway),
        tasks: { total: tasks.length, byState: countByState(tasks) },
        inFlight,
        epics,
        unassignedTasks: tasks.filter((t) => !t.payload?.epicId).length,
        _next:
          "Ready work is the 'approved' count — call queue_next to see it. Tasks stuck at " +
          "'proposed' are waiting on a human (and tasks under a 'proposed' epic wait on that epic).",
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
      "call. Next: context_get to learn the canvas, or queue_next to go straight to the work.",
    inputSchema: schemaOf("canvas_connect"),
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
      "THE ENTRY POINT FOR WORK: the approved tasks ready to be picked up right now, compact " +
      "({id, ticketId, title, state, epicId}) — no bodies. Start here rather than reading the " +
      "canvas. Pick ONE, then task_get it for the full brief and task_claim it before you touch " +
      "anything. Empty means nothing is approved: tasks you propose sit at 'proposed' until a " +
      "human approves them on the board. " +
      SESSION_CONVENTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max tasks to return. Default 10." },
        epicId: { type: "string", description: "Only ready tasks under this epic." },
      },
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
      "Claim a task before you do any work on it (approved → executing), so parallel sessions " +
      "skip it. The claim is ATOMIC and losing is NORMAL: { claimed: false, claimedBy } means " +
      "another session got there first — do NOT work on it, go back to queue_next and take the " +
      "next one. On success you get the task's `ticketId` (e.g. 'TDM-142'); put it in your commit " +
      "messages so the work traces back. " +
      SESSION_CONVENTION,
    inputSchema: schemaOf("canvas_task_start"),
  },
  {
    name: "task_progress",
    description:
      "Report progress on a task you claimed, mid-flight. Use it on long work so the human (and " +
      "other sessions) can see movement instead of silence — after a meaningful step, or when you " +
      "hit a blocker and change approach. One short line per call: what changed since last time. " +
      "The entry is stored ON the task and comes back from task_get. This is NOT the finish line — " +
      "call task_complete for that. " +
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
      "FINISH a task with a result summary — the last step of every task you claim; leaving one " +
      "'executing' blocks the queue. `result` is a short human-readable account of what was done " +
      "and where: files, commit hashes, PR. It shows on the board, so it is the human's whole view " +
      "of your work. Back it with `links`: the GitHub URLs the work produced (commit / pull " +
      "request / branch). The board resolves those live — merged, open, checks failing — so the " +
      "human reads what HAPPENED, not just what you said. " +
      "Failed? pass status:'failed' with `error` rather than leaving it hanging. " +
      "Complete under the SAME identity you claimed with. " +
      SESSION_CONVENTION,
    inputSchema: schemaOf("canvas_task_complete"),
  },
  {
    name: "task_propose",
    description:
      "Propose work for LATER sessions — one task, or a whole plan at once via `tasks` (strongly " +
      "preferred over calling this repeatedly). Proposals land as 'proposed' and a human approves " +
      "them on the board before any session can claim them, so this is how you hand off work " +
      "instead of doing it. Keep `body` a tight brief (what to do, acceptance criteria) and put " +
      "the heavy context in notes/roadmap items referenced by `linkedIds` — task_get hydrates " +
      "those for whoever picks it up. " +
      SESSION_CONVENTION,
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
            "Epic this task belongs to. Under the default approval policy, a task added to an " +
            "already-approved epic is born approved instead of waiting for its own approval.",
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
              epicId: { type: "string" },
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
      "A compact read of the BOARD, not the canvas: task counts by state, what's in flight and who " +
      "holds it, epics with their approval state and per-epic task counts. Use it to answer 'where " +
      "does this project stand', to check whether your proposals got approved, or to spot a task " +
      "another session left stuck in 'executing'. Cheap — it never dumps canvas contents. For the " +
      "work you can actually start, use queue_next. " +
      SESSION_CONVENTION,
    inputSchema: { type: "object" as const, properties: {} },
  },
];
