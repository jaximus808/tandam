/**
 * TDM-62 / E9.2 — the paste-ready dispatch handoff on queue_next.
 *
 * The E9 contract: an agent claims only what it will personally do; an
 * orchestrator dispatches, and never transports its `session` handle. The
 * handle is ~700 base64 characters carrying the canvas JWT and the planner's
 * identity — a worker handed that one claims AS the planner, and the fleet tree
 * the board draws collapses to a single node.
 *
 * So the delegation payload has to be something else, and it has to already
 * exist: every ready task queue_next returns carries a `handoff` block with the
 * 8-char canvas CODE, the task's id/ticket/title, the planner's agentId to
 * parent under, and the literal steps. What's pinned here is that shape, that
 * the session handle never appears anywhere in it, and that an unregistered
 * caller still gets a usable block (with the missing parent spelled out rather
 * than silently dropped).
 *
 * Also pinned: the surface copy that produced the bug this task fixes — no
 * description may tell an orchestrator to claim before dispatching.
 *
 * No network: global fetch is replaced with a recorder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleFacadeTool } from "../src/facade.js";
import { handleTool } from "../src/tools.js";
import { FACADE_TOOLS } from "../src/server.js";

const AUTH_RESPONSE = {
  token: "jwt-token",
  canvasId: "canvas-1",
  canvasName: "Test Canvas",
  canvasCode: "TESTCODE",
};

const READY_TASKS = [
  {
    id: "task-aaa",
    state: "approved",
    ticketId: "TDM-101",
    proposedBy: "agent",
    createdAt: "2026-07-29T00:00:00Z",
    payload: { title: "Wire the thing", assignee: "agent" },
  },
  {
    id: "task-bbb",
    state: "approved",
    ticketId: "TDM-102",
    proposedBy: "agent",
    createdAt: "2026-07-29T00:00:00Z",
    payload: { title: "Unwire the other thing", assignee: "agent" },
  },
];

function withRecordedFetch(run: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/mcp/auth") {
      return json(AUTH_RESPONSE);
    }
    if (url.pathname === "/api/canvas/agents") {
      return json({ agentId: "planner-77" }, 201);
    }
    if (url.pathname === "/api/canvas/actions") {
      return json({ actions: READY_TASKS });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return run().finally(() => {
    globalThis.fetch = real;
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type QueueResult = {
  tasks: Array<Record<string, any>>;
  _dispatch?: string;
  _next?: string;
};

/** Connect (optionally registering as a planner) and pull the ready queue. */
async function queue(opts?: { register?: boolean }): Promise<{
  result: QueueResult;
  handle: string;
}> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  const connected = (await handleTool(gw, "canvas_connect", {
    code: "TESTCODE",
    ...(opts?.register ? { role: "planner", name: "the-planner" } : {}),
  })) as { session: string };
  const result = (await handleFacadeTool(gw, "queue_next", {})) as QueueResult;
  return { result, handle: connected.session };
}

test("every ready task carries a handoff with code, id, ticket, title and steps", async () => {
  await withRecordedFetch(async () => {
    const { result } = await queue({ register: true });

    assert.equal(result.tasks.length, 2);
    for (const t of result.tasks) {
      assert.ok(t.handoff, `${t.id} must carry a handoff`);
    }

    const h = result.tasks[0].handoff;
    // The CODE — 8 chars a human could retype — is what travels, not a handle.
    assert.equal(h.canvasCode, "TESTCODE");
    assert.equal(h.canvasCode.length, 8);
    assert.equal(h.taskId, "task-aaa");
    assert.equal(h.ticketId, "TDM-101");
    assert.equal(h.title, "Wire the thing");
    assert.equal(h.parentAgentId, "planner-77", "workers parent under the planner that dispatched");
    assert.equal(result.tasks[1].handoff.taskId, "task-bbb");
    assert.equal(result.tasks[1].handoff.ticketId, "TDM-102");
  });
});

test("the handoff steps are the literal dispatch sequence, in order", async () => {
  await withRecordedFetch(async () => {
    const { result } = await queue({ register: true });
    const steps: string[] = result.tasks[0].handoff.steps;

    assert.ok(Array.isArray(steps) && steps.length >= 5, "an ordered instruction sequence");
    const seq = steps.join("\n");

    // connect+register as an executor under the planner, in ONE call.
    assert.match(steps[0], /canvas_connect/);
    assert.match(steps[0], /TESTCODE/);
    assert.match(steps[0], /executor/);
    assert.match(steps[0], /parentAgentId "planner-77"/);
    // claim THIS task — with the id inline, so the worker cannot guess wrong.
    assert.match(steps[1], /task_claim/);
    assert.match(steps[1], /task-aaa/);
    // the fallback: losing the claim means take another ready task, not stall.
    assert.match(seq, /claimed:false/);
    assert.match(seq, /queue_next/);
    // work → progress → complete.
    assert.match(seq, /task_get/);
    assert.match(seq, /task_progress/);
    assert.match(seq, /task_complete/);

    // The whole point: nothing in here tells a worker to start with task_start,
    // a tool the facade does not advertise.
    assert.doesNotMatch(seq, /task_start/);

    // Order matters — claim before work, complete last.
    assert.ok(seq.indexOf("task_claim") < seq.indexOf("task_get"));
    assert.ok(seq.indexOf("task_progress") < seq.indexOf("task_complete"));
  });
});

test("the handoff NEVER carries the session handle", async () => {
  await withRecordedFetch(async () => {
    const { result, handle } = await queue({ register: true });
    const serialized = JSON.stringify(result);

    // The handle itself, and the JWT inside it, are both disqualifying.
    assert.ok(handle.length > 100, "the handle really is the fat thing we're excluding");
    assert.equal(serialized.includes(handle), false, "the handle must not travel");
    assert.equal(serialized.includes("jwt-token"), false, "nor the canvas JWT inside it");
    // Nor anything SHAPED like one: every handle is base64url of a JSON object,
    // so it starts "eyJ". This catches a future field that leaks a fresh handle.
    assert.doesNotMatch(serialized, /eyJ[A-Za-z0-9_-]{16,}/, "no base64 handle-shaped blob");

    for (const t of result.tasks) {
      assert.equal("session" in t.handoff, false, "no session field on the handoff");
    }
  });
});

test("an unregistered caller still gets a usable handoff, with the gap named", async () => {
  await withRecordedFetch(async () => {
    const { result } = await queue();
    const h = result.tasks[0].handoff;

    assert.equal(h.parentAgentId, null, "there is no planner id to give");
    assert.equal(h.canvasCode, "TESTCODE", "everything else still works");
    // Spelled out in the steps rather than silently dropped — a handoff with no
    // parent link produces an orphaned worker, which is what the tree exists to
    // make visible.
    assert.match(h.steps[0], /planner/);
    assert.match(result._dispatch ?? "", /not registered/);
  });
});

test("queue_next tells an orchestrator to dispatch, not to claim", async () => {
  await withRecordedFetch(async () => {
    const { result } = await queue({ register: true });
    const dispatch = result._dispatch ?? "";
    assert.match(dispatch, /handoff/);
    assert.match(dispatch, /do not claim these yourself/i);
  });
});

test("an empty queue has no handoffs and says what to do instead", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/mcp/auth") return json(AUTH_RESPONSE);
    if (url.pathname === "/api/canvas/actions") return json({ actions: [] });
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof globalThis.fetch;
  try {
    const { result } = await queue();
    assert.deepEqual(result.tasks, []);
    assert.equal(result._dispatch, undefined);
    assert.match(result._next ?? "", /Nothing approved/);
  } finally {
    globalThis.fetch = real;
  }
});

test("no facade description tells an orchestrator to claim before dispatching", () => {
  const byName = new Map(FACADE_TOOLS.map((t) => [t.name, t]));

  // The copy that produced the bug: an unconditional claim-first imperative on
  // the two tools an orchestrator reads before it fans out.
  const queueNext = byName.get("queue_next")!.description;
  assert.doesNotMatch(queueNext, /task_claim it before you touch anything/i);
  assert.match(queueNext, /handoff/, "it must point at the dispatch payload");
  assert.match(queueNext, /do NOT claim these yourself/);
  assert.match(queueNext, /never passes on its `session` handle/);

  const claim = byName.get("task_claim")!.description;
  assert.match(claim, /YOURSELF/, "claim what you will personally work");
  assert.match(claim, /dispatching subagents, do\s+NOT claim/i);

  // And no facade tool may name a tool the facade doesn't advertise.
  const advertised = new Set(FACADE_TOOLS.map((t) => t.name));
  for (const tool of FACADE_TOOLS) {
    for (const m of tool.description.matchAll(/\b(task|queue|doc|board|epic|context)_[a-z_]+/g)) {
      const named = m[0];
      if (named.startsWith("canvas_")) continue;
      assert.ok(
        advertised.has(named),
        `${tool.name}'s description names "${named}", which is not on the facade`
      );
    }
  }
});
