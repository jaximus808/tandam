/**
 * TDM-65 / E9.5 — the edge-claim path, end to end from the gateway side.
 *
 * E9's contract is that WORKERS claim their own tasks under their own
 * identities and an orchestrator only dispatches. Its pieces are covered
 * separately (registration in connect-register.test.ts, the dispatch block in
 * handoff.test.ts, the API's own guards in apps/api) — what's pinned HERE is the
 * sequence a real fleet walks, in one file:
 *
 *   1. two fresh sessions on one canvas are DIFFERENT claimants;
 *   2. losing a race is DATA (`{claimed:false, claimedBy}`), not a throw, and
 *      the loser goes on to claim different ready work — the exact fallback the
 *      dispatch steps tell every subagent to take;
 *   3. a worker completes its OWN claim, and a rival's completion is refused as
 *      data too;
 *   4. a planner that never claimed anything still sees both workers and the
 *      tasks they hold, via board_status.
 *
 * No network: global fetch is replaced by a small in-memory API that implements
 * the REAL claim decisions (winner / idempotent self / loser, and the terminal
 * holder guard), because a recorder that always answers 200 cannot express the
 * half of this contract that is about losing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway, mintClaimantId, parseSession } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool } from "../src/facade.js";

const CODE = "TESTCODE";

type Task = {
  id: string;
  ticketId: string;
  state: string;
  claimedBy?: string;
  result?: string;
  proposedBy: string;
  createdAt: string;
  payload: { title: string; assignee: string };
};

function readyTask(id: string, ticketId: string, title: string): Task {
  return {
    id,
    ticketId,
    state: "approved",
    proposedBy: "planner-1",
    createdAt: "2026-07-29T00:00:00Z",
    payload: { title, assignee: "agent" },
  };
}

/**
 * A stand-in for the API that keeps STATE: the claim is decided the way
 * supabaseStore's conditional UPDATE decides it, and the terminal PATCH runs the
 * same holder guard action_handler.go does. Registration hands out agent ids so
 * the planner's queue_next/board_status calls look like a real planner's.
 */
class FakeApi {
  tasks = new Map<string, Task>();
  agents: Array<{ id: string; name?: string; role?: string; parentAgentId?: string }> = [];
  private nextAgent = 1;

  constructor(tasks: Task[]) {
    for (const t of tasks) this.tasks.set(t.id, t);
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private claim(task: Task, agentName: string): Response {
    if (task.state === "executing") {
      const holder = task.claimedBy ?? "";
      if (holder && holder !== "agent" && holder !== agentName) {
        return this.json({ error: "already_claimed", claimedBy: holder }, 409);
      }
    } else if (task.state !== "approved") {
      return this.json({ error: "illegal transition" }, 400);
    }
    task.state = "executing";
    task.claimedBy = agentName;
    return this.json({ action: { ...task } });
  }

  private finish(task: Task, to: string, agentName: string, result?: string): Response {
    const holder = task.claimedBy ?? "";
    if (agentName && holder && holder !== "agent" && holder !== agentName) {
      return this.json({ error: "claimed_by_other", claimedBy: holder }, 409);
    }
    task.state = to;
    if (result) task.result = result;
    return this.json({ action: { ...task } });
  }

  handle(url: URL, method: string, body: any): Response {
    const path = url.pathname;
    if (path === "/api/mcp/auth") {
      return this.json({
        token: "jwt-token",
        canvasId: "canvas-1",
        canvasName: "Test Canvas",
        canvasCode: CODE,
      });
    }
    if (path === "/api/canvas/agents" && method === "POST") {
      const id = `agent-${this.nextAgent++}`;
      this.agents.push({ id, ...body });
      return this.json({ agentId: id, ...(body?.parentAgentId ? { parentAgentId: body.parentAgentId } : {}) }, 201);
    }
    if (path === "/api/canvas/actions" && method === "GET") {
      const type = url.searchParams.get("type");
      if (type === "epic") return this.json({ actions: [] });
      const state = url.searchParams.get("state");
      const actions = [...this.tasks.values()].filter((t) => !state || t.state === state);
      return this.json({ actions });
    }
    const one = path.match(/^\/api\/canvas\/actions\/([^/]+)$/);
    if (one) {
      const task = this.tasks.get(one[1]);
      if (!task) return this.json({ error: "not found" }, 404);
      if (method === "GET") return this.json({ action: { ...task } });
      if (method === "PATCH") {
        const agentName = String(body?.agentName ?? "");
        return body?.state === "executing"
          ? this.claim(task, agentName)
          : this.finish(task, String(body?.state), agentName, body?.result);
      }
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  }

  /** Install as global fetch for the duration of `run`. */
  async run(run: () => Promise<void>): Promise<void> {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return this.handle(url, method, body);
    }) as typeof globalThis.fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = real;
    }
  }
}

function freshGateway(): Gateway {
  return new Gateway({ apiUrl: "http://api.test" });
}

/** Connect (optionally registering), and return the gateway plus its handle. */
async function connect(args: Record<string, unknown> = {}): Promise<{ gw: Gateway; res: any }> {
  const gw = freshGateway();
  const res = (await handleTool(gw, "canvas_connect", { code: CODE, ...args })) as any;
  return { gw, res };
}

/** The claimant a LATER call would present, restored from the handle alone. */
function claimantFromHandle(handle: string): string {
  const gw = freshGateway();
  gw.adoptSession(handle);
  return gw.claimant();
}

// ── (1) Distinct claimants ────────────────────────────────────────────────────

// The property the whole worker-claims-its-own-task model rests on: two
// sessions on ONE canvas are two identities. If connect handed out a shared or
// constant claimant, every guard downstream — the atomic claim, the terminal
// holder check — would read two different workers as the same agent and wave
// both through.
test("two fresh sessions on one canvas mint distinct claimant ids", async () => {
  const api = new FakeApi([]);
  await api.run(async () => {
    const a = await connect();
    const b = await connect();

    const idA = a.gw.claimant();
    const idB = b.gw.claimant();
    assert.match(idA, /^session-/, "an unregistered session claims as its minted id");
    assert.match(idB, /^session-/);
    assert.notEqual(idA, idB, "two workers on one canvas must not share a claimant");

    // And the identity is minted at CONNECT, not per call: the hosted sidecar
    // rebuilds a Gateway from the handle for every request, so a claimant that
    // lived only in memory would differ between task_claim and task_complete.
    assert.equal(parseSession(a.res.session).claimantId, idA);
    assert.equal(claimantFromHandle(a.res.session), idA);
    assert.equal(claimantFromHandle(b.res.session), idB);
  });
});

// The mint itself, at volume — the distinctness above must not rest on two
// draws happening to differ.
test("minted claimant ids are unique across many draws", () => {
  const ids = new Set(Array.from({ length: 100 }, () => mintClaimantId()));
  assert.equal(ids.size, 100, "mintClaimantId produced a collision");
});

// Registered workers claim under their REGISTERED names, which is what makes a
// claim traceable to a row on the board rather than to an anonymous session.
test("two workers registered under one planner claim as themselves", async () => {
  const api = new FakeApi([]);
  await api.run(async () => {
    const planner = await connect({ role: "planner", name: "planner-1" });
    const a = await connect({
      role: "executor",
      name: "worker-a",
      parentAgentId: planner.res.agentId,
    });
    const b = await connect({
      role: "executor",
      name: "worker-b",
      parentAgentId: planner.res.agentId,
    });

    assert.equal(claimantFromHandle(a.res.session), "worker-a");
    assert.equal(claimantFromHandle(b.res.session), "worker-b");
    assert.notEqual(a.res.agentId, b.res.agentId, "each worker gets its own agent row");
    // Both parented to the planner — the grouping the fleet tree is drawn from.
    const parents = api.agents.filter((x) => x.role === "executor").map((x) => x.parentAgentId);
    assert.deepEqual(parents, [planner.res.agentId, planner.res.agentId]);
  });
});

// ── (2) Losing is data, and the loser takes other work ────────────────────────

// The fallback branch every dispatch block tells a subagent to take. A throw
// here would end the worker's run; what it must get instead is a value naming
// the holder, so it can turn around and claim something else.
test("the losing worker is handed data, then claims a different ready task", async () => {
  const api = new FakeApi([
    readyTask("task-1", "TDM-201", "the contested task"),
    readyTask("task-2", "TDM-202", "the next ready task"),
  ]);
  await api.run(async () => {
    const a = await connect({ role: "executor", name: "worker-a" });
    const b = await connect({ role: "executor", name: "worker-b" });

    const won = (await handleFacadeTool(a.gw, "task_claim", { id: "task-1" })) as any;
    assert.equal(won.claimed, true);

    // Not `assert.rejects` — the point is that this RESOLVES.
    const lost = (await handleFacadeTool(b.gw, "task_claim", { id: "task-1" })) as any;
    assert.equal(lost.claimed, false, "a lost race must resolve, not throw");
    assert.equal(lost.claimedBy, "worker-a", "the loser is told who beat it");
    assert.match(lost.message, /Do NOT work on it/i);

    // The loss left the winner's claim alone…
    assert.equal(api.tasks.get("task-1")!.claimedBy, "worker-a");
    // …and the loser goes on to claim different ready work under its OWN name.
    const fallback = (await handleFacadeTool(b.gw, "task_claim", { id: "task-2" })) as any;
    assert.equal(fallback.claimed, true);
    assert.equal(api.tasks.get("task-2")!.claimedBy, "worker-b");
  });
});

// A worker rebuilt from its handle (the hosted per-call model) still claims as
// itself — otherwise a subagent would lose its own task between two calls.
test("a worker resumed from its session handle claims under the same identity", async () => {
  const api = new FakeApi([readyTask("task-1", "TDM-203", "resumed claim")]);
  await api.run(async () => {
    const a = await connect({ role: "executor", name: "worker-a" });
    await handleFacadeTool(a.gw, "task_claim", { id: "task-1" });

    // Fresh gateway, handle carried by the model — the hosted sidecar's shape.
    const resumed = freshGateway();
    const again = (await handleFacadeTool(resumed, "task_claim", {
      id: "task-1",
      session: a.res.session,
    })) as any;
    assert.equal(again.claimed, true, "re-claiming your OWN task is idempotent");
    assert.equal(api.tasks.get("task-1")!.claimedBy, "worker-a");
  });
});

// ── (3) Completion: your own claim finishes, someone else's does not ──────────

// The reason workers claim their own work: the agent that claimed is the agent
// that finishes, so completing under its own identity must sail through the
// API's holder guard. And the inverse — a rival's completion — must come back
// as data, the same way a lost claim does.
test("a worker completes its own claim; a rival's completion is refused as data", async () => {
  const api = new FakeApi([
    readyTask("task-1", "TDM-204", "worker-a's task"),
    readyTask("task-2", "TDM-205", "worker-b's task"),
  ]);
  await api.run(async () => {
    const a = await connect({ role: "executor", name: "worker-a" });
    const b = await connect({ role: "executor", name: "worker-b" });

    await handleFacadeTool(a.gw, "task_claim", { id: "task-1" });
    await handleFacadeTool(b.gw, "task_claim", { id: "task-2" });

    // Self-complete: no conflict, and the result lands.
    const done = (await handleFacadeTool(a.gw, "task_complete", {
      id: "task-1",
      result: "tests added, all green",
    })) as any;
    assert.equal(done.completed, undefined, "a self-complete must not report a conflict");
    assert.equal(api.tasks.get("task-1")!.state, "done");
    assert.equal(api.tasks.get("task-1")!.result, "tests added, all green");

    // Finishing work you do not hold: refused, and told whose it is.
    const refused = (await handleFacadeTool(a.gw, "task_complete", {
      id: "task-2",
      result: "I did not do this",
    })) as any;
    assert.equal(refused.completed, false, "a rival completion must resolve, not throw");
    assert.equal(refused.claimedBy, "worker-b");
    assert.equal(api.tasks.get("task-2")!.state, "executing", "the refusal left the task alone");
    assert.equal(api.tasks.get("task-2")!.result, undefined);
  });
});

// ── (4) Fleet visibility from the planner's seat ──────────────────────────────

// The dispatcher's whole view of a fan-out. It claimed nothing, so nothing it
// sees comes from its own session — board_status has to report both workers and
// the tasks they hold, or a planner has no way to know its fleet is working.
test("a planner that never claimed sees both workers and their in-flight tasks", async () => {
  const api = new FakeApi([
    readyTask("task-1", "TDM-206", "worker-a's task"),
    readyTask("task-2", "TDM-207", "worker-b's task"),
    readyTask("task-3", "TDM-208", "still in the queue"),
  ]);
  await api.run(async () => {
    const planner = await connect({ role: "planner", name: "planner-1" });
    const a = await connect({
      role: "executor",
      name: "worker-a",
      parentAgentId: planner.res.agentId,
    });
    const b = await connect({
      role: "executor",
      name: "worker-b",
      parentAgentId: planner.res.agentId,
    });
    await handleFacadeTool(a.gw, "task_claim", { id: "task-1" });
    await handleFacadeTool(b.gw, "task_claim", { id: "task-2" });

    const status = (await handleFacadeTool(planner.gw, "board_status", {})) as any;
    const inFlight = (status.inFlight as any[]).sort((x, y) =>
      String(x.ticketId).localeCompare(String(y.ticketId))
    );
    assert.deepEqual(
      inFlight.map((t) => [t.ticketId, t.claimedBy, t.state]),
      [
        ["TDM-206", "worker-a", "executing"],
        ["TDM-207", "worker-b", "executing"],
      ],
      "the planner must see BOTH workers and what each holds"
    );
    assert.deepEqual(status.tasks.byState, { executing: 2, approved: 1 });

    // The ready queue it would dispatch next holds only the untaken task —
    // claimed work must not be handed to a second worker.
    const queue = (await handleFacadeTool(planner.gw, "queue_next", {})) as any;
    assert.deepEqual(
      (queue.tasks as any[]).map((t) => t.ticketId),
      ["TDM-208"]
    );
  });
});
