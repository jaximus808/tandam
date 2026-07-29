/**
 * TDM-43 / E5.2 — MCP_TRACE per-tool-call timing + session summary.
 *
 * The pure seams (mode parsing, line formatting, aggregation) are tested
 * directly; the timing path is smoke-tested with a fake clock and a captured
 * sink, so no wall time and no I/O is involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Tracer,
  TraceStats,
  formatCallLine,
  formatSummary,
  isOffValue,
  parseTraceMode,
  type CallRecord,
} from "../src/trace.js";

// ---------------------------------------------------------------- mode parsing

test("parseTraceMode: off unless asked for", () => {
  assert.equal(parseTraceMode({}), "off");
  assert.equal(parseTraceMode({ MCP_TRACE: "0" }), "off");
  assert.equal(parseTraceMode({ MCP_TRACE: "off" }), "off");
  assert.equal(parseTraceMode({ MCP_TRACE: "FALSE" }), "off");
  assert.equal(parseTraceMode({ MCP_TRACE: "" }), "off");
});

test("parseTraceMode: 1 is human, json is json", () => {
  assert.equal(parseTraceMode({ MCP_TRACE: "1" }), "human");
  assert.equal(parseTraceMode({ MCP_TRACE: "on" }), "human");
  assert.equal(parseTraceMode({ MCP_TRACE: "json" }), "json");
  assert.equal(parseTraceMode({ MCP_TRACE: " JSON " }), "json");
});

test("parseTraceMode: TANDEM_MCP_TIMING stays an alias, MCP_TRACE=0 overrides it", () => {
  assert.equal(parseTraceMode({ TANDEM_MCP_TIMING: "1" }), "human");
  assert.equal(parseTraceMode({ MCP_TRACE: "0", TANDEM_MCP_TIMING: "1" }), "off");
  assert.equal(parseTraceMode({ MCP_TRACE: "json", TANDEM_MCP_TIMING: "1" }), "json");
});

test("isOffValue covers the shared disable vocabulary", () => {
  for (const v of ["0", "off", "false", "no", "", undefined]) {
    assert.equal(isOffValue(v), true, `${v} should be off`);
  }
  for (const v of ["1", "on", "json", "yes"]) {
    assert.equal(isOffValue(v), false, `${v} should be on`);
  }
});

// ------------------------------------------------------------- line formatting

const rec: CallRecord = { tool: "task_claim", ms: 132.44, apiMs: 118.72, apiCalls: 2, ok: true };

test("human call line is one greppable key=value row", () => {
  assert.equal(
    formatCallLine(rec, "human"),
    "[tandem-mcp] call tool=task_claim ms=132.4 api=118.7 api_calls=2 ok\n"
  );
});

test("human call line marks failures", () => {
  assert.match(formatCallLine({ ...rec, ok: false }, "human"), / error\n$/);
});

test("json call line is one parseable object with the same fields", () => {
  const line = formatCallLine({ ...rec, ts: "2026-07-29T00:00:00.000Z" }, "json");
  assert.equal(line.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(line), {
    t: "call",
    ts: "2026-07-29T00:00:00.000Z",
    tool: "task_claim",
    ms: 132.4,
    apiMs: 118.7,
    apiCalls: 2,
    overheadMs: 13.7,
    ok: true,
  });
});

// ----------------------------------------------------------------- aggregation

function statsWith(records: Array<Partial<CallRecord> & { tool: string; ms: number }>): TraceStats {
  const stats = new TraceStats();
  for (const r of records) {
    stats.record({ apiMs: 0, apiCalls: 0, ok: true, ...r });
  }
  return stats;
}

test("TraceStats rolls up per tool: calls, total, max, api, errors", () => {
  const stats = statsWith([
    { tool: "task_get", ms: 100, apiMs: 90, apiCalls: 1 },
    { tool: "task_get", ms: 300, apiMs: 250, apiCalls: 2 },
    { tool: "queue_next", ms: 50, apiMs: 40, apiCalls: 1, ok: false },
  ]);
  const s = stats.summarize(10_000);

  assert.equal(s.calls, 3);
  assert.equal(s.errors, 1);
  assert.equal(s.handlerMs, 450);
  assert.equal(s.apiMs, 380);
  assert.equal(s.overheadMs, 70);
  assert.equal(s.apiCalls, 4);
  assert.equal(s.sessionMs, 10_000);

  // Sorted by total time, descending.
  assert.deepEqual(
    s.tools.map((t) => t.tool),
    ["task_get", "queue_next"]
  );
  assert.deepEqual(s.tools[0], {
    tool: "task_get",
    calls: 2,
    errors: 0,
    totalMs: 400,
    maxMs: 300,
    apiMs: 340,
    apiCalls: 3,
  });
  assert.equal(s.tools[1].errors, 1);
});

test("TraceStats keeps the top N and reports what it hid", () => {
  const stats = statsWith([
    { tool: "a", ms: 500 },
    { tool: "b", ms: 400 },
    { tool: "c", ms: 30 },
    { tool: "d", ms: 20 },
  ]);
  const s = stats.summarize(1000, 2);
  assert.deepEqual(
    s.tools.map((t) => t.tool),
    ["a", "b"]
  );
  assert.equal(s.hiddenTools, 2);
  assert.equal(s.hiddenMs, 50);
});

// -------------------------------------------------------------- summary output

test("human summary is a greppable block prefixed [tandem-mcp] summary", () => {
  const stats = statsWith([
    { tool: "task_get", ms: 100, apiMs: 90, apiCalls: 1 },
    { tool: "task_get", ms: 300, apiMs: 250, apiCalls: 2 },
    { tool: "queue_next", ms: 50, apiMs: 40, apiCalls: 1, ok: false },
  ]);
  const block = formatSummary(stats.summarize(94_200), "human");
  const lines = block.trimEnd().split("\n");

  assert.equal(lines.length, 3);
  for (const line of lines) assert.equal(line.startsWith("[tandem-mcp] summary"), true);
  assert.equal(
    lines[0],
    "[tandem-mcp] summary session=94.2s calls=3 errors=1 handler=450.0ms " +
      "api=380.0ms(84%) overhead=70.0ms http=4"
  );
  assert.equal(
    lines[1],
    "[tandem-mcp] summary tool=task_get calls=2 total=400.0ms avg=200.0ms " +
      "max=300.0ms api=340.0ms errors=0"
  );
});

test("json summary is a single scrapeable object", () => {
  const stats = statsWith([{ tool: "task_get", ms: 100, apiMs: 90, apiCalls: 1 }]);
  const block = formatSummary(stats.summarize(5000), "json");
  assert.equal(block.trimEnd().includes("\n"), false);
  const parsed = JSON.parse(block);
  assert.equal(parsed.t, "summary");
  assert.equal(parsed.calls, 1);
  assert.equal(parsed.apiPct, 90);
  assert.deepEqual(parsed.tools, [
    {
      tool: "task_get",
      calls: 1,
      errors: 0,
      totalMs: 100,
      avgMs: 100,
      maxMs: 100,
      apiMs: 90,
      apiCalls: 1,
    },
  ]);
});

// -------------------------------------------------------- tracer wiring (clock)

/** A tracer over a fake clock that captures its output instead of writing. */
function fakeTracer(mode: "human" | "json" = "human") {
  const lines: string[] = [];
  let clock = 0;
  const tracer = new Tracer({
    mode,
    now: () => clock,
    sink: (line) => lines.push(line),
  });
  return { tracer, lines, advance: (ms: number) => (clock += ms) };
}

test("tracer attributes API time to the enclosing call and nothing else", async () => {
  const { tracer, lines, advance } = fakeTracer();

  await tracer.call("task_get", async () => {
    advance(5); // handler work
    tracer.recordApi(60); // one round-trip
    tracer.recordApi(30); // another
    advance(95);
    return { ok: true };
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0], "[tandem-mcp] call tool=task_get ms=100.0 api=90.0 api_calls=2 ok\n");
});

test("API calls made outside any tool call are ignored", async () => {
  const { tracer, lines, advance } = fakeTracer();
  tracer.recordApi(999); // e.g. the `init` CLI path
  await tracer.call("queue_next", async () => {
    advance(10);
    return {};
  });
  assert.equal(lines[0], "[tandem-mcp] call tool=queue_next ms=10.0 api=0.0 api_calls=0 ok\n");
});

test("concurrent calls do not pool each other's API time", async () => {
  const { tracer, lines } = fakeTracer();

  const slow = tracer.call("slow_tool", async () => {
    tracer.recordApi(10);
    await new Promise((r) => setTimeout(r, 5));
    tracer.recordApi(10); // after an await — must still land on THIS call
    return {};
  });
  const fast = tracer.call("fast_tool", async () => {
    tracer.recordApi(1);
    return {};
  });
  await Promise.all([slow, fast]);

  const byTool = Object.fromEntries(
    lines.map((l) => [l.match(/tool=(\w+)/)![1], l.match(/api=([\d.]+)/)![1]])
  );
  assert.equal(byTool.slow_tool, "20.0");
  assert.equal(byTool.fast_tool, "1.0");
});

test("isError results are traced as errors; throws propagate and are traced", async () => {
  const { tracer, lines } = fakeTracer();

  await tracer.call(
    "task_claim",
    async () => ({ isError: true }),
    (r) => !(r as { isError?: boolean }).isError
  );
  await assert.rejects(
    tracer.call("boom", async () => {
      throw new Error("kaboom");
    }),
    /kaboom/
  );

  assert.match(lines[0], /tool=task_claim .* error\n/);
  assert.match(lines[1], /tool=boom .* error\n/);
});

test("summary reflects the calls made and is emitted at most once", async () => {
  const { tracer, lines, advance } = fakeTracer();
  await tracer.call("task_get", async () => {
    tracer.recordApi(40);
    advance(50);
    return {};
  });
  advance(1000);

  tracer.flushSummary();
  tracer.flushSummary(); // idempotent

  const summary = lines.filter((l) => l.includes("summary"));
  assert.equal(summary.length, 1);
  assert.match(summary[0], /session=1\.1s calls=1 errors=0 handler=50\.0ms api=40\.0ms\(80%\)/);
  assert.match(summary[0], /tool=task_get calls=1 total=50\.0ms/);
});

test("no summary when the session made no tool calls", () => {
  const { tracer, lines } = fakeTracer();
  assert.equal(tracer.summary(), null);
  tracer.flushSummary();
  assert.equal(lines.length, 0);
});

test("an empty flush does not disarm a later real summary", async () => {
  const { tracer, lines, advance } = fakeTracer();
  tracer.flushSummary(); // e.g. the sidecar's stdin ending at startup
  await tracer.call("task_get", async () => {
    advance(10);
    return {};
  });
  tracer.flushSummary(); // the real shutdown
  assert.equal(lines.filter((l) => l.includes("summary")).length > 0, true);
});

test("tracing off is a pass-through: no lines, no summary, result untouched", async () => {
  const lines: string[] = [];
  const tracer = new Tracer({ mode: "off", now: () => 0, sink: (l) => lines.push(l) });

  assert.equal(tracer.enabled, false);
  const result = await tracer.call("task_get", async () => ({ value: 42 }));
  tracer.recordApi(100);
  tracer.flushSummary();

  assert.deepEqual(result, { value: 42 });
  assert.equal(lines.length, 0);
  assert.equal(tracer.summary(), null);
});

test("json mode emits one object per call, with a timestamp", async () => {
  const { tracer, lines, advance } = fakeTracer("json");
  await tracer.call("doc_write", async () => {
    tracer.recordApi(20);
    advance(25);
    return {};
  });
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.tool, "doc_write");
  assert.equal(parsed.ms, 25);
  assert.equal(parsed.apiMs, 20);
  assert.equal(parsed.overheadMs, 5);
  assert.equal(typeof parsed.ts, "string");
});
