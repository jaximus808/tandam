/**
 * TDM-180 — doc_read: an agent can read back the tab it wrote.
 *
 * The point of the tool is the SCOPE. Before it, reading a document meant
 * /api/canvas/state?fields=notes — every note on the canvas — matched by hand
 * against a second read of the documents. So the load-bearing assertions here
 * are as much about what doc_read does NOT request as about what it returns:
 * the happy path is one scoped call and never touches the state read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool } from "../src/facade.js";

const CODE = "TESTCODE";

const DOCS = [
  { id: "doc-thesis", type: "notes", name: "Thesis" },
  { id: "doc-strategy", type: "notes", name: "Strategy" },
];

const THESIS_NOTES = [
  { id: "note-1", body: "## Thesis\n\nAgents need a shared board.", createdBy: "agent", updatedAt: "2026-08-01T10:00:00Z" },
  { id: "note-2", body: "Second para.", createdBy: "human", updatedAt: "2026-08-01T11:00:00Z" },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The SPA catch-all: an unrouted /api path on an API that predates TDM-179. */
function spa(): Response {
  return new Response("<!doctype html><html></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

/**
 * @param scopedEndpoint how the document-scoped notes route behaves:
 *   "served" (TDM-179 deployed), "missing" (older API → SPA HTML), or
 *   "unknown-ref" (deployed, but the ref names nothing → 404).
 */
function install(
  scopedEndpoint: "served" | "missing" | "unknown-ref",
  thesisNotes: Array<{ id: string; body: string; createdBy?: string; updatedAt?: string }> = THESIS_NOTES
) {
  const calls: Array<{ method: string; path: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname + url.search });

    if (url.pathname === "/api/mcp/auth") {
      return json({ token: "t", canvasId: "canvas-1", canvasName: "C", canvasCode: CODE });
    }
    if (/^\/api\/canvas\/documents\/[^/]+\/notes$/.test(url.pathname)) {
      if (scopedEndpoint === "missing") return spa();
      if (scopedEndpoint === "unknown-ref") {
        return json({ error: 'no document named "Nope" — have: Thesis, Strategy' }, 404);
      }
      return json({
        document: { id: "doc-thesis", name: "Thesis", type: "notes" },
        notes: thesisNotes,
        _hint: "One document's notes.",
      });
    }
    if (url.pathname === "/api/canvas/documents") {
      return json({ documents: DOCS });
    }
    if (url.pathname === "/api/canvas/agents") {
      return json({ agent: { id: "agent-1" } });
    }
    if (url.pathname === "/api/canvas/state") {
      return json({
        type: "state",
        canvas: {},
        state: {
          notes: {
            // Deliberately out of order, and mixed with another tab's note.
            "note-2": { ...thesisNotes[1], documentId: "doc-thesis", sortOrder: 2 },
            "note-other": { id: "note-other", body: "belongs to Strategy", documentId: "doc-strategy", sortOrder: 1 },
            "note-1": { ...thesisNotes[0], documentId: "doc-thesis", sortOrder: 1 },
          },
        },
      });
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

/** Connect + register, then forget those calls: the tests are about doc_read's. */
async function connect(calls: Array<unknown>): Promise<Gateway> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", { code: CODE, role: "executor", name: "reader-a" });
  calls.length = 0;
  return gw;
}

test("doc_read reads one tab by NAME, scoped — never the whole canvas state", async () => {
  const { calls, restore } = install("served");
  try {
    const gw = await connect(calls);
    const out = (await handleFacadeTool(gw, "doc_read", { document: "Thesis" })) as any;

    assert.equal(out.document.name, "Thesis");
    assert.equal(out.document.id, "doc-thesis");
    assert.equal(out.noteCount, 2);
    assert.match(out.notes[0].body, /Agents need a shared board/);
    // The whole reason to return the ids: doc_write can revise a note in place.
    assert.deepEqual(out.notes.map((n: any) => n.noteId), ["note-1", "note-2"]);
    assert.equal(out.notes[1].createdBy, "human");
    assert.match(out._next, /noteId/);

    const reads = calls.filter((c) => c.path.startsWith("/api/canvas"));
    assert.deepEqual(
      reads.map((c) => c.path),
      ["/api/canvas/documents/Thesis/notes"],
      "the happy path is ONE scoped call"
    );
    assert.ok(
      !calls.some((c) => c.path.startsWith("/api/canvas/state")),
      "reading one tab must not pull every note on the canvas"
    );
  } finally {
    restore();
  }
});

test("doc_read url-encodes a tab name with spaces", async () => {
  const { calls, restore } = install("served");
  try {
    const gw = await connect(calls);
    await handleFacadeTool(gw, "doc_read", { document: "Pivot Strategy (Jul 2026)" });
    assert.ok(
      calls.some((c) => c.path === "/api/canvas/documents/Pivot%20Strategy%20(Jul%202026)/notes"),
      `expected an encoded path, got: ${calls.map((c) => c.path).join(", ")}`
    );
  } finally {
    restore();
  }
});

test("an unknown tab name names the tabs that DO exist", async () => {
  const { calls, restore } = install("unknown-ref");
  try {
    const gw = await connect(calls);
    await assert.rejects(
      () => handleFacadeTool(gw, "doc_read", { document: "Nope" }) as Promise<unknown>,
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /No document "Nope"/);
        // The retry has to be possible without a second lookup call.
        assert.match(msg, /"Thesis"/);
        assert.match(msg, /"Strategy"/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("an API without the scoped endpoint still answers, in the same shape", async () => {
  // The endpoint is absent (SPA HTML), but the tab is real: that is an API
  // version problem, not the agent's mistake, so doc_read degrades to the state
  // read rather than failing — and filters/orders to this tab itself.
  const { calls, restore } = install("missing");
  try {
    const gw = await connect(calls);
    const out = (await handleFacadeTool(gw, "doc_read", { document: "doc-thesis" })) as any;

    assert.equal(out.document.name, "Thesis");
    assert.equal(out.noteCount, 2, "only this tab's notes");
    assert.deepEqual(out.notes.map((n: any) => n.noteId), ["note-1", "note-2"], "in sortOrder");
    assert.ok(
      !out.notes.some((n: any) => /belongs to Strategy/.test(n.body)),
      "another tab's note must never leak into a document read"
    );
    assert.ok(
      calls.some((c) => c.path.startsWith("/api/canvas/state")),
      "the legacy path is the state read"
    );
  } finally {
    restore();
  }
});

// ── TDM-181: the output budget ───────────────────────────────────────────────
//
// A tab is unbounded; a context window is not. These pin the two halves of the
// bargain: a big tab can never arrive in one answer, and paging it must lose
// nothing — the N pages reassemble byte-for-byte into what the tab holds.

const BUDGET = 20_000;

/** A note of `bytes` ASCII, distinguishable per note so misordering shows up. */
const bigNote = (id: string, bytes: number, fill: string) => ({
  id,
  body: `# ${id}\n` + fill.repeat(Math.ceil(bytes / fill.length)).slice(0, bytes),
  createdBy: "agent",
});

/** Read a tab to exhaustion the way an agent would: follow `nextCursor`. */
async function pageAll(gw: Gateway, document: string) {
  const bodies = new Map<string, string>();
  const pages: any[] = [];
  let args: Record<string, unknown> = { document };
  for (let guard = 0; guard < 50; guard++) {
    const out = (await handleFacadeTool(gw, "doc_read", args)) as any;
    pages.push(out);
    for (const n of out.notes) bodies.set(n.noteId, (bodies.get(n.noteId) ?? "") + n.body);
    if (!out.truncated) return { pages, bodies };
    args = {
      document: out.nextCursor.document,
      noteCursor: out.nextCursor.noteCursor,
      offset: out.nextCursor.offset,
    };
  }
  throw new Error("doc_read never stopped truncating — the cursor is not advancing");
}

test("a small tab comes back in one call with no truncation noise", async () => {
  const { calls, restore } = install("served");
  try {
    const gw = await connect(calls);
    const out = (await handleFacadeTool(gw, "doc_read", { document: "Thesis" })) as any;
    // The common case must not pay for the rare one: no cursor, no flags, no
    // paging vocabulary at all in the answer the model reads.
    assert.equal(out.truncated, undefined);
    assert.equal(out.nextCursor, undefined);
    assert.equal(out.bytesRemaining, undefined);
    assert.ok(!out.notes.some((n: any) => n.partial), "nothing is a fragment");
    assert.doesNotMatch(out._next, /TRUNCATED|noteCursor/);
  } finally {
    restore();
  }
});

test("a tab over the budget round-trips completely across N doc_read calls", async () => {
  const notes = [
    bigNote("note-1", 18_000, "alpha "),
    bigNote("note-2", 25_000, "bravo "),
    bigNote("note-3", 9_000, "delta "),
  ];
  const { calls, restore } = install("served", notes);
  try {
    const gw = await connect(calls);
    const { pages, bodies } = await pageAll(gw, "Thesis");

    assert.ok(pages.length > 1, "52KB of markdown cannot arrive in one answer");
    // No page may exceed the budget — that is the whole promise.
    for (const p of pages) {
      const bytes = p.notes.reduce((s: number, n: any) => s + Buffer.byteLength(n.body, "utf8"), 0);
      assert.ok(bytes <= BUDGET, `page returned ${bytes} bytes, over the ${BUDGET} budget`);
    }
    // And nothing may be lost or duplicated in the seams.
    for (const n of notes) assert.equal(bodies.get(n.id), n.body, `${n.id} did not reassemble`);
    assert.equal(bodies.size, 3);
    assert.equal(pages[pages.length - 1].truncated, undefined, "the last page is clean");
    assert.match(pages[pages.length - 1]._next, /LAST page/);
  } finally {
    restore();
  }
});

test("one note bigger than the whole budget is split mid-note and marked partial", async () => {
  const notes = [bigNote("note-1", 55_000, "x")];
  const { calls, restore } = install("served", notes);
  try {
    const gw = await connect(calls);
    const first = (await handleFacadeTool(gw, "doc_read", { document: "Thesis" })) as any;

    assert.equal(first.truncated, true);
    assert.equal(first.notes.length, 1);
    assert.equal(first.notes[0].partial, true, "a fragment must say so");
    assert.ok(Buffer.byteLength(first.notes[0].body, "utf8") <= BUDGET);
    assert.equal(first.nextCursor.noteCursor, "note-1", "resume inside the same note");
    assert.ok(first.nextCursor.offset > 0 && first.nextCursor.offset < 55_010);

    const { bodies, pages } = await pageAll(gw, "Thesis");
    assert.equal(bodies.get("note-1"), notes[0].body, "the giant note reassembles exactly");
    assert.ok(pages.length >= 3);
  } finally {
    restore();
  }
});

test("the truncation message says how much is left and the exact call to fetch it", async () => {
  const notes = [bigNote("note-1", 30_000, "alpha "), bigNote("note-2", 4_000, "bravo ")];
  const { calls, restore } = install("served", notes);
  try {
    const gw = await connect(calls);
    const out = (await handleFacadeTool(gw, "doc_read", { document: "Thesis" })) as any;

    // How much is left — as numbers the caller can act on...
    assert.equal(out.budgetBytes, BUDGET);
    assert.equal(out.totalBytes, Buffer.byteLength(notes[0].body + notes[1].body, "utf8"));
    assert.equal(out.bytesReturned + out.bytesRemaining, out.totalBytes);
    assert.equal(out.notesRemaining, 2);
    // ...and in the prose, since that is what the model actually reads.
    assert.match(out._next, /TRUNCATED/);
    assert.match(out._next, new RegExp(String(out.bytesRemaining)));
    assert.match(out._next, /doc_read \{ document: "doc-thesis", noteCursor: "note-1", offset: \d+ \}/);
    assert.match(out._next, /never doc_write it back/i, "a fragment must not be written back");
  } finally {
    restore();
  }
});

test("paging never splits a UTF-8 codepoint", async () => {
  // "☕" is 3 bytes, and 20,000 is not divisible by 3 — so the budget boundary
  // lands INSIDE a sequence unless the slice backs off to a codepoint boundary,
  // and a split codepoint silently corrupts the markdown it was asked to read.
  const notes = [{ id: "note-1", body: "☕".repeat(15_000), createdBy: "agent" }];
  const { calls, restore } = install("served", notes);
  try {
    const gw = await connect(calls);
    const { bodies, pages } = await pageAll(gw, "Thesis");
    for (const p of pages) {
      assert.ok(!p.notes.some((n: any) => n.body.includes("�")), "a page decoded to garbage");
    }
    assert.equal(bodies.get("note-1"), notes[0].body);
  } finally {
    restore();
  }
});

test("a cursor whose note has vanished says so instead of silently restarting", async () => {
  const { calls, restore } = install("served");
  try {
    const gw = await connect(calls);
    await assert.rejects(
      () =>
        handleFacadeTool(gw, "doc_read", {
          document: "Thesis",
          noteCursor: "note-deleted",
          offset: 10,
        }) as Promise<unknown>,
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /"note-deleted" is not in "Thesis"/);
        assert.match(msg, /Re-read the tab from the start/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("a nonsense offset is refused before any request", async () => {
  const { calls, restore } = install("served");
  try {
    const gw = await connect(calls);
    await assert.rejects(
      () => handleFacadeTool(gw, "doc_read", { document: "Thesis", offset: -5 }) as Promise<unknown>,
      (err: unknown) => {
        assert.match(String(err), /`offset` must be a non-negative byte offset/);
        return true;
      }
    );
    assert.ok(!calls.some((c) => c.path.startsWith("/api/canvas/documents")), "rejected before the read");
  } finally {
    restore();
  }
});

test("doc_read requires a document and says how to find one", async () => {
  const { calls, restore } = install("served");
  try {
    const gw = await connect(calls);
    await assert.rejects(
      () => handleFacadeTool(gw, "doc_read", {}) as Promise<unknown>,
      (err: unknown) => {
        assert.match(String(err), /`document` \(string\) is required/);
        assert.match(String(err), /context_get/);
        return true;
      }
    );
    assert.ok(
      !calls.some((c) => c.path.startsWith("/api/canvas/documents")),
      "a missing argument is rejected before any request"
    );
  } finally {
    restore();
  }
});
