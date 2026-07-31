/**
 * TDM-146 — the reviewer's surface: `task_approve`, and the prose around it.
 *
 * The RULE it fronts is not tested here because the gateway does not own it: the
 * API decides, from provenance it derived itself, whether a registered agent may
 * approve a task a DIFFERENT agent proposed on a canvas the owner put on the
 * 'peer' policy (apps/api/internal/api/peer_approval.go, covered by
 * peer_approval_test.go). What IS the gateway's job, and what these tests pin:
 *
 *   1. it calls the EXISTING approve endpoint and sends no approver in the body
 *      (the identity rides the header the server derives from);
 *   2. a 403 comes back as DATA a model can route on, not a thrown error;
 *   3. a coded refusal keeps the server's code, and the LEGACY uncoded refusal —
 *      what every strict|epic|auto canvas still answers, byte for byte — is not
 *      mislabelled as one;
 *   4. prose that used to say "a human approves" is conditioned on the canvas's
 *      policy rather than deleted, because it stays true everywhere else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool } from "../src/facade.js";
import { FACADE_TOOLS, SERVER_INSTRUCTIONS } from "../src/server.js";

const CODE = "TESTCODE";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = { method: string; path: string; body: any };

/**
 * Stub the API. `approve` answers POST …/approve; `policy` is what the canvas
 * meta read reports (undefined = the endpoint is unavailable, which every caller
 * must survive).
 */
function install(opts: {
  approve?: () => Response;
  policy?: string;
  state?: Record<string, unknown>;
  actions?: unknown[];
}) {
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
    if (url.pathname === "/api/canvas/state") {
      if (opts.policy === undefined) return json({ error: "not found" }, 404);
      return json({ type: "state", canvas: { approvalPolicy: opts.policy }, state: {} });
    }
    if (url.pathname.endsWith("/approve") && method === "POST") {
      return (opts.approve ?? (() => json({ action: { id: "t1", state: "approved" } })))();
    }
    if (url.pathname === "/api/canvas/actions") {
      return json({ actions: opts.actions ?? [] });
    }
    if (url.pathname.startsWith("/api/canvas/actions/")) {
      return json({ action: { type: "task", ...(opts.state ?? {}) } });
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

// ── The tool ─────────────────────────────────────────────────────────────────

test("task_approve POSTs the existing approve endpoint with NO approver in the body", async () => {
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
    const out = (await handleFacadeTool(gw, "task_approve", { id: "TDM-21" })) as any;
    assert.equal(out.approved, true);
    assert.equal(out.ticketId, "TDM-21");
    assert.equal(out.title, "Wire the thing");
    // The server-stamped prefix is what tells a peer approval from a human one.
    assert.equal(out.approvedBy, "agent:reviewer-a");

    const post = calls.find((c) => c.path.endsWith("/approve"));
    assert.ok(post, "it calls the approve route");
    assert.equal(post!.path, "/api/canvas/actions/TDM-21/approve", "no new route, ticket ref passed through");
    // The forgery vector TDM-40/TDM-129 closed: no client-asserted approver.
    assert.deepEqual(post!.body, {});
    // And no policy pre-flight — the server owns the rule.
    assert.ok(
      !calls.some((c) => c.path.startsWith("/api/canvas/state")),
      "approving does not read the policy first"
    );
  } finally {
    restore();
  }
});

test("a coded 403 comes back as DATA carrying the server's reason, not a throw", async () => {
  const { restore } = install({
    approve: () =>
      json(
        {
          error: "peer_self_approval",
          message: "self-approval is refused: …",
          approver: "agent:reviewer-a",
          proposedBy: "agent:reviewer-a",
        },
        403
      ),
  });
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_approve", { id: "TDM-21" })) as any;
    assert.equal(out.approved, false);
    assert.equal(out.reason, "peer_self_approval");
    assert.match(out.message, /self-approval is refused/);
    // The `extra` the server attached rides along, so the model can say WHO.
    assert.equal(out.proposedBy, "agent:reviewer-a");
    assert.match(out._next, /DIFFERENT registered agent|different/i);
  } finally {
    restore();
  }
});

test("each server refusal code gets its own next step", async () => {
  const codes = [
    ["peer_identity_required", /canvas_connect/],
    ["peer_agent_unregistered", /agent_register|canvas_connect/],
    ["peer_epic_human_only", /[Ee]pics? stay human-only|human/],
    ["peer_proposer_unknown", /human approves/],
  ] as const;
  for (const [code, expected] of codes) {
    const { restore } = install({
      approve: () => json({ error: code, message: "refused" }, 403),
    });
    try {
      const gw = await connect();
      const out = (await handleFacadeTool(gw, "task_approve", { id: "TDM-21" })) as any;
      assert.equal(out.reason, code);
      assert.match(out._next, expected, `${code} must route somewhere useful`);
    } finally {
      restore();
    }
  }
});

test("the LEGACY uncoded 403 is not mislabelled as a peer code (strict|epic|auto)", async () => {
  // A canvas that is not on 'peer' answers exactly what it answered before peer
  // approval existed: prose in `error`, no `message`, no code. Reading `error` as
  // a code there would hand the model the whole refusal sentence as a "reason".
  const { restore } = install({
    approve: () => json({ error: "only a signed-in human can approve an action" }, 403),
  });
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_approve", { id: "TDM-21" })) as any;
    assert.equal(out.approved, false);
    assert.equal(out.reason, "human_approval_only");
    assert.equal(out.message, "only a signed-in human can approve an action");
    assert.match(out._next, /'peer'/);
    assert.match(out._next, /owner/);
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
      () => handleFacadeTool(gw, "task_approve", {}) as Promise<unknown>,
      /`id` \(string\) is required/
    );
    assert.equal(calls.length, before, "no request on a malformed call");
  } finally {
    restore();
  }
});

// ── Conditioned prose (not deleted — still true on every other canvas) ───────

test("an empty queue says 'a human approves' on a normal canvas", async () => {
  const { restore } = install({ policy: "epic", actions: [] });
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "queue_next", {})) as any;
    assert.match(out._next, /need a human to approve them/);
    assert.doesNotMatch(out._next, /task_approve/);
  } finally {
    restore();
  }
});

test("an empty queue points a reviewer at task_approve on a 'peer' canvas", async () => {
  const { restore } = install({ policy: "peer", actions: [] });
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "queue_next", {})) as any;
    assert.match(out._next, /task_approve/);
    assert.match(out._next, /DIFFERENT agent/);
  } finally {
    restore();
  }
});

test("an unreadable policy degrades to the human-only wording", async () => {
  // policy: undefined → the meta read 404s. "We could not tell" must resolve to
  // the default gate, never to advertising an approval path that will be refused.
  const { restore } = install({ actions: [] });
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "queue_next", {})) as any;
    assert.match(out._next, /need a human to approve them/);
  } finally {
    restore();
  }
});

test("epic_propose stops promising a cascade on a 'peer' canvas", async () => {
  for (const [policy, expect, reject] of [
    ["epic", /cascades to every task/, /does NOT cascade/],
    ["peer", /does NOT cascade/, /and that approval cascades/],
  ] as const) {
    const { restore } = install({ policy });
    // canvas_epic_add / canvas_task_add_batch go through POST /api/canvas/actions.
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/canvas/actions" && (init?.method ?? "GET") === "POST") {
        return json({ id: "epic-1", state: "proposed" }, 201);
      }
      return real(input as any, init);
    }) as typeof globalThis.fetch;
    try {
      const gw = await connect();
      const out = (await handleFacadeTool(gw, "epic_propose", { title: "Batch" })) as any;
      assert.match(out._next, expect, `${policy}: wrong approval story`);
      assert.doesNotMatch(out._next, reject, `${policy}: says the other policy's story too`);
    } finally {
      globalThis.fetch = real;
      restore();
    }
  }
});

test("task_amend's refusal names a reviewer only where one can exist", async () => {
  for (const [policy, expected] of [
    ["epic", /Once a human approves a task it is theirs/],
    ["peer", /reviewer agent under this canvas's 'peer' policy/],
  ] as const) {
    const { restore } = install({
      policy,
      state: { state: "approved", authoredBy: "agent:reviewer-a", payload: { title: "t" } },
    });
    try {
      const gw = await connect();
      await assert.rejects(
        () => handleFacadeTool(gw, "task_amend", { id: "TDM-1", title: "x" }) as Promise<unknown>,
        expected
      );
    } finally {
      restore();
    }
  }
});

// ── What the surface teaches ────────────────────────────────────────────────

test("the reviewer is documented as a second pair of eyes, not a rubber stamp", () => {
  const tool = FACADE_TOOLS.find((t) => t.name === "task_approve")!;
  assert.ok(tool, "task_approve is advertised on the default manifest");
  // The distinction that justifies the role existing at all.
  assert.match(tool.description, /auto/, "must contrast itself with the 'auto' policy");
  assert.match(tool.description, /read/i, "must tell the reviewer to read the work");
  // The narrow scope, so a model does not go looking for what is not there.
  assert.match(tool.description, /own/, "self-approval is refused");
  assert.match(tool.description, /epic/i, "epics stay human-only");
  assert.equal(tool.annotations.readOnlyHint, false, "approving is a write");
});

test("SERVER_INSTRUCTIONS keeps the human gate as the rule and peer as the exception", () => {
  assert.match(SERVER_INSTRUCTIONS, /HUMAN approves it on the board/);
  assert.match(SERVER_INSTRUCTIONS, /exception/);
  assert.match(SERVER_INSTRUCTIONS, /task_approve/);
  assert.ok(SERVER_INSTRUCTIONS.length < 1600, "instructions must stay compact");
});
