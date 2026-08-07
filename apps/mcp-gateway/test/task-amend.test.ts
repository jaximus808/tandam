/**
 * TDM-117 — an agent can correct its OWN proposal, but only within the fence.
 *
 * task_amend edits or withdraws a task, guarded three ways against the server's
 * view: it must be `proposed` (or, since TDM-4, `rejected`), unclaimed, and
 * authored by the caller. Approved or in-flight work is off-limits — that stays
 * the human's / the claimant's.
 *
 * TDM-4 adds the way OUT of a rejection to the same verb: amending a REJECTED
 * ticket goes to `POST /actions/{id}/resubmit` instead of PATCH, carries a
 * required `note` saying what changed, and lands the same ticket back at
 * 'proposed' behind the human gate. The four coded refusals that door can answer
 * come back as DATA with a `_next`, never as thrown errors — a refusal an agent
 * meets as `POST … failed: 400 {json}` is one it retries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool } from "../src/facade.js";

const CODE = "TESTCODE";

type StoredAction = {
  state?: string;
  claimedBy?: string;
  authoredBy?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

/**
 * Answer the GET the tool reads with `action`, and record PATCH/DELETE/POST.
 * `resubmit` overrides what the resubmit endpoint answers, so a refusal can be
 * played back exactly as the API writes it (`writeCodedError`: the code in
 * `error`, the prose in `message`, the rest as extras).
 */
function install(action: StoredAction, opts: { resubmit?: () => Response } = {}) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/api/mcp/auth") {
      return json({ token: "t", canvasId: "canvas-1", canvasName: "C", canvasCode: CODE });
    }
    if (url.pathname === "/api/canvas/agents" && method === "POST") {
      // Registration, so claimant() resolves to the given name (authoredBy match).
      return json({ agentId: "agent-1", name: body?.name }, 201);
    }
    if (url.pathname.endsWith("/resubmit")) {
      calls.push({ method, path: url.pathname, body });
      return (
        opts.resubmit?.() ??
        json({
          action: { ...action, id: "task-1", ticketId: "TDM-1", state: "proposed" },
          resubmitted: true,
          from: "rejected",
          to: "proposed",
        })
      );
    }
    if (url.pathname.startsWith("/api/canvas/actions/")) {
      if (method === "GET") return json({ action: { type: "task", ...action } });
      calls.push({ method, path: url.pathname, body });
      return json({ action: { ...action, payload: body?.payload ?? action.payload } });
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function connect(name = "worker-a"): Promise<Gateway> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", { code: CODE, role: "planner", name });
  return gw;
}

const OWNED_PROPOSED: StoredAction = {
  state: "proposed",
  authoredBy: "agent:worker-a",
  payload: { title: "old title", assignee: "agent", epicId: "epic-1" },
};

test("the author re-parents its own proposed task", async () => {
  const { calls, restore } = install(OWNED_PROPOSED);
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_amend", {
      id: "TDM-1",
      epicId: "epic-2",
      title: "new title",
    })) as any;
    assert.equal(out.amended, true);
    const patch = calls.find((c) => c.method === "PATCH");
    assert.ok(patch, "an amend PATCHes the payload");
    assert.equal(patch!.body.payload.epicId, "epic-2", "re-parented");
    assert.equal(patch!.body.payload.title, "new title", "title changed");
    assert.equal(patch!.body.payload.assignee, "agent", "unchanged fields carried forward");
  } finally {
    restore();
  }
});

test("withdraw deletes the proposal", async () => {
  const { calls, restore } = install(OWNED_PROPOSED);
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_amend", {
      id: "TDM-1",
      withdraw: true,
    })) as any;
    assert.equal(out.withdrawn, true);
    assert.ok(
      calls.some((c) => c.method === "DELETE"),
      "withdraw issues a DELETE"
    );
    assert.ok(!calls.some((c) => c.method === "PATCH"), "and does not also edit");
  } finally {
    restore();
  }
});

test("cannot amend an APPROVED task", async () => {
  const { calls, restore } = install({ ...OWNED_PROPOSED, state: "approved" });
  try {
    const gw = await connect();
    await assert.rejects(
      () => handleFacadeTool(gw, "task_amend", { id: "TDM-1", title: "x" }) as Promise<unknown>,
      /is "approved", not "proposed"/
    );
    assert.equal(calls.length, 0, "no write on a refused amend");
  } finally {
    restore();
  }
});

test("cannot amend a task another agent authored", async () => {
  const { calls, restore } = install({ ...OWNED_PROPOSED, authoredBy: "agent:worker-b" });
  try {
    const gw = await connect("worker-a");
    await assert.rejects(
      () => handleFacadeTool(gw, "task_amend", { id: "TDM-1", title: "x" }) as Promise<unknown>,
      /did not propose this task/
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("cannot amend a task a worker holds", async () => {
  const { calls, restore } = install({ ...OWNED_PROPOSED, claimedBy: "worker-b" });
  try {
    const gw = await connect("worker-a");
    await assert.rejects(
      () => handleFacadeTool(gw, "task_amend", { id: "TDM-1", title: "x" }) as Promise<unknown>,
      /held by "worker-b"/
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("an amend with no fields, no note and no withdraw is rejected before any request", async () => {
  const { calls, restore } = install(OWNED_PROPOSED);
  try {
    const gw = await connect();
    await assert.rejects(
      () => handleFacadeTool(gw, "task_amend", { id: "TDM-1" }) as Promise<unknown>,
      /Nothing to amend/
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

// ── Answering a rejection: amend-and-resubmit (TDM-4) ────────────────────────
//
// A rejected ticket used to be a dead end here — guard 1 refused anything that
// was not 'proposed', so the only move left was filing a near-duplicate that
// arrived with no memory of the rejection. These pin the way back: same ticket,
// same author, a note the human reads, and the human gate still in front of it.

const OWNED_REJECTED: StoredAction = {
  state: "rejected",
  authoredBy: "agent:worker-a",
  payload: { title: "old title", body: "old body", assignee: "agent", epicId: "epic-1" },
};

test("amending a REJECTED ticket RESUBMITS it — POST /resubmit, never a PATCH", async () => {
  const { calls, restore } = install(OWNED_REJECTED);
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_amend", {
      id: "TDM-1",
      body: "scoped to the gateway",
      note: "dropped the API half; it is TDM-9 now",
    })) as any;

    assert.equal(out.resubmitted, true);
    assert.equal(out.state, "proposed", "the same ticket is back at the gate");
    assert.equal(out.ticketId, "TDM-1");
    assert.equal(out.note, "dropped the API half; it is TDM-9 now");

    const post = calls.find((c) => c.method === "POST");
    assert.ok(post, "a rejected amend goes to the resubmit endpoint");
    assert.match(post!.path, /\/resubmit$/);
    assert.equal(post!.body.note, "dropped the API half; it is TDM-9 now");
    // A PARTIAL payload: the server merges key by key, so resending the stored
    // fields would write back everything this amend never meant to touch.
    assert.deepEqual(post!.body.payload, { body: "scoped to the gateway" });
    assert.ok(!calls.some((c) => c.method === "PATCH"), "and never edits it in place");

    // It is NOT approved: the answer has to say so, or an agent claims it next.
    assert.match(out._next, /NOT approved/i);
    assert.match(out._next, /queue_wait/);
    assert.match(out._next, /SAME ticket/i);
  } finally {
    restore();
  }
});

test("a resubmit with a note but no edits does not rewrite the ticket's fields", async () => {
  // "The text stands, I am asking again" — the reason was answered elsewhere.
  const { calls, restore } = install(OWNED_REJECTED);
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_amend", {
      id: "TDM-1",
      note: "the neighbour it duplicated is withdrawn, so this one stands alone now",
    })) as any;
    assert.equal(out.resubmitted, true);
    const post = calls.find((c) => c.method === "POST")!;
    assert.equal("payload" in post.body, false, "no payload key at all on an unchanged resubmit");
  } finally {
    restore();
  }
});

test("resubmitting without a note is refused HERE, before it costs a round trip", async () => {
  const { calls, restore } = install(OWNED_REJECTED);
  try {
    const gw = await connect();
    await assert.rejects(
      () =>
        handleFacadeTool(gw, "task_amend", { id: "TDM-1", title: "x" }) as Promise<unknown>,
      /needs a `note`/
    );
    assert.equal(calls.length, 0, "no write on a refused resubmit");
  } finally {
    restore();
  }
});

test("a note alone on a still-PROPOSED ticket is refused rather than written as a no-op", async () => {
  const { calls, restore } = install(OWNED_PROPOSED);
  try {
    const gw = await connect();
    await assert.rejects(
      () => handleFacadeTool(gw, "task_amend", { id: "TDM-1", note: "please look again" }) as Promise<unknown>,
      /only does something when the ticket is REJECTED/
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("withdraw does not apply to a rejected ticket — it would erase the reason", async () => {
  const { calls, restore } = install(OWNED_REJECTED);
  try {
    const gw = await connect();
    await assert.rejects(
      () => handleFacadeTool(gw, "task_amend", { id: "TDM-1", withdraw: true }) as Promise<unknown>,
      /nothing to withdraw/
    );
    assert.equal(calls.length, 0, "and certainly no DELETE");
  } finally {
    restore();
  }
});

test("the author guard still applies to a rejected ticket", async () => {
  const { calls, restore } = install({ ...OWNED_REJECTED, authoredBy: "agent:worker-b" });
  try {
    const gw = await connect("worker-a");
    await assert.rejects(
      () =>
        handleFacadeTool(gw, "task_amend", {
          id: "TDM-1",
          note: "I would have scoped it differently",
        }) as Promise<unknown>,
      /did not propose this task/
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

// ── The four coded refusals come back as DATA (contract B) ───────────────────

/** Exactly what api/helpers.go writeCodedError writes. */
const coded = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
  json({ error: code, message, ...extra }, status);

const REFUSALS: Array<{
  code: string;
  status: number;
  message: string;
  extra?: Record<string, string>;
  /** What the rendered `_next` must tell the agent to do about it. */
  next: RegExp;
}> = [
  {
    code: "task_not_found",
    status: 404,
    message: "no task with that id or ticket ref on this canvas",
    next: /nothing to resubmit/i,
  },
  {
    code: "resubmit_wrong_state",
    status: 400,
    message: "a task must be rejected to be resubmitted; this one is approved",
    extra: { state: "approved" },
    next: /Only a REJECTED ticket can be resubmitted.*'approved'/s,
  },
  {
    code: "resubmit_not_author",
    status: 403,
    message: "only the agent that proposed a task may resubmit it",
    extra: { authoredBy: "agent:worker-b" },
    next: /did not propose this ticket.*agent:worker-b/s,
  },
  {
    code: "resubmit_note_required",
    status: 400,
    message: "note: say what changed since the rejection",
    next: /Call task_amend again with a `note`/,
  },
];

for (const r of REFUSALS) {
  test(`${r.code} comes back as data with a _next, not as a thrown error`, async () => {
    const { restore } = install(OWNED_REJECTED, {
      resubmit: () => coded(r.status, r.code, r.message, r.extra),
    });
    try {
      const gw = await connect();
      const out = (await handleFacadeTool(gw, "task_amend", {
        id: "TDM-1",
        note: "reworked the scope",
      })) as any;

      assert.equal(out.resubmitted, false, "a refusal is an answer, not a success");
      assert.equal(out.refusal, r.code, "the server's stable code is what a client branches on");
      assert.equal(out.message, r.message, "and its own words survive");
      assert.match(out._next, r.next);
      for (const [k, v] of Object.entries(r.extra ?? {})) {
        assert.equal(out[k], v, `the server's \`${k}\` rides along`);
      }
    } finally {
      restore();
    }
  });
}

test("a refusal code this build has never heard of hands back the server's own words", async () => {
  // The rule the switch has no `default:` for: never translate an unknown code
  // into advice that might be wrong — quote the server and stop.
  const { restore } = install(OWNED_REJECTED, {
    resubmit: () => coded(403, "resubmit_canvas_frozen", "this canvas is frozen for the migration"),
  });
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "task_amend", {
      id: "TDM-1",
      note: "reworked the scope",
    })) as any;
    assert.equal(out.resubmitted, false);
    assert.equal(out.refusal, "resubmit_canvas_frozen");
    assert.match(out._next, /this canvas is frozen for the migration/);
    assert.match(out._next, /do not retry the same call/i);
  } finally {
    restore();
  }
});
