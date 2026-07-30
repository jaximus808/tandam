/**
 * TDM-131 — the surface must teach itself to a cold client.
 *
 * Two things are pinned here: the server-level briefing carried at initialize
 * (InitializeResult.instructions), and that the `session` line is FRONT-loaded on
 * the longest tool descriptions so a length-capping client can't drop it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { FACADE_TOOLS, SERVER_INSTRUCTIONS, createTandemServer } from "../src/server.js";
import { Gateway } from "../src/gateway.js";

test("SERVER_INSTRUCTIONS carries the four load-bearing rules", () => {
  const s = SERVER_INSTRUCTIONS;
  // 1. connect first + carry the session handle on every call
  assert.match(s, /canvas_connect/);
  assert.match(s, /session/);
  assert.match(s, /EVERY later call/i);
  // 2. the executor loop, named end to end
  for (const tool of ["queue_next", "task_claim", "task_progress", "task_complete"]) {
    assert.match(s, new RegExp(tool), `instructions must name ${tool}`);
  }
  // 3. the human approval gate
  assert.match(s, /proposed/);
  assert.match(s, /approve/i);
  // 4. orchestrator SEQUENCING — the rule the field incident broke
  assert.match(s, /WAIT for the human's approval/i);
  assert.match(s, /before you dispatch|before dispatching/i);
  assert.match(s, /CODE, never your `session`/);
  // Compact — this rides on every initialize.
  assert.ok(s.length < 1600, `instructions are ${s.length} chars; keep them compact`);
});

test("createTandemServer wires the instructions in (does not throw)", () => {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  const server = createTandemServer(gw, "0.0.0-test");
  assert.ok(server, "server builds with instructions set");
});

test("the session line is FRONT-loaded on the longest facade descriptions", () => {
  const byName = new Map(FACADE_TOOLS.map((t) => [t.name, t]));
  // The entry point and the write tools are the longest and the ones a length
  // cap bites first; the session sentence must be in their opening, not trailing.
  for (const name of [
    "queue_next",
    "task_claim",
    "task_complete",
    "task_propose",
    "epic_propose",
  ]) {
    const desc = byName.get(name)!.description;
    const head = desc.slice(0, 120);
    assert.match(head, /session/, `${name} must lead with the session handle line`);
  }
});
