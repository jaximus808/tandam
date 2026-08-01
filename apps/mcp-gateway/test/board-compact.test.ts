/**
 * TDM-184 — the board read stops shipping the archive.
 *
 * board_status used to quote one line per finished ticket for EVERY batch on the
 * canvas, so the answer to "where does this project stand?" grew with the whole
 * history: 34 batches and 250 tickets in, ~79KB of mostly-finished work with the
 * live rows buried in it. The per-ticket account did not stop being useful — it
 * stopped being something every read pays for. What these pin:
 *
 *   1. the DEFAULT read asks the API for the compact rollup (no `?full=1`) and
 *      carries no per-ticket lines at all — each row says how many it is holding
 *      back (`doneOmitted`) rather than dropping them silently;
 *   2. `epic:` expands EXACTLY ONE batch — that one whole, every other one still
 *      compact — in ONE rollup call, not two;
 *   3. a ref that names nothing, or names several batches, expands nothing and
 *      says so as DATA: the board read still answers;
 *   4. the per-epic cost is BOUNDED — summaries are excerpted, activity trivia is
 *      dropped — so the read scales with the number of batches, never with the
 *      number of tickets under them.
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

/** One finished ticket as the rollup lists it. */
function doneLine(n: number): Row {
  return {
    id: `t-${n}`,
    ticketId: `TDM-${n}`,
    title: `Finished ticket ${n}`,
    state: "done",
    result: `Did the work for ${n}, in apps/mcp-gateway/src/facade.ts.`,
  };
}

/** A rollup row as GET /api/canvas/epics answers it. */
function rollup(over: Row = {}): Row {
  return {
    id: "epic-1",
    title: "E15 · Board reads on a token diet",
    state: "approved",
    tasks: { total: 3, byState: { done: 3 } },
    done: [doneLine(1), doneLine(2), doneLine(3)],
    drained: true,
    summaryNeeded: false,
    firstActivity: "2026-07-30T09:00:00Z",
    lastActivity: "2026-08-01T09:00:00Z",
    ...over,
  };
}

/**
 * Serve the three reads board_status makes. `epics` is a function of the query
 * so a test can answer the compact and the `?full=1` read differently — which is
 * how the API behaves, and the only way to see WHICH one the gateway asked for.
 */
function install(opts: { epics?: (full: boolean) => Row[]; tasks?: Row[] }) {
  const paths: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    paths.push(`${method} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/mcp/auth") {
      return json({ token: "t", canvasId: "canvas-1", canvasName: "C", canvasCode: CODE });
    }
    if (url.pathname === "/api/canvas/agents" && method === "POST") {
      return json({ agentId: "agent-1", name: "reporter" }, 201);
    }
    if (url.pathname === "/api/canvas/epics") {
      if (!opts.epics) return json({ error: "not found" }, 404);
      return json({ epics: opts.epics(url.searchParams.get("full") === "1") });
    }
    if (url.pathname === "/api/canvas/actions") {
      const type = url.searchParams.get("type");
      return json({ actions: type === "epic" ? [] : (opts.tasks ?? []) });
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return { paths, restore: () => (globalThis.fetch = real) };
}

async function connect(): Promise<Gateway> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", { code: CODE, role: "planner", name: "reporter" });
  return gw;
}

/** The compact rollup, as the API composes it (TDM-183): counts, no line items. */
function asCompact(e: Row): Row {
  const { done, ...rest } = e as Row & { done?: Row[] };
  return { ...rest, done: [], doneOmitted: done?.length ?? 0 };
}

test("the default board read asks for the compact rollup and carries no per-ticket lines", async () => {
  const { paths, restore } = install({
    epics: (full) => [full ? rollup() : asCompact(rollup())],
  });
  try {
    const res = (await handleFacadeTool(await connect(), "board_status", {})) as any;

    assert.ok(
      paths.some((p) => p === "GET /api/canvas/epics"),
      "the default read must NOT ask for ?full=1"
    );
    assert.equal(
      paths.filter((p) => p.startsWith("GET /api/canvas/epics")).length,
      1,
      "one rollup call, not one per shape"
    );
    const row = res.epics[0];
    assert.equal("done" in row, false, "no per-ticket account by default");
    assert.equal(row.doneOmitted, 3, "and it says how many lines it is holding back");
    assert.equal(row.tasks.total, 3, "counts stay — that is what a board read is");
    assert.equal(row.drained, true);
    assert.equal("expanded" in row, false);
    assert.match(String(res._epics), /3 finished-ticket line\(s\) are not shown/);
  } finally {
    restore();
  }
});

test("a batch with nothing to omit says nothing about omissions", async () => {
  const { restore } = install({
    epics: () => [
      asCompact(rollup({ done: [], tasks: { total: 2, byState: { approved: 2 } }, drained: false })),
    ],
  });
  try {
    const res = (await handleFacadeTool(await connect(), "board_status", {})) as any;
    assert.equal("doneOmitted" in res.epics[0], false);
    assert.equal("drained" in res.epics[0], false, "false flags are weight, not information");
    assert.equal("_epics" in res, false, "no diet notice when nothing was left out");
  } finally {
    restore();
  }
});

test("`epic` expands exactly one batch — that one whole, the rest still compact", async () => {
  const other = rollup({
    id: "epic-2",
    title: "E16 · Mobile board fix",
    done: [doneLine(7), doneLine(8)],
    tasks: { total: 2, byState: { done: 2 } },
  });
  const { paths, restore } = install({
    epics: (full) =>
      full ? [rollup(), other] : [asCompact(rollup()), asCompact(other)],
  });
  try {
    const res = (await handleFacadeTool(await connect(), "board_status", {
      epic: "E15",
    })) as any;

    assert.ok(
      paths.includes("GET /api/canvas/epics?full=1"),
      "expanding reads the full shape"
    );
    assert.equal(
      paths.filter((p) => p.startsWith("GET /api/canvas/epics")).length,
      1,
      "expanding stays ONE rollup call"
    );
    assert.equal(res.expandedEpic, "epic-1");

    const [expanded, compact] = res.epics;
    assert.equal(expanded.expanded, true);
    assert.equal(expanded.done.length, 3, "the batch asked for comes back whole");
    assert.equal(expanded.done[0].result, "Did the work for 1, in apps/mcp-gateway/src/facade.ts.");
    assert.equal(expanded.lastActivity, "2026-08-01T09:00:00Z");

    assert.equal("done" in compact, false, "every OTHER batch stays compact");
    assert.equal(compact.doneOmitted, 2);
  } finally {
    restore();
  }
});

test("an epic id expands too, and so does a title fragment", async () => {
  const { restore } = install({ epics: (full) => [full ? rollup() : asCompact(rollup())] });
  try {
    const gw = await connect();
    for (const ref of ["epic-1", "EPIC-1", "token diet", "E15 · Board reads on a token diet"]) {
      const res = (await handleFacadeTool(gw, "board_status", { epic: ref })) as any;
      assert.equal(res.expandedEpic, "epic-1", `\`epic: "${ref}"\` should expand it`);
      assert.equal(res.epics[0].done.length, 3);
    }
  } finally {
    restore();
  }
});

test("a ref that names nothing expands nothing and still answers the board read", async () => {
  const { restore } = install({ epics: (full) => [full ? rollup() : asCompact(rollup())] });
  try {
    const res = (await handleFacadeTool(await connect(), "board_status", {
      epic: "E99 · a batch that never existed",
    })) as any;
    assert.equal("expandedEpic" in res, false);
    assert.match(String(res._epicNotExpanded), /No epic here matches/);
    // It names what DOES exist rather than leaving the caller to go looking.
    assert.match(String(res._epicNotExpanded), /E15 · Board reads on a token diet/);
    assert.equal(res.epics.length, 1, "the rest of the read is unaffected");
    assert.equal("done" in res.epics[0], false);
  } finally {
    restore();
  }
});

test("an ambiguous ref refuses as DATA, naming the batches it matched", async () => {
  const { restore } = install({
    epics: (full) => {
      const rows = [rollup(), rollup({ id: "epic-2", title: "E16 · Board reads, part two" })];
      return full ? rows : rows.map(asCompact);
    },
  });
  try {
    const res = (await handleFacadeTool(await connect(), "board_status", {
      epic: "Board reads",
    })) as any;
    assert.equal("expandedEpic" in res, false);
    assert.match(String(res._epicNotExpanded), /matches 2 batches/);
    assert.match(String(res._epicNotExpanded), /E16 · Board reads, part two/);
    assert.ok(
      res.epics.every((e: any) => !("done" in e)),
      "an ambiguous ref expands NOTHING, rather than guessing"
    );
  } finally {
    restore();
  }
});

test("a batch's summary is excerpted, and says so", async () => {
  const long = `${"Shipped the whole batch. ".repeat(20)}\nAnd a second paragraph.`;
  const { restore } = install({
    epics: () => [asCompact(rollup({ summary: long }))],
  });
  try {
    const res = (await handleFacadeTool(await connect(), "board_status", {})) as any;
    const row = res.epics[0];
    assert.ok(row.summary.length < 240, `summary is capped, got ${row.summary.length}`);
    assert.equal(row.summaryTruncated, true);
    assert.ok(row.summary.endsWith("…"));
  } finally {
    restore();
  }
});

test("a short one-line summary comes back whole and unflagged", async () => {
  const { restore } = install({
    epics: () => [asCompact(rollup({ summary: "Put the board read on a diet." }))],
  });
  try {
    const res = (await handleFacadeTool(await connect(), "board_status", {})) as any;
    assert.equal(res.epics[0].summary, "Put the board read on a diet.");
    assert.equal("summaryTruncated" in res.epics[0], false);
  } finally {
    restore();
  }
});

test("`epic` on an API with no rollup endpoint says so instead of silently ignoring it", async () => {
  const { restore } = install({ epics: undefined });
  try {
    const res = (await handleFacadeTool(await connect(), "board_status", { epic: "E15" })) as any;
    assert.match(String(res._epicNotExpanded), /no epic rollup endpoint/);
    assert.equal("expandedEpic" in res, false);
  } finally {
    restore();
  }
});

test("the un-summarized list is capped, and the count stays exact", async () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    rollup({ id: `epic-${i}`, title: `E${i} · A drained batch`, summaryNeeded: true })
  );
  const { restore } = install({ epics: () => many.map(asCompact) });
  try {
    const res = (await handleFacadeTool(await connect(), "board_status", {})) as any;
    assert.ok(
      res.unsummarizedEpics.length < many.length,
      "the convenience list does not re-quote every batch on the board"
    );
    // The COUNT is never trimmed, and the rest are findable on their own rows.
    assert.match(String(res._unsummarizedEpics), /^20 epic\(s\) have DRAINED/);
    assert.match(String(res._unsummarizedEpics), /summaryNeeded/);
    assert.equal(res.epics.filter((e: any) => e.summaryNeeded).length, 20);
  } finally {
    restore();
  }
});

test("the default read is O(batches): its size does not move when tickets pile up", async () => {
  const sizeWith = async (perEpicTickets: number) => {
    const epics = Array.from({ length: 8 }, (_, i) =>
      rollup({
        id: `epic-${i}`,
        title: `E${i} · A batch`,
        tasks: { total: perEpicTickets, byState: { done: perEpicTickets } },
        done: Array.from({ length: perEpicTickets }, (_, n) => doneLine(n)),
      })
    );
    const { restore } = install({ epics: (full) => (full ? epics : epics.map(asCompact)) });
    try {
      const res = await handleFacadeTool(await connect(), "board_status", {});
      return JSON.stringify(res).length;
    } finally {
      restore();
    }
  };

  const small = await sizeWith(2);
  const huge = await sizeWith(60);
  // Only the counts and the omitted-line tallies differ — a couple of digits per
  // batch. History is what used to make this answer unbounded.
  assert.ok(
    huge - small < 200,
    `30x the tickets must not grow the board read (${small} → ${huge} bytes)`
  );
});

/**
 * The ABSOLUTE ceiling, and the API-side guard's counterpart (TDM-185).
 *
 * The test above pins that the read does not move when tickets pile up. It says
 * nothing about what a batch costs in the first place: a fat new field on every
 * row would keep that delta at zero and still double every board read. So this
 * pins bytes-per-BATCH — and per-batch rather than a flat total on purpose,
 * because what survives the diet is ~one irreducible identity row per batch, so
 * the TOTAL legitimately drifts up as Jaxon creates batches while the per-batch
 * cost must not.
 *
 * Run twice, against both kinds of server. The second run is the one that pins
 * the GATEWAY as its own line of defense: pointed at an API that never learned
 * the compact shape (a pre-TDM-183 server, or a rollback), board_status must
 * still drop the lines itself rather than passing the archive through.
 */
/**
 * 600 B/batch. The fixture below is the WORST case — every row carries a
 * maxed-out summary that hits the excerpt cap and a full-length title — and
 * measures 459; the live 34-batch board measures ~231. What the ceiling has to
 * stay under is a row that carries its ticket lines again, which the last
 * assertion in this test computes rather than trusting a comment.
 */
const MAX_BOARD_BYTES_PER_EPIC = 600;

test("a batch's row costs a bounded number of bytes, whatever the server sends", async () => {
  const epics = Array.from({ length: 34 }, (_, i) =>
    rollup({
      id: `epic-${i}`,
      title: `E${i} · Board reads on a token diet — board_status stops shipping the archive`,
      summary: `The batch landed the read-path diet end to end. ${"It shipped the API half, the gateway half, and the guard. ".repeat(5)}`,
      tasks: { total: 8, byState: { done: 8 } },
      done: Array.from({ length: 8 }, (_, n) => doneLine(n)),
    })
  );

  for (const [server, rows] of [
    ["a compacting API", epics.map(asCompact)],
    ["an API that still sends the lines", epics],
  ] as const) {
    const { restore } = install({ epics: (full) => (full ? epics : rows) });
    try {
      const res = (await handleFacadeTool(await connect(), "board_status", {})) as any;
      assert.ok(
        res.epics.every((e: any) => !("done" in e)),
        `${server}: the default read must carry no per-ticket lines`
      );
      const bytes = JSON.stringify(res).length;
      const perEpic = Math.round(bytes / epics.length);
      assert.ok(
        perEpic <= MAX_BOARD_BYTES_PER_EPIC,
        `${server}: the board read costs ${perEpic} B/batch (${bytes} bytes over ${epics.length} ` +
          `batches), over the ${MAX_BOARD_BYTES_PER_EPIC} B/batch ceiling. Something fat was added to ` +
          `every row — check boardEpicRow and BOARD_SUMMARY_CHARS. If the growth is deliberate, raise ` +
          `MAX_BOARD_BYTES_PER_EPIC deliberately and say why.`
      );
    } finally {
      restore();
    }
  }

  // And the ceiling has to be able to fail. A row that still carried its
  // per-ticket account is what this guard exists to catch, so the ceiling must
  // sit well under what one of those costs — otherwise it would pass straight
  // through a revert of the diet.
  const preDietPerEpic = Math.round(JSON.stringify(epics).length / epics.length);
  assert.ok(
    MAX_BOARD_BYTES_PER_EPIC < preDietPerEpic / 2,
    `the ceiling no longer discriminates: a pre-diet row costs ${preDietPerEpic} B/batch and the ` +
      `ceiling is ${MAX_BOARD_BYTES_PER_EPIC} — tighten it, or this test stops noticing the archive coming back`
  );
});
