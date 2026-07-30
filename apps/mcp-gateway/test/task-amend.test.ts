/**
 * TDM-117 — an agent can correct its OWN proposal, but only within the fence.
 *
 * task_amend edits or withdraws a task, guarded three ways against the server's
 * view: it must be `proposed`, unclaimed, and authored by the caller. Approved or
 * in-flight work is off-limits — that stays the human's / the claimant's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool } from "../src/facade.js";

const CODE = "TESTCODE";

type StoredAction = {
  state?: string;
  claimedBy?: string;
  authoredBy?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

/** Answer the GET the tool reads with `action`, and record PATCH/DELETE. */
function install(action: StoredAction) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/api/mcp/auth") {
      return json({ token: "t", canvasId: "canvas-1", canvasName: "C", canvasCode: CODE });
    }
    if (url.pathname === "/api/canvas/agents" && method === "POST") {
      // Registration, so claimant() resolves to the given name (authoredBy match).
      return json({ agentId: "agent-1", name: body?.name }, 201);
    }
    if (url.pathname.startsWith("/api/canvas/actions/")) {
      if (method === "GET") return json({ action: { type: "task", ...action } });
      calls.push({ method, path: url.pathname, body });
      return json({ action: { ...action, payload: body?.payload ?? action.payload } });
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function connect(name = "worker-a"): Promise<Gateway> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", { code: CODE, role: "planner", name });
  return gw;
}

const OWNED_PROPOSED: StoredAction = {
  state: "proposed",
  authoredBy: "agent:worker-a",
  payload: { title: "old title", assignee: "agent", epicId: "epic-1" },
};

test("the author re-parents its own proposed task", async () => {
  const { calls, restore } = install(OWNED_PROPOSED);
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_amend", {
      id: "TDM-1",
      epicId: "epic-2",
      title: "new title",
    })) as any;
    assert.equal(out.amended, true);
    const patch = calls.find((c) => c.method === "PATCH");
    assert.ok(patch, "an amend PATCHes the payload");
    assert.equal(patch!.body.payload.epicId, "epic-2", "re-parented");
    assert.equal(patch!.body.payload.title, "new title", "title changed");
    assert.equal(patch!.body.payload.assignee, "agent", "unchanged fields carried forward");
  } finally {
    restore();
  }
});

test("withdraw deletes the proposal", async () => {
  const { calls, restore } = install(OWNED_PROPOSED);
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_amend", {
      id: "TDM-1",
      withdraw: true,
    })) as any;
    assert.equal(out.withdrawn, true);
    assert.ok(
      calls.some((c) => c.method === "DELETE"),
      "withdraw issues a DELETE"
    );
    assert.ok(!calls.some((c) => c.method === "PATCH"), "and does not also edit");
  } finally {
    restore();
  }
});

test("cannot amend an APPROVED task", async () => {
  const { calls, restore } = install({ ...OWNED_PROPOSED, state: "approved" });
  try {
    const gw = await connect();
    await assert.rejects(
      () => handleFacadeTool(gw, "task_amend", { id: "TDM-1", title: "x" }) as Promise<unknown>,
      /is "approved", not "proposed"/
    );
    assert.equal(calls.length, 0, "no write on a refused amend");
  } finally {
    restore();
  }
});

test("cannot amend a task another agent authored", async () => {
  const { calls, restore } = install({ ...OWNED_PROPOSED, authoredBy: "agent:worker-b" });
  try {
    const gw = await connect("worker-a");
    await assert.rejects(
      () => handleFacadeTool(gw, "task_amend", { id: "TDM-1", title: "x" }) as Promise<unknown>,
      /did not propose this task/
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("cannot amend a task a worker holds", async () => {
  const { calls, restore } = install({ ...OWNED_PROPOSED, claimedBy: "worker-b" });
  try {
    const gw = await connect("worker-a");
    await assert.rejects(
      () => handleFacadeTool(gw, "task_amend", { id: "TDM-1", title: "x" }) as Promise<unknown>,
      /held by "worker-b"/
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("an amend with no fields and no withdraw is rejected before any request", async () => {
  const { calls, restore } = install(OWNED_PROPOSED);
  try {
    const gw = await connect();
    await assert.rejects(
      () => handleFacadeTool(gw, "task_amend", { id: "TDM-1" }) as Promise<unknown>,
      /Nothing to amend/
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});
