/**
 * Epic summaries (TDM-93) — reading what a batch achieved without opening its
 * tickets, and the write path that keeps that field from staying empty.
 *
 * What's pinned here is the facade's half of the contract:
 *   · board_status prefers the server ROLLUP (summary + per-ticket account) and
 *     still answers on an API that has no such endpoint;
 *   · task_complete's `epicSummary` writes to the EPIC (merged, never replacing
 *     the epic's other payload fields) and never claims a write that failed;
 *   · the rollup is SUPPLEMENTARY — a completion is never reported as failed
 *     because the enrichment read broke;
 *   · task_get warns the worker BEFORE it finishes the last task in a batch,
 *     which is the only moment the one-call write is still available.
 *
 * No network: global fetch is replaced with a recorder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway, serializeSession } from "../src/gateway.js";
import { handleFacadeTool } from "../src/facade.js";

type Recorded = { method: string; path: string; body: any };

const EPIC_ID = "11111111-1111-4111-8111-111111111111";

/** A rollup row as GET /api/canvas/epics returns it. */
function rollup(over: Record<string, unknown> = {}) {
  return {
    id: EPIC_ID,
    title: "E10 · Demo blockers",
    state: "approved",
    tasks: { total: 3, byState: { done: 2, approved: 1 } },
    done: [
      { id: "t1", ticketId: "TDM-90", title: "Publish the pivot", state: "done", result: "Shipped." },
    ],
    drained: false,
    summaryNeeded: false,
    ...over,
  };
}

type Opts = {
  /** null = the endpoint is not deployed (404); "boom" = it errors hard. */
  epics?: any[] | null | "boom";
  /**
   * When set, GET /api/canvas/actions/{id} answers as a TASK read — the
   * { action, linked, epic? } shape the API hydrates for task_get. Otherwise it
   * answers as the epic row the summary write reads before merging.
   */
  taskRead?: any;
  /** Fail the epic payload PATCH. */
  failPatch?: boolean;
  /** What the task completion PATCH answers with. */
  completion?: any;
  /** Answer the completion PATCH with a 409 (the claim-conflict path). */
  completionConflict?: any;
};

function withRecordedFetch(run: (calls: Recorded[]) => Promise<void>, opts: Opts = {}) {
  const calls: Recorded[] = [];
  const real = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const path = url.pathname;

    if (path === "/api/canvas/epics") {
      if (opts.epics === "boom") throw new Error("network down");
      if (opts.epics === null || opts.epics === undefined) return json({ error: "not found" }, 404);
      return json({ epics: opts.epics });
    }
    if (path === "/api/canvas/actions" && method === "GET") {
      // The fallback epic list board_status reads alongside the rollup.
      return json({
        actions: [{ id: EPIC_ID, state: "approved", payload: { title: "E10 · Demo blockers" } }],
      });
    }
    if (path.startsWith("/api/canvas/actions/") && method === "GET") {
      if (opts.taskRead) return json(opts.taskRead);
      return json({
        action: {
          id: EPIC_ID,
          type: "epic",
          state: "approved",
          payload: { title: "E10 · Demo blockers", body: "Ship it", linkedIds: ["note-1"] },
        },
      });
    }
    if (path.startsWith("/api/canvas/actions/") && method === "PATCH") {
      if (body?.payload && opts.failPatch) return json({ error: "content_locked" }, 409);
      if (body?.payload) return json({ action: { id: EPIC_ID, payload: body.payload } });
      // The task completion PATCH.
      if (opts.completionConflict) return json(opts.completionConflict, 409);
      return json(
        opts.completion ?? {
          completed: true,
          action: { id: "task-9", state: "done", payload: { title: "Last one", epicId: EPIC_ID } },
        }
      );
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  }) as typeof globalThis.fetch;

  return run(calls).finally(() => {
    globalThis.fetch = real;
  });
}

function connectedGateway(): Gateway {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  gw.adoptSession(
    serializeSession({
      token: "jwt",
      canvasId: "canvas-1",
      canvasName: "Test",
      canvasCode: "TESTCODE",
      agentName: "tester",
    })
  );
  return gw;
}

// ── board_status ──────────────────────────────────────────────────────────────

test("board_status returns each epic's summary and account without reading its tasks", async () => {
  await withRecordedFetch(
    async (calls) => {
      const res = (await handleFacadeTool(connectedGateway(), "board_status", {})) as any;

      // THE acceptance criterion: no per-task read anywhere in this answer.
      assert.equal(
        calls.filter((c) => /\/api\/canvas\/actions\/[^/?]+$/.test(c.path)).length,
        0,
        "board_status must not read individual tasks"
      );
      assert.equal(res.epics.length, 1);
      assert.equal(res.epics[0].summary, "Published the pivot; reconciled the surfaces.");
      // The per-ticket account is EXPANDED now, not free (TDM-184): the default
      // read says how many lines it is holding back, and `epic:` fetches them.
      assert.equal("done" in res.epics[0], false, "no per-ticket lines on the default read");
      assert.equal(res.epics[0].doneOmitted, 1);
      assert.match(String(res._epics), /epic: "<id or title>"/);
    },
    { epics: [rollup({ summary: "Published the pivot; reconciled the surfaces." })] }
  );
});

test("board_status names the epics that drained with nobody saying what they achieved", async () => {
  await withRecordedFetch(
    async () => {
      const res = (await handleFacadeTool(connectedGateway(), "board_status", {})) as any;
      assert.deepEqual(res.unsummarizedEpics, [
        { id: EPIC_ID, title: "E10 · Demo blockers", doneTasks: 3 },
      ]);
      assert.match(String(res._unsummarizedEpics), /epicSummary/);
    },
    {
      epics: [
        rollup({ tasks: { total: 3, byState: { done: 3 } }, drained: true, summaryNeeded: true }),
      ],
    }
  );
});

test("board_status still answers when the rollup endpoint is absent", async () => {
  await withRecordedFetch(
    async () => {
      const res = (await handleFacadeTool(connectedGateway(), "board_status", {})) as any;
      // Composed fallback: counts, no summary — and crucially not an error.
      assert.equal(res.epics.length, 1);
      assert.equal(res.epics[0].title, "E10 · Demo blockers");
      assert.equal("unsummarizedEpics" in res, false);
    },
    { epics: null }
  );
});

// ── The write path ────────────────────────────────────────────────────────────

test("task_complete's epicSummary merges onto the epic instead of replacing it", async () => {
  await withRecordedFetch(
    async (calls) => {
      const res = (await handleFacadeTool(connectedGateway(), "task_complete", {
        id: "TDM-99",
        result: "Did the last ticket.",
        epicSummary: "  Shipped the pivot end to end.  ",
      })) as any;

      const patch = calls.find((c) => c.method === "PATCH" && c.body?.payload)!;
      assert.ok(patch, "the epic payload must be PATCHed");
      // A payload PATCH REPLACES, so the epic's other fields have to ride along.
      assert.deepEqual(patch.body.payload, {
        title: "E10 · Demo blockers",
        body: "Ship it",
        linkedIds: ["note-1"],
        summary: "Shipped the pivot end to end.",
      });
      // summaryBy/summaryAt are the SERVER's to stamp — sending them would be a
      // client claiming provenance it cannot have.
      assert.equal("summaryBy" in patch.body.payload, false);
      assert.equal("summaryAt" in patch.body.payload, false);
      assert.equal(res.epicSummary.written, true);
      assert.equal(res.epicSummary.epicId, EPIC_ID);
    },
    { epics: [rollup()] }
  );
});

test("a failed summary write does not report the finished task as failed", async () => {
  await withRecordedFetch(
    async () => {
      const res = (await handleFacadeTool(connectedGateway(), "task_complete", {
        id: "TDM-99",
        result: "Did the last ticket.",
        epicSummary: "Shipped it.",
      })) as any;
      assert.equal(res.completed, true, "the task really is done");
      assert.equal(res.epicSummary.written, false);
      assert.match(String(res.epicSummary.note), /task completed/i);
    },
    { epics: [rollup()], failPatch: true }
  );
});

test("epicSummary on a task with no epic says so instead of silently dropping it", async () => {
  await withRecordedFetch(
    async () => {
      const res = (await handleFacadeTool(connectedGateway(), "task_complete", {
        id: "TDM-99",
        result: "Standalone work.",
        epicSummary: "Some batch story.",
      })) as any;
      assert.equal(res.epicSummary.written, false);
      assert.match(String(res.epicSummary.reason), /no epic/i);
    },
    {
      epics: [rollup()],
      completion: { completed: true, action: { id: "task-9", state: "done", payload: { title: "Loose" } } },
    }
  );
});

test("a refused completion is returned untouched — a tap-out is not summarizable", async () => {
  await withRecordedFetch(
    async (calls) => {
      const res = (await handleFacadeTool(connectedGateway(), "task_complete", {
        id: "TDM-99",
        result: "Not mine.",
        epicSummary: "Should never be written.",
      })) as any;
      assert.equal(res.completed, false);
      assert.equal("epicSummary" in res, false);
      assert.equal(
        calls.filter((c) => c.method === "PATCH" && c.body?.payload).length,
        0,
        "a session that lost the task must not write to its epic"
      );
    },
    {
      epics: [rollup()],
      // Already executing, so canvas_task_complete goes straight to the terminal
      // PATCH (no auto-claim) — and that PATCH is what gets refused.
      taskRead: {
        action: {
          id: "task-9",
          type: "task",
          state: "executing",
          claimedBy: "someone-else",
          payload: { title: "Not mine", epicId: EPIC_ID },
        },
      },
      // The 409 the API answers when the claim is not ours — canvas_task_complete
      // turns it into the tap-out shape, and the facade must not read past it.
      completionConflict: { error: "not_your_claim", claimedBy: "someone-else", state: "executing" },
    }
  );
});

test("a broken rollup read degrades the answer, it does not fail the completion", async () => {
  await withRecordedFetch(
    async () => {
      const res = (await handleFacadeTool(connectedGateway(), "task_complete", {
        id: "TDM-99",
        result: "Done.",
      })) as any;
      assert.equal(res.completed, true);
      assert.equal("epic" in res, false, "no rollup, no epic block — and no throw");
    },
    { epics: "boom" }
  );
});

// ── The nudge lands while it can still be acted on ────────────────────────────

test("task_get warns when this is the last unfinished task in the batch", async () => {
  await withRecordedFetch(
    async () => {
      const res = (await handleFacadeTool(connectedGateway(), "task_get", { id: "TDM-99" })) as any;
      assert.equal(res.epic.openTasks, 1);
      assert.match(String(res._epic), /LAST unfinished task/);
      assert.match(String(res._epic), /epicSummary/);
    },
    {
      taskRead: {
        action: { id: "task-9", type: "task", state: "approved", payload: { title: "Last one", epicId: EPIC_ID } },
        linked: [],
        epic: { id: EPIC_ID, title: "E10 · Demo blockers", state: "approved" },
      },
      epics: [rollup({ tasks: { total: 3, byState: { done: 2, approved: 1 } } })],
    }
  );
});

test("task_get stays quiet about the batch when work is still queued behind this task", async () => {
  await withRecordedFetch(
    async () => {
      const res = (await handleFacadeTool(connectedGateway(), "task_get", { id: "TDM-99" })) as any;
      assert.equal(res.epic.openTasks, 3);
      assert.equal("_epic" in res, false);
    },
    {
      taskRead: {
        action: { id: "task-9", type: "task", state: "approved", payload: { title: "One of many", epicId: EPIC_ID } },
        linked: [],
        epic: { id: EPIC_ID, title: "E10 · Demo blockers", state: "approved" },
      },
      epics: [rollup({ tasks: { total: 5, byState: { done: 2, approved: 3 } } })],
    }
  );
});

test("task_complete advertises epicSummary as the epic-level write path", async () => {
  const { FACADE_TOOLS } = await import("../src/server.js");
  const tool = FACADE_TOOLS.find((t) => t.name === "task_complete")!;
  const props = (tool.inputSchema.properties ?? {}) as Record<string, any>;
  assert.equal(props.epicSummary?.type, "string");
  // The description is the only doc an agent gets: it has to say the summary
  // lands on the EPIC, not on this task.
  assert.match(props.epicSummary.description, /epic/i);
  // And the CRUD schema it extends must be intact.
  assert.equal(props.result?.type, "string");
  assert.equal(props.links?.type, "array");
  assert.deepEqual(tool.inputSchema.required, ["id", "result"]);
});
