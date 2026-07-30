/**
 * TDM-116 — task_propose's batch branch must forward the call-level defaults.
 *
 * It used to forward ONLY `tasks`, silently dropping a top-level epicId (and
 * assignee / requiresApproval), so a whole plan proposed under an epic landed
 * unparented while the response still said "created". Every item must now carry
 * the call-level defaults, with an item's own field winning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool } from "../src/facade.js";

const CODE = "TESTCODE";

/** Capture the batch POST body so we can assert on each item's payload. */
function install() {
  const batchBodies: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/api/mcp/auth") {
      return json({ token: "t", canvasId: "canvas-1", canvasName: "C", canvasCode: CODE });
    }
    if (url.pathname === "/api/canvas/actions/batch" && method === "POST") {
      batchBodies.push(body);
      return json({
        actions: (body.actions ?? []).map((a: any, i: number) => ({
          id: `t-${i}`,
          ticketId: `TDM-${100 + i}`,
          state: "proposed",
          payload: a.payload,
        })),
      });
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return { batchBodies, restore: () => (globalThis.fetch = real) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function connect(): Promise<Gateway> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", { code: CODE, role: "planner", name: "planner-1" });
  return gw;
}

test("a call-level epicId is applied to every task in the batch", async () => {
  const { batchBodies, restore } = install();
  try {
    const gw = await connect();
    await handleFacadeTool(gw, "task_propose", {
      epicId: "epic-15",
      requiresApproval: true,
      tasks: [{ title: "one" }, { title: "two" }, { title: "three" }],
    });
    assert.equal(batchBodies.length, 1, "one batch write");
    const payloads = batchBodies[0].actions.map((a: any) => a.payload);
    assert.equal(payloads.length, 3);
    for (const p of payloads) {
      assert.equal(p.epicId, "epic-15", "every task is parented to the call-level epic");
      assert.equal(p.requiresApproval, true, "call-level requiresApproval rides along too");
    }
  } finally {
    restore();
  }
});

test("an item's own epicId wins over the call-level default", async () => {
  const { batchBodies, restore } = install();
  try {
    const gw = await connect();
    await handleFacadeTool(gw, "task_propose", {
      epicId: "epic-default",
      tasks: [{ title: "inherits" }, { title: "overrides", epicId: "epic-own" }],
    });
    const payloads = batchBodies[0].actions.map((a: any) => a.payload);
    assert.equal(payloads[0].epicId, "epic-default");
    assert.equal(payloads[1].epicId, "epic-own", "item-level epicId must win");
  } finally {
    restore();
  }
});

test("task_propose batch rejects an item missing a title before any write", async () => {
  const { batchBodies, restore } = install();
  try {
    const gw = await connect();
    await assert.rejects(
      () =>
        handleFacadeTool(gw, "task_propose", {
          epicId: "epic-15",
          tasks: [{ title: "ok" }, { body: "no title" }],
        }) as Promise<unknown>,
      /tasks\[1\] needs a `title`/
    );
    assert.equal(batchBodies.length, 0, "a bad plan never reaches the API");
  } finally {
    restore();
  }
});
