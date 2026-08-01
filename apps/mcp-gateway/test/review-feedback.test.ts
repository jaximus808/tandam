/**
 * TDM-161 — a rejection reason reaches the agent that proposed it.
 *
 * The DERIVATION is not tested here, because the gateway does not own it: the
 * API reduces a rejection (actions.error) and a rework bounce (the done →
 * approved audit note) into one `review` block, and review_feedback_test.go
 * pins those rules. What IS the gateway's job, and what these pin:
 *
 *   1. task_get passes the server's `review` through and turns it into the
 *      author's next move (`_review`) — with the reason VERBATIM, and different
 *      prose per outcome, because a rejection and a bounce ask for different
 *      things;
 *   2. it does so on EVERY branch of task_get — epic, no epic, rollup missing;
 *   3. the batch read carries the reasons too, so an orchestrator polling for
 *      its approvals learns WHY a ticket went away and not just that the count
 *      dropped;
 *   4. queue_next stays a ready-work call: no review block, no notifications
 *      copy. The reason reaches a worker one call later, on task_get, which the
 *      handoff already tells it to make.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool } from "../src/facade.js";
import { FACADE_TOOLS } from "../src/server.js";

const CODE = "TESTCODE";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Routes = Record<string, (url: URL) => Response>;

function install(routes: Routes) {
  const paths: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    paths.push(`${method} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/mcp/auth") {
      return json({ token: "t", canvasId: "canvas-1", canvasName: "C", canvasCode: CODE });
    }
    if (url.pathname === "/api/canvas/agents" && method === "POST") {
      return json({ agentId: "agent-1", name: "author" }, 201);
    }
    const hit = routes[url.pathname];
    if (hit) return hit(url);
    throw new Error(`unexpected request: ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return { paths, restore: () => (globalThis.fetch = real) };
}

async function connect(): Promise<Gateway> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", { code: CODE, role: "executor", name: "author" });
  return gw;
}

const REJECTION = {
  outcome: "rejected",
  reason: "messaging is a separate service — do not touch it",
  by: "human",
  at: "2026-08-01T10:00:00Z",
  state: "rejected",
};

const BOUNCE = {
  outcome: "rework",
  reason:
    "the rework handler never checks the claim fence, so a worker whose lease was superseded " +
    "can still bounce the task — cover that case in the API tests",
  by: "agent:codex-reviewer",
  at: "2026-08-01T11:00:00Z",
  state: "approved",
};

// ── task_get is where a returned ticket explains itself ──────────────────────

test("task_get hands back the rejection reason and what to do about it", async () => {
  const { restore } = install({
    "/api/canvas/actions/task-1": () =>
      json({
        action: { id: "task-1", ticketId: "TDM-21", state: "rejected", payload: { title: "X" } },
        linked: [],
        review: REJECTION,
      }),
  });
  try {
    const res = (await handleFacadeTool(await connect(), "task_get", { id: "task-1" })) as any;
    // The server's block passes through untouched — it is the data.
    assert.deepEqual(res.review, REJECTION);
    // VERBATIM: the reason is the correction, so nothing excerpts it.
    assert.ok(String(res._review).includes(REJECTION.reason));
    assert.match(String(res._review), /REJECTED/);
    assert.match(String(res._review), /by human/);
    // The two things that turn triage into a treadmill if they are not said.
    assert.match(String(res._review), /do not\s+re-propose/i);
    assert.match(String(res._review), /task_amend/);
  } finally {
    restore();
  }
});

test("task_get reads a rework bounce as a live instruction, not a verdict", async () => {
  const { restore } = install({
    "/api/canvas/actions/TDM-21": () =>
      json({
        action: { id: "task-1", ticketId: "TDM-21", state: "approved", payload: { title: "X" } },
        linked: [],
        review: BOUNCE,
      }),
  });
  try {
    const res = (await handleFacadeTool(await connect(), "task_get", { id: "TDM-21" })) as any;
    assert.ok(String(res._review).includes(BOUNCE.reason), "the whole instruction, not an excerpt");
    assert.match(String(res._review), /SENT BACK/);
    assert.match(String(res._review), /agent:codex-reviewer/);
    assert.match(String(res._review), /task_complete again/);
    // A bounce is the SAME ticket — re-proposing it is the failure mode here.
    assert.match(String(res._review), /same ticket/i);
    // And it is not a rejection: nothing here should tell the author to stop.
    assert.doesNotMatch(String(res._review), /REJECTED/);
  } finally {
    restore();
  }
});

test("a task with nothing to report carries no review copy at all", async () => {
  const { restore } = install({
    "/api/canvas/actions/task-1": () =>
      json({ action: { id: "task-1", state: "approved", payload: { title: "X" } }, linked: [] }),
  });
  try {
    const res = (await handleFacadeTool(await connect(), "task_get", { id: "task-1" })) as any;
    assert.equal("review" in res, false);
    assert.equal("_review" in res, false);
  } finally {
    restore();
  }
});

// The epic branch of task_get takes a different return path; the reason must not
// fall out of it. This is the branch a worker in a batch actually hits.
test("the reason survives the epic-rollup branch of task_get", async () => {
  const { restore } = install({
    "/api/canvas/actions/task-1": () =>
      json({
        action: { id: "task-1", state: "approved", payload: { title: "X", epicId: "epic-1" } },
        linked: [],
        epic: { id: "epic-1", title: "E21", state: "approved" },
        review: BOUNCE,
      }),
    "/api/canvas/epics": () =>
      json({
        epics: [
          {
            id: "epic-1",
            title: "E21",
            state: "approved",
            tasks: { total: 3, byState: { approved: 1, done: 2 } },
            done: [],
            drained: false,
            summaryNeeded: false,
            returned: [
              { ...REJECTION, id: "task-9", ticketId: "TDM-19", title: "Rewrite messaging" },
            ],
          },
        ],
      }),
  });
  try {
    const res = (await handleFacadeTool(await connect(), "task_get", { id: "task-1" })) as any;
    assert.ok(String(res._review).includes(BOUNCE.reason));
    // And the batch's own casualties ride along on the epic snapshot, because a
    // worker about to start is the reader most likely to be building the same
    // mistake the human already cut next door.
    assert.equal(res.epic.returned.length, 1);
    assert.equal(res.epic.returned[0].ticketId, "TDM-19");
  } finally {
    restore();
  }
});

// ── the batch read: what an orchestrator polling for approvals learns ────────

test("board_status names the tickets that came back", async () => {
  const { restore } = install({
    "/api/canvas/actions": (url) =>
      url.search.includes("type=epic")
        ? json({ actions: [] })
        : json({ actions: [{ id: "t1", state: "approved", payload: { title: "A" } }] }),
    "/api/canvas/epics": () =>
      json({
        epics: [
          {
            id: "epic-1",
            title: "E21",
            state: "approved",
            tasks: { total: 2, byState: { approved: 1, rejected: 1 } },
            done: [],
            drained: false,
            summaryNeeded: false,
            returned: [
              { ...REJECTION, id: "task-9", ticketId: "TDM-19", title: "Rewrite messaging" },
            ],
          },
        ],
      }),
  });
  try {
    const res = (await handleFacadeTool(await connect(), "board_status", {})) as any;
    assert.match(String(res._returned), /1 ticket\(s\) came BACK/);
    assert.match(String(res._returned), /returned/);
    // The reason itself is on the epic row, not re-quoted into the note.
    assert.equal(res.epics[0].returned[0].reason, REJECTION.reason);
  } finally {
    restore();
  }
});

// ── and queue_next stays a ready-work call ───────────────────────────────────

test("queue_next carries no review block and no notifications copy", async () => {
  const { restore } = install({
    "/api/canvas/actions": () =>
      json({
        actions: [
          {
            id: "task-1",
            ticketId: "TDM-21",
            state: "approved",
            payload: { title: "Add the fence test" },
          },
        ],
      }),
  });
  try {
    const res = (await handleFacadeTool(await connect(), "queue_next", {})) as any;
    assert.equal(res.tasks.length, 1);
    assert.equal("review" in res, false);
    assert.equal("_review" in res, false);
    assert.equal("_returned" in res, false);
    for (const t of res.tasks) {
      assert.equal("review" in t, false, "the queue projection must stay a ready-work list");
    }
  } finally {
    restore();
  }
});

// The manifest is the only documentation an agent gets: if task_get does not
// SAY it answers this, an author whose ticket vanished has no reason to call it.
test("the manifest teaches where a returned ticket explains itself", () => {
  const tool = FACADE_TOOLS.find((t) => t.name === "task_get")!;
  assert.ok(tool);
  assert.match(tool.description, /review/);
  assert.match(tool.description, /reject/i);
  assert.match(tool.description, /rework/i);
});
