/**
 * TDM-201 — a handoff may only name a parent that EXISTS.
 *
 * THE INCIDENT. queue_next copied `session.agentId` onto every handoff without
 * checking it. On 2026-08-03 a one-character corruption in a carried session
 * handle produced an agentId registered nowhere on the canvas, and the whole
 * dispatched batch told its workers to register under that ghost — the fleet
 * tree silently wrong, no error raised anywhere, and nothing in the response
 * that would let the planner notice.
 *
 * So the id is now checked against the canvas's registered agents before it is
 * shipped, and what is pinned here is the three-way behaviour that follows:
 *   - REGISTERED → nothing changes; the handoff carries it, no warning.
 *   - UNREGISTERED → the parent is OMITTED (workers connecting unparented is a
 *     path that already works) and a `_warning` names the id and says to
 *     reconnect.
 *   - UNREADABLE → fail OPEN. "We could not check" must never become "we could
 *     not dispatch"; the handoff ships exactly as it did before.
 *
 * Plus the cost rule that makes it affordable: ONE agent-list read per
 * queue_next / queue_wait call, reused across every row in the batch.
 *
 * No network: global fetch is replaced with a recorder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleFacadeTool } from "../src/facade.js";
import { handleTool } from "../src/tools.js";

const AUTH_RESPONSE = {
  token: "jwt-token",
  canvasId: "canvas-1",
  canvasName: "Test Canvas",
  canvasCode: "TESTCODE",
};

/** The id POST /api/canvas/agents hands back on register — the session's own. */
const MY_ID = "planner-77";

const READY_ACTIONS = [
  {
    id: "task-aaa",
    state: "approved",
    ticketId: "TDM-101",
    proposedBy: "agent",
    createdAt: "2026-08-03T00:00:00Z",
    payload: { title: "Wire the thing", assignee: "agent" },
  },
  {
    id: "task-bbb",
    state: "approved",
    ticketId: "TDM-102",
    proposedBy: "agent",
    createdAt: "2026-08-03T00:00:00Z",
    payload: { title: "Unwire the other thing", assignee: "agent" },
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The state projection as the API serves it: `state.agents` keyed by id. */
function agentsState(ids: string[]): unknown {
  const agents: Record<string, unknown> = {};
  for (const id of ids) {
    agents[id] = { id, kind: "agent", name: `agent-${id}`, role: "planner", status: "active" };
  }
  return { type: "state", canvas: { approvalPolicy: "epic" }, state: { agents } };
}

type Routes = {
  /** Answer for GET /api/canvas/state (the agent-list read). */
  state?: () => Response;
  /** Answer for GET /api/canvas/queue/wait, when the test uses queue_wait. */
  wait?: () => Response;
  actions?: unknown[];
};

type Recorded = { url: URL };

async function withFetch<T>(routes: Routes, run: (calls: Recorded[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push({ url });
    if (url.pathname === "/api/mcp/auth") return json(AUTH_RESPONSE);
    if (url.pathname === "/api/canvas/agents") return json({ agentId: MY_ID }, 201);
    if (url.pathname === "/api/canvas/state") {
      return routes.state ? routes.state() : json(agentsState([MY_ID]));
    }
    if (url.pathname === "/api/canvas/queue/wait") {
      if (!routes.wait) throw new Error("unexpected wait call");
      return routes.wait();
    }
    if (url.pathname === "/api/canvas/actions") {
      return json({ actions: routes.actions ?? READY_ACTIONS });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof globalThis.fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = real;
  }
}

type QueueResult = {
  tasks: Array<Record<string, any>>;
  _dispatch?: string;
  _warning?: string;
  _next?: string;
  status?: string;
};

/** Connect + register as a planner, then pull the ready queue. */
async function queueNext(): Promise<QueueResult> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", { code: "TESTCODE", role: "planner", name: "the-planner" });
  return (await handleFacadeTool(gw, "queue_next", {})) as QueueResult;
}

/** How many times the agent-list read went out on this run. */
function agentListReads(calls: Recorded[]): number {
  return calls.filter(
    (c) => c.url.pathname === "/api/canvas/state" && c.url.searchParams.get("fields") === "agents"
  ).length;
}

test("a REGISTERED agentId rides the handoff exactly as before", async () => {
  await withFetch({ state: () => json(agentsState([MY_ID, "other-9"])) }, async () => {
    const result = await queueNext();

    assert.equal(result.tasks.length, 2);
    for (const t of result.tasks) {
      assert.equal(t.handoff.parentAgentId, MY_ID, "the verified parent is shipped");
      assert.match(t.handoff.steps[0], new RegExp(`parentAgentId "${MY_ID}"`));
    }
    assert.equal(result._warning, undefined, "nothing to warn about");
    assert.doesNotMatch(result._dispatch ?? "", /not registered/);
  });
});

test("an UNREGISTERED agentId is omitted from the handoff, and warned about", async () => {
  await withFetch({ state: () => json(agentsState(["someone-else", "and-another"])) }, async () => {
    const result = await queueNext();

    assert.equal(result.tasks.length, 2);
    for (const t of result.tasks) {
      assert.equal(t.handoff.parentAgentId, null, "a link to nobody is worse than no link");
      // The worker still gets a usable block — the gap is spelled out in step 1,
      // the same way an unregistered planner's handoffs already read.
      assert.match(t.handoff.steps[0], /canvas_connect/);
      assert.match(t.handoff.steps[0], /planner/);
      assert.match(t.handoff.steps[1], /task_claim/);
    }

    // The ghost id must not survive anywhere in the payload — that is the whole
    // point: a worker must not be able to copy it back out of the response.
    assert.doesNotMatch(JSON.stringify(result.tasks), new RegExp(MY_ID));

    // The warning names the id and says what to do about it.
    const warning = result._warning ?? "";
    assert.ok(warning, "an omitted parent must be reported, not silent");
    assert.match(warning, new RegExp(MY_ID), "name the unrecognized id");
    assert.match(warning, /not a registered agent/i);
    assert.match(warning, /canvas_connect/, "the fix is a fresh handle");
  });
});

test("the agent list is read ONCE per call, not once per task", async () => {
  await withFetch({}, async (calls) => {
    const result = await queueNext();
    assert.equal(result.tasks.length, 2, "a multi-row batch");
    assert.equal(agentListReads(calls), 1, "one read for the whole batch");
  });
});

test("an unreadable agent list FAILS OPEN — the handoff ships as it does today", async () => {
  // 404: an API too old to answer this projection.
  await withFetch({ state: () => json({ error: "not found" }, 404) }, async () => {
    const result = await queueNext();
    assert.equal(result.tasks[0].handoff.parentAgentId, MY_ID);
    assert.equal(result._warning, undefined, "we could not check ≠ we found a problem");
  });

  // And a transport failure, which is the likelier one in practice.
  await withFetch(
    {
      state: () => {
        throw new Error("connection reset");
      },
    },
    async () => {
      const result = await queueNext();
      assert.equal(result.tasks[0].handoff.parentAgentId, MY_ID);
      assert.equal(result._warning, undefined);
    }
  );

  // An answer carrying no agents at all is "unknown", not "nobody is registered".
  await withFetch({ state: () => json({ type: "state", canvas: {}, state: {} }) }, async () => {
    const result = await queueNext();
    assert.equal(result.tasks[0].handoff.parentAgentId, MY_ID);
    assert.equal(result._warning, undefined);
  });
});

test("an agent list served as a plain LIST is understood too", async () => {
  await withFetch(
    { state: () => json({ agents: [{ id: "someone-else" }, { id: "and-another" }] }) },
    async () => {
      const result = await queueNext();
      assert.equal(result.tasks[0].handoff.parentAgentId, null);
      assert.match(result._warning ?? "", new RegExp(MY_ID));
    }
  );
});

test("an unregistered caller is untouched by the check — no id, no warning", async () => {
  await withFetch({}, async (calls) => {
    const gw = new Gateway({ apiUrl: "http://api.test" });
    // No role/name: this session never registered, so there is no id to verify.
    await handleTool(gw, "canvas_connect", { code: "TESTCODE" });
    const result = (await handleFacadeTool(gw, "queue_next", {})) as QueueResult;

    assert.equal(result.tasks[0].handoff.parentAgentId, null);
    assert.equal(result._warning, undefined, "already covered by the _dispatch note");
    assert.match(result._dispatch ?? "", /not registered/);
    assert.equal(agentListReads(calls), 0, "nothing to check, so nothing is spent checking");
  });
});

test("queue_wait's ready answer omits a ghost parent the same way queue_next does", async () => {
  const readyBody = {
    type: "queue.wait",
    status: "ready",
    actions: READY_ACTIONS,
    count: READY_ACTIONS.length,
    waitedMs: 4200,
    timeoutSeconds: 25,
  };
  await withFetch(
    {
      wait: () => json(readyBody),
      state: () => json(agentsState(["someone-else"])),
    },
    async (calls) => {
      const gw = new Gateway({ apiUrl: "http://api.test" });
      await handleTool(gw, "canvas_connect", {
        code: "TESTCODE",
        role: "planner",
        name: "the-planner",
      });
      const result = (await handleFacadeTool(gw, "queue_wait", {})) as QueueResult;

      assert.equal(result.status, "ready");
      assert.equal(result.tasks.length, 2);
      for (const t of result.tasks) {
        assert.equal(t.handoff.parentAgentId, null, "a waited-for handoff is the same object");
      }
      assert.match(result._warning ?? "", new RegExp(MY_ID));
      assert.equal(agentListReads(calls), 1, "one read for the whole waited batch");
    }
  );
});
