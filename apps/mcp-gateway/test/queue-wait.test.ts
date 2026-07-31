/**
 * TDM-149 — `queue_wait`: the call an agent makes INSTEAD of ending its turn.
 *
 * THE FAILURE THIS TOOL EXISTS FOR. An MCP agent has no sleep and no blocking
 * call, so "poll queue_next on a backing-off interval" is an instruction it
 * cannot follow: it ends its turn, and a human has to prompt it a second time to
 * notice an approval that already landed. That happened on this project on
 * 2026-07-31. The waiting moved to the server (TDM-148); this is the one call
 * that reaches it.
 *
 * Which makes the WORDING part of the contract, not decoration, and it is pinned
 * here alongside the plumbing:
 *   - "timeout" must never read as a failure, and must say call again;
 *   - "ready" must come back dispatch-ready, with the same handoffs queue_next
 *     attaches, so there is nothing left to compose;
 *   - the CLIENT deadline must outlast the SERVER's wait, or the tool breaks
 *     precisely when it is working;
 *   - an API older than the gateway, or a canvas at its waiter cap, degrades to
 *     the plain queue read instead of throwing at an agent that only wanted to
 *     wait.
 *
 * No network: global fetch is replaced with a recorder. The long poll itself is
 * server-side, so what is exercised here is the GATEWAY layer — the request it
 * builds, the deadline it sets, and the four answers it renders. Nothing here
 * proves a live wait against a running API; that is Jaxon's runtime QA.
 */
import { test, mock } from "node:test";
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

/** Raw actions, exactly as GET /api/canvas/actions (and the wait) return them. */
const READY_ACTIONS = [
  {
    id: "task-aaa",
    state: "approved",
    ticketId: "TDM-201",
    proposedBy: "agent",
    createdAt: "2026-07-31T00:00:00Z",
    payload: { title: "Wire the wait", assignee: "agent" },
  },
  {
    id: "task-bbb",
    state: "approved",
    ticketId: "TDM-202",
    proposedBy: "agent",
    createdAt: "2026-07-31T00:00:00Z",
    payload: { title: "Word the timeout", assignee: "agent" },
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Recorded = { url: URL; init?: RequestInit };

type Routes = {
  /** Answer for GET /api/canvas/queue/wait. */
  wait?: (url: URL) => Response;
  /** Answer for GET /api/canvas/actions (the plain queue read / fallback). */
  actions?: (url: URL) => Response;
};

/** Install a fetch recorder for the duration of `run`. */
async function withFetch<T>(routes: Routes, run: (calls: Recorded[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/api/mcp/auth") return json(AUTH_RESPONSE);
    if (url.pathname === "/api/canvas/agents") return json({ agentId: "planner-77" }, 201);
    if (url.pathname === "/api/canvas/state") return json({ canvas: {} });
    if (url.pathname === "/api/canvas/queue/wait") {
      if (!routes.wait) throw new Error("unexpected wait call");
      return routes.wait(url);
    }
    if (url.pathname === "/api/canvas/actions") {
      return routes.actions ? routes.actions(url) : json({ actions: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof globalThis.fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = real;
  }
}

type WaitResult = {
  status: string;
  tasks: Array<Record<string, any>>;
  count: number;
  waited?: boolean;
  waitedMs?: number;
  timeoutSeconds?: number;
  truncated?: number;
  lostByYou?: unknown[];
  _lostByYou?: string;
  _dispatch?: string;
  _next?: string;
};

/** Connect as a registered planner, then wait. */
async function wait(args: Record<string, unknown> = {}): Promise<WaitResult> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", {
    code: "TESTCODE",
    role: "planner",
    name: "the-planner",
  });
  return (await handleFacadeTool(gw, "queue_wait", args)) as WaitResult;
}

const readyBody = (actions: unknown[] = READY_ACTIONS, waitedMs = 4200) => ({
  type: "queue.wait",
  status: "ready",
  actions,
  count: actions.length,
  waitedMs,
  timeoutSeconds: 25,
  _hint: "Approved work is ready.",
});

const timeoutBody = (timeoutSeconds = 25) => ({
  type: "queue.wait",
  status: "timeout",
  actions: [],
  count: 0,
  waitedMs: timeoutSeconds * 1000,
  timeoutSeconds,
  _hint: "Nothing approved within the wait window.",
});

// ── status: ready ────────────────────────────────────────────────────────────

test("ready comes back DISPATCH-READY: the same rows queue_next gives, with handoffs", async () => {
  await withFetch({ wait: () => json(readyBody()) }, async () => {
    const result = await wait();

    assert.equal(result.status, "ready");
    assert.equal(result.count, 2);
    assert.equal(result.waited, true);
    assert.equal(result.waitedMs, 4200);

    // The projection is canvas_task_list's, not a second one invented here.
    assert.deepEqual(
      result.tasks.map((t) => [t.id, t.ticketId, t.title, t.state, t.assignee]),
      [
        ["task-aaa", "TDM-201", "Wire the wait", "approved", "agent"],
        ["task-bbb", "TDM-202", "Word the timeout", "approved", "agent"],
      ]
    );

    // …and the handoff is the same block queue_next attaches: the CODE travels,
    // the session handle never does.
    for (const t of result.tasks) {
      assert.ok(t.handoff, `${t.id} must carry a handoff`);
      assert.equal(t.handoff.canvasCode, "TESTCODE");
      assert.equal(t.handoff.parentAgentId, "planner-77");
      assert.equal("session" in t.handoff, false);
    }
    assert.equal(result.tasks[0].handoff.taskId, "task-aaa");
    assert.match(result.tasks[0].handoff.steps[1], /task_claim/);

    assert.match(result._dispatch ?? "", /do not claim these yourself/i);
    assert.match(result._next ?? "", /ready NOW/i);
    // Nothing may tell the caller to go back to waiting while work sits unclaimed.
    assert.match(result._next ?? "", /Do not wait again/i);
  });
});

test("the handoffs a wait hands back never carry the session handle or the JWT", async () => {
  await withFetch({ wait: () => json(readyBody()) }, async () => {
    const serialized = JSON.stringify(await wait());
    assert.equal(serialized.includes("jwt-token"), false);
    assert.doesNotMatch(serialized, /eyJ[A-Za-z0-9_-]{16,}/, "no handle-shaped blob");
  });
});

test("the request asks the SERVER to wait, on the agent queue, for the epic asked about", async () => {
  await withFetch({ wait: () => json(readyBody([])) }, async (calls) => {
    await wait({ timeoutSeconds: 45, epicId: "epic-9" });
    const waitCall = calls.find((c) => c.url.pathname === "/api/canvas/queue/wait")!;
    assert.ok(waitCall, "it must go to the long-poll endpoint, not the plain list");
    assert.equal(waitCall.url.searchParams.get("timeout"), "45");
    // An agent waits on the AGENT queue: a human's todo must never wake a worker.
    assert.equal(waitCall.url.searchParams.get("assignee"), "agent");
    assert.equal(waitCall.url.searchParams.get("epicId"), "epic-9");
  });
});

test("a nonsense or out-of-range timeout is clamped here, not spent on a 400", async () => {
  const asked: string[] = [];
  await withFetch(
    {
      wait: (url) => {
        asked.push(url.searchParams.get("timeout") ?? "");
        return json(timeoutBody());
      },
    },
    async () => {
      for (const t of [undefined, "soon", 0, -5, 3600, 12.4]) {
        await wait(t === undefined ? {} : { timeoutSeconds: t });
      }
    }
  );
  // default, default, default, default, max, rounded
  assert.deepEqual(asked, ["25", "25", "25", "25", "60", "12"]);
});

test("epic state is hydrated on a waited-for task, exactly as on a read one", async () => {
  const withEpic = [{ ...READY_ACTIONS[0], payload: { ...READY_ACTIONS[0].payload, epicId: "epic-9" } }];
  await withFetch(
    {
      wait: () => json(readyBody(withEpic)),
      actions: (url) =>
        url.searchParams.get("type") === "epic"
          ? json({ actions: [{ id: "epic-9", state: "approved" }] })
          : json({ actions: [] }),
    },
    async () => {
      const result = await wait();
      assert.equal(result.tasks[0].epicId, "epic-9");
      assert.equal(result.tasks[0].epicState, "approved");
    }
  );
});

// ── status: timeout — the answer that must not read like a failure ───────────

test("timeout is a NON-ERROR that says, in words, to call again", async () => {
  await withFetch({ wait: () => json(timeoutBody()) }, async () => {
    const result = await wait();

    assert.equal(result.status, "timeout");
    assert.deepEqual(result.tasks, []);
    assert.equal(result.count, 0);
    assert.equal(result.waited, true);
    assert.equal(result.timeoutSeconds, 25);

    const next = result._next ?? "";
    // The whole point: if a timeout reads like a failure, agents stop calling it.
    assert.match(next, /NOT an error/i);
    assert.match(next, /not a failure/i);
    // And the instruction has to be unmistakable: call THIS tool again, now.
    assert.match(next, /queue_wait/);
    assert.match(next, /again/i);
    assert.match(next, /DO NOT end your turn/i);
    // No dispatch instruction on an empty answer — there is nothing to dispatch.
    assert.equal(result._dispatch, undefined);
  });
});

test("an unrecognized status is treated as 'nothing yet', never as work", async () => {
  // Defensive: a future/garbled status must not be rendered as ready with no tasks.
  await withFetch({ wait: () => json({ type: "queue.wait", status: "???" }) }, async () => {
    const result = await wait();
    assert.equal(result.status, "timeout");
    assert.deepEqual(result.tasks, []);
  });
});

// ── the deadline that makes the whole thing work ─────────────────────────────

test("the CLIENT deadline outlasts the SERVER's wait (the tool must not abort itself)", async (t) => {
  // The bug this pins: the shared per-request budget is 15s and a wait may run
  // 60s, so an un-overridden deadline aborts the call precisely when it is doing
  // its job. Fake timers let us watch the abort that must not happen.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const real = globalThis.fetch;
  let waitSignal: AbortSignal | undefined;
  let plainSignal: AbortSignal | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/mcp/auth") return json(AUTH_RESPONSE);
    if (url.pathname === "/api/canvas/queue/wait") {
      waitSignal = init?.signal ?? undefined;
    } else {
      plainSignal = init?.signal ?? undefined;
    }
    return new Promise<Response>(() => {}); // never settles: we only want the signal
  }) as typeof globalThis.fetch;

  try {
    const gw = new Gateway({ apiUrl: "http://api.test" });
    await handleTool(gw, "canvas_connect", { code: "TESTCODE" });

    // A 60s wait — the server's own maximum.
    void handleFacadeTool(gw, "queue_wait", { timeoutSeconds: 60 }).catch(() => {});
    void gw.get("/api/canvas/actions?type=task").catch(() => {});
    await Promise.resolve();

    assert.ok(waitSignal, "the wait request was made");
    assert.ok(plainSignal, "a plain read was made alongside it");

    // 15s: the default budget. The plain read is done for; the wait is untouched.
    t.mock.timers.tick(15_000);
    assert.equal(plainSignal!.aborted, true, "a normal request still uses the shared budget");
    assert.equal(waitSignal!.aborted, false, "a wait must survive the default 15s budget");

    // 60s: the server is answering right about now. Still no client abort.
    t.mock.timers.tick(45_000);
    assert.equal(waitSignal!.aborted, false, "the server's answer must beat the client deadline");

    // And it is still BOUNDED — a hung connection does not park forever.
    t.mock.timers.tick(60_000);
    assert.equal(waitSignal!.aborted, true, "a wait that never answers still gives up");
  } finally {
    globalThis.fetch = real;
    mock.timers.reset();
  }
});

// ── degradations: neither may throw at an agent that only wanted to wait ─────

test("an API older than the gateway degrades to a plain queue read, not an exception", async () => {
  for (const absent of [
    () => json({ error: "not found" }, 404),
    // The API serves the SPA on /*, so an unrouted path answers 200 text/html.
    () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
  ]) {
    await withFetch(
      { wait: absent, actions: () => json({ actions: [] }) },
      async () => {
        const result = await wait();
        assert.equal(result.status, "unsupported");
        assert.equal(result.waited, false);
        assert.deepEqual(result.tasks, []);
        assert.match(result._next ?? "", /could not wait/i);
        assert.match(result._next ?? "", /Not an error/i);
        // It must name what the human has to do, since the agent cannot fix it.
        assert.match(result._next ?? "", /API needs updating/i);
      }
    );
  }
});

test("an old API that already HAS work still hands it over, dispatch-ready", async () => {
  await withFetch(
    {
      wait: () => json({ error: "not found" }, 404),
      actions: (url) =>
        url.searchParams.get("type") === "epic"
          ? json({ actions: [] })
          : json({ actions: READY_ACTIONS }),
    },
    async () => {
      const result = await wait();
      assert.equal(result.status, "ready");
      assert.equal(result.count, 2);
      assert.ok(result.tasks[0].handoff, "the fallback path is dispatch-ready too");
      assert.match(result._next ?? "", /ready NOW/i);
    }
  );
});

test("a canvas at its waiter cap says 'busy', reads the queue anyway, and does not loop", async () => {
  await withFetch(
    {
      wait: () =>
        new Response(
          JSON.stringify({
            error: "too_many_waiters",
            message: "This canvas already has the maximum number of agents waiting on its queue.",
            retryAfterSeconds: "5",
          }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": "5" } }
        ),
      actions: () => json({ actions: [] }),
    },
    async (calls) => {
      const result = await wait();
      assert.equal(result.status, "busy");
      assert.equal(result.waited, false);
      // It fell back to the plain read rather than hammering the wait endpoint.
      assert.equal(calls.filter((c) => c.url.pathname === "/api/canvas/queue/wait").length, 1);
      assert.ok(calls.some((c) => c.url.pathname === "/api/canvas/actions"));
      const next = result._next ?? "";
      assert.match(next, /Not an error/i);
      assert.match(next, /~5s/, "the server's own back-off hint is passed through");
      // Bounded: try once more, then tell the human — never spin.
      assert.match(next, /once more/i);
      assert.match(next, /rather than looping/i);
    }
  );
});

// ── the surface copy, which is half the fix ──────────────────────────────────

test("the tool sells ONE CALL instead of ending your turn — and never a poll loop", () => {
  const tool = FACADE_TOOLS.find((t) => t.name === "queue_wait")!;
  assert.ok(tool, "queue_wait is advertised on the DEFAULT manifest");

  const d = tool.description;
  // The choice the model is actually making, named in the description.
  assert.match(d, /INSTEAD OF ENDING YOUR TURN/i);
  assert.match(d, /returns the moment/i);
  // A timeout must be pre-framed as normal, before the model ever sees one.
  assert.match(d, /NOT AN ERROR/i);
  assert.match(d, /again/i);
  // It must not describe itself as polling — that is the instruction agents
  // cannot follow, and the reason this tool exists.
  assert.doesNotMatch(d, /backing[- ]off/i);
  assert.doesNotMatch(d, /poll(ing)? (this|it|queue_wait)/i);
  // Reads are annotated read-only so a connector can auto-approve them.
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.match(d, /session/, "the handle convention rides on every facade tool");
});

test("epic_propose sends the proposer to the wait, not to a polling loop", () => {
  const d = FACADE_TOOLS.find((t) => t.name === "epic_propose")!.description;
  assert.match(d, /queue_wait/);
  assert.doesNotMatch(d, /backing[- ]off/i, "the interval-polling instruction is what failed");
});
