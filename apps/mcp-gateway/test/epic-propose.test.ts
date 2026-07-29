/**
 * The facade's `epic_propose` — the container a plan hangs off. An agent asked
 * to "write an epic" used to be able to propose tasks but not the epic itself,
 * so the tasks landed unparented and each needed its own approval.
 *
 * What's pinned here is the WIRING, because that's where it can silently break:
 * the epic POST's shape, the id injection onto the batched tasks (one write, not
 * N), and the projected return. The API owns approval cascade and ticketing —
 * nothing here re-implements it.
 *
 * No network: global fetch is replaced with a recorder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway, serializeSession } from "../src/gateway.js";
import { handleFacadeTool } from "../src/facade.js";

type Recorded = { method: string; path: string; body: any };

/** Swap fetch for a recorder answering the epic POST and the task batch POST. */
function withRecordedFetch(
  run: (calls: Recorded[]) => Promise<void>,
  opts?: { failBatch?: boolean }
): Promise<void> {
  const calls: Recorded[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });

    if (url.pathname === "/api/canvas/actions/batch") {
      if (opts?.failBatch) {
        return new Response(JSON.stringify({ error: "nope" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const actions = (body.actions as any[]).map((a, i) => ({
        id: `task-${i + 1}`,
        ticketId: `TDM-${i + 1}`,
        type: "task",
        state: "proposed",
        payload: a.payload,
      }));
      return new Response(JSON.stringify({ actions }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    // POST /api/canvas/actions — the epic itself.
    return new Response(
      JSON.stringify({ id: "epic-1", type: body?.type, state: "proposed", payload: body?.payload }),
      { status: 201, headers: { "content-type": "application/json" } }
    );
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

test("epic_propose posts an epic and projects id + state + url", async () => {
  await withRecordedFetch(async (calls) => {
    const res = (await handleFacadeTool(connectedGateway(), "epic_propose", {
      title: "Dark mode rollout",
      body: "Ship theming end to end",
      linkedIds: ["note-1"],
    })) as Record<string, unknown>;

    assert.equal(calls.length, 1, "no tasks means one write");
    const post = calls[0];
    assert.equal(post.method, "POST");
    assert.equal(post.path, "/api/canvas/actions");
    assert.equal(post.body.type, "epic");
    assert.deepEqual(post.body.payload, {
      title: "Dark mode rollout",
      body: "Ship theming end to end",
      linkedIds: ["note-1"],
    });

    assert.equal(res.created, true);
    assert.equal(res.epicId, "epic-1");
    assert.equal(res.state, "proposed");
    assert.match(String(res.url), /TESTCODE/);
    // Projection, not an echo: the body it just wrote costs context for nothing.
    assert.equal("payload" in res, false);
    assert.equal("tasks" in res, false, "no tasks were asked for");
  });
});

test("epic + tasks is ONE round trip per side, with the new epic's id injected", async () => {
  await withRecordedFetch(async (calls) => {
    const res = (await handleFacadeTool(connectedGateway(), "epic_propose", {
      title: "Dark mode rollout",
      tasks: [
        { title: "Token the palette", body: "CSS vars" },
        // An item's own epicId is overridden — this call's point is the new epic.
        { title: "Convert the chrome", epicId: "some-older-epic", requiresApproval: true },
      ],
    })) as Record<string, unknown>;

    assert.equal(calls.length, 2, "one epic write + one batch write");
    const batch = calls[1];
    assert.equal(batch.path, "/api/canvas/actions/batch");
    assert.deepEqual(
      batch.body.actions.map((a: any) => a.payload.epicId),
      ["epic-1", "epic-1"]
    );
    assert.equal(batch.body.actions[1].payload.requiresApproval, true);
    assert.equal(batch.body.actions[0].payload.assignee, "agent");

    assert.equal(res.epicId, "epic-1");
    assert.deepEqual(res.tasks, [
      { id: "task-1", ticketId: "TDM-1", title: "Token the palette", state: "proposed" },
      { id: "task-2", ticketId: "TDM-2", title: "Convert the chrome", state: "proposed" },
    ]);
  });
});

test("a titleless task is rejected BEFORE the epic is written", async () => {
  await withRecordedFetch(async (calls) => {
    await assert.rejects(
      handleFacadeTool(connectedGateway(), "epic_propose", {
        title: "Dark mode rollout",
        tasks: [{ title: "Fine" }, { body: "no title" }],
      }),
      /tasks\[1\]/
    );
    // Otherwise the board would keep an empty epic from a failed call.
    assert.equal(calls.length, 0, "nothing may be written on a bad plan");
  });
});

test("epic_propose requires a title", async () => {
  await withRecordedFetch(async (calls) => {
    await assert.rejects(
      handleFacadeTool(connectedGateway(), "epic_propose", { body: "orphan" }),
      /title/
    );
    assert.equal(calls.length, 0);
  });
});

test("the manifest teaches the human-only approval rule", async () => {
  const { FACADE_TOOLS } = await import("../src/server.js");
  const tool = FACADE_TOOLS.find((t) => t.name === "epic_propose")!;
  assert.ok(tool, "epic_propose must be advertised by default");
  // Descriptions are the only docs an agent gets — the gate has to be in there,
  // or a session will try canvas_action_approve and be refused.
  assert.match(tool.description, /human/i);
  assert.match(tool.description, /proposed/);
  const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
  assert.equal(props.title?.type, "string");
  assert.equal(props.tasks?.type, "array");
  assert.ok(props.session, "epic_propose must take the session handle");
});

test("task_propose advertises epicId on both the single and the batch shape", async () => {
  const { FACADE_TOOLS } = await import("../src/server.js");
  const tool = FACADE_TOOLS.find((t) => t.name === "task_propose")!;
  const props = (tool.inputSchema.properties ?? {}) as Record<string, any>;
  assert.equal(props.epicId?.type, "string");
  assert.match(props.epicId.description, /epic_propose/);
  assert.equal(props.tasks.items.properties.epicId?.type, "string");
  assert.ok(props.tasks.items.properties.epicId.description, "batch items must document epicId too");
});
