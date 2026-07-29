/**
 * TDM-33 — `tandem-mcp init`. Everything here is pure or runs against injected
 * fs/network deps: no disk, no HTTP. What's pinned is the contract that makes
 * the command safe to run twice — the .mcp.json merge never eats another
 * server, and a second run is a no-op.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_DOC_FILES,
  CANVAS_CODE_ENV,
  InitUsageError,
  MCP_SERVER_KEY,
  SNIPPET_MARKER,
  agentSnippet,
  appendSnippet,
  decideInit,
  defaultCanvasName,
  mergeMcpConfig,
  parseInitArgs,
  parseMcpConfig,
  readExistingCode,
  runInit,
  serializeMcpConfig,
  type CanvasHandle,
  type InitDeps,
  type InitOptions,
  type McpConfig,
} from "../src/init.js";
import { withConfiguredCanvasCode } from "../src/server.js";

// ── Args ─────────────────────────────────────────────────────────────────────

test("parseInitArgs: flags, = form, and defaults", () => {
  const bare = parseInitArgs([], "/proj");
  assert.equal(bare.dir, "/proj");
  assert.equal(bare.write, false);
  assert.equal(bare.force, false);
  assert.equal(bare.name, undefined);

  const full = parseInitArgs(
    ["--name", "My Board", "--code", "abcd1234", "--write", "--force"],
    "/proj"
  );
  assert.equal(full.name, "My Board");
  assert.equal(full.code, "ABCD1234", "codes are normalized to upper case");
  assert.equal(full.write, true);
  assert.equal(full.force, true);

  assert.equal(parseInitArgs(["--name=Inline Name"], "/proj").name, "Inline Name");
  assert.equal(parseInitArgs(["--dir", "sub"], "/proj").dir, "/proj/sub");
  assert.equal(parseInitArgs(["--help"], "/proj").help, true);
});

test("parseInitArgs: unknown flags and missing values are usage errors", () => {
  assert.throws(() => parseInitArgs(["--nope"], "/p"), InitUsageError);
  assert.throws(() => parseInitArgs(["--name"], "/p"), InitUsageError);
  assert.throws(() => parseInitArgs(["--name", "--write"], "/p"), InitUsageError);
});

test("defaultCanvasName is the folder name", () => {
  assert.equal(defaultCanvasName("/home/me/my-project"), "my-project");
  assert.equal(defaultCanvasName("/home/me/my-project/"), "my-project");
  assert.equal(defaultCanvasName("/"), "Untitled canvas");
});

// ── .mcp.json merge ──────────────────────────────────────────────────────────

test("mergeMcpConfig writes the npx stdio entry with the canvas code", () => {
  const merged = mergeMcpConfig(null, { code: "K3P9TQXR" });
  const entry = merged.mcpServers![MCP_SERVER_KEY];
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", "@jaximus/tandem-mcp"]);
  assert.equal(entry.env![CANVAS_CODE_ENV], "K3P9TQXR");
  assert.equal(entry.env!.API_URL, undefined, "hosted default is never pinned");
  assert.equal(mergeMcpConfig(null, { code: "X", apiUrl: "http://localhost:7891" })
    .mcpServers![MCP_SERVER_KEY].env!.API_URL, "http://localhost:7891");
});

test("mergeMcpConfig never clobbers other servers or unknown top-level keys", () => {
  const existing: McpConfig = {
    $schema: "https://example.com/mcp.json",
    mcpServers: {
      postgres: { command: "npx", args: ["-y", "@some/pg"], env: { PGHOST: "db" } },
      linear: { command: "linear-mcp" },
    },
  };
  const merged = mergeMcpConfig(existing, { code: "AAAA1111" });

  assert.equal(merged.$schema, "https://example.com/mcp.json");
  assert.deepEqual(merged.mcpServers!.postgres, existing.mcpServers!.postgres);
  assert.deepEqual(merged.mcpServers!.linear, existing.mcpServers!.linear);
  assert.equal(merged.mcpServers![MCP_SERVER_KEY].env![CANVAS_CODE_ENV], "AAAA1111");
  // Input is not mutated.
  assert.equal(existing.mcpServers![MCP_SERVER_KEY], undefined);
});

test("mergeMcpConfig preserves a hand-rolled tandem entry, changing only the code", () => {
  const existing: McpConfig = {
    mcpServers: {
      [MCP_SERVER_KEY]: {
        command: "node",
        args: ["/src/tandem/apps/mcp-gateway/dist/index.js", "--full-tools"],
        env: { API_URL: "http://localhost:7891", TANDEM_TOKEN: "secret" },
        disabled: false,
      },
    },
  };
  const entry = mergeMcpConfig(existing, { code: "NEWCODE1" }).mcpServers![MCP_SERVER_KEY];
  assert.equal(entry.command, "node", "local-dev command survives");
  assert.deepEqual(entry.args, ["/src/tandem/apps/mcp-gateway/dist/index.js", "--full-tools"]);
  assert.equal(entry.env!.TANDEM_TOKEN, "secret", "other env survives");
  assert.equal(entry.env!.API_URL, "http://localhost:7891");
  assert.equal(entry.disabled, false, "unknown keys survive");
  assert.equal(entry.env![CANVAS_CODE_ENV], "NEWCODE1");
});

test("serialize / parse round-trips", () => {
  const cfg = mergeMcpConfig(null, { code: "ROUND123" });
  const text = serializeMcpConfig(cfg);
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(parseMcpConfig(text, ".mcp.json"), cfg);
  assert.deepEqual(parseMcpConfig("   ", ".mcp.json"), {}, "empty file is an empty config");
  assert.throws(() => parseMcpConfig("{nope", ".mcp.json"), /not valid JSON/);
  assert.throws(() => parseMcpConfig("[]", ".mcp.json"), /JSON object/);
});

// ── Idempotency decision ─────────────────────────────────────────────────────

test("readExistingCode finds the pinned code, ignoring blanks", () => {
  assert.equal(readExistingCode(null), undefined);
  assert.equal(readExistingCode({}), undefined);
  assert.equal(readExistingCode({ mcpServers: { [MCP_SERVER_KEY]: {} } }), undefined);
  assert.equal(
    readExistingCode({ mcpServers: { [MCP_SERVER_KEY]: { env: { [CANVAS_CODE_ENV]: "  " } } } }),
    undefined
  );
  assert.equal(
    readExistingCode({ mcpServers: { [MCP_SERVER_KEY]: { env: { [CANVAS_CODE_ENV]: "CODE1234" } } } }),
    "CODE1234"
  );
});

test("decideInit: configured project re-runs as a no-op, --force overrides", () => {
  const configured = mergeMcpConfig(null, { code: "CODE1234" });

  assert.equal(decideInit(null, {}).action, "configure");
  assert.equal(decideInit({ mcpServers: { other: {} } }, {}).action, "configure");
  assert.equal(decideInit(configured, {}).action, "reuse");
  assert.equal(decideInit(configured, {}).existingCode, "CODE1234");
  assert.equal(decideInit(configured, { force: true }).action, "configure");
  // Same code passed explicitly is still a no-op; a different one repoints.
  assert.equal(decideInit(configured, { code: "CODE1234" }).action, "reuse");
  assert.equal(decideInit(configured, { code: "OTHER999" }).action, "configure");
});

// ── Agent snippet ────────────────────────────────────────────────────────────

test("agentSnippet teaches the facade queue loop with this canvas's code", () => {
  const snippet = agentSnippet({ code: "K3P9TQXR", url: "https://tandemcanvas.com/c/K3P9TQXR", canvasName: "my-project" });
  assert.ok(snippet.startsWith(SNIPPET_MARKER));
  assert.match(snippet, /my-project/);
  assert.match(snippet, /https:\/\/tandemcanvas\.com\/c\/K3P9TQXR/);
  // The facade names (TDM-32), in workflow order — not the CRUD ones.
  const order = ["canvas_connect", "queue_next", "task_get", "task_claim", "task_progress", "task_complete", "task_propose"];
  let cursor = -1;
  for (const name of order) {
    const at = snippet.indexOf(name);
    assert.ok(at > cursor, `${name} must appear, after the previous step`);
    cursor = at;
  }
  assert.doesNotMatch(snippet, /canvas_task_list|canvas_task_start/, "no legacy CRUD names");
  assert.ok(snippet.split("\n").filter((l) => l.trim()).length <= 14, "stays short");
});

test("appendSnippet is idempotent and preserves existing content", () => {
  const snippet = agentSnippet({ code: "K3P9TQXR", url: "https://x/c/K3P9TQXR" });
  const doc = "# My project\n\nSome rules.\n";

  const once = appendSnippet(doc, snippet, "K3P9TQXR")!;
  assert.ok(once.startsWith("# My project"), "existing content is kept");
  assert.ok(once.includes(SNIPPET_MARKER));
  assert.equal(appendSnippet(once, snippet, "K3P9TQXR"), null, "second append is a no-op");
  // Hand-pasted (marker-less) mention of the code also counts as present.
  assert.equal(appendSnippet("we use canvas K3P9TQXR", snippet, "K3P9TQXR"), null);
  assert.equal(appendSnippet("", snippet, "K3P9TQXR"), snippet);
});

// ── Flow (fake fs + fake network) ────────────────────────────────────────────

function harness(files: Record<string, string> = {}) {
  const out: string[] = [];
  const created: string[] = [];
  const connected: string[] = [];
  const deps: InitDeps = {
    webUrl: "https://tandemcanvas.com",
    createCanvas: async (name): Promise<CanvasHandle> => {
      created.push(name);
      return {
        code: "K3P9TQXR",
        name,
        url: "https://tandemcanvas.com/c/K3P9TQXR",
        claimUrl: "https://tandemcanvas.com/c/K3P9TQXR?claim=tok",
      };
    },
    connectCanvas: async (code): Promise<CanvasHandle> => {
      connected.push(code);
      return { code, name: "Existing", url: `https://tandemcanvas.com/c/${code}` };
    },
    readFile: (p) => files[p] ?? null,
    writeFile: (p, c) => {
      files[p] = c;
    },
    exists: (p) => p in files,
    out: (l) => out.push(l),
  };
  return { deps, files, out, created, connected, text: () => out.join("\n") };
}

const opts = (over: Partial<InitOptions> = {}): InitOptions => ({
  dir: "/proj/my-app",
  write: false,
  force: false,
  help: false,
  ...over,
});

test("runInit: fresh project creates a canvas, writes .mcp.json, prints code + URL", async () => {
  const h = harness();
  assert.equal(await runInit(opts(), h.deps), 0);

  assert.deepEqual(h.created, ["my-app"], "canvas is named after the folder");
  const written = parseMcpConfig(h.files["/proj/my-app/.mcp.json"], ".mcp.json");
  assert.equal(written.mcpServers![MCP_SERVER_KEY].env![CANVAS_CODE_ENV], "K3P9TQXR");

  const text = h.text();
  assert.match(text, /K3P9TQXR/);
  assert.match(text, /https:\/\/tandemcanvas\.com\/c\/K3P9TQXR/);
  assert.match(text, /claim=tok/, "the private claim link is surfaced");
  assert.match(text, /AGENTS\.md/, "snippet is printed with a paste hint");
  assert.match(text, /queue_next/);
});

test("runInit: re-run is a no-op — no canvas created, no file written", async () => {
  const h = harness({
    "/proj/my-app/.mcp.json": serializeMcpConfig(mergeMcpConfig(null, { code: "K3P9TQXR" })),
  });
  const before = h.files["/proj/my-app/.mcp.json"];

  assert.equal(await runInit(opts(), h.deps), 0, "exit 0 on a no-op");
  assert.deepEqual(h.created, [], "no second canvas");
  assert.equal(h.files["/proj/my-app/.mcp.json"], before, "file untouched");
  assert.match(h.text(), /already set up/);
  assert.match(h.text(), /K3P9TQXR/);
  assert.match(h.text(), /--force/);
});

test("runInit --force re-creates and repoints, keeping other servers", async () => {
  const existing = mergeMcpConfig({ mcpServers: { linear: { command: "linear-mcp" } } }, { code: "OLDCODE1" });
  const h = harness({ "/proj/my-app/.mcp.json": serializeMcpConfig(existing) });

  assert.equal(await runInit(opts({ force: true, name: "Renamed" }), h.deps), 0);
  assert.deepEqual(h.created, ["Renamed"]);
  const written = parseMcpConfig(h.files["/proj/my-app/.mcp.json"], ".mcp.json");
  assert.equal(written.mcpServers![MCP_SERVER_KEY].env![CANVAS_CODE_ENV], "K3P9TQXR");
  assert.equal(written.mcpServers!.linear.command, "linear-mcp");
});

test("runInit --code attaches an existing canvas instead of creating one", async () => {
  const h = harness();
  assert.equal(await runInit(opts({ code: "TEGLQFXR" }), h.deps), 0);
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.connected, ["TEGLQFXR"]);
  const written = parseMcpConfig(h.files["/proj/my-app/.mcp.json"], ".mcp.json");
  assert.equal(written.mcpServers![MCP_SERVER_KEY].env![CANVAS_CODE_ENV], "TEGLQFXR");
});

test("runInit --write appends to the agent docs that exist, twice safely", async () => {
  const h = harness({ "/proj/my-app/CLAUDE.md": "# Rules\n" });
  await runInit(opts({ write: true }), h.deps);

  assert.match(h.files["/proj/my-app/CLAUDE.md"], /# Rules/);
  assert.match(h.files["/proj/my-app/CLAUDE.md"], /queue_next/);
  assert.equal(h.files["/proj/my-app/AGENTS.md"], undefined, "does not invent a second doc");

  // Second pass (forced, so it reaches the write step) must not duplicate.
  const h2 = harness({
    "/proj/my-app/CLAUDE.md": h.files["/proj/my-app/CLAUDE.md"],
    "/proj/my-app/.mcp.json": h.files["/proj/my-app/.mcp.json"],
  });
  await runInit(opts({ write: true, force: true }), h2.deps);
  const occurrences = h2.files["/proj/my-app/CLAUDE.md"].split(SNIPPET_MARKER).length - 1;
  assert.equal(occurrences, 1, "snippet appears exactly once");
  assert.match(h2.text(), /already mentions this canvas/);
});

test("runInit --write with no agent doc starts AGENTS.md", async () => {
  const h = harness();
  await runInit(opts({ write: true }), h.deps);
  assert.match(h.files[`/proj/my-app/${AGENT_DOC_FILES[0]}`], /Tandem task queue/);
});

test("runInit surfaces a corrupt .mcp.json instead of overwriting it", async () => {
  const h = harness({ "/proj/my-app/.mcp.json": "{ oops" });
  await assert.rejects(() => runInit(opts(), h.deps), /not valid JSON/);
  assert.equal(h.files["/proj/my-app/.mcp.json"], "{ oops", "left exactly as it was");
});

// ── Manifest side of the env binding ─────────────────────────────────────────

test("withConfiguredCanvasCode tells the model which canvas this project is", () => {
  const tools = [
    { name: "canvas_connect", description: "STEP 1 …" },
    { name: "queue_next", description: "the queue" },
  ];
  assert.deepEqual(withConfiguredCanvasCode(tools, undefined), tools, "no env, no change");
  assert.deepEqual(withConfiguredCanvasCode(tools, "  "), tools);

  const pinned = withConfiguredCanvasCode(tools, "K3P9TQXR");
  assert.match(pinned[0].description, /`K3P9TQXR`/);
  assert.match(pinned[0].description, /STEP 1/, "original description is kept");
  assert.equal(pinned[1].description, "the queue", "other tools untouched");
  assert.equal(tools[0].description, "STEP 1 …", "input not mutated");
});
