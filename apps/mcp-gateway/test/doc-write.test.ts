/**
 * TDM-137 — doc_write must not report a false success.
 *
 * The note PATCH 200s for ANY id (the API does not existence-check it), so the
 * gateway used to relay updated:true even when the noteId did not exist — telling
 * an agent its content was saved when it was silently dropped. doc_write now
 * confirms the note exists (a notes-only state read) before honouring an update.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool } from "../src/facade.js";

const CODE = "TESTCODE";

/** Record every request and answer the handful of endpoints doc_write touches. */
function install(notes: Record<string, { id: string; documentId?: string }>) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    if (url.pathname === "/api/mcp/auth") {
      return json({ token: "t", canvasId: "canvas-1", canvasName: "C", canvasCode: CODE });
    }
    if (url.pathname === "/api/canvas/state") {
      return json({ type: "state", canvas: {}, state: { notes } });
    }
    if (url.pathname.startsWith("/api/canvas/notes/") && method === "PATCH") {
      // The real API 200s regardless of whether the id exists.
      return json({ ok: "true" });
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

async function connect(): Promise<Gateway> {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  await handleTool(gw, "canvas_connect", { code: CODE, role: "executor", name: "worker-a" });
  return gw;
}

test("doc_write updates an existing note and echoes its documentId", async () => {
  const { calls, restore } = install({
    "note-1": { id: "note-1", documentId: "doc-9" },
  });
  try {
    const gw = await connect();
    const out = (await handleFacadeTool(gw, "doc_write", {
      noteId: "note-1",
      body: "fresh content",
    })) as any;
    assert.equal(out.updated, true);
    assert.equal(out.noteId, "note-1");
    assert.equal(out.documentId, "doc-9", "the documentId comes from the confirming read");
    assert.ok(
      calls.some((c) => c.method === "PATCH" && c.path === "/api/canvas/notes/note-1"),
      "a real update PATCHes the note"
    );
  } finally {
    restore();
  }
});

test("doc_write on a nonexistent noteId fails loudly and does NOT patch", async () => {
  const { calls, restore } = install({
    "note-1": { id: "note-1", documentId: "doc-9" },
  });
  try {
    const gw = await connect();
    await assert.rejects(
      () =>
        handleFacadeTool(gw, "doc_write", {
          noteId: "nonexistent-id-zzz",
          body: "content that must not be silently dropped",
        }) as Promise<unknown>,
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /No note with id "nonexistent-id-zzz" exists/);
        assert.match(msg, /NOT saved/);
        return true;
      }
    );
    assert.ok(
      !calls.some((c) => c.method === "PATCH"),
      "a nonexistent note must never reach the PATCH — the false success is the bug"
    );
  } finally {
    restore();
  }
});
