/**
 * TDM-167 — the loss ledger has to let go of a DEAD holder.
 *
 * The anti-loop guard (TDM-99, edge-claim.test.ts) is not in question here: a
 * session that lost a claim must stop asking, and it does. What is pinned here
 * is the way OUT of that refusal when the winner dies mid-task, because both of
 * the documented escapes were unreachable for exactly that case:
 *
 *   - queue_next clears a loss only when the server lists the task as ready and
 *     unheld — and a task stuck `executing` under a dead holder is never in the
 *     ready queue;
 *   - the TTL never elapsed, because every retry re-stamped the entry's clock.
 *     Asking again at minute 14 pushed the deadline to minute 29, forever.
 *
 * During E20 that stranded TDM-154 twice: a worker built and committed a whole
 * ticket, then could neither claim it nor heartbeat on it, so the board showed
 * no trail and a human had to release it by hand.
 *
 * The contract now: the clock starts at the FIRST loss of a streak and nothing
 * pushes it forward, so one claim per lease reaches the server and the SERVER
 * decides — a live holder still wins (the guard is not removed), a dead one's
 * lease has expired and the re-claim succeeds. Same session, same agent name, no
 * re-registration, no human.
 *
 * No network: global fetch is replaced by a small in-memory API that implements
 * the two REAL asymmetric rules this ticket turns on —
 *   1. the claim path expires a stale claim lazily, at claim time
 *      (store.DefaultClaimTTL / supabaseStore.claim);
 *   2. the write fence (progress / complete) is IDENTITY-only — it refuses on
 *      the holder's name whatever the lease age (claim_fence.go).
 * Time is a fake clock the ledger is wound onto, so "15 minutes later" costs
 * nothing.
 */
import { beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool } from "../src/facade.js";
import {
  LOSS_TTL_MS,
  bumpLoss,
  findLoss,
  recordLoss,
  resetLossLedger,
  setLossClock,
} from "../src/tapout.js";

const CODE = "TESTCODE";
/** The server's claim lease — the same 15 min store.DefaultClaimTTL uses. */
const LEASE_MS = 15 * 60 * 1000;

// The ledger is process-global and keyed by canvas + claimant, and these tests
// reuse names on one canvas id, so it has to be dropped between them.
let clock = 0;
beforeEach(() => {
  resetLossLedger();
  clock = Date.parse("2026-08-01T00:00:00Z");
  setLossClock(() => clock);
});
afterEach(() => setLossClock());

/** Wind every clock in the test — the ledger's and the fake API's. */
function advance(ms: number): void {
  clock += ms;
}

type Task = {
  id: string;
  ticketId: string;
  state: string;
  claimedBy?: string;
  /** Milliseconds, on the same fake clock: the lease stamp. */
  claimedAt?: number;
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
    createdAt: "2026-08-01T00:00:00Z",
    payload: { title, assignee: "agent" },
  };
}

class FakeApi {
  tasks = new Map<string, Task>();
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

  /**
   * The claim decision, with the server's LAZY expiry: a claim older than the
   * lease is stale and the next claimer takes the task. This is the rule the
   * whole ticket rests on — without it there would be nothing for the gateway to
   * let through to.
   */
  private claim(task: Task, agentName: string): Response {
    if (task.state === "executing") {
      const holder = task.claimedBy ?? "";
      const heldFor = clock - (task.claimedAt ?? 0);
      const stale = heldFor >= LEASE_MS;
      if (holder && holder !== "agent" && holder !== agentName && !stale) {
        return this.json({ error: "claimed_by_other", claimedBy: holder, fenced: true }, 409);
      }
    } else if (task.state !== "approved") {
      return this.json({ error: "illegal transition" }, 400);
    }
    task.state = "executing";
    task.claimedBy = agentName;
    task.claimedAt = clock;
    return this.json({ action: { ...task } });
  }

  /**
   * A status report (heartbeat). IDENTITY-only, like claim_fence.go: a rival is
   * refused however old the lease is — which is why a refused heartbeat must not
   * be allowed to extend a loss.
   */
  private status(task: Task, agentName: string): Response {
    const holder = task.claimedBy ?? "";
    if (holder && holder !== "agent" && holder !== agentName) {
      return this.json(
        { error: "claimed_by_other", reason: "claimed_by_other", claimedBy: holder, holder, fenced: true },
        409
      );
    }
    task.claimedAt = clock; // the holder's heartbeat pushes its own lease out
    return this.json({ action: { ...task } });
  }

  /** PATCHes against one action — i.e. claim attempts that reached the API. */
  writesTo(id: string): number {
    return this.calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/actions/${id}`)).length;
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
      return this.json({ agentId: `agent-${this.nextAgent++}`, ...body }, 201);
    }
    const status = path.match(/^\/api\/canvas\/[^/]+\/tasks\/([^/]+)\/status$/);
    if (status && method === "POST") {
      const task = this.tasks.get(status[1]);
      if (!task) return this.json({ error: "not found" }, 404);
      return this.status(task, String(body?.agent ?? ""));
    }
    const one = path.match(/^\/api\/canvas\/actions\/([^/]+)$/);
    if (one) {
      const task = this.tasks.get(one[1]);
      if (!task) return this.json({ error: "not found" }, 404);
      if (method === "GET") return this.json({ action: { ...task } });
      if (method === "PATCH") {
        const agentName = String(body?.agentName ?? "");
        if (body?.state === "executing") return this.claim(task, agentName);
        task.state = String(body.state);
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
      return this.handle(url, method, body);
    }) as typeof globalThis.fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = real;
    }
  }
}

async function connect(name: string): Promise<Gateway> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", { code: CODE, role: "executor", name });
  return gw;
}

// ── The ledger's own clock ────────────────────────────────────────────────────

test("a repeat local refusal counts the ask but does not extend the loss (TDM-167)", async () => {
  const api = new FakeApi([]);
  await api.run(async () => {
    const gw = await connect("worker-b");
    const first = recordLoss(gw, "task-1", { holder: "worker-a", reason: "already_claimed" });
    assert.equal(first.attempts, 1);

    // Ask again and again, right up to the edge of the lease.
    advance(LOSS_TTL_MS - 60_000);
    const live = findLoss(gw, "task-1");
    assert.ok(live, "inside the lease the loss is still proof");
    const again = bumpLoss(gw, live);
    assert.equal(again.attempts, 2, "the ask is counted");
    assert.equal(again.at, first.at, "…but the deadline is where the FIRST loss put it");
    assert.equal(again.lastAt, clock, "the retry is recorded as the newest ask, separately");

    // The minute the lease is up, the entry is gone — the old bug was that this
    // moment was pushed forward by the very retries it exists to refuse.
    advance(60_000);
    assert.equal(findLoss(gw, "task-1"), undefined, "the loss expires on schedule");
  });
});

test("a refused heartbeat re-records the loss without buying the holder more time", async () => {
  const api = new FakeApi([]);
  await api.run(async () => {
    const gw = await connect("worker-b");
    const first = recordLoss(gw, "task-1", { holder: "worker-a", reason: "already_claimed" });

    // The write fence is identity-only, so a rejected progress/complete says
    // nothing about whether the lease is still live. It must not reset the clock.
    advance(LOSS_TTL_MS - 1000);
    const second = recordLoss(gw, "task-1", { holder: "worker-a", reason: "not_your_claim" });
    assert.equal(second.at, first.at, "a rival's name is not evidence of a live lease");
    assert.equal(second.attempts, 2);
    assert.equal(second.reason, "not_your_claim");

    advance(2000);
    assert.equal(findLoss(gw, "task-1"), undefined);
  });
});

test("a loss recorded after an expired streak starts a fresh clock", async () => {
  const api = new FakeApi([]);
  await api.run(async () => {
    const gw = await connect("worker-b");
    const first = recordLoss(gw, "task-1", { holder: "worker-a", reason: "already_claimed" });
    advance(LOSS_TTL_MS + 1000);
    assert.equal(findLoss(gw, "task-1"), undefined);

    // Re-raced, and lost again: that is a NEW refusal with its own lease, not a
    // continuation of the lapsed one.
    const next = recordLoss(gw, "task-1", { holder: "worker-a", reason: "already_claimed" });
    assert.notEqual(next.at, first.at);
    assert.equal(next.at, clock);
    assert.equal(next.attempts, 1, "the count restarts with the streak");
    assert.ok(findLoss(gw, "task-1"));
  });
});

// ── End to end: the E20 case ──────────────────────────────────────────────────

test("a task whose holder went dark can be re-claimed by the loser, same session, same name", async () => {
  const api = new FakeApi([readyTask("task-1", "TDM-167", "the stranded task")]);
  await api.run(async () => {
    const a = await connect("worker-a");
    const b = await connect("worker-b");

    await handleFacadeTool(a, "task_claim", { id: "task-1" });
    const lost = (await handleFacadeTool(b, "task_claim", { id: "task-1" })) as any;
    assert.equal(lost.claimed, false);
    assert.equal(lost.tapOut, true);
    assert.equal(lost.reason, "already_claimed");
    const writesAfterLoss = api.writesTo("task-1");

    // worker-b keeps bumping into it the way the E20 worker did: a refused
    // heartbeat, then repeat claims. None of this reaches the API…
    advance(60_000);
    const heartbeat = (await handleFacadeTool(b, "task_progress", {
      id: "task-1",
      note: "still going",
    })) as any;
    assert.equal(heartbeat.recorded, false);
    assert.equal(heartbeat.tapOut, true);

    advance(5 * 60_000);
    const repeat = (await handleFacadeTool(b, "task_claim", { id: "task-1" })) as any;
    assert.equal(repeat.reason, "already_lost");
    assert.equal(api.writesTo("task-1"), writesAfterLoss, "a re-race must not reach the API");
    // …and none of it moved the deadline: the refusal names when it lifts.
    assert.match(repeat.message, /lifts by itself in about 9 minutes/);

    // worker-a is dead: no heartbeat, so its lease runs out. Past it, ONE claim
    // is let through, the server sees a stale claim, and worker-b — same session,
    // same name, no re-registration — gets the task.
    advance(LEASE_MS);
    const reclaimed = (await handleFacadeTool(b, "task_claim", { id: "task-1" })) as any;
    assert.equal(reclaimed.claimed, true, "the loser can recover a dead holder's task");
    assert.equal(api.writesTo("task-1"), writesAfterLoss + 1, "exactly one claim was retried");
    assert.equal(api.tasks.get("task-1")!.claimedBy, "worker-b");
    assert.equal(b.claimant(), "worker-b", "and it recovered as ITSELF, not a fresh identity");

    // Having won it, worker-b can report on it again — the thing the stranded
    // E20 worker could not do, which is why its work left no trail on the board.
    const progress = (await handleFacadeTool(b, "task_progress", {
      id: "task-1",
      note: "picked it back up",
    })) as any;
    assert.equal(progress.recorded, true);
  });
});

test("a LIVE holder still wins the re-race — the guard is time-boxed, not removed", async () => {
  const api = new FakeApi([readyTask("task-1", "TDM-167", "the contested task")]);
  await api.run(async () => {
    const a = await connect("worker-a");
    const b = await connect("worker-b");

    await handleFacadeTool(a, "task_claim", { id: "task-1" });
    await handleFacadeTool(b, "task_claim", { id: "task-1" });
    const writesAfterLoss = api.writesTo("task-1");

    // worker-a is alive and heartbeating, so its lease keeps moving.
    for (let i = 0; i < 2; i++) {
      advance(5 * 60_000);
      const beat = (await handleFacadeTool(a, "task_progress", { id: "task-1", note: `step ${i}` })) as any;
      assert.equal(beat.recorded, true);
      // Meanwhile worker-b asks every turn: refused locally, for free.
      const nope = (await handleFacadeTool(b, "task_claim", { id: "task-1" })) as any;
      assert.equal(nope.claimed, false);
      assert.equal(nope.reason, "already_lost");
    }
    assert.equal(api.writesTo("task-1"), writesAfterLoss, "no turn-by-turn re-racing");

    // Past the window one attempt is allowed through — and it LOSES, because the
    // claim really is live (the heartbeat at minute 10 pushed the lease out). The
    // answer is still a tap-out, and the retry budget is one per lease rather
    // than one per turn.
    advance(6 * 60_000);
    const retried = (await handleFacadeTool(b, "task_claim", { id: "task-1" })) as any;
    assert.equal(retried.claimed, false);
    assert.equal(retried.tapOut, true);
    assert.equal(retried.reason, "already_claimed", "it was a real race, and it was lost");
    assert.equal(retried.holder, "worker-a");
    assert.equal(api.writesTo("task-1"), writesAfterLoss + 1);
    assert.equal(api.tasks.get("task-1")!.claimedBy, "worker-a", "the holder keeps its task");

    // And the fresh loss starts a fresh window: back to local refusals.
    const after = (await handleFacadeTool(b, "task_claim", { id: "task-1" })) as any;
    assert.equal(after.reason, "already_lost");
    assert.equal(api.writesTo("task-1"), writesAfterLoss + 1);
  });
});
