/**
 * TDM-156 — `task_review`: the reviewer's one verb, two outcomes.
 *
 * The RULES are not tested here because the gateway does not own them: the API
 * decides, from provenance it derives itself, whether this agent may approve
 * (peer_approval.go) or bounce (task_rework_test.go) another agent's work. What
 * IS the gateway's job, and what these pin:
 *
 *   1. `outcome` picks the ENDPOINT and nothing else — 'pass' → approve (empty
 *      body, identity on the header), 'changes_requested' → rework with the
 *      reason. No pre-flight, no local rule;
 *   2. a refusal is DATA with a `_next`, never a thrown error — including the
 *      400 the rework endpoint answers when the work isn't finished, which is
 *      the likeliest reviewer mistake there is;
 *   3. a refusal code this build has never seen still reads as prose, so an API
 *      that grows a new one (TDM-155's same-model refusal) does not need a
 *      gateway release to be usable;
 *   4. the surface advertises ONE review verb, and the name it shipped under
 *      (task_approve) still routes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool, isFacadeTool } from "../src/facade.js";
import { FACADE_TOOLS } from "../src/server.js";

const CODE = "TESTCODE";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = { method: string; path: string; body: any };

function install(opts: { approve?: () => Response; rework?: () => Response }) {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });

    if (url.pathname === "/api/mcp/auth") {
      return json({ token: "t", canvasId: "canvas-1", canvasName: "C", canvasCode: CODE });
    }
    if (url.pathname === "/api/canvas/agents" && method === "POST") {
      return json({ agentId: "agent-1", name: body?.name }, 201);
    }
    if (url.pathname.endsWith("/approve") && method === "POST") {
      return (opts.approve ?? (() => json({ action: { id: "t1", state: "approved" } })))();
    }
    if (url.pathname.endsWith("/rework") && method === "POST") {
      return (opts.rework ?? (() => json({ action: { id: "t1", state: "approved" } })))();
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

async function connect(name = "reviewer-a"): Promise<Gateway> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", { code: CODE, role: "executor", name });
  return gw;
}

// ── outcome routes, and nothing else ─────────────────────────────────────────

test("'pass' POSTs the approve endpoint with no approver in the body", async () => {
  const { calls, restore } = install({
    approve: () =>
      json({
        action: {
          id: "task-1",
          ticketId: "TDM-21",
          state: "approved",
          approvedBy: "agent:reviewer-a",
          payload: { title: "Wire the thing" },
        },
      }),
  });
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_review", {
      id: "TDM-21",
      outcome: "pass",
    })) as any;
    assert.equal(out.reviewed, true);
    assert.equal(out.outcome, "pass");
    assert.equal(out.ticketId, "TDM-21");
    assert.equal(out.approvedBy, "agent:reviewer-a");

    const post = calls.find((c) => c.path.endsWith("/approve"))!;
    assert.equal(post.path, "/api/canvas/actions/TDM-21/approve", "ticket ref passed through");
    assert.deepEqual(post.body, {}, "no client-asserted approver (TDM-40 / TDM-129)");
    // The reviewer must not then work what it reviewed.
    assert.match(out._next, /two hats/);
  } finally {
    restore();
  }
});

test("'changes_requested' POSTs the rework endpoint carrying the reason", async () => {
  const { calls, restore } = install({
    rework: () =>
      json({
        action: { id: "task-1", ticketId: "TDM-21", state: "approved", payload: { title: "T" } },
      }),
  });
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_review", {
      id: "TDM-21",
      outcome: "changes_requested",
      reason: "  the fence is never checked  ",
    })) as any;
    assert.equal(out.reviewed, true);
    assert.equal(out.outcome, "changes_requested");
    assert.equal(out.state, "approved", "the bounce rewinds done → approved");
    assert.equal(out.reason, "the fence is never checked", "trimmed, and echoed back");

    const post = calls.find((c) => c.path.endsWith("/rework"))!;
    assert.equal(post.path, "/api/canvas/actions/TDM-21/rework");
    assert.deepEqual(post.body, { reason: "the fence is never checked" });
    assert.ok(
      !calls.some((c) => c.path.endsWith("/approve")),
      "a bounce never touches the approve path"
    );
    // The bounce puts it back in the queue for SOMEONE ELSE.
    assert.match(out._next, /queue_next|ready queue/);
    assert.match(out._next, /NOT claim it/);
  } finally {
    restore();
  }
});

// ── argument shape, refused before any request ───────────────────────────────

test("a bounce with no reason is refused before the request", async () => {
  const { calls, restore } = install({});
  try {
    const gw = await connect();
    const before = calls.length;
    await assert.rejects(
      () =>
        handleFacadeTool(gw, "task_review", {
          id: "TDM-21",
          outcome: "changes_requested",
        }) as Promise<unknown>,
      /`reason` \(string\) is required/
    );
    assert.equal(calls.length, before, "nothing is sent");
  } finally {
    restore();
  }
});

test("an outcome that is not one of the two is refused, and says why there is no third", async () => {
  const { calls, restore } = install({});
  try {
    const gw = await connect();
    const before = calls.length;
    for (const outcome of ["reject", "fail", ""]) {
      await assert.rejects(
        () => handleFacadeTool(gw, "task_review", { id: "TDM-21", outcome }) as Promise<unknown>,
        /`outcome` must be/
      );
    }
    assert.equal(calls.length, before);
  } finally {
    restore();
  }
});

test("a missing id is refused before any request", async () => {
  const { calls, restore } = install({});
  try {
    const gw = await connect();
    const before = calls.length;
    await assert.rejects(
      () => handleFacadeTool(gw, "task_review", { outcome: "pass" }) as Promise<unknown>,
      /`id` \(string\) is required/
    );
    assert.equal(calls.length, before);
  } finally {
    restore();
  }
});

// ── refusals are answers ─────────────────────────────────────────────────────

test("400 rework_not_finished comes back as data naming the state and the way out", async () => {
  const { restore } = install({
    rework: () =>
      json(
        {
          error: "rework_not_finished",
          message: "only a finished task can be sent back",
          state: "executing",
        },
        400
      ),
  });
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_review", {
      id: "TDM-21",
      outcome: "changes_requested",
      reason: "not covered",
    })) as any;
    assert.equal(out.reviewed, false);
    assert.equal(out.refusal, "rework_not_finished");
    assert.equal(out.state, "executing", "the server's extras ride along");
    assert.match(out._next, /executing/, "the prose names the state it is actually in");
    assert.match(out._next, /'pass'|proposed/, "and what the other outcome is for");
  } finally {
    restore();
  }
});

test("403 rework_self_review reads as 'you did this work', not as an error", async () => {
  const { restore } = install({
    rework: () =>
      json(
        {
          error: "rework_self_review",
          message: "the reviewer completed this task",
          reviewer: "agent:reviewer-a",
          completedBy: "agent:reviewer-a",
        },
        403
      ),
  });
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_review", {
      id: "TDM-21",
      outcome: "changes_requested",
      reason: "x",
    })) as any;
    assert.equal(out.reviewed, false);
    assert.equal(out.refusal, "rework_self_review");
    assert.equal(out.completedBy, "agent:reviewer-a");
    assert.match(out._next, /You finished this task/);
  } finally {
    restore();
  }
});

test("'pass' on work that is already finished routes to the OTHER outcome, not to the policy", async () => {
  // The state machine's uncoded 400 ("illegal transition: done → approved").
  // Answering it with the human-only sentence would send a reviewer away from a
  // canvas it is allowed to review on.
  const { restore } = install({
    approve: () => json({ error: "illegal transition: done → approved" }, 400),
  });
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_review", {
      id: "TDM-21",
      outcome: "pass",
    })) as any;
    assert.equal(out.reviewed, false);
    assert.equal(out.refusal, "not_reviewable");
    assert.match(out._next, /changes_requested/);
    assert.doesNotMatch(out._next, /'peer' approval policy/);
  } finally {
    restore();
  }
});

test("the legacy uncoded 403 still reads as 'this canvas is not on peer'", async () => {
  const { restore } = install({
    approve: () => json({ error: "only a signed-in human can approve an action" }, 403),
  });
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_review", {
      id: "TDM-21",
      outcome: "pass",
    })) as any;
    assert.equal(out.refusal, "human_approval_only");
    assert.match(out._next, /'peer'/);
    assert.match(out._next, /owner/);
  } finally {
    restore();
  }
});

// ── forward compatibility: a code this build has never heard of ──────────────

test("an UNKNOWN refusal code degrades to the server's own words, not to a wrong sentence", async () => {
  for (const [outcome, stub] of [
    ["pass", "approve"],
    ["changes_requested", "rework"],
  ] as const) {
    const { restore } = install({
      [stub]: () =>
        json({ error: "peer_moon_phase_wrong", message: "the moon is gibbous", detail: "d" }, 403),
    } as any);
    try {
      const gw = await connect();
      const out = (await handleFacadeTool(gw, "task_review", {
        id: "TDM-21",
        outcome,
        reason: "r",
      })) as any;
      assert.equal(out.reviewed, false);
      assert.equal(out.refusal, "peer_moon_phase_wrong");
      assert.match(out._next, /the moon is gibbous/, `${outcome}: quotes the server`);
      assert.match(out._next, /do not retry/i, `${outcome}: says it is a decision, not a fault`);
      // The bug this replaces: the old default sentence claimed the canvas was
      // not on 'peer', which is a different (and usually wrong) answer.
      assert.doesNotMatch(out._next, /not on the 'peer' approval policy/);
    } finally {
      restore();
    }
  }
});

test("a same-model refusal (TDM-155) gets same-model prose on both doors", async () => {
  // The two codes the API actually ships (peer_approval.go), plus the models it
  // attaches so the prose can name the collision.
  for (const code of ["peer_same_model", "rework_same_model"]) {
    const body = {
      error: code,
      message: "reviewer is the same model",
      approverModel: "claude-opus-5",
      reviewerModel: "claude-opus-5",
    };
    const { restore } = install({
      approve: () => json(body, 403),
      rework: () => json(body, 403),
    });
    try {
      const gw = await connect();
      for (const outcome of ["pass", "changes_requested"]) {
        const out = (await handleFacadeTool(gw, "task_review", {
          id: "TDM-21",
          outcome,
          reason: "r",
        })) as any;
        assert.equal(out.refusal, code);
        assert.match(out._next, /same MODEL/, `${code}/${outcome}: names the real problem`);
        assert.match(out._next, /claude-opus-5/, "and the model that collided");
        assert.match(out._next, /different model|the human/);
      }
    } finally {
      restore();
    }
  }
});

// ── the surface ──────────────────────────────────────────────────────────────

test("one review verb is advertised, and it teaches both outcomes", () => {
  const names = FACADE_TOOLS.map((t) => t.name);
  assert.ok(names.includes("task_review"));
  assert.ok(
    !names.includes("task_approve"),
    "two review verbs would make 'which one applies?' the model's problem"
  );
  const tool = FACADE_TOOLS.find((t) => t.name === "task_review")!;
  const outcome = (tool.inputSchema.properties as Record<string, any>).outcome;
  assert.deepEqual(outcome.enum, ["pass", "changes_requested"]);
  assert.deepEqual(tool.inputSchema.required, ["id", "outcome"]);
  // The reason is the whole content of a bounce — the description has to say so.
  assert.match(tool.description, /REQUIRED on 'changes_requested'|reason/i);
  // And the two things an agent may NOT do, so it does not go looking.
  assert.match(tool.description, /reject/i);
  assert.match(tool.description, /epic/i);
});

test("the name the reviewer's tool shipped under still routes (TDM-146 sessions)", () => {
  assert.equal(isFacadeTool("task_approve"), true, "unadvertised, but not removed");
  assert.equal(isFacadeTool("task_review"), true);
});
