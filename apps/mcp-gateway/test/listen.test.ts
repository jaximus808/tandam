/**
 * TDM-56 — `tandem-mcp listen`. What's pinned here is the contract that makes
 * an approval-triggered orchestrator safe to leave running: a forged or stale
 * delivery never execs, a retried delivery never execs twice, an epic's fan-out
 * execs ONCE, and two approvals never produce two concurrent children.
 *
 * The signature vectors are computed with the same construction as
 * apps/api/internal/webhooks/sign.go — `hex(hmac_sha256(secret, "<ts>.<body>"))`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_EVENTS,
  DEFAULT_PORT,
  DeliveryDedupe,
  ListenUsageError,
  SECRET_ENV,
  TriggerCoordinator,
  canvasCodeOf,
  createListenServer,
  eventTypeOf,
  execEnv,
  parseListenArgs,
  parseWebhookBody,
  sign,
  ticketOf,
  verifySignature,
  type Timers,
  type TriggerBatch,
} from "../src/listen/index.js";

// Deliberately non-hex so secret scanners don't flag it as a real Stripe-style
// key — the secret is only ever an HMAC key, so its shape doesn't matter.
const SECRET = "whsec_test-fixture-not-a-real-secret";
const NOW_MS = 1_800_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** A realistic task.approved body (apps/api/internal/api/task_events.go). */
function eventBody(ticket = "TDM-56", type = "task.approved"): string {
  return JSON.stringify({
    event_id: "8f0a2c3e-0000-4000-8000-000000000001",
    type,
    timestamp: "2026-07-29T09:41:02.114Z",
    canvas_id: "3c11a2b4-0000-4000-8000-000000000002",
    task: { id: "aaaa", ticketId: ticket, title: "Add a listen subcommand", state: "approved" },
  });
}

// ── Signature verification (mirrors sign.go) ─────────────────────────────────

test("verifySignature: accepts a correctly signed delivery", () => {
  const body = eventBody();
  const res = verifySignature({
    secret: SECRET,
    signature: sign(SECRET, NOW_SEC, body),
    timestamp: String(NOW_SEC),
    body,
    nowMs: NOW_MS,
  });
  assert.deepEqual(res, { ok: true });
});

test("verifySignature: matches sign.go's construction byte for byte", () => {
  const body = eventBody();
  // Independently computed here rather than via sign() so a change to the
  // signing string fails this test instead of being self-consistent.
  const expected = createHmac("sha256", SECRET).update(`${NOW_SEC}.${body}`).digest("hex");
  assert.equal(sign(SECRET, NOW_SEC, body), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
});

test("verifySignature: rejects a tampered body", () => {
  const signed = eventBody("TDM-56");
  const tampered = eventBody("TDM-99");
  const res = verifySignature({
    secret: SECRET,
    signature: sign(SECRET, NOW_SEC, signed),
    timestamp: String(NOW_SEC),
    body: tampered,
    nowMs: NOW_MS,
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.status, 401);
});

test("verifySignature: rejects a wrong secret, a flipped hex digit, and a missing header", () => {
  const body = eventBody();
  const good = sign(SECRET, NOW_SEC, body);

  const wrongSecret = verifySignature({
    secret: "whsec_deadbeef",
    signature: good,
    timestamp: String(NOW_SEC),
    body,
    nowMs: NOW_MS,
  });
  assert.equal(wrongSecret.ok, false);

  const flipped = `${good[0] === "a" ? "b" : "a"}${good.slice(1)}`;
  const tamperedSig = verifySignature({
    secret: SECRET,
    signature: flipped,
    timestamp: String(NOW_SEC),
    body,
    nowMs: NOW_MS,
  });
  assert.equal(tamperedSig.ok, false);
  assert.equal(tamperedSig.ok === false && tamperedSig.status, 401);

  const missing = verifySignature({
    secret: SECRET,
    signature: undefined,
    timestamp: String(NOW_SEC),
    body,
    nowMs: NOW_MS,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.status, 401);

  // A truncated signature must not match on a prefix.
  const short = verifySignature({
    secret: SECRET,
    signature: good.slice(0, 32),
    timestamp: String(NOW_SEC),
    body,
    nowMs: NOW_MS,
  });
  assert.equal(short.ok, false);
});

test("verifySignature: enforces the 60s replay window in both directions", () => {
  const body = eventBody();
  const at = (tsOffsetSec: number) => {
    const ts = NOW_SEC + tsOffsetSec;
    return verifySignature({
      secret: SECRET,
      signature: sign(SECRET, ts, body),
      timestamp: String(ts),
      body,
      nowMs: NOW_MS,
    });
  };
  assert.equal(at(0).ok, true);
  assert.equal(at(-60).ok, true, "exactly at the edge is still inside the window");
  assert.equal(at(60).ok, true);

  const stale = at(-61);
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.status, 400);
  assert.match(stale.ok === false ? stale.reason : "", /replay window/);

  const future = at(61);
  assert.equal(future.ok, false, "forward-dated attempts are stale too");
});

test("verifySignature: rejects a missing or malformed timestamp with 400", () => {
  const body = eventBody();
  for (const ts of [undefined, "", "not-a-number", "1.5"]) {
    const res = verifySignature({
      secret: SECRET,
      signature: sign(SECRET, NOW_SEC, body),
      timestamp: ts,
      body,
      nowMs: NOW_MS,
    });
    assert.equal(res.ok, false, `ts=${String(ts)}`);
    assert.equal(res.ok === false && res.status, 400, `ts=${String(ts)}`);
  }
});

// ── Delivery-id dedupe ───────────────────────────────────────────────────────

test("DeliveryDedupe: a retried delivery id is seen once", () => {
  const d = new DeliveryDedupe();
  assert.equal(d.seen("delivery-1"), false, "first sighting is new");
  assert.equal(d.seen("delivery-1"), true, "the retry is a duplicate");
  assert.equal(d.seen("delivery-2"), false);
  assert.equal(d.seen("delivery-1"), true);
});

test("DeliveryDedupe: an absent delivery id is never a duplicate", () => {
  const d = new DeliveryDedupe();
  assert.equal(d.seen(undefined), false);
  assert.equal(d.seen(undefined), false);
  assert.equal(d.seen(""), false);
});

test("DeliveryDedupe: bounded — evicts oldest first, keeps recent ids", () => {
  const d = new DeliveryDedupe(3);
  d.seen("a");
  d.seen("b");
  d.seen("c");
  assert.equal(d.size, 3);
  d.seen("dee"); // evicts "a"
  assert.equal(d.size, 3);
  assert.equal(d.seen("a"), false, "oldest was evicted");
  assert.equal(d.seen("dee"), true, "newest is still remembered");
});

// ── Fake clock for the coordinator ───────────────────────────────────────────

class FakeTimers implements Timers {
  private seq = 0;
  private jobs = new Map<number, { at: number; fn: () => void }>();
  now = 0;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.jobs.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.jobs.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, job] of [...this.jobs]) {
      if (job.at <= this.now) {
        this.jobs.delete(id);
        job.fn();
      }
    }
  }

  get scheduled(): number {
    return this.jobs.size;
  }
}

/** Let queued microtasks (a resolved exec promise) run. */
const tick = () => new Promise<void>((r) => setImmediate(r));

function approved(ticket: string) {
  return { event: "task.approved", canvasCode: "TEGLQFXR", canvasId: "canvas-uuid", ticket };
}

// ── Debounce: an epic's fan-out is ONE run ───────────────────────────────────

test("TriggerCoordinator: coalesces a burst into one trigger with merged tickets", () => {
  const timers = new FakeTimers();
  const runs: TriggerBatch[] = [];
  const c = new TriggerCoordinator({
    debounceMs: 5000,
    timers,
    run: async (b) => {
      runs.push(b);
    },
  });

  // Five tasks under one epic, arriving over 800ms.
  for (const t of ["TDM-56", "TDM-57", "TDM-58", "TDM-59", "TDM-60"]) {
    c.push(approved(t));
    timers.advance(200);
  }
  assert.equal(runs.length, 0, "still inside the window");

  timers.advance(5000);
  assert.equal(runs.length, 1, "one trigger for the whole fan-out");
  assert.deepEqual(runs[0].tickets, ["TDM-56", "TDM-57", "TDM-58", "TDM-59", "TDM-60"]);
  assert.deepEqual(runs[0].events, ["task.approved"]);
  assert.equal(runs[0].canvasCode, "TEGLQFXR");
  assert.equal(runs[0].count, 5);
});

test("TriggerCoordinator: the window is trailing-edge — each event pushes it out", () => {
  const timers = new FakeTimers();
  const runs: TriggerBatch[] = [];
  const c = new TriggerCoordinator({
    debounceMs: 5000,
    timers,
    run: async (b) => {
      runs.push(b);
    },
  });

  c.push(approved("TDM-1"));
  timers.advance(4000);
  c.push(approved("TDM-2"));
  timers.advance(4000); // 8s after the first event, but only 4s of quiet
  assert.equal(runs.length, 0);
  timers.advance(1000);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].tickets, ["TDM-1", "TDM-2"]);
});

test("TriggerCoordinator: dedupes tickets and event types inside a batch", () => {
  const timers = new FakeTimers();
  const runs: TriggerBatch[] = [];
  const c = new TriggerCoordinator({
    debounceMs: 1000,
    timers,
    run: async (b) => {
      runs.push(b);
    },
  });

  c.push(approved("TDM-1"));
  c.push(approved("TDM-1"));
  c.push({ event: "task.completed", canvasCode: "", ticket: "TDM-2" });
  c.push({ event: "task.approved", canvasCode: "" }); // no ticket
  timers.advance(1000);

  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].tickets, ["TDM-1", "TDM-2"]);
  assert.deepEqual(runs[0].events, ["task.approved", "task.completed"]);
  assert.equal(runs[0].count, 4);
  assert.equal(runs[0].canvasCode, "TEGLQFXR", "first non-empty code wins");
});

test("TriggerCoordinator: a later burst starts a fresh trigger", async () => {
  const timers = new FakeTimers();
  const runs: TriggerBatch[] = [];
  const c = new TriggerCoordinator({
    debounceMs: 1000,
    timers,
    run: async (b) => {
      runs.push(b);
    },
  });

  c.push(approved("TDM-1"));
  timers.advance(1000);
  await tick();
  c.push(approved("TDM-2"));
  timers.advance(1000);

  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].tickets, ["TDM-2"]);
});

// ── Single-flight: never two orchestrators at once ───────────────────────────

test("TriggerCoordinator: events during an exec become exactly ONE follow-up run", async () => {
  const timers = new FakeTimers();
  const runs: TriggerBatch[] = [];
  let release: (() => void) | undefined;
  const c = new TriggerCoordinator({
    debounceMs: 5000,
    timers,
    run: (b) => {
      runs.push(b);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });

  c.push(approved("TDM-1"));
  timers.advance(5000);
  assert.equal(runs.length, 1);
  assert.equal(c.isRunning, true);

  // Three more approvals land across two separate debounce windows while the
  // child is still running.
  c.push(approved("TDM-2"));
  c.push(approved("TDM-3"));
  timers.advance(5000);
  assert.equal(runs.length, 1, "no second child while the first is alive");
  c.push(approved("TDM-4"));
  timers.advance(5000);
  assert.equal(runs.length, 1);
  assert.equal(c.hasPending, true);

  const first = release!;
  first();
  await tick();

  assert.equal(runs.length, 2, "exactly one follow-up run, not three");
  assert.deepEqual(runs[1].tickets, ["TDM-2", "TDM-3", "TDM-4"], "nothing dropped");
  assert.equal(runs[1].count, 3);
  assert.equal(c.isRunning, true);

  release!();
  await tick();
  assert.equal(runs.length, 2, "nothing queued behind the follow-up");
  assert.equal(c.isRunning, false);
  assert.equal(c.hasPending, false);
});

test("TriggerCoordinator: a failing exec does not wedge the queue", async () => {
  const timers = new FakeTimers();
  const runs: TriggerBatch[] = [];
  let fail = true;
  const c = new TriggerCoordinator({
    debounceMs: 100,
    timers,
    run: async (b) => {
      runs.push(b);
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
    },
  });

  c.push(approved("TDM-1"));
  timers.advance(100);
  await tick();
  assert.equal(c.isRunning, false);

  c.push(approved("TDM-2"));
  timers.advance(100);
  await tick();
  assert.equal(runs.length, 2);
});

test("TriggerCoordinator: stop() drops buffered work and cancels the timer", () => {
  const timers = new FakeTimers();
  const runs: TriggerBatch[] = [];
  const c = new TriggerCoordinator({
    debounceMs: 1000,
    timers,
    run: async (b) => {
      runs.push(b);
    },
  });

  c.push(approved("TDM-1"));
  c.stop();
  assert.equal(timers.scheduled, 0);
  timers.advance(10_000);
  assert.equal(runs.length, 0);

  c.push(approved("TDM-2"));
  timers.advance(10_000);
  assert.equal(runs.length, 0, "stopped for good");
});

// ── Payload projection + exec env ────────────────────────────────────────────

test("payload: reads the task_events.go shape", () => {
  const body = parseWebhookBody(eventBody("TDM-56"));
  assert.equal(eventTypeOf("task.approved", body), "task.approved");
  assert.equal(eventTypeOf(undefined, body), "task.approved", "header falls back to body.type");
  assert.equal(ticketOf(body), "TDM-56");
  assert.equal(canvasCodeOf(body, "TEGLQFXR"), "TEGLQFXR", "payload has canvas_id, not a code");
  assert.equal(canvasCodeOf(body, undefined), "");
  assert.equal(parseWebhookBody("not json"), null);
  assert.equal(ticketOf(parseWebhookBody("{}")), undefined);
});

test("execEnv: the documented four vars, empty string when unknown", () => {
  assert.deepEqual(
    execEnv({
      events: ["task.approved"],
      canvasCode: "TEGLQFXR",
      canvasId: "canvas-uuid",
      tickets: ["TDM-56", "TDM-57"],
      count: 2,
    }),
    {
      TANDEM_EVENT: "task.approved",
      TANDEM_CANVAS_CODE: "TEGLQFXR",
      TANDEM_CANVAS_ID: "canvas-uuid",
      TANDEM_TICKETS: "TDM-56,TDM-57",
    }
  );
  assert.deepEqual(
    execEnv({ events: [], canvasCode: "", canvasId: "", tickets: [], count: 0 }),
    { TANDEM_EVENT: "", TANDEM_CANVAS_CODE: "", TANDEM_CANVAS_ID: "", TANDEM_TICKETS: "" }
  );
});

// ── Flags ────────────────────────────────────────────────────────────────────

test("parseListenArgs: defaults", () => {
  const o = parseListenArgs(["--exec", "echo hi"], { [SECRET_ENV]: SECRET });
  assert.equal(o.exec, "echo hi");
  assert.equal(o.port, DEFAULT_PORT);
  assert.equal(o.secret, SECRET);
  assert.deepEqual(o.events, DEFAULT_EVENTS);
  assert.equal(o.debounceMs, DEFAULT_DEBOUNCE_MS);
});

test("parseListenArgs: --flag value and --flag=value both work", () => {
  const a = parseListenArgs(
    ["--exec", "run.sh", "--port", "9999", "--secret", SECRET, "--events", "task.approved,task.completed", "--debounce", "250"],
    {}
  );
  const b = parseListenArgs(
    [`--exec=run.sh`, `--port=9999`, `--secret=${SECRET}`, `--events=task.approved,task.completed`, `--debounce=250`],
    {}
  );
  assert.deepEqual(a, b);
  assert.equal(a.port, 9999);
  assert.deepEqual(a.events, ["task.approved", "task.completed"]);
  assert.equal(a.debounceMs, 250);
});

test("parseListenArgs: --secret beats the env var", () => {
  const o = parseListenArgs(["--exec", "x", "--secret", "whsec_flag"], { [SECRET_ENV]: "whsec_env" });
  assert.equal(o.secret, "whsec_flag");
});

test("parseListenArgs: usage errors", () => {
  assert.throws(() => parseListenArgs([], { [SECRET_ENV]: SECRET }), ListenUsageError, "--exec required");
  assert.throws(() => parseListenArgs(["--exec", "x"], {}), ListenUsageError, "no secret anywhere");
  assert.throws(() => parseListenArgs(["--exec", "x", "--port", "0"], { [SECRET_ENV]: SECRET }), ListenUsageError);
  assert.throws(() => parseListenArgs(["--exec", "x", "--port", "nope"], { [SECRET_ENV]: SECRET }), ListenUsageError);
  assert.throws(() => parseListenArgs(["--exec", "x", "--debounce", "-1"], { [SECRET_ENV]: SECRET }), ListenUsageError);
  assert.throws(() => parseListenArgs(["--exec", "x", "--events", " , "], { [SECRET_ENV]: SECRET }), ListenUsageError);
  assert.throws(() => parseListenArgs(["--exec", "x", "--wat"], { [SECRET_ENV]: SECRET }), ListenUsageError);
});

test("parseListenArgs: --help short-circuits the required flags", () => {
  const o = parseListenArgs(["--help"], {});
  assert.equal(o.help, true);
});

// ── HTTP shell (end to end over a real loopback socket) ──────────────────────

test("createListenServer: verify → dedupe → filter → ack", async () => {
  const triggers: string[] = [];
  const server = createListenServer({
    secret: SECRET,
    events: new Set(["task.approved"]),
    log: () => {},
    onTrigger: (ev) => triggers.push(`${ev.event}:${ev.ticket ?? ""}`),
    now: () => NOW_MS,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/webhook`;

  const post = (body: string, headers: Record<string, string>) =>
    fetch(url, { method: "POST", body, headers });

  const signed = (body: string, deliveryId: string, ts = NOW_SEC) => ({
    "content-type": "application/json",
    "tandem-timestamp": String(ts),
    "tandem-signature": sign(SECRET, ts, body),
    "tandem-delivery-id": deliveryId,
    "tandem-event": JSON.parse(body).type as string,
  });

  try {
    const body = eventBody("TDM-56");
    const ok = await post(body, signed(body, "d1"));
    assert.equal(ok.status, 200);
    assert.deepEqual(triggers, ["task.approved:TDM-56"]);

    // Retry of the same delivery: acked, not re-triggered.
    const retry = await post(body, signed(body, "d1", NOW_SEC + 5));
    assert.equal(retry.status, 200);
    assert.deepEqual(triggers, ["task.approved:TDM-56"]);

    // Forged signature.
    const forged = await post(body, { ...signed(body, "d2"), "tandem-signature": "00".repeat(32) });
    assert.equal(forged.status, 401);

    // Stale timestamp (correctly signed, but outside the window).
    const staleTs = NOW_SEC - 120;
    const stale = await post(body, signed(body, "d3", staleTs));
    assert.equal(stale.status, 400);

    // An event outside --events is acked and ignored.
    const other = eventBody("TDM-70", "task.completed");
    const ignored = await post(other, signed(other, "d4"));
    assert.equal(ignored.status, 200);
    assert.deepEqual(triggers, ["task.approved:TDM-56"]);

    // Wrong path / method.
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope`, { method: "POST" })).status, 404);
    assert.equal((await fetch(url)).status, 405);

    // A second, distinct approval does trigger.
    const b2 = eventBody("TDM-57");
    assert.equal((await post(b2, signed(b2, "d5"))).status, 200);
    assert.deepEqual(triggers, ["task.approved:TDM-56", "task.approved:TDM-57"]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
