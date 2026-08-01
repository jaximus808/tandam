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
function install(scopedEndpoint: "served" | "missing" | "unknown-ref") {
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
        notes: THESIS_NOTES,
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
            "note-2": { ...THESIS_NOTES[1], documentId: "doc-thesis", sortOrder: 2 },
            "note-other": { id: "note-other", body: "belongs to Strategy", documentId: "doc-strategy", sortOrder: 1 },
            "note-1": { ...THESIS_NOTES[0], documentId: "doc-thesis", sortOrder: 1 },
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
