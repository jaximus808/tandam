/**
 * TDM-67 / E9.6 — task_progress is a HEARTBEAT, not a payload edit.
 *
 * It used to record progress with the payload-only PATCH
 * (/api/canvas/actions/{id}), a client-side read-modify-write that carried no
 * caller identity. Two consequences, both fatal for a long-running worker:
 * the server could not tell whose report it was (so the "is this mine?" check
 * was advisory, done in this process), and nothing refreshed claimed_at — so a
 * worker heartbeating through an hour of real work still had its ~15-minute
 * claim expire and its task reclaimed underneath it.
 *
 * What's pinned here: the request now goes to the inbound status endpoint —
 * POST /api/canvas/{code}/tasks/{id}/status with {state:"progress", agent, summary}
 * — the payload PATCH is never touched, a non-holder's 409 comes back as DATA
 * rather than a throw, and the fresh claimedAt (the lease extension itself) is
 * reflected on the result.
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

const TASK_ID = "11111111-2222-3333-4444-555555555555";
const FRESH_CLAIMED_AT = "2026-07-29T12:34:56Z";

type Recorded = { method: string; path: string; body: any; headers: Record<string, string> };

/** Reply the status endpoint gives; anything else is a test failure. */
type StatusReply = { status: number; body: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Runs `run` with fetch recording every call. `reply` decides what the status
 * endpoint answers; every OTHER /api path throws, which is how "it must not
 * fall back to the payload PATCH" is enforced rather than merely asserted.
 */
function withFetch(
  reply: StatusReply,
  run: (calls: Recorded[]) => Promise<void>
): Promise<void> {
  const real = globalThis.fetch;
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (url.pathname === "/api/mcp/auth") return json(AUTH_RESPONSE);
    if (url.pathname === "/api/canvas/agents") return json({ agentId: "worker-77" }, 201);
    if (url.pathname === `/api/canvas/TESTCODE/tasks/${TASK_ID}/status`) {
      return json(reply.body, reply.status);
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return run(calls).finally(() => {
    globalThis.fetch = real;
  });
}

/** Connect as a named agent, then report progress. */
async function report(args: Record<string, unknown>): Promise<any> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", {
    code: "TESTCODE",
    role: "executor",
    name: "worker-one",
  });
  return handleFacadeTool(gw, "task_progress", args);
}

/** The status endpoint's success shape: the whole action, payload merged. */
function okAction(over: Record<string, unknown> = {}) {
  return {
    action: {
      id: TASK_ID,
      kind: "action",
      type: "task",
      state: "executing",
      claimedBy: "worker-one",
      claimedAt: FRESH_CLAIMED_AT,
      payload: {
        title: "Wire the thing",
        progress: [
          { at: "2026-07-29T12:00:00Z", agent: "worker-one", note: "started" },
          { at: FRESH_CLAIMED_AT, agent: "worker-one", note: "halfway" },
        ],
      },
      ...over,
    },
  };
}

test("progress goes to the status endpoint, not the payload PATCH", async () => {
  await withFetch({ status: 200, body: okAction() }, async (calls) => {
    // canvas_connect registers the agent, so filter to what task_progress did.
    const before = 0;
    await report({ id: TASK_ID, note: "halfway" });
    const after = calls.slice(before).filter((c) => c.path.includes("/tasks/"));

    assert.equal(after.length, 1, "exactly one call for one heartbeat");
    const call = after[0];
    assert.equal(call.method, "POST");
    assert.equal(call.path, `/api/canvas/TESTCODE/tasks/${TASK_ID}/status`);
    assert.equal(call.body.state, "progress");
    assert.equal(call.body.summary, "halfway");

    // The old shape must be gone: no read of the action, no payload PATCH.
    for (const c of calls) {
      assert.notEqual(c.path, `/api/canvas/actions/${TASK_ID}`, "no payload read-modify-write");
      assert.notEqual(c.method, "PATCH", "no PATCH at all on this path");
    }
  });
});

test("the report carries the caller's claimant identity as `agent`", async () => {
  await withFetch({ status: 200, body: okAction() }, async (calls) => {
    await report({ id: TASK_ID, note: "halfway" });
    const call = calls.find((c) => c.path.includes("/tasks/"))!;
    // This is the whole fix: the server can only guard (and only extend the
    // lease) for an identified holder.
    assert.equal(call.body.agent, "worker-one");
  });
});

test("an explicit agentName overrides the session identity", async () => {
  await withFetch({ status: 200, body: okAction({ claimedBy: "ci-github" }) }, async (calls) => {
    const out = await report({ id: TASK_ID, note: "tests green", agentName: "ci-github" });
    const call = calls.find((c) => c.path.includes("/tasks/"))!;
    assert.equal(call.body.agent, "ci-github");
    assert.equal(out.by, "ci-github");
  });
});

test("holder success reflects the fresh claimedAt — the lease extension itself", async () => {
  await withFetch({ status: 200, body: okAction() }, async () => {
    const out = await report({ id: TASK_ID, note: "halfway" });

    assert.equal(out.recorded, true);
    assert.equal(out.id, TASK_ID);
    assert.equal(out.by, "worker-one");
    // Entry count now comes from what the SERVER stored, not what we guessed.
    assert.equal(out.entries, 2);
    assert.equal(out.claimedAt, FRESH_CLAIMED_AT, "the refreshed lease clock");
    assert.equal(out.leaseExtended, true);
    assert.match(out.note, /extends your claim/i);
  });
});

test("lease extension is claimed only when the caller IS the exclusive holder", async () => {
  // The server refreshes claimed_at holder-only (its predicate is claimed_by =
  // agent), so a report accepted against a non-exclusive holder ("agent") moved
  // nothing — saying otherwise would be a comfortable lie to a live worker.
  await withFetch({ status: 200, body: okAction({ claimedBy: "agent" }) }, async () => {
    const out = await report({ id: TASK_ID, note: "halfway" });
    assert.equal(out.recorded, true, "the note still landed");
    assert.equal(out.leaseExtended, false);
  });
});

test("percent rides along in the note rather than being dropped", async () => {
  await withFetch({ status: 200, body: okAction() }, async (calls) => {
    const out = await report({ id: TASK_ID, note: "halfway", percent: 50 });
    const call = calls.find((c) => c.path.includes("/tasks/"))!;
    // The wire entry is {at, agent, note} — there is no percent field — so it is
    // folded into the line the human reads on the board.
    assert.equal(call.body.summary, "halfway (50%)");
    assert.equal(out.percent, 50);
  });
});

test("a non-holder's report comes back as DATA, not a thrown error", async () => {
  const conflict = {
    error: "claimed_by_other",
    message: "this task is claimed by another fleet member — it is not yours to report on",
    claimedBy: "worker-two",
  };
  await withFetch({ status: 409, body: conflict }, async () => {
    const out = await report({ id: TASK_ID, note: "meddling" });

    assert.equal(out.recorded, false, "nothing was recorded");
    assert.equal(out.claimedBy, "worker-two", "the rival is named so the model can route");
    assert.equal(out.reason, "claimed_by_other");
    assert.match(out.message, /worker-two/);
    assert.match(out.message, /queue_next/, "and told what to do instead");
  });
});

test("reporting on a task that is not executing is data too, with the state", async () => {
  const conflict = {
    error: "not_executing",
    message: 'claim the task first: POST this endpoint with {"state":"started"}',
    state: "approved",
  };
  await withFetch({ status: 409, body: conflict }, async () => {
    const out = await report({ id: TASK_ID, note: "jumping the gun" });

    assert.equal(out.recorded, false);
    assert.equal(out.reason, "not_executing");
    assert.equal(out.state, "approved");
    // The endpoint's own remedy is curl-shaped; the MCP caller gets the MCP one.
    assert.match(out.message, /task_claim/);
  });
});

test("bad input is rejected before any request is made", async () => {
  await withFetch({ status: 200, body: okAction() }, async (calls) => {
    await assert.rejects(() => report({ note: "no id" }), /`id`/);
    await assert.rejects(() => report({ id: TASK_ID, note: "   " }), /`note`/);
    assert.equal(
      calls.filter((c) => c.path.includes("/tasks/")).length,
      0,
      "neither reached the API"
    );
  });
});
