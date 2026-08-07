/**
 * TDM-168 — the ticket-quality warnings are DERIVED at read time, not stored.
 *
 * TDM-159 computed them once, on the `epic_propose` response, and dropped them:
 * they reached the agent that had just made the mistake and nothing else could
 * read them back. The fix deliberately adds no column. The same rules now run
 * against the STORED row on task_get, which is what makes them answer for the
 * cases a propose-time snapshot could never have covered.
 *
 * What these pin:
 *
 *   1. a ticket that NEVER went through epic_propose — filed on its own with
 *      task_propose, or proposed before the contract existed — still reports;
 *   2. the derivation reads the row's CURRENT text, so amending a ticket
 *      changes what it says;
 *   3. propose time and read time AGREE. A read that disagreed with the call
 *      that proposed the batch would be worse than a read that said nothing;
 *   4. only ticket-scoped rules run on a single-ticket read. `context_duplicated`
 *      needs the batch, and a batch of one would never fire it — reporting
 *      "clean" where we mean "not checked" is the thing to avoid;
 *   5. `context_not_linked` respects the EPIC's links, which is the one fact the
 *      API has to supply (`epic.hasLinkedContext`, action_handler.go);
 *   6. finished work says nothing: a warning on a `done` ticket is noise on a
 *      read every session makes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Gateway, serializeSession } from "../src/gateway.js";
import { handleFacadeTool } from "../src/facade.js";
import {
  TICKET_CONTEXT_CHARS,
  TICKET_COORDINATE_CHARS_PER_REF,
  TICKET_COORDINATE_MIN_REFS,
  coordinateRefs,
  isCoordinateBrief,
} from "@agentcanvas/shared/ticket-quality";

type Routes = Record<string, (url: URL, body: any) => Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function install(routes: Routes) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const hit = routes[url.pathname];
    if (hit) return hit(url, body);
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return { restore: () => (globalThis.fetch = real) };
}

function gateway(): Gateway {
  const gw = new Gateway({ apiUrl: "http://api.test" });
  gw.adoptSession(
    serializeSession({
      token: "jwt",
      canvasId: "canvas-1",
      canvasName: "Test",
      canvasCode: "TESTCODE",
      agentName: "tester",
    })
  );
  return gw;
}

/** A body with nothing a rule can hold on to: no surface, no done condition. */
const MUSHY = "Clean up the auth stuff so it is less annoying to deal with day to day.";

/** The same ticket, written properly. */
const SPECIFIC =
  "In `apps/api/internal/api/auth_handler.go`, split the session lookup out of RequireUser. " +
  "Done when `go test ./...` passes and an expired cookie returns 401 rather than 500.";

/** Reads one task through task_get with whatever the API is pretending to hold. */
async function readTask(action: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const { restore } = install({
    "/api/canvas/actions/task-1": () => json({ action, linked: [], ...extra }),
  });
  try {
    return (await handleFacadeTool(gateway(), "task_get", { id: "task-1" })) as any;
  } finally {
    restore();
  }
}

function codes(res: any): string[] {
  return (res.quality ?? []).map((w: any) => w.code);
}

// ── 1. The case a stored warning could never have covered ────────────────────

test("a ticket that never went through epic_propose still reports its warnings", async () => {
  // No epicId: filed on its own with task_propose, which runs no contract at
  // all. Under a propose-time snapshot this ticket would be silent forever.
  const res = await readTask({
    id: "task-1",
    ticketId: "TDM-9",
    state: "proposed",
    payload: { title: "Fix auth", body: MUSHY },
  });

  assert.deepEqual(codes(res).sort(), ["no_done_condition", "no_surface_named"]);
  // Addressed to whoever can act: still 'proposed', so it is editable.
  assert.match(String(res._quality), /task_amend/);
  assert.match(String(res._quality), /do NOT block/i);
});

test("a specific ticket is left alone — no quality key at all", async () => {
  const res = await readTask({
    id: "task-1",
    state: "approved",
    payload: { title: "Split the session lookup out of RequireUser", body: SPECIFIC },
  });
  assert.equal("quality" in res, false, "a warning on a good ticket is the expensive mistake");
  assert.equal("_quality" in res, false);
});

// ── 2. It reads the text as it is NOW ────────────────────────────────────────

test("the derivation follows the row, so an amended ticket stops warning", async () => {
  const before = await readTask({
    id: "task-1",
    state: "proposed",
    payload: { title: "Fix auth", body: MUSHY },
  });
  assert.ok(codes(before).length > 0);

  // Same task id, text a human amended in place (TDM-160). Nothing was
  // re-proposed and no warning was rewritten — the rules simply read what is
  // there now.
  const after = await readTask({
    id: "task-1",
    state: "proposed",
    payload: { title: "Fix auth", body: SPECIFIC },
  });
  assert.equal("quality" in after, false);
});

// ── 3. Propose time and read time agree ──────────────────────────────────────

test("the read-time warnings are the same warnings epic_propose reported", async () => {
  const tasks = [
    { title: "Fix auth", body: MUSHY },
    { title: "Split the session lookup out of RequireUser", body: SPECIFIC },
  ];

  const { restore } = install({
    "/api/canvas/actions/batch": (_u, body: any) =>
      json(
        {
          actions: (body.actions as any[]).map((a, i) => ({
            id: `task-${i + 1}`,
            ticketId: `TDM-${i + 1}`,
            type: "task",
            state: "proposed",
            payload: a.payload,
          })),
        },
        201
      ),
    "/api/canvas/actions": (_u, body: any) =>
      json({ id: "epic-1", type: body?.type, state: "proposed", payload: body?.payload }, 201),
    "/api/canvas/meta": () => json({ canvas: {} }),
  });
  let proposed: any;
  try {
    proposed = (await handleFacadeTool(gateway(), "epic_propose", {
      title: "E99 · auth cleanup",
      tasks,
    })) as any;
  } finally {
    restore();
  }

  const proposeCodes = (proposed.warnings ?? [])
    .filter((w: any) => w.index === 0)
    .map((w: any) => w.code)
    .sort();
  assert.deepEqual(proposeCodes, ["no_done_condition", "no_surface_named"]);

  // The SAME ticket, read back off the row it just wrote.
  const read = await readTask({
    id: "task-1",
    ticketId: "TDM-1",
    state: "proposed",
    payload: { title: tasks[0].title, body: tasks[0].body },
  });
  assert.deepEqual(codes(read).sort(), proposeCodes, "the two ends must not drift");
});

// ── 4. Scope: a single-ticket read runs only what it can honestly answer ─────

test("context_duplicated never fires on a single-ticket read", async () => {
  // A long line that IS duplicated across the batch — but a read holding one
  // ticket cannot know that, so it must not claim to have checked.
  const pasted =
    "The claim fence rejects a heartbeat from a lease that has been superseded, by generation " +
    "rather than by name, so a worker whose task moved on cannot report into it.";
  const res = await readTask({
    id: "task-1",
    state: "approved",
    payload: { title: "Cover the fence in `apps/api`", body: `${pasted}\n${pasted}` },
  });
  assert.equal(codes(res).includes("context_duplicated"), false);
  assert.match(String(res._quality ?? ""), /Ticket-scoped rules only/);
});

// ── 5. The one fact the API supplies ─────────────────────────────────────────

test("an epic that links the shared note suppresses context_not_linked", async () => {
  const heavy = { title: "Wire the derivation", body: "x".repeat(1400) };

  const unlinked = await readTask(
    { id: "task-1", state: "proposed", payload: { ...heavy, epicId: "epic-1" } },
    { epic: { id: "epic-1", title: "E22", state: "proposed", hasLinkedContext: false } }
  );
  assert.ok(codes(unlinked).includes("context_not_linked"));

  const linked = await readTask(
    { id: "task-1", state: "proposed", payload: { ...heavy, epicId: "epic-1" } },
    { epic: { id: "epic-1", title: "E22", state: "proposed", hasLinkedContext: true } }
  );
  assert.equal(
    codes(linked).includes("context_not_linked"),
    false,
    "context linked once on the batch covers every ticket under it"
  );
});

// task_get has three return paths (no epic, epic with no rollup, epic with a
// rollup). The deepest one is what a worker in a batch actually hits, and it is
// the easy one to drop a field out of.
test("the warnings survive the epic-rollup branch of task_get", async () => {
  const { restore } = install({
    "/api/canvas/actions/task-1": () =>
      json({
        action: {
          id: "task-1",
          state: "approved",
          payload: { title: "Fix auth", body: MUSHY, epicId: "epic-1" },
        },
        linked: [],
        epic: { id: "epic-1", title: "E22", state: "approved", hasLinkedContext: false },
      }),
    "/api/canvas/epics": () =>
      json({
        epics: [
          {
            id: "epic-1",
            title: "E22",
            state: "approved",
            tasks: { total: 3, byState: { approved: 2, done: 1 } },
            done: [],
            returned: [],
            drained: false,
            summaryNeeded: false,
          },
        ],
        unepiced: { total: 0, byState: {} },
        unepicedReturned: [],
      }),
  });
  try {
    const res = (await handleFacadeTool(gateway(), "task_get", { id: "task-1" })) as any;
    assert.deepEqual(codes(res).sort(), ["no_done_condition", "no_surface_named"]);
    // …and the epic block it shares the answer with is still the deepened one.
    assert.equal(res.epic.openTasks, 2);
  } finally {
    restore();
  }
});

// ── 6. Finished work says nothing ────────────────────────────────────────────

test("a done or rejected ticket carries no warnings", async () => {
  for (const state of ["done", "failed", "rejected"]) {
    const res = await readTask({
      id: "task-1",
      state,
      payload: { title: "Fix auth", body: MUSHY },
    });
    assert.equal("quality" in res, false, `${state} is history, not something to fix`);
  }
});

test("an executing ticket is told to settle the questions before writing code", async () => {
  const res = await readTask({
    id: "task-1",
    state: "executing",
    payload: { title: "Fix auth", body: MUSHY },
  });
  assert.ok(codes(res).length > 0);
  assert.match(String(res._quality), /before you write code/i);
  assert.doesNotMatch(String(res._quality), /task_amend/);
});

// ── 7. context_not_linked measures DENSITY, not length (TDM-7) ───────────────
//
// The rule fired on `body.length > TICKET_CONTEXT_CHARS && !linked`, which is
// pure weight — and a coordinate brief is heavy for the right reason. A body
// that is mostly `path/file.go:123` IS the brief; there is no note it could
// have linked, so the advice ("link it instead of pasting it") had nothing to
// point at. What these pin is that the exemption is narrow: prose stays prose
// however many paths it name-drops, and both sides of the density bar are here.

/** TDM-7's calibration case, verbatim: TDM-1's real body — 1416 chars, a walk
 *  down one component naming 15 distinct coordinates and nothing else. */
const COORDINATE_BRIEF =
  "Surface: apps/web/src/components/TaskBoard.tsx only. Today only the bulk triage bar " +
  "(lines ~3583-3667, `bulkReason` textarea, ⌘/Ctrl+Enter submit) collects a reason; single " +
  "rejects never do. Add an optional-reason step, reusing the bulk bar's textarea pattern and " +
  "styling, to: (a) card-level `TriageControls` (~line 1021) — tapping Reject on a task opens " +
  "an inline reason strip (textarea + Reject submit + cancel) instead of firing `onReject()` " +
  "immediately (~1069-1076); (b) the epic two-step 'Confirm reject' strip (~1044-1058) — add " +
  "the textarea there; (c) the detail slide-over `confirmStrip` for reject (~4358-4383, " +
  "invoked ~4866) — add a textarea to the reject variant only (not delete). Reason stays " +
  "OPTIONAL everywhere — empty submit still rejects. Thread the string through `rejectOne` " +
  "(~2010), `reject` (~2021), and TaskDetail's `reject` (~4296) into the existing " +
  "`rejectAction(code, id, reason)` (apps/web/src/lib/api.ts:647 — no API changes needed). " +
  "Keep the `agent_task_rejected` analytics event and add a `with_reason` property mirroring " +
  "the batch event (~2233). Update the now-false header comment at ~999-1019 ('Neither path " +
  "takes a reason'). DONE WHEN: rejecting one task from card, epic strip, or detail panel can " +
  "carry a reason that shows in the existing 'Rejection reason' display (TaskBoard.tsx ~4804) " +
  "and TicketView; `cd apps/web && pnpm build` passes. Do not touch apps/api or apps/mcp-gateway.";

/** Prose with no coordinate in it, for padding a body out to a length. */
const FILLER =
  "the fence rejects a heartbeat from a lease that has been superseded, by generation rather " +
  "than by name, so a worker whose task has moved on cannot report into it ";

/** A body of exactly `length` chars carrying exactly `refs` distinct coordinates. */
function body(refs: number, length: number): string {
  const head = Array.from(
    { length: refs },
    (_, i) => `apps/api/internal/api/action_handler.go:${100 + i}`
  ).join(", ");
  let out = head;
  while (out.length < length) out += ` ${FILLER}`;
  return out.slice(0, Math.max(length, head.length));
}

/** Reads a heavy body with nothing linked on it or its epic — the firing case. */
async function heavy(text: string) {
  return readTask({
    id: "task-1",
    state: "proposed",
    payload: { title: "Thread the rejection reason through", body: text },
  });
}

test("a coordinate brief is not pasted context — TDM-1's body warns about nothing", async () => {
  assert.ok(COORDINATE_BRIEF.length > TICKET_CONTEXT_CHARS, "must be heavy enough to have fired");
  assert.equal(coordinateRefs(COORDINATE_BRIEF).length, 15);

  const res = await heavy(COORDINATE_BRIEF);
  assert.equal(
    codes(res).includes("context_not_linked"),
    false,
    "the map IS the brief — there is no note it could have linked instead"
  );
  // And nothing else took its place: a brief this specific is simply a good
  // ticket, so the read stays silent rather than swapping one warning for another.
  assert.equal("quality" in res, false, JSON.stringify(codes(res)));
});

test("prose stays prose however many paths it name-drops", async () => {
  // 1400 chars, two file mentions — one coordinate per ~700 chars. This is the
  // body the rule is FOR: the context is real, and it belongs in a linked note.
  const prose = `We should revisit how apps/api/internal/api/hub.go and the board in ` +
    `apps/web/src/components/TaskBoard.tsx came to disagree about presence. ${FILLER.repeat(9)}`;
  assert.ok(prose.length > TICKET_CONTEXT_CHARS);

  const res = await heavy(prose);
  assert.ok(codes(res).includes("context_not_linked"));
});

test("the density bar, from both sides", async () => {
  // Same eight coordinates. Under the bar (8 × 200 ≥ 1500) it is a brief; the
  // only thing that changes below is how much prose is wrapped around them.
  const tight = await heavy(body(8, 1500));
  assert.equal(codes(tight).includes("context_not_linked"), false);

  // 8 × 200 = 1600 < 1700: the same coordinates, now diluted. Kept under
  // TICKET_SPRAWL_CHARS so this is the context rule answering, not sprawl.
  const diluted = await heavy(body(8, 1700));
  assert.ok(codes(diluted).includes("context_not_linked"));
  assert.equal(codes(diluted).includes("may_exceed_one_sitting"), false);
});

test("one path repeated is repetition, not a map", async () => {
  // Thirty mentions, one distinct coordinate. Counting matches instead of
  // distinct refs would have handed this an exemption, and a body that repeats
  // itself is exactly the shape the rule exists to notice.
  const repeated = `apps/api/internal/api/action_handler.go:412 `.repeat(30);
  assert.equal(coordinateRefs(repeated).length, 1);
  assert.ok(repeated.length > TICKET_CONTEXT_CHARS);

  const res = await heavy(repeated);
  assert.ok(codes(res).includes("context_not_linked"));
});

test("the exemption's constants say what the comment says they say", () => {
  // 200 is TICKET_CONTEXT_CHARS / TICKET_COORDINATE_MIN_REFS, so the floor and
  // the density are the same bar at the length where the rule starts firing.
  // Retune one of the three and this fails rather than drifting quietly.
  assert.equal(
    TICKET_CONTEXT_CHARS / TICKET_COORDINATE_MIN_REFS,
    TICKET_COORDINATE_CHARS_PER_REF
  );

  // The floor on its own: five coordinates in a short body is a mention, not a
  // map, however dense. (Unreachable through the rule while the trigger is
  // 1200 chars — which is the point of keeping it.)
  const five = body(5, 400);
  assert.equal(coordinateRefs(five).length, 5);
  assert.equal(isCoordinateBrief(five), false);
  assert.equal(isCoordinateBrief(body(6, 400)), true);
});

test("a linked coordinate brief is still just linked", async () => {
  // The exemption is a second reason not to warn, never a reason to. The
  // pre-existing suppressions have to keep working underneath it.
  const res = await readTask(
    {
      id: "task-1",
      state: "proposed",
      payload: { title: "Thread the reason through", body: body(8, 1700), epicId: "epic-1" },
    },
    { epic: { id: "epic-1", title: "E22", state: "proposed", hasLinkedContext: true } }
  );
  assert.equal(codes(res).includes("context_not_linked"), false);
});
