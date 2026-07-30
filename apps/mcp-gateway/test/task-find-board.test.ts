/**
 * TDM-95 — the two agent-friendliness gaps found dogfooding TDM-21.
 *
 * 1. task_find: a session handed a NAME ("the constraints task") could only get
 *    to an id by listing the whole board and scanning it. Now one call returns
 *    just the matches, and a ticket ref is resolved instead of searched.
 * 2. board_status: in-flight rows named a holder and nothing else, so an
 *    orchestrator reporting on its fleet had to task_get every executing task.
 *    Now each row carries the claim's age, a staleness flag, and the last
 *    progress note — the whole report, from one read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool } from "../src/facade.js";

const CODE = "TESTCODE";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Row = Record<string, unknown>;

/**
 * Serve the two reads these tools make: the action list (tasks or epics) and a
 * single action by ticket ref. `byRef` maps a ref to a row, or to null for the
 * 404 the API answers an unknown ticket with (TDM-95, api side).
 */
function install(opts: { tasks?: Row[]; epics?: Row[]; byRef?: Record<string, Row | null> }) {
  const paths: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/mcp/auth") {
      return json({ token: "t", canvasId: "canvas-1", canvasName: "C", canvasCode: CODE });
    }
    if (url.pathname === "/api/canvas/agents") return json({ agentId: "agent-1" }, 201);
    if (url.pathname === "/api/canvas/actions") {
      paths.push(`${url.pathname}?${url.searchParams.toString()}`);
      const type = url.searchParams.get("type");
      return json({ actions: type === "epic" ? (opts.epics ?? []) : (opts.tasks ?? []) });
    }
    if (url.pathname.startsWith("/api/canvas/actions/")) {
      const ref = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      paths.push(url.pathname);
      const hit = opts.byRef?.[ref];
      if (!hit) {
        return json({ error: "task_not_found", message: `no task ${ref} on this canvas` }, 404);
      }
      return json({ action: hit });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return { paths, restore: () => (globalThis.fetch = real) };
}

async function connect(): Promise<Gateway> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", { code: CODE, role: "executor", name: "worker-a" });
  return gw;
}

const TASKS: Row[] = [
  {
    id: "t-1",
    ticketId: "TDM-21",
    state: "approved",
    createdAt: "2026-07-01T00:00:00Z",
    payload: { title: "Honour the constraints panel", assignee: "agent", epicId: "epic-1" },
  },
  {
    id: "t-2",
    ticketId: "TDM-22",
    state: "done",
    createdAt: "2026-07-02T00:00:00Z",
    payload: { title: "Dark mode rollout", body: "respect the constraints in DESIGN.md" },
  },
  {
    id: "t-3",
    ticketId: "TDM-23",
    state: "approved",
    createdAt: "2026-07-03T00:00:00Z",
    payload: { title: "Ship the landing page" },
  },
];

test("task_find matches a title and ranks it above a body-only match", async () => {
  const { restore } = install({ tasks: TASKS });
  try {
    const out = (await handleFacadeTool(await connect(), "task_find", {
      query: "constraints",
    })) as any;
    assert.equal(out.matches.length, 2, "title hit and body hit");
    assert.equal(out.matches[0].id, "t-1", "the title match ranks first");
    assert.equal(out.matches[0].matchedIn, "title");
    assert.equal(out.matches[0].ticketId, "TDM-21", "a match is addressable by ticket");
    assert.equal(out.matches[1].matchedIn, "body");
    assert.equal(out.searched, 3);
  } finally {
    restore();
  }
});

test("task_find takes a state filter to the API, not just the client", async () => {
  const { paths, restore } = install({ tasks: TASKS });
  try {
    const out = (await handleFacadeTool(await connect(), "task_find", {
      query: "landing page",
      state: "approved",
    })) as any;
    assert.equal(out.matches.length, 1);
    assert.equal(out.matches[0].id, "t-3", "all query words present in the title");
    assert.ok(
      paths.some((p) => p.includes("state=approved")),
      `the filter must reach the API: ${paths.join(", ")}`
    );
  } finally {
    restore();
  }
});

test("task_find resolves a ticket ref directly instead of searching titles", async () => {
  const { paths, restore } = install({ tasks: TASKS, byRef: { "TDM-21": TASKS[0] } });
  try {
    for (const query of ["TDM-21", "tdm-21", "#21", "21"]) {
      const out = (await handleFacadeTool(await connect(), "task_find", { query })) as any;
      assert.equal(out.resolvedAs, "TDM-21", `${query} is a ref, not a search`);
      assert.equal(out.matches[0].id, "t-1");
    }
    assert.ok(
      paths.every((p) => !p.includes("?type=task")),
      "a ref must not cost a board list"
    );
  } finally {
    restore();
  }
});

test("task_find reports an unknown ref as no matches, not an error", async () => {
  const { restore } = install({ tasks: TASKS, byRef: { "TDM-99999": null } });
  try {
    const out = (await handleFacadeTool(await connect(), "task_find", {
      query: "TDM-99999",
    })) as any;
    assert.deepEqual(out.matches, []);
    assert.match(out._next, /No task TDM-99999 on this canvas/);
  } finally {
    restore();
  }
});

test("task_find refuses an empty query before any request", async () => {
  const { paths, restore } = install({ tasks: TASKS });
  try {
    const gw = await connect();
    await assert.rejects(
      () => handleFacadeTool(gw, "task_find", { query: "   " }) as Promise<unknown>,
      /`query` \(string\) is required/
    );
    assert.equal(paths.length, 0);
  } finally {
    restore();
  }
});

test("board_status in-flight rows carry ticket, claim age and the last progress note", async () => {
  const fresh = new Date(Date.now() - 3 * 60_000).toISOString();
  const { restore } = install({
    tasks: [
      {
        id: "t-9",
        ticketId: "TDM-90",
        state: "executing",
        claimedBy: "worker-b",
        claimedAt: fresh,
        payload: {
          title: "Wire the fleet view",
          epicId: "epic-1",
          progress: [
            { at: "2026-07-01T00:00:00Z", agent: "worker-b", note: "first" },
            { at: fresh, agent: "worker-b", note: "second, the latest" },
          ],
        },
      },
    ],
    epics: [{ id: "epic-1", state: "approved", payload: { title: "E1" } }],
  });
  try {
    const out = (await handleFacadeTool(await connect(), "board_status", {})) as any;
    const row = out.inFlight[0];
    assert.equal(row.ticketId, "TDM-90");
    assert.equal(row.claimedBy, "worker-b");
    assert.equal(row.claimAgeMinutes, 3, "how long the claim has been held");
    assert.ok(!("staleClaim" in row), "a fresh claim is not stale");
    assert.equal(row.lastProgress.note, "second, the latest", "the MOST RECENT note");
    assert.equal(row.lastProgress.entries, 2);
    assert.equal(out._staleClaims, undefined);
  } finally {
    restore();
  }
});

test("board_status flags a claim that outlived its lease", async () => {
  const old = new Date(Date.now() - 47 * 60_000).toISOString();
  const { restore } = install({
    tasks: [
      {
        id: "t-9",
        state: "executing",
        claimedBy: "worker-gone",
        claimedAt: old,
        payload: { title: "Went dark" },
      },
    ],
  });
  try {
    const out = (await handleFacadeTool(await connect(), "board_status", {})) as any;
    const row = out.inFlight[0];
    assert.equal(row.staleClaim, true);
    assert.equal(row.claimAgeMinutes, 47);
    assert.match(out._staleClaims, /reclaimable/);
    // The report says "at risk", never "finish it for them" — completing another
    // agent's task is exactly what the claim fence exists to stop.
    assert.match(out._staleClaims, /do NOT complete them on the holder's behalf/);
  } finally {
    restore();
  }
});

test("board_status omits claim age for a claim with no timestamp", async () => {
  const { restore } = install({
    tasks: [{ id: "t-9", state: "executing", claimedBy: "worker-b", payload: { title: "Old row" } }],
  });
  try {
    const out = (await handleFacadeTool(await connect(), "board_status", {})) as any;
    const row = out.inFlight[0];
    assert.ok(!("claimAgeMinutes" in row), "no timestamp ⇒ no invented age");
    assert.ok(!("staleClaim" in row), "and no staleness claim either");
  } finally {
    restore();
  }
});
