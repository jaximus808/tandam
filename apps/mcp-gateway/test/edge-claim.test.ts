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
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { Gateway, mintClaimantId, parseSession } from "../src/gateway.js";
import { claimRejectionMessage, handleTool } from "../src/tools.js";
import { handleFacadeTool } from "../src/facade.js";
import { TAP_OUT_REASONS, resetLossLedger } from "../src/tapout.js";

// The loss ledger is process-global and keyed by canvas + claimant, and these
// tests deliberately reuse names ("worker-a") on one canvas id — so without this
// a loss recorded in one test would still be remembered in the next.
beforeEach(resetLossLedger);

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
  /** Every request that reached the API — the anti-loop tests count writes. */
  calls: Array<{ method: string; path: string }> = [];
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

  /** PATCHes against one action — the write a re-racing claim would make. */
  writesTo(id: string): number {
    return this.calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/actions/${id}`))
      .length;
  }

  handle(url: URL, method: string, body: any): Response {
    const path = url.pathname;
    this.calls.push({ method, path });
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
    // TDM-72: the instruction must name a tool the facade actually advertises.
    // `canvas_task_list` is not on the default manifest, so telling the loser to
    // call it sent it after a tool it cannot see.
    assert.match(lost.message, /Call queue_next/);
    assert.doesNotMatch(lost.message, /canvas_task_list/);

    // The loss left the winner's claim alone…
    assert.equal(api.tasks.get("task-1")!.claimedBy, "worker-a");
    // …and the loser goes on to claim different ready work under its OWN name.
    const fallback = (await handleFacadeTool(b.gw, "task_claim", { id: "task-2" })) as any;
    assert.equal(fallback.claimed, true);
    assert.equal(api.tasks.get("task-2")!.claimedBy, "worker-b");
  });
});

// TDM-72 — the rejection string itself, on BOTH call paths, verbatim.
//
// It is the only instruction a losing worker gets, and it is also the frame the
// launch thread freezes on (docs/demo-script.md §3), so it is pinned twice over:
// once as the exact sentence, and once as "the facade and the CRUD surface say
// the SAME thing" — the facade delegates to canvas_task_start, so any wording
// that is right on one surface and wrong on the other is a bug in one of them.
test("a lost claim reads identically through the facade and the CRUD surface", async () => {
  const api = new FakeApi([
    readyTask("task-1", "TDM-206", "the contested task"),
    readyTask("task-2", "TDM-207", "the contested task, again"),
  ]);
  await api.run(async () => {
    const a = await connect({ role: "executor", name: "session-A" });
    const b = await connect({ role: "executor", name: "session-B" });

    // The demo's money shot: session-B loses to session-A and is told where to go.
    const expected =
      'This task is already claimed by "session-A" — another session got it first. ' +
      "Do NOT work on it. Call queue_next and pick the next ready task.";
    assert.equal(claimRejectionMessage("session-A"), expected);

    await handleFacadeTool(a.gw, "task_claim", { id: "task-1" });
    const viaFacade = (await handleFacadeTool(b.gw, "task_claim", { id: "task-1" })) as any;
    // TDM-99 grew this response: the SENTENCE above is unchanged (it is the
    // freeze-frame), and the machine-readable tap-out block rides alongside it.
    assert.deepEqual(viaFacade, {
      claimed: false,
      claimedBy: "session-A",
      tapOut: true,
      reason: "already_claimed",
      next: "queue_next",
      taskId: "task-1",
      holder: "session-A",
      attempts: 1,
      message: expected,
    });

    // Same loss, called by its CRUD name (full-tools manifest / legacy prompts).
    await handleTool(a.gw, "canvas_task_start", { id: "task-2" });
    const viaCrud = (await handleTool(b.gw, "canvas_task_start", { id: "task-2" })) as any;
    // Identical but for the task it names — the facade delegates to this handler,
    // so the tap-out block and the sentence are one implementation.
    assert.deepEqual(viaCrud, { ...viaFacade, taskId: "task-2" }, "one rejection, both surfaces");

    // The clause the freeze-frame is cropped around, verbatim.
    assert.match(viaFacade.message, /^This task is already claimed by "session-A" — /);
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

// ── (3b) The tap-out contract (TDM-99 / E14) ─────────────────────────────────
//
// Prose told a loser to stop; nothing let it BRANCH on having lost, and nothing
// remembered the loss — so queue_next → claim → lose → queue_next was a stable
// loop. What is pinned here is the machine-readable half and its teeth.

test("every losing path carries the SAME tap-out block", async () => {
  const api = new FakeApi([
    readyTask("task-1", "TDM-210", "the contested task"),
    readyTask("task-2", "TDM-211", "worker-b's task"),
  ]);
  await api.run(async () => {
    const a = await connect({ role: "executor", name: "worker-a" });
    const b = await connect({ role: "executor", name: "worker-b" });

    await handleFacadeTool(a.gw, "task_claim", { id: "task-1" });
    await handleFacadeTool(b.gw, "task_claim", { id: "task-2" });

    // (i) a lost claim
    const lost = (await handleFacadeTool(b.gw, "task_claim", { id: "task-1" })) as any;
    assert.equal(lost.tapOut, true, "the one field a loser branches on");
    assert.equal(lost.reason, "already_claimed");
    assert.equal(lost.holder, "worker-a");
    assert.equal(lost.taskId, "task-1");
    assert.equal(lost.next, "queue_next", "and it names where to go instead");
    assert.equal(lost.attempts, 1);
    assert.match(lost.message, /Do NOT work on it/i, "prose says do not touch it");

    // (ii) completing work you do not hold — same shape, different reason
    const refused = (await handleFacadeTool(a.gw, "task_complete", {
      id: "task-2",
      result: "not mine",
    })) as any;
    assert.equal(refused.tapOut, true);
    assert.equal(refused.reason, "not_your_claim");
    assert.equal(refused.holder, "worker-b");
    assert.equal(refused.next, "queue_next");
    assert.match(refused.message, /Do NOT work on it/i);

    // Both blocks are the same SHAPE — the point of a contract.
    assert.deepEqual(
      Object.keys(lost).filter((k) => k in refused).sort(),
      ["attempts", "claimedBy", "holder", "message", "next", "reason", "tapOut", "taskId"]
    );
    // …and every reason is drawn from the closed set.
    for (const r of [lost.reason, refused.reason]) assert.ok(TAP_OUT_REASONS.includes(r));
  });
});

test("a REPEAT claim on a task you lost is refused without re-racing", async () => {
  const api = new FakeApi([readyTask("task-1", "TDM-212", "the contested task")]);
  await api.run(async () => {
    const a = await connect({ role: "executor", name: "worker-a" });
    const b = await connect({ role: "executor", name: "worker-b" });

    await handleFacadeTool(a.gw, "task_claim", { id: "task-1" });
    const first = (await handleFacadeTool(b.gw, "task_claim", { id: "task-1" })) as any;
    assert.equal(first.reason, "already_claimed");
    const writesAfterFirstLoss = api.writesTo("task-1");

    // Ask again: same contract, firmer, and the API is not touched at all.
    const again = (await handleFacadeTool(b.gw, "task_claim", { id: "task-1" })) as any;
    assert.equal(again.claimed, false);
    assert.equal(again.tapOut, true, "the shape does not change on the second refusal");
    assert.equal(again.reason, "already_lost", "…but the reason gets firmer");
    assert.equal(again.holder, "worker-a");
    assert.equal(again.next, "queue_next");
    assert.equal(again.attempts, 2, "the session is told how many times it has been here");
    assert.match(again.message, /did NOT retry the claim/i);
    assert.match(again.message, /DIFFERENT ready task/i);
    assert.equal(
      api.writesTo("task-1"),
      writesAfterFirstLoss,
      "a re-race must not reach the API — that is the loop this closes"
    );

    // A third try keeps counting rather than resetting.
    const third = (await handleFacadeTool(b.gw, "task_claim", { id: "task-1" })) as any;
    assert.equal(third.attempts, 3);
    assert.equal(api.writesTo("task-1"), writesAfterFirstLoss);

    // The refusals never touched the winner's claim.
    assert.equal(api.tasks.get("task-1")!.claimedBy, "worker-a");
  });
});

test("a refused completion is remembered, so the follow-up claim is refused too", async () => {
  const api = new FakeApi([readyTask("task-1", "TDM-213", "worker-a's task")]);
  await api.run(async () => {
    const a = await connect({ role: "executor", name: "worker-a" });
    const b = await connect({ role: "executor", name: "worker-b" });

    await handleFacadeTool(a.gw, "task_claim", { id: "task-1" });
    const refused = (await handleFacadeTool(b.gw, "task_complete", {
      id: "task-1",
      result: "I did not do this",
    })) as any;
    assert.equal(refused.tapOut, true);

    // Having been told the task is not yours, claiming it is the same loop.
    const writes = api.writesTo("task-1");
    const claim = (await handleFacadeTool(b.gw, "task_claim", { id: "task-1" })) as any;
    assert.equal(claim.reason, "already_lost");
    assert.equal(api.writesTo("task-1"), writes, "no claim attempt was made");
  });
});

test("queue_next marks a task you lost and withholds its handoff", async () => {
  const api = new FakeApi([
    readyTask("task-1", "TDM-214", "the contested task"),
    readyTask("task-2", "TDM-215", "still free"),
  ]);
  await api.run(async () => {
    const a = await connect({ role: "executor", name: "worker-a" });
    const b = await connect({ role: "executor", name: "worker-b" });

    await handleFacadeTool(a.gw, "task_claim", { id: "task-1" });
    await handleFacadeTool(b.gw, "task_claim", { id: "task-1" });

    // The ready queue normally hides a claimed task by state alone. This is the
    // case where it does NOT: the row still reads approved (a lagging read, or a
    // write fenced by claim generation) while a holder is stamped on it. Without
    // the ledger the loser would be handed back the exact task it just lost.
    const contested = api.tasks.get("task-1")!;
    contested.state = "approved";
    contested.claimedBy = "worker-a";

    const queue = (await handleFacadeTool(b.gw, "queue_next", {})) as any;
    const rows = new Map((queue.tasks as any[]).map((t) => [t.id, t]));

    const mine = rows.get("task-1");
    assert.equal(mine.lostByYou, true, "annotated, not silently dropped");
    assert.equal(mine.lostTo, "worker-a");
    assert.equal(mine.handoff, undefined, "a task you lost is not dispatchable either");
    assert.match(mine._tapOut, /NOT yours/);
    assert.deepEqual(queue.lostByYou, [{ id: "task-1", ticketId: "TDM-214" }]);
    assert.match(queue._lostByYou, /must not claim them again/);

    // Everything else is untouched and still dispatchable.
    assert.equal(rows.get("task-2").lostByYou, undefined);
    assert.ok(rows.get("task-2").handoff, "the rest of the queue still carries handoffs");

    // The winner sees a normal queue — the ledger is per session, not global.
    const winnersQueue = (await handleFacadeTool(a.gw, "queue_next", {})) as any;
    assert.equal(
      (winnersQueue.tasks as any[]).every((t) => t.lostByYou === undefined),
      true
    );
    assert.equal(winnersQueue.lostByYou, undefined);
  });
});

test("queue_next forgets the loss once the task is ready and unheld again", async () => {
  const api = new FakeApi([readyTask("task-1", "TDM-216", "released after all")]);
  await api.run(async () => {
    const a = await connect({ role: "executor", name: "worker-a" });
    const b = await connect({ role: "executor", name: "worker-b" });

    await handleFacadeTool(a.gw, "task_claim", { id: "task-1" });
    assert.equal(((await handleFacadeTool(b.gw, "task_claim", { id: "task-1" })) as any).claimed, false);

    // A human releases it on the board: back to approved, claim cleared (that is
    // what ReleaseAction does server-side). The refusal is now a lie, so the
    // ready queue — the tool every tap-out points at — must take it back.
    const released = api.tasks.get("task-1")!;
    released.state = "approved";
    released.claimedBy = undefined;

    const queue = (await handleFacadeTool(b.gw, "queue_next", {})) as any;
    const row = (queue.tasks as any[]).find((t) => t.id === "task-1");
    assert.equal(row.lostByYou, undefined, "the loss is stale — do not keep refusing");
    assert.ok(row.handoff, "and it is dispatchable again");
    assert.equal(queue.lostByYou, undefined);

    // Not just cosmetics: the ledger entry is gone, so the claim really works.
    const retry = (await handleFacadeTool(b.gw, "task_claim", { id: "task-1" })) as any;
    assert.equal(retry.claimed, true);
    assert.equal(api.tasks.get("task-1")!.claimedBy, "worker-b");
  });
});

// TDM-98 is adding claim-generation fencing to the Go API in parallel. Its
// rejection spells the holder `holder` (not `claimedBy`), says `fenced: true`,
// and may well use 412 rather than 409. None of that may reach a model as a
// thrown protocol error, and none of it may need this gateway to be redeployed
// in lockstep — so both spellings and both statuses fold into one tap-out.
test("a fenced rejection folds into the tap-out contract, 409 or 412", async () => {
  // The body writeFenced actually sends (apps/api/internal/api/claim_fence.go):
  // the code twice (`error` + `reason`), the holder twice (`holder` + `claimedBy`),
  // the flag, the live generation, and its own STOP sentence.
  const fence = {
    error: "claimed_by_other",
    reason: "claimed_by_other",
    fenced: true,
    holder: "worker-a",
    claimedBy: "worker-a",
    claimGeneration: 4,
    message: "STOP — worker-a holds this task at generation 4.",
  };
  for (const status of [409, 412]) {
    resetLossLedger();
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/mcp/auth") {
        return new Response(
          JSON.stringify({ token: "t", canvasId: "canvas-1", canvasName: "C", canvasCode: CODE }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (method === "PATCH") {
        return new Response(JSON.stringify(fence), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      // The action read task_complete does before its terminal PATCH.
      return new Response(JSON.stringify({ action: { state: "executing", claimedBy: "worker-a" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    try {
      const b = await connect({ role: "executor", name: "worker-b" });

      const claim = (await handleFacadeTool(b.gw, "task_claim", { id: "task-9" })) as any;
      assert.equal(claim.claimed, false, `${status}: a fence must not throw`);
      assert.equal(claim.tapOut, true);
      assert.equal(claim.reason, "fenced");
      assert.equal(claim.fenced, true, "the API's own signal is passed through");
      assert.equal(claim.holder, "worker-a", "`holder` is read as well as `claimedBy`");
      assert.equal(claim.next, "queue_next");
      assert.equal(
        claim.claimGeneration,
        4,
        "the live generation is passed through — it is what a legitimate re-claim presents"
      );
      // `fenced` overrides the code: the API's own error string here is the
      // pre-fence "claimed_by_other", and the flag is what says it was fenced.
      assert.equal(claim.reason, "fenced");
      assert.match(claim.message, /no longer current/i);
      assert.match(claim.message, /Do NOT work on it/);

      // Same fence on the terminal write — one shape, whichever call hit it.
      const done = (await handleFacadeTool(b.gw, "task_complete", {
        id: "task-8",
        result: "finished something that moved on",
      })) as any;
      assert.equal(done.completed, false);
      assert.equal(done.tapOut, true);
      assert.equal(done.reason, "fenced");
      assert.equal(done.holder, "worker-a");
    } finally {
      globalThis.fetch = real;
    }
  }
});

// The generic state MOVE used to let a 409 THROW, which is the one shape a model
// cannot route on: a protocol error mid-run. It taps out like everything else now.
test("a state move on a task you do not hold taps out instead of throwing", async () => {
  const api = new FakeApi([readyTask("task-1", "TDM-217", "worker-a's task")]);
  await api.run(async () => {
    const a = await connect({ role: "executor", name: "worker-a" });
    const b = await connect({ role: "executor", name: "worker-b" });
    await handleFacadeTool(a.gw, "task_claim", { id: "task-1" });

    // canvas_action_update_state is CRUD-only, so call it by its own name.
    const moved = (await handleTool(b.gw, "canvas_action_update_state", {
      id: "task-1",
      state: "done",
      agentName: "worker-b",
    })) as any;
    assert.equal(moved.moved, false, "a rejected move resolves");
    assert.equal(moved.tapOut, true);
    assert.equal(moved.reason, "not_your_claim");
    assert.equal(moved.holder, "worker-a");
    assert.equal(moved.next, "queue_next");
    assert.equal(api.tasks.get("task-1")!.state, "executing", "the refusal left it alone");
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
