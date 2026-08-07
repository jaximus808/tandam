/**
 * TDM-9 — the handoff carries SHARED-CHECKOUT conventions when, and only when,
 * the read is actually a fan-out.
 *
 * THE FAILURE THIS PINS. Workers dispatched from one queue read share a single
 * working copy, and every collision seen in practice came from a worker doing
 * the locally-correct thing: two agents independently invented a package-level
 * test fixture with the same obvious name (a compile error, not a merge
 * conflict); formatter noise belonging to somebody else's uncommitted edit was
 * nearly "fixed"; a repo-wide `git add` swept a second ticket's half-finished
 * hunks into the wrong commit. That is not a rule of any one repo — it is what
 * "you are not alone in this checkout" means — so it rides in the dispatch
 * payload, which is the one thing every parallel worker provably reads. (TDM-8
 * put it in this repo's CLAUDE.md instead, and was rejected for being
 * repo-specific.)
 *
 * And the NEGATIVE half is the real contract: a solo read must stay exactly as
 * it was. A lone worker told to defend against collisions that cannot happen is
 * noise, and noise is what trains an agent to skim the steps it should follow.
 *
 * Both queue reads are pinned, because queue_wait's ready branch and queue_next
 * must hand back the same object (TDM-149) — a convention that appeared on only
 * one of them would be a coin flip on how the batch was started.
 *
 * No network: global fetch is replaced with a small recorder.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleFacadeTool } from "../src/facade.js";
import { handleTool } from "../src/tools.js";
import { recordLoss, resetLossLedger } from "../src/tapout.js";

// The loss ledger is process-global and keyed by canvas + claimant; these tests
// reuse one canvas, so it starts empty or the tap-out case would leak.
beforeEach(resetLossLedger);

const TDM9_AUTH = {
  token: "jwt-token",
  canvasId: "canvas-1",
  canvasName: "Test Canvas",
  canvasCode: "TESTCODE",
};

/** Raw actions exactly as GET /api/canvas/actions and the wait return them. */
function tdm9ReadyAction(id: string, ticketId: string, title: string, claimedBy?: string) {
  return {
    id,
    ticketId,
    state: "approved",
    proposedBy: "agent",
    createdAt: "2026-08-06T00:00:00Z",
    ...(claimedBy ? { claimedBy } : {}),
    payload: { title, assignee: "agent" },
  };
}

const TDM9_TWO = [
  tdm9ReadyAction("task-aaa", "TDM-901", "Wire the thing"),
  tdm9ReadyAction("task-bbb", "TDM-902", "Unwire the other thing"),
];
const TDM9_ONE = [tdm9ReadyAction("task-solo", "TDM-903", "The only thing")];

function tdm9Json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Tdm9Routes = {
  actions?: unknown[];
  /** Present only for the queue_wait tests. */
  wait?: unknown[];
};

async function withTdm9Fetch<T>(routes: Tdm9Routes, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/mcp/auth") return tdm9Json(TDM9_AUTH);
    if (url.pathname === "/api/canvas/agents") return tdm9Json({ agentId: "planner-77" }, 201);
    if (url.pathname === "/api/canvas/state") return tdm9Json({ canvas: {} });
    if (url.pathname === "/api/canvas/queue/wait") {
      const actions = routes.wait ?? [];
      return tdm9Json({
        type: "queue.wait",
        status: "ready",
        actions,
        count: actions.length,
        waitedMs: 4200,
        timeoutSeconds: 25,
      });
    }
    if (url.pathname === "/api/canvas/actions") {
      return tdm9Json({ actions: routes.actions ?? [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

type Tdm9Queue = { tasks: Array<Record<string, any>> };

/** A connected, registered planner — the caller a fan-out is dispatched from. */
async function tdm9Planner(): Promise<Gateway> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", { code: "TESTCODE", role: "planner", name: "the-planner" });
  return gw;
}

/** The conventions step of a handoff, or undefined when it carries none. */
function tdm9ConventionsStep(handoff: { steps: string[] } | undefined): string | undefined {
  return handoff?.steps.find((s) => /shared checkout/i.test(s));
}

test("2+ ready tasks: every handoff carries the shared-checkout conventions step", async () => {
  await withTdm9Fetch({ actions: TDM9_TWO }, async () => {
    const gw = await tdm9Planner();
    const result = (await handleFacadeTool(gw, "queue_next", {})) as Tdm9Queue;

    assert.equal(result.tasks.length, 2);
    for (const t of result.tasks) {
      const step = tdm9ConventionsStep(t.handoff);
      assert.ok(step, `${t.ticketId} must carry the conventions step`);

      // ONE step, not a lecture split across the sequence.
      const all: string[] = t.handoff.steps;
      assert.equal(
        all.filter((s) => /shared checkout/i.test(s)).length,
        1,
        "exactly one conventions step"
      );

      // The five conventions, each of which is a collision observed in practice.
      assert.match(step!, /surface/i, "scope edits to your own ticket's surface");
      assert.match(step!, /ticket-unique/i, "ticket-unique names for shared test fixtures");
      assert.match(step!, /lint\/format|format/i, "leave foreign formatting noise alone");
      assert.match(step!, /git add/i, "stage by explicit path, never a repo-wide add");
      assert.match(step!, /uncommitted/i, "let the other ticket commit its hunks first");
    }
  });
});

test("the conventions step sits between the work step and the reporting steps", async () => {
  await withTdm9Fetch({ actions: TDM9_TWO }, async () => {
    const gw = await tdm9Planner();
    const result = (await handleFacadeTool(gw, "queue_next", {})) as Tdm9Queue;
    const steps: string[] = result.tasks[0].handoff.steps;

    const at = steps.findIndex((s) => /shared checkout/i.test(s));
    const get = steps.findIndex((s) => s.startsWith("task_get"));
    const progress = steps.findIndex((s) => s.startsWith("task_progress"));

    assert.ok(at > get, "read before you start editing, not before you have the brief");
    assert.ok(at < progress, "and before the reporting tail");

    // The dispatch sequence itself is untouched — this ticket ADDS a step, it
    // does not reorder the contract the worker follows.
    assert.match(steps[0], /canvas_connect/);
    assert.match(steps[1], /task_claim/);
    assert.match(steps[steps.length - 1], /task_complete/);
  });
});

test("a SINGLE ready task gets the unchanged solo steps — no conventions noise", async () => {
  await withTdm9Fetch({ actions: TDM9_ONE }, async () => {
    const gw = await tdm9Planner();
    const result = (await handleFacadeTool(gw, "queue_next", {})) as Tdm9Queue;

    assert.equal(result.tasks.length, 1);
    const steps: string[] = result.tasks[0].handoff.steps;
    assert.equal(tdm9ConventionsStep(result.tasks[0].handoff), undefined);
    // Nothing about sharing a checkout leaked in under another wording.
    assert.doesNotMatch(steps.join("\n"), /git add|ticket-unique/i);
    // Still a complete, usable handoff.
    assert.match(steps[0], /canvas_connect/);
    assert.match(steps[1], /task_claim/);
  });
});

test("tap-outs do not make a read parallel: one live task plus a lost one stays solo", async () => {
  const lost = tdm9ReadyAction("task-lost", "TDM-904", "Already lost", "another-agent");
  await withTdm9Fetch({ actions: [lost, ...TDM9_ONE] }, async () => {
    const gw = await tdm9Planner();
    // This session raced for `task-lost` and lost it: it comes back marked and
    // carries no handoff, so it dispatches nobody and cannot make company.
    recordLoss(gw, "task-lost", { holder: "another-agent", reason: "already_claimed" });

    const result = (await handleFacadeTool(gw, "queue_next", {})) as Tdm9Queue;
    const marked = result.tasks.find((t) => t.id === "task-lost");
    const live = result.tasks.find((t) => t.id === "task-solo");

    assert.equal(marked?.lostByYou, true);
    assert.equal(marked?.handoff, undefined, "a lost task is never dispatched");
    assert.ok(live?.handoff, "the live one still dispatches");
    assert.equal(
      tdm9ConventionsStep(live!.handoff),
      undefined,
      "only one worker is going out — the conventions would be noise"
    );
  });
});

test("queue_wait's ready branch hands back the SAME conventions, both ways", async () => {
  // Parallel: the waited-for handoff must equal the read-for one (TDM-149).
  await withTdm9Fetch({ wait: TDM9_TWO }, async () => {
    const gw = await tdm9Planner();
    const result = (await handleFacadeTool(gw, "queue_wait", {})) as Tdm9Queue & { status: string };

    assert.equal(result.status, "ready");
    assert.equal(result.tasks.length, 2);
    for (const t of result.tasks) {
      assert.ok(tdm9ConventionsStep(t.handoff), `${t.ticketId} must carry the conventions step`);
    }
  });

  // Solo: and the wait must not invent a fan-out that isn't there.
  await withTdm9Fetch({ wait: TDM9_ONE }, async () => {
    const gw = await tdm9Planner();
    const result = (await handleFacadeTool(gw, "queue_wait", {})) as Tdm9Queue;
    assert.equal(result.tasks.length, 1);
    assert.equal(tdm9ConventionsStep(result.tasks[0].handoff), undefined);
  });
});
