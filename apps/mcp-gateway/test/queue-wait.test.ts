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
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleFacadeTool, resetTellHumanLedger } from "../src/facade.js";
import { handleTool } from "../src/tools.js";
import { FACADE_TOOLS } from "../src/server.js";

// The missed-ask reminder is once-per-scope-per-session (TDM-187), and every
// test here connects as the SAME session — so start each one having reminded
// nobody, or the assertions would depend on the order the file happens to run in.
beforeEach(resetTellHumanLedger);

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
  rejected?: Array<Record<string, any>>;
  lostByYou?: unknown[];
  _lostByYou?: string;
  _dispatch?: string;
  _tell_human?: string;
  _next?: string;
};

/** A connected, registered planner — the identity the ledger keys on. */
async function planner(): Promise<Gateway> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", {
    code: "TESTCODE",
    role: "planner",
    name: "the-planner",
  });
  return gw;
}

/** Connect as a registered planner, then wait. */
async function wait(args: Record<string, unknown> = {}): Promise<WaitResult> {
  return (await handleFacadeTool(await planner(), "queue_wait", args)) as WaitResult;
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

// ── status: rejected — woken by a NO (TDM-4, contract A) ─────────────────────
//
// The dead end this closes: a rejection used to signal nothing, so an agent
// parked here waited out its whole budget on a ticket that could never become
// ready, and the timeout copy had to warn it about that in the abstract. Now the
// rejection wakes the wait and brings the reason with it, which turns "keep
// waiting" into "here is work you can do right now".

const REJECTED = [
  {
    id: "task-ccc",
    ticketId: "TDM-203",
    title: "Rewrite the whole queue in Rust",
    reason: "Out of scope for this batch — the queue is fine; the gap is the rejection loop.",
    by: "human",
    at: "2026-08-06T12:00:00Z",
  },
];

const rejectedBody = (rejected: unknown[] = REJECTED, waitedMs = 1200) => ({
  type: "queue.wait",
  status: "rejected",
  rejected,
  count: rejected.length,
  waitedMs,
  timeoutSeconds: 25,
});

test("a rejection wakes the wait, and the reason comes back VERBATIM", async () => {
  await withFetch({ wait: () => json(rejectedBody()) }, async () => {
    const result = await wait();

    assert.equal(result.status, "rejected");
    assert.equal(result.count, 1);
    assert.equal(result.waited, true);
    assert.equal(result.waitedMs, 1200);
    // Nothing to claim or dispatch — a rejection is not work in the queue.
    assert.deepEqual(result.tasks, []);
    assert.equal(result._dispatch, undefined);

    // The whole point: the decider's words, uncut. An excerpt would send the
    // author back to the board for the thing this answer exists to deliver.
    assert.deepEqual(result.rejected, REJECTED);
    assert.equal(result.rejected![0].reason, REJECTED[0].reason);
  });
});

test("the rejected answer says: not an error, resubmit with task_amend, do not re-file", async () => {
  await withFetch({ wait: () => json(rejectedBody()) }, async () => {
    const next = (await wait())._next ?? "";

    assert.match(next, /REJECTED/);
    assert.match(next, /TDM-203/, "it names the ticket that came back");
    assert.match(next, /NOT an error/i);
    // The two moves the reason licenses, and the one it forbids.
    assert.match(next, /task_amend/);
    assert.match(next, /note/i, "the resubmit's note is what the human reads");
    assert.match(next, /'proposed'/, "amending a rejected ticket sends it back to the gate");
    assert.match(next, /neighbouring tickets/i, "a rejection usually condemns more than one");
    assert.match(next, /Do not re-file the same ticket as a new one/i);
    // And it must not send the agent straight back to waiting on a dead ticket.
    assert.match(next, /work you can do right now/i);
  });
});

test("several rejections come back together, each with its own reason", async () => {
  const two = [
    REJECTED[0],
    { id: "task-ddd", ticketId: "TDM-204", title: "Second one", reason: "Same problem.", by: "human" },
  ];
  await withFetch({ wait: () => json(rejectedBody(two)) }, async () => {
    const result = await wait();
    assert.equal(result.count, 2);
    assert.deepEqual(
      result.rejected!.map((r) => [r.ticketId, r.reason]),
      [
        ["TDM-203", REJECTED[0].reason],
        ["TDM-204", "Same problem."],
      ]
    );
    assert.match(result._next ?? "", /2 tickets/, "plural, and it says how many");
    assert.match(result._next ?? "", /TDM-203, TDM-204/);
  });
});

test("a rejection is not a timeout: it spends no _tell_human reminder", async () => {
  // The reminder exists for a human who was never asked to approve anything. A
  // human who just REJECTED something has plainly seen the board.
  await withFetch(
    {
      wait: (() => {
        let n = 0;
        return () => json(n++ === 0 ? rejectedBody() : timeoutBody());
      })(),
    },
    async () => {
      const gw = await planner();
      const first = (await handleFacadeTool(gw, "queue_wait", {})) as WaitResult;
      assert.equal(first.status, "rejected");
      assert.equal(first._tell_human, undefined);
      // …and the backstop is still unspent for the timeout that follows.
      assert.ok(((await handleFacadeTool(gw, "queue_wait", {})) as WaitResult)._tell_human);
    }
  );
});

test("the timeout no longer claims a rejected ticket leaves you waiting forever", async () => {
  await withFetch({ wait: () => json(timeoutBody()) }, async () => {
    const next = (await wait())._next ?? "";
    // That sentence was true only while rejections signalled nothing. Saying it
    // now would send an agent to board_status on every quiet round.
    assert.doesNotMatch(next, /waiting forever/i);
    assert.doesNotMatch(next, /never becomes ready/i);
    // What replaces it: a rejection WOULD have woken you, so silence means
    // nobody has decided — with the older-API caveat kept as the exception.
    assert.match(next, /wakes this call/i);
    assert.match(next, /nobody has decided yet/i);
    assert.match(next, /board_status/, "the fallback for an API that cannot signal one");
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

// ── the missed-ask backstop (TDM-187) ────────────────────────────────────────
//
// The deadlock this catches: the gate is open, the agent is parked here, and the
// human was never told either is true. TDM-186 put the ask on the propose
// answer; this is the last place it can be caught once that ask was skipped —
// and it must stay a BACKSTOP, so it fires once and then shuts up.

test("the FIRST timeout carries the _tell_human reminder, with the board URL in it", async () => {
  await withFetch({ wait: () => json(timeoutBody()) }, async () => {
    const result = await wait();

    const tell = result._tell_human ?? "";
    assert.ok(tell, "a timeout is the one moment the missed ask can still be caught");
    // Relayable as-is: it names the gate, and it says where to click.
    assert.match(tell, /approval/i);
    assert.match(tell, /http[^\s"]*\/c\/TESTCODE/, "the board URL must be in the sentence");
    // Say it NOW, and keep waiting — not "stop and ask", which would undo the tool.
    assert.match(tell, /NOT YET TOLD THE HUMAN/i);
    assert.match(tell, /queue_wait again/i);
    // Honest about what it is, so an agent that DID relay the ask ignores it.
    assert.match(tell, /already relayed/i);
    assert.match(tell, /backstop/i);
    // It never displaces the timeout's own "this is not an error" message.
    assert.match(result._next ?? "", /NOT an error/i);
  });
});

test("it does not nag: later timeouts on the same wait carry no reminder", async () => {
  await withFetch({ wait: () => json(timeoutBody()) }, async () => {
    const gw = await planner();
    const again = async () => (await handleFacadeTool(gw, "queue_wait", {})) as WaitResult;

    assert.ok((await again())._tell_human, "first timeout reminds");
    for (let i = 0; i < 3; i++) {
      assert.equal((await again())._tell_human, undefined, "a loop must not be nagged every round");
    }
  });
});

test("one reminder per BATCH: a second epic is a second thing nobody was told about", async () => {
  await withFetch({ wait: () => json(timeoutBody()) }, async () => {
    const gw = await planner();
    const waitOn = async (epicId?: string) =>
      (await handleFacadeTool(gw, "queue_wait", epicId ? { epicId } : {})) as WaitResult;

    const first = await waitOn("epic-9");
    assert.ok(first._tell_human);
    assert.match(first._tell_human!, /epic-9/, "the ask names the batch it is about");
    assert.equal((await waitOn("epic-9"))._tell_human, undefined);

    // A different batch is owed its own ask…
    assert.ok((await waitOn("epic-10"))._tell_human);
    // …and so is the unscoped whole-queue wait.
    assert.ok((await waitOn())._tell_human);
  });
});

test("a wait that comes back READY spends no reminder — there is nothing to ask for", async () => {
  await withFetch(
    {
      // ready first, then timeouts: the ready answer must not consume the ask.
      wait: (() => {
        let n = 0;
        return () => json(n++ === 0 ? readyBody() : timeoutBody());
      })(),
    },
    async () => {
      const gw = await planner();
      const ready = (await handleFacadeTool(gw, "queue_wait", {})) as WaitResult;
      assert.equal(ready.status, "ready");
      assert.equal(ready._tell_human, undefined, "approved work needs no approval ask");

      const timedOut = (await handleFacadeTool(gw, "queue_wait", {})) as WaitResult;
      assert.equal(timedOut.status, "timeout");
      assert.ok(timedOut._tell_human, "the reminder was still there to be spent");
    }
  );
});

test("the description carries the tell-first contract, not just the wait", () => {
  const d = FACADE_TOOLS.find((t) => t.name === "queue_wait")!.description;
  assert.match(d, /TELL THE HUMAN BEFORE YOU WAIT/i);
  assert.match(d, /tellHuman/, "it points at the line the propose answer already composed");
  assert.match(d, /_tell_human/, "and names the field the first timeout hands back");
  assert.match(d, /backstop, not a substitute/i);
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
