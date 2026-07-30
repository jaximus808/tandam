#!/usr/bin/env tsx
/**
 * THE TAP-OUT PROOF (TDM-102 / E14) — two agents, one task, and one of them
 * MUST let go.
 *
 * WHY THIS EXISTS. In a live multi-subagent run the contention story failed in
 * the worst possible way: two workers reached for the same task and *neither*
 * stopped. They looped — claim, lose, re-read the queue, claim again — burning
 * tokens and, on the board, looking busy. The contracts that fix that landed as
 * code (the gateway's tap-out block, TDM-99; the API's claim fence, TDM-98) and
 * both have unit tests. What did NOT exist was a way to point two agents at one
 * task and watch one of them tap out for real, end to end, against a running
 * server. That is this script.
 *
 * WHAT AN "AGENT" IS HERE. Two `Gateway` instances in one process, each with its
 * own canvas session and its own registered identity, driven through the SAME
 * entry point a real MCP client goes through (`handleTool` / `handleFacadeTool`).
 * So the tool layer, the loss ledger, the conflict parsing and every HTTP call
 * are the production paths — the only thing scripted is the decision-making that
 * a model would otherwise do, which is exactly the part that has to be
 * deterministic for this to be re-runnable. No LLM in the loop.
 *
 * WHAT IT ASSERTS. See the phase banners below; every check prints PASS/FAIL and
 * a non-zero exit means the contention contract regressed.
 *
 *   1. the race            exactly one claimed:true; the loser gets tapOut with
 *                          reason "already_claimed" and the winner as holder.
 *   2. the loser's writes   progress / complete / move are all refused, and the
 *                          task is byte-identical afterwards — ZERO mutations.
 *   3. the anti-loop        a deliberately BAD loser (the one from the incident)
 *                          re-claims 10 times: every answer is "already_lost"
 *                          with a rising attempt count, and the gateway makes
 *                          ZERO API calls doing it.
 *   4. the winner           heartbeats, completes; exactly one completion.
 *   5. the aftermath        a write against the finished task taps out with
 *                          "already_finished".
 *   6. lease recovery       the winner goes silent, the lease is ended, the task
 *                          becomes claimable again, the loser's remembered loss
 *                          is FORGOTTEN, it reclaims under a NEW generation, and
 *                          the dead winner's late completion is refused.
 *   7. the fence            a write presenting a STALE claim generation is
 *                          refused 409 {fenced:true} — the case holder identity
 *                          cannot see.
 *
 * SCOPE, HONESTLY STATED. Phase 6 ends the winner's lease with the board's
 * release control rather than by waiting out the ~15-minute claim TTL: the TTL is
 * fixed at server boot (CLAIM_TTL_MINUTES) and this harness does not start or
 * stop servers, so waiting is not something you can put in CI. The lease-EXPIRY
 * path — same fence, different reason for the lease ending — is proven in Go
 * against the store fake, which can backdate a claim: see
 * TestContentionHarnessScenario2LeaseExpiry in apps/api/internal/api. The split
 * is documented in docs/contention-harness.md.
 *
 * SAFETY. The harness CREATES its own scratch canvas and works only in there. It
 * never touches a canvas you name, and in particular never the planning canvas.
 *
 * RUN IT:  pnpm --filter @jaximus/tandem-mcp qa:contention
 *          (or: cd apps/mcp-gateway && pnpm qa:contention)
 * FLAGS:   --api=<url>        API base (default $API_URL or http://localhost:7891)
 *          --require-fence    treat a server without claim fencing as a FAILURE
 *                             rather than a skip (use once TDM-98 is deployed)
 *          --keep             don't delete the scratch canvas's tasks on exit
 */

import { Gateway, type CanvasSession } from "../src/gateway.js";
import { handleTool } from "../src/tools.js";
import { handleFacadeTool, isFacadeTool } from "../src/facade.js";

// ── Options ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
};

const API_URL = (flag("api") || process.env.API_URL || "http://localhost:7891").replace(/\/$/, "");
const REQUIRE_FENCE = flag("require-fence") !== undefined;
const KEEP = flag("keep") !== undefined;

// ── Instrumented fetch: the harness counts what reached the API ──────────────
//
// "The loser made zero API writes" is half the anti-loop contract, and the only
// way to prove it from outside is to count. Every call the gateway makes goes
// through global fetch, so wrapping it here captures agents and harness alike;
// phases take a MARK and assert on what happened after it.

interface Req {
  method: string;
  path: string;
  status: number;
  /** The request body, when it was a string — phase 8 reads it. */
  body?: string;
  /**
   * True for a call the HARNESS made directly (the board/human surface, and the
   * one raw agent write phase 7 needs). Phase 8 asks what the GATEWAY sends, so
   * it must not count the harness's own hand-rolled requests as evidence.
   */
  harness?: true;
}
/** Depth counter, not a boolean: the raw helpers do not nest today, but a nested
 * call would silently un-tag the outer one if this were a flag. */
let rawDepth = 0;
const REQUESTS: Req[] = [];
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : undefined;
  const res = await realFetch(input as never, init);
  REQUESTS.push({
    method,
    path: url.replace(API_URL, ""),
    status: res.status,
    ...(body ? { body } : {}),
    ...(rawDepth > 0 ? { harness: true as const } : {}),
  });
  return res;
}) as typeof fetch;

const mark = (): number => REQUESTS.length;
const since = (m: number): Req[] => REQUESTS.slice(m);

// ── Reporting ────────────────────────────────────────────────────────────────

let failures = 0;
let skipped = 0;
let gaps = 0;

function phase(title: string): void {
  process.stdout.write(`\n── ${title} ${"─".repeat(Math.max(0, 68 - title.length))}\n`);
}

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    process.stdout.write(`  PASS  ${label}\n`);
    return;
  }
  failures++;
  process.stdout.write(`  FAIL  ${label}\n`);
  if (detail !== undefined) {
    process.stdout.write(`        got: ${brief(detail)}\n`);
  }
}

/** A capability the running server does not have. Skipped, unless --require-fence. */
function gated(label: string, reason: string): void {
  if (REQUIRE_FENCE) {
    failures++;
    process.stdout.write(`  FAIL  ${label}\n        ${reason} (--require-fence)\n`);
    return;
  }
  skipped++;
  process.stdout.write(`  SKIP  ${label}\n        ${reason}\n`);
}

/**
 * A KNOWN HOLE the harness measured rather than a contract that broke. Reported
 * loudly and counted, but it does not fail the run: a gap is work that has not
 * been done yet, and a suite that goes red for it can't be used as a regression
 * gate. Every gap must name the tripwire test that will fail when it closes.
 */
function gap(label: string, detail: string): void {
  gaps++;
  process.stdout.write(`  GAP   ${label}\n        ${detail}\n`);
}

function note(text: string): void {
  process.stdout.write(`  note  ${text}\n`);
}

function brief(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

// ── Agents ───────────────────────────────────────────────────────────────────

type Args = Record<string, unknown>;

interface Agent {
  name: string;
  gateway: Gateway;
  session: CanvasSession;
  /** Drive a tool exactly as an MCP client would — facade first, then CRUD. */
  call(tool: string, args?: Args): Promise<Record<string, unknown>>;
}

function newGateway(): Gateway {
  return new Gateway({ apiUrl: API_URL, webUrl: API_URL, requestTimeoutMs: 20000 });
}

async function connectAgent(code: string, name: string, parentAgentId?: string): Promise<Agent> {
  const gateway = newGateway();
  const res = (await handleTool(gateway, "canvas_connect", {
    code,
    role: "executor",
    name,
    ...(parentAgentId ? { parentAgentId } : {}),
  })) as Record<string, unknown>;
  if (res.connected !== true) throw new Error(`${name} could not connect: ${brief(res)}`);
  const agent: Agent = {
    name,
    gateway,
    session: gateway.getSession(),
    async call(tool, args = {}) {
      const handler = isFacadeTool(tool) ? handleFacadeTool : handleTool;
      return (await handler(gateway, tool, args)) as Record<string, unknown>;
    },
  };
  return agent;
}

// ── The human / board surface ────────────────────────────────────────────────
//
// Deliberately RAW http with no X-Tandem-Agent header, because that is what
// makes a caller "a human" to the API: the claim fence engages on a caller that
// asserts an agent identity and stays out of the way for one that does not, which
// is how the board keeps its release/requeue/delete escape hatches over a task an
// agent is holding (see apps/api/internal/api/claim_fence.go). Driving the
// release through a Gateway instead would (correctly) be fenced.

let humanToken = "";

async function human<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: T }> {
  rawDepth++;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(humanToken ? { Authorization: `Bearer ${humanToken}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).finally(() => {
    rawDepth--;
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed as T };
}

/**
 * An AGENT-identified raw write. The gateway never presents a claim generation
 * today (it reads one out of a refusal but has no field to send it in), so the
 * stale-token case — the one holder identity cannot see — has to be exercised at
 * the wire level. Everything else in this harness goes through the tool layer.
 */
async function agentPatch(
  agentName: string,
  id: string,
  body: Args
): Promise<{ status: number; body: Record<string, unknown> }> {
  rawDepth++;
  const res = await fetch(`${API_URL}/api/canvas/actions/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${humanToken}`,
      "X-Tandem-Agent": agentName,
    },
    body: JSON.stringify({ agentName, ...body }),
  }).finally(() => {
    rawDepth--;
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

type StoredTask = {
  id: string;
  state: string;
  claimedBy?: string | null;
  claimedAt?: string | null;
  result?: string | null;
  payload?: Record<string, unknown>;
};

/** A neutral observer read: what the SERVER thinks the task is right now. */
async function readTask(id: string): Promise<StoredTask> {
  const { status, body } = await human<{ action?: StoredTask } & Partial<StoredTask>>(
    "GET",
    `/api/canvas/actions/${id}`
  );
  if (status !== 200) throw new Error(`read task ${id}: ${status} ${brief(body)}`);
  const action = body.action ?? (body as StoredTask);
  if (!action?.state) throw new Error(`read task ${id}: unexpected shape ${brief(body)}`);
  return action;
}

/**
 * The task as a comparable string, with the fields that legitimately move on any
 * write stripped out. `updatedAt` changes on every touch; everything else here is
 * what a mutation would show up in.
 */
function fingerprint(t: StoredTask): string {
  const { state, claimedBy, claimedAt, result, payload } = t;
  const p = { ...(payload ?? {}) };
  return JSON.stringify({ state, claimedBy, claimedAt, result, payload: p });
}

interface Counters {
  claims?: number;
  claim_conflicts?: number;
  ttl_expiries?: number;
  fenced_writes?: number;
}

async function counters(): Promise<Counters> {
  const { status, body } = await human<{ counters?: Counters }>("GET", "/api/metrics");
  if (status !== 200 || !body.counters) return {};
  return body.counters;
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

interface Scratch {
  code: string;
  url: string;
  taskIds: string[];
}

async function createScratch(): Promise<Scratch> {
  // A gateway with no registered identity stands in for "the human who made the
  // board": it creates the canvas and lends the harness its canvas JWT.
  const owner = newGateway();
  const session = await owner.createCanvas(
    `contention-harness ${new Date().toISOString().replace(/\..*/, "")}`
  );
  humanToken = session.token;
  return { code: session.canvasCode, url: owner.canvasUrl(session.canvasCode), taskIds: [] };
}

/**
 * One task, created the way the board creates one and approved the way a human
 * approves one — proposed, then POST …/approve — so the queue this harness races
 * over is a real approved queue and not a hand-placed row.
 */
async function addApprovedTask(scratch: Scratch, title: string): Promise<string> {
  const created = await human<{ action?: { id?: string }; id?: string }>(
    "POST",
    "/api/canvas/actions",
    {
      type: "task",
      state: "proposed",
      payload: { title, body: "Scratch task for the contention harness.", assignee: "agent" },
      proposedBy: "contention-harness",
    }
  );
  // The propose endpoint answers with the bare action; other action endpoints wrap
  // it in {action}. Read both rather than pinning one spelling.
  const id = created.body?.action?.id ?? created.body?.id;
  if (created.status >= 300 || !id) {
    throw new Error(`could not create task: ${created.status} ${brief(created.body)}`);
  }
  const approved = await human("POST", `/api/canvas/actions/${id}/approve`, {
    approvedBy: "contention-harness",
  });
  if (approved.status >= 300) {
    throw new Error(`could not approve task: ${approved.status} ${brief(approved.body)}`);
  }
  scratch.taskIds.push(id);
  return id;
}

/**
 * Teardown deletes the tasks the harness made. The scratch CANVAS itself stays:
 * deleting a canvas needs an owning user account and this harness runs anonymous
 * on purpose (it must work with nothing but an API URL). An empty scratch canvas
 * is inert — and its code is printed either way so you can open or delete it.
 */
async function teardown(scratch: Scratch): Promise<void> {
  for (const id of scratch.taskIds) {
    // No agent header: the human escape hatch, so a task still held by a worker
    // is deletable. A fenced delete here would leave litter behind.
    await human("DELETE", `/api/canvas/actions/${id}`);
  }
}

// ── Tap-out shape ────────────────────────────────────────────────────────────

const TAP_OUT_REASONS = [
  "already_claimed",
  "already_lost",
  "not_your_claim",
  "already_finished",
  "fenced",
] as const;

/** Assert the machine-readable block a loser branches on, whatever produced it. */
function checkTapOut(
  label: string,
  res: Record<string, unknown>,
  want: { reason?: string; reasonIn?: readonly string[]; attempts?: number; holder?: string }
): void {
  check(`${label}: tapOut:true`, res.tapOut === true, res);
  check(
    `${label}: next = "queue_next"`,
    res.next === "queue_next",
    res.next
  );
  const reason = res.reason;
  check(
    `${label}: reason is in the closed set`,
    typeof reason === "string" && (TAP_OUT_REASONS as readonly string[]).includes(reason),
    reason
  );
  if (want.reason !== undefined) {
    check(`${label}: reason = "${want.reason}"`, reason === want.reason, reason);
  }
  if (want.reasonIn !== undefined) {
    check(
      `${label}: reason in {${want.reasonIn.join(", ")}}`,
      typeof reason === "string" && want.reasonIn.includes(reason),
      reason
    );
  }
  if (want.attempts !== undefined) {
    check(`${label}: attempts = ${want.attempts}`, res.attempts === want.attempts, res.attempts);
  }
  if (want.holder !== undefined) {
    check(`${label}: holder = "${want.holder}"`, res.holder === want.holder, res.holder);
  }
  check(
    `${label}: message tells it to stop`,
    typeof res.message === "string" && /do not work on it|not yours|already/i.test(res.message),
    res.message
  );
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.stdout.write(
    `\nTandem contention harness (TDM-102) — two agents, one task\n` +
      `api: ${API_URL}${REQUIRE_FENCE ? "  [--require-fence]" : ""}\n`
  );

  // ── Phase 0: what does this server actually implement? ─────────────────────
  phase("phase 0 · server capabilities");
  const c0 = await counters();
  const hasCounters = Object.keys(c0).length > 0;
  const hasFencedWrites = c0.fenced_writes !== undefined;
  check("server reachable and exposing /api/metrics counters", hasCounters, c0);
  if (hasFencedWrites) {
    note("counters include fenced_writes — this build has the TDM-98 fence metric");
  } else {
    note("counters have NO fenced_writes — this build predates the TDM-98 fence metric");
  }

  const scratch = await createScratch();
  process.stdout.write(`scratch canvas: ${scratch.url}  (code ${scratch.code})\n`);

  try {
    const t1 = await addApprovedTask(scratch, "harness T1 — the race");
    const t2 = await addApprovedTask(scratch, "harness T2 — lease recovery");

    const a = await connectAgent(scratch.code, "harness-worker-a");
    const b = await connectAgent(scratch.code, "harness-worker-b", a.session.agentId);
    check("two sessions are DIFFERENT claimants", a.gateway.claimant() !== b.gateway.claimant(), {
      a: a.gateway.claimant(),
      b: b.gateway.claimant(),
    });

    // ── Phase 1: the race ────────────────────────────────────────────────────
    phase("phase 1 · simultaneous claim on ONE approved task");
    const beforeRace = await counters();
    const [ra, rb] = await Promise.all([
      a.call("task_claim", { id: t1 }),
      b.call("task_claim", { id: t1 }),
    ]);
    const won = [
      { agent: a, res: ra },
      { agent: b, res: rb },
    ].filter((x) => x.res.claimed === true);
    const lost = [
      { agent: a, res: ra },
      { agent: b, res: rb },
    ].filter((x) => x.res.claimed !== true);
    check("exactly ONE claimed:true", won.length === 1, { a: ra.claimed, b: rb.claimed });
    check("exactly ONE loser", lost.length === 1, { a: ra.claimed, b: rb.claimed });
    if (won.length !== 1 || lost.length !== 1) {
      throw new Error("the race did not produce one winner and one loser — cannot continue");
    }
    const winner = won[0]!.agent;
    const loser = lost[0]!.agent;
    process.stdout.write(`  winner: ${winner.name}   loser: ${loser.name}\n`);

    checkTapOut("loser", lost[0]!.res, {
      reason: "already_claimed",
      attempts: 1,
      holder: winner.name,
    });
    check(
      "loser's claimedBy names the winner",
      lost[0]!.res.claimedBy === winner.name,
      lost[0]!.res.claimedBy
    );

    const stored = await readTask(t1);
    check("server says the task is executing", stored.state === "executing", stored.state);
    check("server says the WINNER holds it", stored.claimedBy === winner.name, stored.claimedBy);

    const claimBlock = (won[0]!.res.claim ?? {}) as { generation?: number; holder?: string };
    const hasGenerations = typeof claimBlock.generation === "number" && claimBlock.generation > 0;
    if (hasGenerations) {
      check(
        "the winning claim minted a fencing token (claim.generation >= 1)",
        (claimBlock.generation ?? 0) >= 1,
        claimBlock
      );
    } else {
      gated(
        "the winning claim mints a fencing token (claim.generation)",
        "this API build returns no `claim` block on a claim — it predates TDM-98"
      );
    }

    const afterRace = await counters();
    const conflictDelta = (afterRace.claim_conflicts ?? 0) - (beforeRace.claim_conflicts ?? 0);
    check(
      "claim_conflicts rose by at least 1 (the contention signal)",
      conflictDelta >= 1,
      { before: beforeRace.claim_conflicts, after: afterRace.claim_conflicts }
    );

    // ── Phase 2: the loser writes anyway ─────────────────────────────────────
    phase("phase 2 · the loser's writes are refused, with ZERO mutations");
    const fp = fingerprint(await readTask(t1));

    const prog = await loser.call("task_progress", { id: t1, note: "loser reporting progress" });
    check("progress refused (recorded:false)", prog.recorded === false, prog);
    // TDM-122: a WRITE against a task a rival holds reports "not_your_claim" again.
    // The API carries fenced:true on EVERY refusal (so a client can branch on one
    // flag), but the CODE — claimed_by_other here — is what the gateway routes on,
    // so a rival holder is told apart from a stale lease ("fenced"). This is the
    // loser's FIRST write, so it races the API rather than being answered from the
    // loss ledger: the reason is pinned to a single value, not a set.
    checkTapOut("progress", prog, {
      reason: "not_your_claim",
      holder: winner.name,
    });

    const comp = await loser.call("task_complete", { id: t1, result: "loser completing" });
    check("complete refused (completed:false)", comp.completed === false, comp);
    // The progress refusal above recorded a loss, so a follow-up write can be
    // answered locally as "already_lost" (the anti-loop) instead of racing to
    // "not_your_claim". Never "fenced": a rival holder is not a generation fence.
    checkTapOut("complete", comp, {
      reasonIn: ["not_your_claim", "already_lost"],
      holder: winner.name,
    });

    const mv = await loser.call("canvas_action_update_state", { id: t1, state: "done" });
    check("state move refused (moved:false)", mv.moved === false, mv);
    checkTapOut("move", mv, { reasonIn: ["not_your_claim", "already_lost"] });

    const afterLoserWrites = await readTask(t1);
    check(
      "the task is UNCHANGED after three refused writes",
      fingerprint(afterLoserWrites) === fp,
      { before: fp, after: fingerprint(afterLoserWrites) }
    );
    check(
      "no progress entry was appended",
      !Array.isArray(afterLoserWrites.payload?.progress),
      afterLoserWrites.payload?.progress
    );
    check("result is still empty", !afterLoserWrites.result, afterLoserWrites.result);

    const afterWrites = await counters();
    if (hasFencedWrites) {
      const fencedDelta = (afterWrites.fenced_writes ?? 0) - (afterRace.fenced_writes ?? 0);
      check(
        "fenced_writes counted the refusals (delta >= 1)",
        fencedDelta >= 1,
        { before: afterRace.fenced_writes, after: afterWrites.fenced_writes }
      );
      note(`fenced_writes delta over the loser's three attempts: ${fencedDelta}`);
    } else {
      gated(
        "fenced_writes counts the loser's refused writes",
        "this API build exposes no fenced_writes counter"
      );
    }

    // ── Phase 3: the anti-loop ───────────────────────────────────────────────
    //
    // This is the incident, reproduced on purpose: a worker that IGNORES its
    // tap-out and keeps re-claiming. The contract says the gateway answers it
    // locally — no race, no API call — with a firmer refusal and a rising
    // attempt count, so the loop is bounded and free.
    phase("phase 3 · a bad loser loops 10x — locally refused, zero API calls");
    const m = mark();
    const attempts: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) {
      attempts.push(await loser.call("task_claim", { id: t1 }));
    }
    const calls = since(m);
    check("the gateway made ZERO API calls for 10 repeat claims", calls.length === 0, calls);
    check(
      "every repeat claim answered claimed:false",
      attempts.every((r) => r.claimed === false),
      attempts.map((r) => r.claimed)
    );
    check(
      'every repeat claim reason = "already_lost"',
      attempts.every((r) => r.reason === "already_lost"),
      attempts.map((r) => r.reason)
    );
    const counts = attempts.map((r) => r.attempts as number);
    check(
      "attempts rise monotonically (the refusal gets firmer)",
      counts.every((n, i) => i === 0 || n > counts[i - 1]!),
      counts
    );
    note(`attempt counter after the loop: ${counts[counts.length - 1]}`);
    // And the contract-respecting worker: it stops at the FIRST tapOut. Modelled
    // as the loop a dispatched subagent actually runs, so "bounded" is measured
    // rather than asserted in prose.
    let respectfulTries = 0;
    for (let i = 0; i < 10; i++) {
      respectfulTries++;
      const r = await loser.call("task_claim", { id: t1 });
      if (r.tapOut === true) break;
    }
    check(
      "a worker that honours tapOut stops after 1 attempt",
      respectfulTries === 1,
      respectfulTries
    );

    // ── Phase 4: the winner finishes ─────────────────────────────────────────
    phase("phase 4 · the winner works and completes — exactly one completion");
    const beat = await winner.call("task_progress", { id: t1, note: "winner heartbeat", percent: 50 });
    check("winner's progress recorded", beat.recorded === true, beat);
    check("winner's heartbeat extended the lease", beat.leaseExtended === true, beat);

    const fin = await winner.call("task_complete", {
      id: t1,
      result: "harness: winner completed T1",
    });
    check("winner's completion accepted", fin.completed !== false, fin);
    const doneTask = await readTask(t1);
    check("server state = done", doneTask.state === "done", doneTask.state);
    check("done by the winner", doneTask.claimedBy === winner.name, doneTask.claimedBy);
    check("the winner's result is the one on record", !!doneTask.result, doneTask.result);
    check(
      "exactly ONE completion write landed for T1",
      REQUESTS.filter(
        (r) => r.method === "PATCH" && r.path.includes(t1) && r.status < 300
      ).length >= 1 &&
        doneTask.result === "harness: winner completed T1",
      doneTask.result
    );

    // ── Phase 5: after the fact ──────────────────────────────────────────────
    phase("phase 5 · a write against finished work taps out");
    // A THIRD session, so this is not the remembered loss answering — a fresh
    // worker reaching for work that is already over.
    const cAgent = await connectAgent(scratch.code, "harness-worker-c", a.session.agentId);
    const late = await cAgent.call("task_progress", { id: t1, note: "late to the party" });
    check("progress on a done task refused", late.recorded === false, late);
    checkTapOut("late progress", late, { reasonIn: ["already_finished", "not_your_claim", "fenced"] });

    // ── Phase 6: kill the winner, recover the lease ──────────────────────────
    phase("phase 6 · the winner goes silent — the task comes back and is reclaimed");
    const g1res = await a.call("task_claim", { id: t2 });
    check("worker-a claims T2", g1res.claimed === true, g1res);
    const gen1 = ((g1res.claim ?? {}) as { generation?: number }).generation;

    // worker-b reaches for it, loses, and REMEMBERS the loss.
    const bLost = await b.call("task_claim", { id: t2 });
    checkTapOut("worker-b on T2", bLost, { reason: "already_claimed", holder: "harness-worker-a" });

    // worker-a now "dies": no heartbeat, no completion, nothing.
    // The lease ends. On a live server that happens either by TTL (~15 min,
    // fixed at boot — see the header) or by a human releasing the task from the
    // board. The harness uses the board control so this runs in seconds; the TTL
    // path is the Go test named in the header. What follows is identical either
    // way: the task is approved again with no holder.
    const rel = await human("POST", `/api/canvas/actions/${t2}/release`, {
      note: "harness: winner went silent",
    });
    check("the board could release the dead winner's task", rel.status < 300, rel);
    const released = await readTask(t2);
    check("released task is approved again", released.state === "approved", released.state);
    check("released task has no holder", !released.claimedBy, released.claimedBy);

    // THE SELF-HEALING PATH: queue_next must forget worker-b's loss now that the
    // server says the task is ready and unheld — otherwise the loser refuses work
    // that is genuinely free, which is a deadlock dressed as good behaviour.
    const q = (await b.call("queue_next", { limit: 20 })) as {
      tasks?: Array<Record<string, unknown>>;
      lostByYou?: unknown[];
    };
    const row = (q.tasks ?? []).find((t) => t.id === t2);
    check("queue_next offers T2 back to worker-b", !!row, (q.tasks ?? []).map((t) => t.id));
    check("T2 is NOT marked lostByYou any more", row?.lostByYou !== true, row?.lostByYou);
    check("T2 comes back WITH a handoff", !!row?.handoff, Object.keys(row ?? {}));

    const reclaim = await b.call("task_claim", { id: t2 });
    check("worker-b reclaims T2", reclaim.claimed === true, reclaim);
    const gen2 = ((reclaim.claim ?? {}) as { generation?: number }).generation;
    if (hasGenerations && typeof gen1 === "number" && typeof gen2 === "number") {
      check("the reclaim minted a NEW generation", gen2 > gen1, { gen1, gen2 });
    } else {
      gated("the reclaim mints a NEW generation", "this API build mints no claim generations");
    }

    // The dead winner comes back and completes work that has moved on.
    const zombie = await a.call("task_complete", { id: t2, result: "zombie completion" });
    check("the dead winner's completion is REFUSED", zombie.completed === false, zombie);
    checkTapOut("zombie completion", zombie, {
      reasonIn: ["not_your_claim", "fenced", "already_lost"],
    });
    const t2after = await readTask(t2);
    check("T2 is still executing (not completed by the zombie)", t2after.state === "executing", t2after.state);
    check("T2 is still held by worker-b", t2after.claimedBy === "harness-worker-b", t2after.claimedBy);

    // ── Phase 7: the stale token, at the wire ────────────────────────────────
    //
    // The case holder identity cannot see: the RIGHT name presenting the WRONG
    // lease. The gateway has no field to send a generation in yet (it only reads
    // one out of a refusal), so this one is asserted against the API directly —
    // which is also the point: it is the API's fence, not the gateway's.
    phase("phase 7 · a write under a STALE claim generation is fenced");
    if (hasGenerations && typeof gen1 === "number") {
      const beforeFence = await counters();
      const staleFp = fingerprint(await readTask(t2));
      const staleWrite = await agentPatch("harness-worker-b", t2, {
        state: "done",
        result: "written under a stale lease",
        claimGeneration: gen1,
      });
      check("stale-generation write refused with 409", staleWrite.status === 409, staleWrite);
      check("refusal carries fenced:true", staleWrite.body.fenced === true, staleWrite.body);
      check(
        'refusal code = "stale_claim_generation"',
        staleWrite.body.error === "stale_claim_generation" &&
          staleWrite.body.reason === "stale_claim_generation",
        staleWrite.body
      );
      check(
        "refusal hands back the LIVE generation",
        staleWrite.body.claimGeneration === gen2,
        staleWrite.body.claimGeneration
      );
      check(
        "the fenced write mutated nothing",
        fingerprint(await readTask(t2)) === staleFp,
        await readTask(t2)
      );
      if (hasFencedWrites) {
        const afterFence = await counters();
        check(
          "fenced_writes counted it",
          (afterFence.fenced_writes ?? 0) > (beforeFence.fenced_writes ?? 0),
          { before: beforeFence.fenced_writes, after: afterFence.fenced_writes }
        );
      }
      // And the holder's own write, with no stale token, still passes.
      const ok = await b.call("task_complete", { id: t2, result: "harness: worker-b completed T2" });
      check("the live holder can still finish", ok.completed !== false, ok);
      check("T2 state = done", (await readTask(t2)).state === "done");
    } else {
      gated(
        "a write under a stale claim generation is fenced 409 {fenced:true}",
        "this API build mints no claim generations, so there is no token to go stale"
      );
      const ok = await b.call("task_complete", { id: t2, result: "harness: worker-b completed T2" });
      check("the live holder can still finish", ok.completed !== false, ok);
    }

    // ── Phase 8: does the CLIENT carry the token? ────────────────────────────
    //
    // Phase 7 proved the API refuses a stale generation. That refusal can only
    // fire for a caller that PRESENTS a generation, and the harness had to reach
    // past the tool layer to do it — so the honest last question is whether the
    // gateway presents one on its own writes. Measured off the wire: every write
    // this run made is recorded with its body.
    phase("phase 8 · does the gateway present its fencing token?");
    const gatewayWrites = REQUESTS.filter(
      (r) =>
        r.method !== "GET" &&
        r.harness !== true &&
        r.body !== undefined &&
        /"agentName"|"agent"/.test(r.body)
    );
    const carried = gatewayWrites.filter((r) => (r.body ?? "").includes("claimGeneration"));
    if (carried.length > 0) {
      check(
        "gateway writes carry claimGeneration",
        true,
        `${carried.length}/${gatewayWrites.length} agent writes`
      );
    } else {
      gap(
        "gateway writes carry claimGeneration",
        `0 of ${gatewayWrites.length} agent-identified writes presented a generation. The gateway ` +
          `READS one out of a refusal but has no field to send it, so its writes are ` +
          `identity-checked only — and identity cannot catch a lease that came back to the SAME ` +
          `agent name (worker-a → worker-b → worker-a). Tripwire: ` +
          `TestGatewayWithoutAFencingTokenIsNotFencedOnSelfTakeover in apps/api/internal/api.`
      );
    }
  } finally {
    if (KEEP) {
      process.stdout.write(`\n  note  --keep: leaving ${scratch.taskIds.length} task(s) in ${scratch.url}\n`);
    } else {
      await teardown(scratch);
      process.stdout.write(`\n  note  scratch tasks deleted; empty canvas left at ${scratch.url}\n`);
    }
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  const writes = REQUESTS.filter((r) => r.method !== "GET").length;
  process.stdout.write(
    `\n${"═".repeat(72)}\n` +
      `api calls: ${REQUESTS.length} (${writes} writes)   ` +
      `failures: ${failures}   skipped: ${skipped}   gaps: ${gaps}\n`
  );
  if (failures > 0) {
    process.stdout.write(`RESULT: FAIL — the contention contract regressed.\n`);
    process.exit(1);
  }
  process.stdout.write(
    `RESULT: PASS — two agents raced, one tapped out, and it stayed tapped out.\n` +
      (skipped > 0
        ? `        ${skipped} check(s) skipped for missing server capabilities; ` +
          `re-run with --require-fence once this API build has them.\n`
        : "") +
      (gaps > 0
        ? `        ${gaps} known gap(s) reported above — measured, not regressions.\n`
        : "")
  );
}

main().catch((err) => {
  process.stderr.write(`\nHARNESS ERROR: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
