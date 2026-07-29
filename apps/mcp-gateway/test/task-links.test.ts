/**
 * TDM-45 — completion evidence. `task_complete` (and the CRUD tool it delegates
 * to) carries `links`: the GitHub URLs the work produced, which the board
 * resolves into a live status.
 *
 * What's pinned here is the PASS-THROUGH, because that's where it can silently
 * break: the gateway builds the terminal PATCH body by hand, so a link the
 * model supplied is only evidence if it survives into that body. The API owns
 * the merge (append, dedupe, cap) — nothing here re-implements it.
 *
 * No network: global fetch is replaced with a recorder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway, serializeSession } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool } from "../src/facade.js";

type Recorded = { method: string; path: string; body: unknown };

/** Swap fetch for a recorder that answers the two calls a completion makes. */
function withRecordedFetch(run: (calls: Recorded[]) => Promise<void>): Promise<void> {
  const calls: Recorded[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    // GET /api/canvas/actions/{id} — the pre-flight read task_complete does to
    // decide whether it must auto-claim first.
    const payload =
      method === "GET"
        ? { action: { state: "executing", claimedBy: "tester", payload: { title: "t" } } }
        : { action: { id: "task-1", state: "done" } };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
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

const terminalPatch = (calls: Recorded[]) =>
  calls.find((c) => c.method === "PATCH" && (c.body as { state?: string })?.state === "done");

test("canvas_task_complete sends links on the terminal PATCH", async () => {
  await withRecordedFetch(async (calls) => {
    await handleTool(connectedGateway(), "canvas_task_complete", {
      id: "task-1",
      result: "merged as #12",
      links: [
        "https://github.com/o/r/pull/12",
        "https://github.com/o/r/commit/b7f1a2c",
      ],
    });
    const patch = terminalPatch(calls);
    assert.ok(patch, "no terminal PATCH was sent");
    const body = patch!.body as { links?: string[]; result?: string; agentName?: string };
    assert.deepEqual(body.links, [
      "https://github.com/o/r/pull/12",
      "https://github.com/o/r/commit/b7f1a2c",
    ]);
    // Evidence rides WITH the completion — one write, not a follow-up call.
    assert.equal(body.result, "merged as #12");
    assert.equal(body.agentName, "tester");
    assert.equal(
      calls.filter((c) => c.method === "PATCH").length,
      1,
      "links must not cost an extra round trip"
    );
  });
});

test("the intent facade's task_complete carries links through too", async () => {
  await withRecordedFetch(async (calls) => {
    await handleFacadeTool(connectedGateway(), "task_complete", {
      id: "task-1",
      result: "shipped",
      links: ["https://github.com/o/r/pull/13"],
    });
    const body = terminalPatch(calls)!.body as { links?: string[] };
    assert.deepEqual(body.links, ["https://github.com/o/r/pull/13"]);
  });
});

test("no links, no field — an ordinary completion body is unchanged", async () => {
  await withRecordedFetch(async (calls) => {
    await handleTool(connectedGateway(), "canvas_task_complete", {
      id: "task-1",
      result: "done",
    });
    const body = terminalPatch(calls)!.body as Record<string, unknown>;
    assert.equal("links" in body, false);
  });
});

test("junk in links is dropped rather than sent", async () => {
  await withRecordedFetch(async (calls) => {
    await handleTool(connectedGateway(), "canvas_task_complete", {
      id: "task-1",
      result: "done",
      // A model that fills the array with blanks (or the wrong type) must not
      // turn a good completion into a 400 from the API's validator.
      links: ["", "   ", 42, null, "https://github.com/o/r/pull/1"],
    });
    const body = terminalPatch(calls)!.body as { links?: string[] };
    assert.deepEqual(body.links, ["https://github.com/o/r/pull/1"]);
  });
});

test("links is advertised on both surfaces, and described as evidence", async () => {
  const { TOOLS } = await import("../src/tools.js");
  const { FACADE_TOOLS } = await import("../src/server.js");
  for (const tool of [
    TOOLS.find((t) => t.name === "canvas_task_complete")!,
    FACADE_TOOLS.find((t) => t.name === "task_complete")!,
  ]) {
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
    assert.equal(props.links?.type, "array", `${tool.name} must accept links`);
  }
  // The pitch has to be in the description or no model will send them.
  assert.match(
    FACADE_TOOLS.find((t) => t.name === "task_complete")!.description,
    /links/,
    "task_complete must tell the model to attach evidence"
  );
});
