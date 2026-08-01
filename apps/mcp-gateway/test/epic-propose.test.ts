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
  opts?: { failBatch?: boolean; taskState?: string }
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
        state: opts?.taskState ?? "proposed",
        payload: a.payload,
      }));
      return new Response(JSON.stringify({ actions }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    // POST /api/canvas/actions — the epic itself, or a single task_propose.
    const isTask = body?.type === "task";
    return new Response(
      JSON.stringify({
        id: isTask ? "task-1" : "epic-1",
        ...(isTask ? { ticketId: "TDM-7" } : {}),
        type: body?.type,
        state: isTask ? opts?.taskState ?? "proposed" : "proposed",
        payload: body?.payload,
      }),
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

    // WRITES, not requests: the answer also probes the canvas's approval policy
    // (TDM-146) to know whether one approval still cascades to the batch, and that
    // read runs alongside the write. What must not grow is the write count.
    const writes = calls.filter((c) => c.method === "POST");
    assert.equal(writes.length, 1, "no tasks means one write");
    const post = writes[0];
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
      // Real bodies, because the ticket-quality contract (TDM-159) hard-fails a
      // bodyless ticket before anything is written — a fixture without them
      // never reaches the round-trip assertion this test exists for.
      tasks: [
        {
          title: "Token the palette",
          body: "Replace the hard-coded hexes in apps/web/src/index.css with paper/surface/ink CSS variables. Done when pnpm build passes and no component reads a raw hex.",
        },
        // An item's own epicId is overridden — this call's point is the new epic.
        {
          title: "Convert the chrome",
          body: "Point the header and sidebar in apps/web/src/components at the new tokens instead of Tailwind literals. Done when both render unchanged in light mode.",
          epicId: "some-older-epic",
          requiresApproval: true,
        },
      ],
    })) as Record<string, unknown>;

    const writes = calls.filter((c) => c.method === "POST");
    assert.equal(writes.length, 2, "one epic write + one batch write");
    const batch = writes[1];
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

// ── The approval ask (TDM-186) ───────────────────────────────────────────────
//
// Proposing then parking on queue_wait without ever telling the human deadlocks
// both sides. What's pinned here is that the answer carries the sentence to
// relay, that `_next` puts relaying BEFORE waiting, and that it stays quiet when
// nothing is actually waiting on a human.

test("epic_propose hands back a paste-ready tellHuman: title, ticket range, board URL", async () => {
  await withRecordedFetch(async () => {
    const res = (await handleFacadeTool(connectedGateway(), "epic_propose", {
      title: "Dark mode rollout",
      tasks: [
        {
          title: "Token the palette",
          body: "Replace the hard-coded hexes in apps/web/src/index.css with paper/surface/ink CSS variables. Done when pnpm build passes and no component reads a raw hex.",
        },
        {
          title: "Convert the chrome",
          body: "Point the header and sidebar in apps/web/src/components at the new tokens instead of Tailwind literals. Done when both render unchanged in light mode.",
        },
      ],
    })) as Record<string, unknown>;

    const tell = String(res.tellHuman);
    assert.match(tell, /Dark mode rollout/, "names the epic");
    assert.match(tell, /2 tasks/, "says how much work it is");
    assert.match(tell, /TDM-1\.\.TDM-2/, "carries the ticket range");
    assert.match(tell, /TESTCODE/, "carries the board URL to click");
    assert.match(tell, /waiting for YOUR approval/);

    // Ask FIRST, wait second — the whole point of the ticket.
    const next = String(res._next);
    assert.match(next.slice(0, 120), /tellHuman/, "_next must LEAD with the relay instruction");
    assert.ok(
      next.indexOf("tellHuman") < next.indexOf("queue_wait"),
      "relaying comes before waiting, not after"
    );
  });
});

test("task_propose answers with the same ask — one task and a batch", async () => {
  await withRecordedFetch(async () => {
    const one = (await handleFacadeTool(connectedGateway(), "task_propose", {
      title: "Fix the bell overlap",
      body: "The notification bell overlaps the code chip in apps/web/src/components/Header.tsx.",
    })) as Record<string, unknown>;
    // The ids it already returned are untouched; the ask rides alongside them.
    assert.equal(one.id, "task-1");
    assert.match(String(one.tellHuman), /Fix the bell overlap/);
    assert.match(String(one.tellHuman), /TDM-7/);
    assert.match(String(one.tellHuman), /TESTCODE/);
    assert.ok(String(one._next).indexOf("tellHuman") < String(one._next).indexOf("queue_wait"));

    const batch = (await handleFacadeTool(connectedGateway(), "task_propose", {
      tasks: [{ title: "One" }, { title: "Two" }],
    })) as Record<string, unknown>;
    assert.equal((batch.actions as unknown[]).length, 2);
    assert.match(String(batch.tellHuman), /2 proposed tasks/);
    assert.match(String(batch.tellHuman), /TDM-1\.\.TDM-2/);
    assert.match(String(batch.tellHuman), /are waiting/, "plural subject takes a plural verb");
  });
});

test("no ask when nothing is waiting: born-approved tasks are not the human's problem", async () => {
  await withRecordedFetch(
    async () => {
      const res = (await handleFacadeTool(connectedGateway(), "task_propose", {
        tasks: [{ title: "One" }, { title: "Two" }],
      })) as Record<string, unknown>;
      // 'auto' policy / approved epic: the board already approved these, so
      // asking the human to go approve them teaches them the line is noise.
      assert.equal("tellHuman" in res, false);
      assert.match(String(res._next), /queue_next/);
      assert.doesNotMatch(String(res._next), /tellHuman/);
    },
    { taskState: "approved" }
  );
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
