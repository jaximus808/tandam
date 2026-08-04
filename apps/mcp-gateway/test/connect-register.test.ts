/**
 * TDM-61 / E9.1 — connect-and-register in ONE call.
 *
 * The fan-out contract is: a subagent is handed the 8-char canvas CODE (never
 * its planner's session handle), comes up as an executor under that planner,
 * then claims its own task. Making registration a SECOND tool call is a step a
 * subagent can skip — and a skipped registration means the fleet tree the board
 * draws never forms. So `canvas_connect` takes the identity fields and does
 * both, and the handle it hands back already carries the registered name.
 *
 * What's pinned here: the POST that registration makes, that the returned handle
 * claims as the registered agent (not the anonymous session id), and that a
 * parentAgentId the canvas rejects DEGRADES to an unparented registration
 * reported as data — never a thrown error, because a subagent that dies on a
 * bad parent id is worse than one working unparented.
 *
 * No network: global fetch is replaced with a recorder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway, parseSession } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";

type Recorded = { method: string; path: string; body: any };

const AUTH_RESPONSE = {
  token: "jwt-token",
  canvasId: "canvas-1",
  canvasName: "Test Canvas",
  canvasCode: "TESTCODE",
};

/**
 * Swap fetch for a recorder answering the auth handshake and the agent POST.
 * `rejectParent` makes the API behave as it really does when parentAgentId does
 * not name an agent on this canvas: HTTP 400 (see RegisterAgent in the API).
 */
function withRecordedFetch(
  run: (calls: Recorded[]) => Promise<void>,
  opts?: { rejectParent?: boolean; failRegister?: boolean }
): Promise<void> {
  const calls: Recorded[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });

    if (url.pathname === "/api/canvases") {
      return new Response(JSON.stringify({ code: "TESTCODE", claimToken: "claim-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/api/mcp/auth") {
      return new Response(JSON.stringify(AUTH_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/api/canvas/agents") {
      if (opts?.failRegister || (opts?.rejectParent && body?.parentAgentId)) {
        return new Response(
          JSON.stringify({ error: "parentAgentId does not name a registered agent on this canvas" }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          agentId: "agent-42",
          ...(body?.parentAgentId ? { parentAgentId: body.parentAgentId } : {}),
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return run(calls).finally(() => {
    globalThis.fetch = real;
  });
}

function freshGateway(): Gateway {
  return new Gateway({ apiUrl: "http://api.test" });
}

/** The claimant a LATER call would present, restored from the handle alone. */
function claimantFromHandle(handle: string): string {
  const gw = freshGateway();
  gw.adoptSession(handle);
  return gw.claimant();
}

test("connect + role registers in one call and returns the agentId", async () => {
  await withRecordedFetch(async (calls) => {
    const res = (await handleTool(freshGateway(), "canvas_connect", {
      code: "TESTCODE",
      role: "executor",
      name: "opus-executor-3",
      model: "claude-opus-4-8",
      parentAgentId: "planner-1",
    })) as Record<string, any>;

    assert.equal(calls.length, 2, "one auth handshake + one registration");
    const post = calls[1];
    assert.equal(post.method, "POST");
    assert.equal(post.path, "/api/canvas/agents");
    assert.deepEqual(post.body, {
      name: "opus-executor-3",
      role: "executor",
      model: "claude-opus-4-8",
      parentAgentId: "planner-1",
    });

    assert.equal(res.connected, true);
    assert.equal(res.agentId, "agent-42", "the agentId must be on the connect result");
    assert.deepEqual(res.agent, {
      registered: true,
      agentId: "agent-42",
      name: "opus-executor-3",
      role: "executor",
      parentAgentId: "planner-1",
    });
  });
});

test("the handle from connect+register already claims as the registered name", async () => {
  await withRecordedFetch(async () => {
    const res = (await handleTool(freshGateway(), "canvas_connect", {
      code: "TESTCODE",
      role: "executor",
      name: "opus-executor-3",
    })) as Record<string, any>;

    // This is the whole point: the hosted sidecar rebuilds a Gateway per call,
    // so identity has to ride INSIDE the handle or the next task_claim would run
    // as an anonymous session-xxxxx and detach from the agent row.
    const session = parseSession(res.session);
    assert.equal(session.agentId, "agent-42");
    assert.equal(session.agentName, "opus-executor-3");
    assert.equal(claimantFromHandle(res.session), "opus-executor-3");
  });
});

test("a nameless registration claims as its role, not a raw id", async () => {
  await withRecordedFetch(async (calls) => {
    const res = (await handleTool(freshGateway(), "canvas_connect", {
      code: "TESTCODE",
      role: "planner",
    })) as Record<string, any>;

    assert.equal(calls[1].body.name, undefined, "the API fills the default");
    assert.equal(res.agent.name, "planner");
    assert.equal(claimantFromHandle(res.session), "planner");
  });
});

test("an unknown parentAgentId still connects — reported as data, unparented", async () => {
  await withRecordedFetch(
    async (calls) => {
      const res = (await handleTool(freshGateway(), "canvas_connect", {
        code: "TESTCODE",
        role: "executor",
        name: "orphan",
        parentAgentId: "not-a-real-agent",
      })) as Record<string, any>;

      // Retried WITHOUT the parent: working unparented beats not working.
      assert.equal(calls.length, 3, "auth + rejected registration + unparented retry");
      assert.equal(calls[1].body.parentAgentId, "not-a-real-agent");
      assert.equal(calls[2].body.parentAgentId, undefined);

      assert.equal(res.connected, true, "a bad parent must not cost the connection");
      assert.equal(res.agentId, "agent-42");
      assert.equal(res.agent.registered, true);
      assert.equal(res.agent.parentAgentId, null);
      // Surfaced as DATA, so the model can act on it (ask for the right id)
      // instead of dying on a thrown error.
      assert.match(res.agent.problem, /parentAgentId/);
      assert.match(res.agent.problem, /not-a-real-agent/);
      assert.equal(claimantFromHandle(res.session), "orphan");
    },
    { rejectParent: true }
  );
});

test("a registration that fails outright still connects, and says so", async () => {
  await withRecordedFetch(
    async () => {
      const res = (await handleTool(freshGateway(), "canvas_connect", {
        code: "TESTCODE",
        role: "executor",
        name: "unlucky",
      })) as Record<string, any>;

      assert.equal(res.connected, true);
      assert.equal("agentId" in res, false, "no id was minted");
      assert.equal(res.agent.registered, false);
      assert.match(res.agent.problem, /agent_register/, "tell it how to retry");
      // Unregistered sessions still get their anonymous claimant, so claims work.
      assert.match(claimantFromHandle(res.session), /^session-/);
    },
    { failRegister: true }
  );
});

test("a bad role is caught before any write, and connect still succeeds", async () => {
  await withRecordedFetch(async (calls) => {
    const res = (await handleTool(freshGateway(), "canvas_connect", {
      code: "TESTCODE",
      role: "supervisor",
    })) as Record<string, any>;

    assert.equal(calls.length, 1, "no point posting a role the API will refuse");
    assert.equal(res.connected, true);
    assert.equal(res.agent.registered, false);
    assert.match(res.agent.problem, /planner.*executor/);
  });
});

test("identity fields without a role are reported, not silently dropped", async () => {
  await withRecordedFetch(async (calls) => {
    const res = (await handleTool(freshGateway(), "canvas_connect", {
      code: "TESTCODE",
      name: "nameless-role",
      parentAgentId: "planner-1",
    })) as Record<string, any>;

    assert.equal(calls.length, 1);
    assert.equal(res.agent.registered, false);
    assert.match(res.agent.problem, /role/);
  });
});

test("a plain connect is untouched — no registration, no agent block", async () => {
  await withRecordedFetch(async (calls) => {
    const res = (await handleTool(freshGateway(), "canvas_connect", {
      code: "TESTCODE",
    })) as Record<string, any>;

    assert.equal(calls.length, 1, "connect must not become a two-request call for everyone");
    assert.equal("agent" in res, false);
    assert.equal("agentId" in res, false);
    assert.match(claimantFromHandle(res.session), /^session-/);
  });
});

// ── canvas_create + register in ONE call ─────────────────────────────────────
// The observed failure mode this exists to kill: after canvas_create the model
// chains straight into agent_register before saying anything, so the user
// stares at a silent session that looks hung even though the url came back on
// the very first call. With registration folded into create there is no second
// call to chain — the next thing the model does is surface the url.

test("create + role registers in one call; agentName names the agent, name the canvas", async () => {
  await withRecordedFetch(async (calls) => {
    const res = (await handleTool(freshGateway(), "canvas_create", {
      name: "Rejection Loop Fixes",
      role: "planner",
      agentName: "opus-orchestrator",
      model: "claude-opus-4-8",
    })) as Record<string, any>;

    assert.equal(calls.length, 3, "canvas create + auth handshake + one registration");
    const post = calls[2];
    assert.equal(post.path, "/api/canvas/agents");
    assert.deepEqual(post.body, {
      name: "opus-orchestrator",
      role: "planner",
      model: "claude-opus-4-8",
    });

    assert.equal(res.created, true);
    assert.equal(res.agentId, "agent-42", "the agentId must be on the create result");
    assert.deepEqual(res.agent, {
      registered: true,
      agentId: "agent-42",
      name: "opus-orchestrator",
      role: "planner",
    });
    // The whole point: the handle handed back already carries the identity, so
    // there is nothing left to chain before talking to the user.
    assert.equal(claimantFromHandle(res.session), "opus-orchestrator");
    assert.match(res._session_note, /ALREADY registered/);
    assert.match(res._session_note, /do NOT call agent_register/);
  });
});

test("a plain create is untouched — no registration, no agent block", async () => {
  await withRecordedFetch(async (calls) => {
    const res = (await handleTool(freshGateway(), "canvas_create", {
      name: "Plain Canvas",
    })) as Record<string, any>;

    assert.equal(calls.length, 2, "create + auth only — no agents POST");
    assert.equal("agent" in res, false);
    assert.equal("agentId" in res, false);
    assert.match(res._session_note, /agent_register returns an UPDATED handle/);
    assert.match(claimantFromHandle(res.session), /^session-/);
  });
});

test("create with a rejected parentAgentId still creates, registered unparented", async () => {
  await withRecordedFetch(
    async (calls) => {
      const res = (await handleTool(freshGateway(), "canvas_create", {
        name: "Fleet Canvas",
        role: "executor",
        agentName: "orphan-worker",
        parentAgentId: "not-a-real-agent",
      })) as Record<string, any>;

      assert.equal(calls.length, 4, "create + auth + rejected registration + unparented retry");
      assert.equal(res.created, true, "a bad parent must not cost the canvas");
      assert.equal(res.agent.registered, true);
      assert.equal(res.agent.parentAgentId, null);
      assert.match(res.agent.problem, /not-a-real-agent/);
      assert.equal(claimantFromHandle(res.session), "orphan-worker");
    },
    { rejectParent: true }
  );
});

test("agent_register still works on its own, for re-registration after connect", async () => {
  await withRecordedFetch(async (calls) => {
    const gw = freshGateway();
    await handleTool(gw, "canvas_connect", { code: "TESTCODE" });
    const res = (await handleTool(gw, "agent_register", {
      role: "executor",
      name: "late-registrant",
      parentAgentId: "planner-1",
    })) as Record<string, any>;

    assert.equal(calls[1].path, "/api/canvas/agents");
    assert.deepEqual(calls[1].body, {
      name: "late-registrant",
      role: "executor",
      parentAgentId: "planner-1",
    });
    assert.equal(res.agentId, "agent-42");
    assert.equal(claimantFromHandle(res.session), "late-registrant");
  });
});
