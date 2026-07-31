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
import { TOOLS, claimRejectionMessage } from "../src/tools.js";
import { isFacadeTool } from "../src/facade.js";
import {
  TAP_OUT_NEXT,
  TAP_OUT_REASONS,
  alreadyFinishedMessage,
  fenceRejectionMessage,
  notYourClaimMessage,
  repeatClaimRejectionMessage,
} from "../src/tapout.js";

const EXPECTED_FACADE = [
  "canvas_connect",
  "agent_register",
  "context_get",
  "queue_next",
  "task_find",
  "task_get",
  "task_claim",
  "task_progress",
  "task_complete",
  "task_propose",
  "task_amend",
  "task_approve",
  "epic_propose",
  "doc_write",
  "board_status",
];

test("default manifest is exactly the 15-tool intent facade", () => {
  const names = manifestFor(false).map((t) => t.name);
  assert.deepEqual(names, EXPECTED_FACADE);
  assert.equal(names.length, 15);
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

test("canvas_connect advertises connect-AND-register (TDM-61)", () => {
  // The fan-out recipe hangs off this: a subagent gets the code and must come up
  // registered under its planner in ONE call, or the fleet tree never forms.
  const connect = manifestFor(false).find((t) => t.name === "canvas_connect")!;
  const props = connect.inputSchema.properties as Record<string, any>;
  assert.deepEqual(props.role.enum, ["planner", "executor"]);
  assert.equal(props.name?.type, "string");
  assert.equal(props.model?.type, "string");
  assert.equal(props.parentAgentId?.type, "string");
  // Only the code is mandatory — registering stays opt-in.
  assert.deepEqual(connect.inputSchema.required, ["code"]);
  assert.match(connect.description, /role/);
});

test("agent_register is on the DEFAULT surface, for re-registration", () => {
  const reg = manifestFor(false).find((t) => t.name === "agent_register")!;
  assert.ok(reg, "a subagent that skipped role at connect must still be able to register");
  assert.deepEqual(reg.inputSchema.required, ["role"]);
  // It points back at the one-call path rather than competing with it.
  assert.match(reg.description, /canvas_connect/);
  assert.equal(reg.annotations.readOnlyHint, false);
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
  for (const n of ["context_get", "queue_next", "task_find", "task_get", "board_status"]) {
    assert.equal(byName.get(n)!.annotations.readOnlyHint, true, `${n} is a read`);
  }
  for (const n of [
    "task_claim",
    "task_complete",
    "doc_write",
    "task_propose",
    "epic_propose",
    "task_approve",
  ]) {
    assert.equal(byName.get(n)!.annotations.readOnlyHint, false, `${n} writes`);
    assert.equal(byName.get(n)!.annotations.destructiveHint, false);
  }
});

// TDM-72 — the bug class: prose the DEFAULT manifest shows a model must not send
// it after a tool that manifest doesn't advertise. The rejection a losing
// claimant gets said "call canvas_task_list", which is invisible on the facade.
// Every tool name a facade description or schema mentions has to be reachable
// from the facade itself.
test("facade-visible prose only names tools the facade advertises", () => {
  const advertised = new Set(FACADE_TOOLS.map((t) => t.name));
  // Underscored tool-shaped identifiers: our whole surface is named this way
  // (canvas_*, task_*, queue_next, board_status, context_get, doc_write).
  const TOOLISH = /\b(?:canvas|task|queue|board|context|doc|agent|epic)_[a-z_]+\b/g;
  // Words that look tool-shaped but are payload/argument names, not tools.
  const NOT_TOOLS = new Set(["task_queue", "agent_id", "canvas_id", "canvas_code", "epic_id"]);

  for (const tool of FACADE_TOOLS) {
    const prose = `${tool.description} ${JSON.stringify(tool.inputSchema)}`;
    for (const hit of prose.match(TOOLISH) ?? []) {
      if (NOT_TOOLS.has(hit)) continue;
      assert.ok(
        advertised.has(hit),
        `${tool.name} points the model at "${hit}", which the default manifest does not advertise`
      );
    }
  }
});

// TDM-81 — the same bug class one level out: prose that sends the human to a UI
// SURFACE that no longer exists. Descriptions told agents a human approves work
// "in the web Tasks panel"; that panel was replaced by the Board surface
// (columns Proposed / Ready / Working / Done), so the instruction named a thing
// nobody could find. Tool descriptions ship to models and are quoted back to
// users, so a renamed surface has to be renamed here too.
//
// Advertised prose is only half of it — the epic-approval refusal and the
// complete-conflict message are runtime strings built inside handlers, never on
// a manifest. So this guard reads the SOURCE (still pure, no network) and covers
// both.
const STALE_UI_SURFACES: Array<[RegExp, string]> = [
  [/tasks?\s*(?:panel|pane)\b/i, 'the Tasks panel is now the Board surface — say "on the board"'],
  [/TasksPanel/, "TasksPanel was replaced by TaskBoard — say \"on the board\""],
  [/tasks?\s+tab\b/i, 'tasks are a board surface, not a tab — say "on the board"'],
];

test("no advertised tool names a UI surface that no longer exists (TDM-81)", () => {
  for (const tool of [...manifestFor(false), ...manifestFor(true), ...TOOLS]) {
    const prose = `${tool.description} ${JSON.stringify(tool.inputSchema)}`;
    for (const [stale, fix] of STALE_UI_SURFACES) {
      assert.doesNotMatch(prose, stale, `${tool.name}: ${fix}`);
    }
  }
});

test("no gateway source string names a UI surface that no longer exists (TDM-81)", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) files.push(full);
    }
  };
  walk(srcDir);
  assert.ok(files.length > 5, "expected to find the gateway sources");

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [stale, fix] of STALE_UI_SURFACES) {
      const hit = text.match(stale);
      if (!hit) continue;
      // Report the offending line so the fix is one jump away.
      const line = text.slice(0, hit.index).split("\n").length;
      assert.fail(`${file.slice(srcDir.length)}:${line} says "${hit[0]}" — ${fix}`);
    }
  }
});

test("the claim rejection routes to a tool the facade advertises (TDM-72)", () => {
  const message = claimRejectionMessage("session-A");
  // The opening clause is the launch thread's freeze-frame (docs/demo-script.md §3).
  assert.match(message, /^This task is already claimed by "session-A" — another session got it first\./);
  assert.match(message, /Do NOT work on it\./);
  // It must name the ready-queue tool that exists on BOTH manifests…
  assert.match(message, /queue_next/);
  assert.ok(manifestFor(false).some((t) => t.name === "queue_next"));
  assert.ok(manifestFor(true).some((t) => t.name === "queue_next"));
  // …and never the CRUD-only one the default manifest hides.
  assert.doesNotMatch(message, /canvas_task_list/);
});

// TDM-99 — the tap-out contract, checked against the manifest it points at.
// Same bug class as TDM-72 one step further in: `next` is a MACHINE instruction,
// so a value naming a tool the default manifest hides would be worse than the
// prose bug, not better.
test("the tap-out `next` names a tool BOTH manifests advertise (TDM-99)", () => {
  assert.equal(TAP_OUT_NEXT, "queue_next");
  assert.ok(manifestFor(false).some((t) => t.name === TAP_OUT_NEXT));
  assert.ok(manifestFor(true).some((t) => t.name === TAP_OUT_NEXT));
});

test("tap-out reasons are a closed set (TDM-99)", () => {
  // Pinned because a loser may branch on `reason` after `tapOut`: adding one is
  // an interface change, so it should have to be made here on purpose.
  assert.deepEqual(
    [...TAP_OUT_REASONS].sort(),
    ["already_claimed", "already_finished", "already_lost", "fenced", "not_your_claim"]
  );
});

test("every tap-out message says stop AND names an advertised tool (TDM-99)", () => {
  const advertised = new Set(FACADE_TOOLS.map((t) => t.name));
  const TOOLISH = /\b(?:canvas|task|queue|board|context|doc|agent|epic)_[a-z_]+\b/g;
  const messages = [
    claimRejectionMessage("session-A"),
    repeatClaimRejectionMessage({
      taskId: "task-1",
      holder: "session-A",
      reason: "already_claimed",
      at: Date.now(),
      attempts: 2,
    }),
    fenceRejectionMessage("task-1", "session-A"),
    notYourClaimMessage("session-A", "complete"),
    alreadyFinishedMessage("done"),
  ];
  for (const message of messages) {
    // The instruction that makes it a tap-out rather than a description.
    assert.match(message, /Do NOT work on it/, `missing the stop instruction: ${message}`);
    assert.match(message, /queue_next/, `missing the route out: ${message}`);
    for (const hit of message.match(TOOLISH) ?? []) {
      assert.ok(advertised.has(hit), `a tap-out points the model at "${hit}", which is not advertised`);
    }
  }
});

test("isFacadeTool routes facade names but leaves the identity pair to the CRUD handler", () => {
  assert.equal(isFacadeTool("queue_next"), true);
  assert.equal(isFacadeTool("doc_write"), true);
  // Shared: advertised by the facade, one implementation, in tools.ts.
  assert.equal(isFacadeTool("canvas_connect"), false);
  assert.equal(isFacadeTool("agent_register"), false);
  assert.equal(isFacadeTool("canvas_task_list"), false);
});
