/**
 * TDM-32 — the intent facade is the DEFAULT manifest; the CRUD surface is one
 * env var away. These tests pin the manifest itself (pure, no network): which
 * tools are advertised, that the flag is additive, that every facade tool takes
 * the session handle, and the standing invariant that no manifest may ever
 * carry a webhook tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { FACADE_TOOLS, manifestFor, fullToolsEnabled } from "../src/server.js";
import { TOOLS } from "../src/tools.js";
import { isFacadeTool } from "../src/facade.js";

const EXPECTED_FACADE = [
  "canvas_connect",
  "context_get",
  "queue_next",
  "task_get",
  "task_claim",
  "task_progress",
  "task_complete",
  "task_propose",
  "doc_write",
  "board_status",
];

test("default manifest is exactly the 10-tool intent facade", () => {
  const names = manifestFor(false).map((t) => t.name);
  assert.deepEqual(names, EXPECTED_FACADE);
  assert.equal(names.length, 10);
});

test("TANDEM_FULL_TOOLS adds the CRUD surface without dropping or duplicating", () => {
  const full = manifestFor(true);
  const names = full.map((t) => t.name);
  assert.deepEqual(names.slice(0, EXPECTED_FACADE.length), EXPECTED_FACADE);
  assert.equal(new Set(names).size, names.length, "no duplicate tool names");
  // Every CRUD tool is reachable except canvas_connect, which the facade owns.
  for (const t of TOOLS) {
    if (t.name === "canvas_connect") continue;
    assert.ok(names.includes(t.name), `${t.name} missing from the full manifest`);
  }
  assert.ok(full.length > TOOLS.length, "full manifest is a superset");
});

test("facade's canvas_connect wins over the CRUD one (queue-first description)", () => {
  const connect = manifestFor(true).find((t) => t.name === "canvas_connect")!;
  assert.match(connect.description, /STEP 1/);
  assert.match(connect.description, /queue_next/);
});

test("fullToolsEnabled: explicit override beats the env var", () => {
  const prior = process.env.TANDEM_FULL_TOOLS;
  try {
    delete process.env.TANDEM_FULL_TOOLS;
    assert.equal(fullToolsEnabled(), false);
    assert.equal(fullToolsEnabled(true), true);
    for (const v of ["1", "true", "YES"]) {
      process.env.TANDEM_FULL_TOOLS = v;
      assert.equal(fullToolsEnabled(), true, `${v} should enable`);
    }
    for (const v of ["0", "", "off"]) {
      process.env.TANDEM_FULL_TOOLS = v;
      assert.equal(fullToolsEnabled(), false, `${v} should not enable`);
    }
    // An explicit false (not just undefined) still wins.
    process.env.TANDEM_FULL_TOOLS = "1";
    assert.equal(fullToolsEnabled(false), false);
  } finally {
    if (prior === undefined) delete process.env.TANDEM_FULL_TOOLS;
    else process.env.TANDEM_FULL_TOOLS = prior;
  }
});

test("SECURITY: no manifest may ever expose a webhook tool", () => {
  // Prompt-injection exfiltration: canvas content is attacker-influenced, so an
  // agent-facing tool that configures outbound HTTP is a data-exfil channel.
  // Webhooks are configured by a human in the web UI only.
  for (const tool of [...manifestFor(false), ...manifestFor(true), ...TOOLS]) {
    assert.doesNotMatch(tool.name, /webhook/i, `${tool.name} must not exist`);
    assert.doesNotMatch(
      JSON.stringify(tool.inputSchema),
      /webhook|callbackUrl/i,
      `${tool.name} takes a webhook-shaped argument`
    );
  }
});

test("every facade tool but the connector advertises the session handle", () => {
  for (const tool of FACADE_TOOLS) {
    const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    if (tool.name === "canvas_connect") {
      assert.equal(props.session, undefined, "connector must not take a session");
      continue;
    }
    assert.ok(props.session, `${tool.name} must accept the session handle`);
    assert.match(tool.description, /session/, `${tool.name} must document the handle`);
  }
});

test("read-only facade tools are annotated read-only", () => {
  const byName = new Map(FACADE_TOOLS.map((t) => [t.name, t]));
  for (const n of ["context_get", "queue_next", "task_get", "board_status"]) {
    assert.equal(byName.get(n)!.annotations.readOnlyHint, true, `${n} is a read`);
  }
  for (const n of ["task_claim", "task_complete", "doc_write", "task_propose"]) {
    assert.equal(byName.get(n)!.annotations.readOnlyHint, false, `${n} writes`);
    assert.equal(byName.get(n)!.annotations.destructiveHint, false);
  }
});

test("isFacadeTool routes facade names but leaves canvas_connect to the CRUD handler", () => {
  assert.equal(isFacadeTool("queue_next"), true);
  assert.equal(isFacadeTool("doc_write"), true);
  // canvas_connect is shared: one implementation, in tools.ts.
  assert.equal(isFacadeTool("canvas_connect"), false);
  assert.equal(isFacadeTool("canvas_task_list"), false);
});
