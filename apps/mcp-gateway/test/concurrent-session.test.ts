/**
 * TDM-178 — one tool call's session binding must be PRIVATE to that call.
 *
 * The bug these pin, observed in the field during a 5-agent parallel dispatch:
 * the stdio entrypoint builds ONE Gateway for the whole process, and every
 * concurrent subagent in the harness funnels its tool calls through it. The
 * binding lived in a single mutable field, so a call that yielded on its API
 * request came back to whatever session had been adopted meanwhile:
 *
 *   A: adopt(A)  →  await PATCH …                (yields)
 *   B:              adopt(B)                     (overwrites the field)
 *   A:              exportSession() → B's session
 *
 * task_claim exports its handle at exactly that point, so an executor was handed
 * a "refreshed" handle carrying a SIBLING's agentId/agentName — and a
 * `_session_note` telling it to switch to it, which would have made every later
 * task_progress / task_complete post as the sibling.
 *
 * Each test below drives two calls through ONE shared Gateway and uses a barrier
 * inside the fake API to guarantee the interleave (both calls are parked
 * mid-flight, then released together). Without the per-call scope every one of
 * them fails; the assertions are all of the form "this call's answer names this
 * call's agent".
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { Gateway, parseSession, serializeSession, type CanvasSession } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool } from "../src/facade.js";
import { resetLossLedger } from "../src/tapout.js";

// The loss ledger is process-global and keyed by canvas + claimant.
beforeEach(resetLossLedger);

const CODE = "TESTCODE";
const CANVAS_ID = "canvas-1";

interface Recorded {
  method: string;
  path: string;
  body: any;
  agent?: string;
  auth?: string;
}

/**
 * Parks every arrival until the nth shows up, then releases them all at once.
 * This is what makes the race deterministic: both calls are guaranteed to be
 * suspended on their API request — the exact window in which the old shared
 * field was overwritten — before either resumes.
 */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return async () => {
    if (++arrived >= n) open();
    await gate;
  };
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers as Record<string, string> | undefined;
  return h?.[name];
}

type Task = { id: string; state: string; claimedBy?: string };

/**
 * A minimal stand-in for the API. `holdOn` marks the requests that must be
 * parked on the barrier — the yield point the race needs.
 */
class FakeApi {
  calls: Recorded[] = [];
  private nextAgent = 1;
  private wait: () => Promise<void>;

  constructor(
    private tasks: Map<string, Task>,
    private holdOn: (method: string, path: string) => boolean,
    holders = 2
  ) {
    this.wait = barrier(holders);
  }

  /** Every recorded request against one action path. */
  patchesTo(id: string): Recorded[] {
    return this.calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/actions/${id}`));
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private async handle(url: URL, method: string, body: any, init?: RequestInit): Promise<Response> {
    const path = url.pathname;
    this.calls.push({
      method,
      path,
      body,
      agent: headerOf(init, "X-Tandem-Agent"),
      auth: headerOf(init, "Authorization"),
    });

    if (this.holdOn(method, path)) await this.wait();

    if (path === "/api/mcp/auth") {
      return this.json({
        token: `jwt-${String(body?.code ?? "x")}-${this.calls.length}`,
        canvasId: CANVAS_ID,
        canvasName: "Test Canvas",
        canvasCode: CODE,
      });
    }
    if (path === "/api/canvas/agents" && method === "POST") {
      return this.json({ agentId: `agent-${this.nextAgent++}` }, 201);
    }
    const one = path.match(/^\/api\/canvas\/actions\/([^/]+)$/);
    if (one) {
      const task = this.tasks.get(one[1]);
      if (!task) return this.json({ error: "not found" }, 404);
      if (method === "GET") return this.json({ action: { ...task } });
      if (method === "PATCH") {
        const agentName = String(body?.agentName ?? "");
        if (body?.state === "executing") {
          const holder = task.claimedBy ?? "";
          if (task.state === "executing" && holder && holder !== agentName) {
            return this.json({ error: "already_claimed", claimedBy: holder }, 409);
          }
          task.state = "executing";
          task.claimedBy = agentName;
          // The fencing token task_claim folds into the handle it exports.
          return this.json({
            action: { ...task },
            claim: { generation: 1, holder: agentName },
          });
        }
        task.state = String(body?.state);
        return this.json({ action: { ...task } });
      }
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  }

  async run(run: () => Promise<void>): Promise<void> {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return this.handle(url, method, body, init);
    }) as typeof globalThis.fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = real;
    }
  }
}

/** The one process-wide Gateway the stdio entrypoint builds. */
function sharedGateway(): Gateway {
  return new Gateway({ apiUrl: "http://api.test" });
}

// ── (1) The reported defect: task_claim's exported handle ─────────────────────

test("concurrent task_claim: each response handle carries the CALLER's identity", async () => {
  const tasks = new Map<string, Task>([
    ["task-a", { id: "task-a", state: "approved" }],
    ["task-b", { id: "task-b", state: "approved" }],
  ]);
  // Park both claim PATCHes, so each call resumes only after the other has
  // adopted its own session — the window the old shared field lost.
  const api = new FakeApi(tasks, (method, path) => method === "PATCH" && path.includes("/actions/"));

  await api.run(async () => {
    const gw = sharedGateway();

    // Two subagents connect+register through the SAME gateway, as they do on
    // stdio, and each keeps its own handle.
    const a = (await handleTool(gw, "canvas_connect", {
      code: CODE,
      role: "executor",
      name: "worker-a",
    })) as any;
    const b = (await handleTool(gw, "canvas_connect", {
      code: CODE,
      role: "executor",
      name: "worker-b",
    })) as any;
    assert.notEqual(a.agentId, b.agentId, "the two workers must be two agent rows");

    const [claimA, claimB] = (await Promise.all([
      handleFacadeTool(gw, "task_claim", { id: "task-a", session: a.session }),
      handleFacadeTool(gw, "task_claim", { id: "task-b", session: b.session }),
    ])) as any[];

    assert.equal(claimA.claimed, true);
    assert.equal(claimB.claimed, true);

    const handleA = parseSession(claimA.session);
    const handleB = parseSession(claimB.session);

    // THE done condition: the handle a claim hands back is the caller's own.
    assert.equal(handleA.agentName, "worker-a");
    assert.equal(handleA.agentId, a.agentId);
    assert.equal(handleB.agentName, "worker-b");
    assert.equal(handleB.agentId, b.agentId);
    assert.notEqual(handleA.agentId, handleB.agentId);
    // The claimant ids minted at connect must not have crossed over either.
    assert.equal(handleA.claimantId, parseSession(a.session).claimantId);
    assert.equal(handleB.claimantId, parseSession(b.session).claimantId);

    // And the server saw each task claimed by its own worker.
    assert.equal(tasks.get("task-a")?.claimedBy, "worker-a");
    assert.equal(tasks.get("task-b")?.claimedBy, "worker-b");
  });
});

// ── (2) The same race one step earlier: connect + register ───────────────────

test("concurrent canvas_connect: each handle carries the identity it registered", async () => {
  // Park both agent registrations: each connect has already written its session
  // and is waiting on the POST that mints its agent id.
  const api = new FakeApi(
    new Map(),
    (method, path) => method === "POST" && path === "/api/canvas/agents"
  );

  await api.run(async () => {
    const gw = sharedGateway();
    const [a, b] = (await Promise.all([
      handleTool(gw, "canvas_connect", { code: CODE, role: "executor", name: "worker-a" }),
      handleTool(gw, "canvas_connect", { code: CODE, role: "planner", name: "planner-b" }),
    ])) as any[];

    assert.notEqual(a.agentId, b.agentId);
    const handleA = parseSession(a.session);
    const handleB = parseSession(b.session);
    assert.equal(handleA.agentName, "worker-a");
    assert.equal(handleA.agentId, a.agentId);
    assert.equal(handleB.agentName, "planner-b");
    assert.equal(handleB.agentId, b.agentId);
    assert.notEqual(handleA.token, handleB.token, "each connect keeps its own JWT");
  });
});

// ── (3) The credential half of the same leak: a write built after a yield ─────

test("concurrent task_complete: the terminal write carries the caller's own credentials", async () => {
  const tasks = new Map<string, Task>([
    ["task-a", { id: "task-a", state: "executing", claimedBy: "worker-a" }],
    ["task-b", { id: "task-b", state: "executing", claimedBy: "worker-b" }],
  ]);
  // Park the pre-flight GET. Everything the terminal PATCH presents — the JWT
  // and X-Tandem-Agent header (built inside the request), and the fencing token
  // — is read AFTER that await, so this is the interleave that used to swap them.
  const api = new FakeApi(tasks, (method, path) => method === "GET" && path.includes("/actions/"));

  const base: Omit<CanvasSession, "token"> = {
    canvasId: CANVAS_ID,
    canvasName: "Test Canvas",
    canvasCode: CODE,
  };
  const handleA = serializeSession({
    ...base,
    token: "jwt-a",
    agentId: "agent-a",
    agentName: "worker-a",
    claimGeneration: 7,
  });
  const handleB = serializeSession({
    ...base,
    token: "jwt-b",
    agentId: "agent-b",
    agentName: "worker-b",
    claimGeneration: 9,
  });

  await api.run(async () => {
    const gw = sharedGateway();
    await Promise.all([
      handleTool(gw, "canvas_task_complete", {
        id: "task-a",
        result: "a done",
        session: handleA,
      }),
      handleTool(gw, "canvas_task_complete", {
        id: "task-b",
        result: "b done",
        session: handleB,
      }),
    ]);

    const [patchA] = api.patchesTo("task-a");
    const [patchB] = api.patchesTo("task-b");
    assert.ok(patchA && patchB, "both completions must reach the API");

    assert.equal(patchA.body.agentName, "worker-a");
    assert.equal(patchA.agent, "worker-a", "provenance header must be the caller's");
    assert.equal(patchA.auth, "Bearer jwt-a", "a call must not write with a sibling's JWT");
    assert.equal(patchA.body.claimGeneration, 7, "each write presents its OWN fencing token");

    assert.equal(patchB.body.agentName, "worker-b");
    assert.equal(patchB.agent, "worker-b");
    assert.equal(patchB.auth, "Bearer jwt-b");
    assert.equal(patchB.body.claimGeneration, 9);
  });
});

// ── (4) The scope must not break delegation or the handle-less fallback ──────

test("a facade tool delegating to a CRUD tool keeps the caller's session", async () => {
  const tasks = new Map<string, Task>([["task-a", { id: "task-a", state: "approved" }]]);
  // No holds: a single call, exercising facade → handleTool nesting.
  const api = new FakeApi(tasks, () => false);

  await api.run(async () => {
    const gw = sharedGateway();
    const a = (await handleTool(gw, "canvas_connect", {
      code: CODE,
      role: "executor",
      name: "worker-a",
    })) as any;
    const claim = (await handleFacadeTool(gw, "task_claim", {
      id: "task-a",
      session: a.session,
    })) as any;
    assert.equal(claim.claimed, true);
    // The nested scope must be a pass-through, not a fresh copy of a stale
    // session: the claim's fencing token has to reach the exported handle.
    assert.equal(parseSession(claim.session).agentName, "worker-a");
    assert.equal(parseSession(claim.session).claimGeneration, 1);
  });
});

test("a session established by connect still serves a later call that omits the handle", async () => {
  const tasks = new Map<string, Task>([["task-a", { id: "task-a", state: "approved" }]]);
  const api = new FakeApi(tasks, () => false);

  await api.run(async () => {
    const gw = sharedGateway();
    await handleTool(gw, "canvas_connect", { code: CODE, role: "executor", name: "worker-a" });
    // No `session` argument — the binding must have been written back to the
    // process-level slot when the connect call's scope closed.
    const claim = (await handleFacadeTool(gw, "task_claim", { id: "task-a" })) as any;
    assert.equal(claim.claimed, true);
    assert.equal(tasks.get("task-a")?.claimedBy, "worker-a");
  });
});
