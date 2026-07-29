/**
 * MCP_TRACE — per-tool-call observability for the gateway (TDM-43 / E5.2).
 *
 * Extends the existing MCP_TRACE facility (http.ts already used it for
 * per-HTTP-request routing traces) with what a fleet operator actually wants
 * when a session feels slow: how long each tool call took, how much of that was
 * the Tandem API, and a session summary on the way out.
 *
 * Everything here writes to **stderr**. stdout carries the stdio MCP protocol
 * frames — a stray byte there corrupts the wire.
 *
 * Modes (env `MCP_TRACE`):
 *   - unset / `0` / `off` / `false` → off. Nothing is allocated, no clock is
 *     read, no AsyncLocalStorage is created; the call path is `fn()`.
 *   - `json`                        → one JSON object per line (scrapeable).
 *   - anything else (`1`, `on`, …)  → human-readable key=value lines.
 * `TANDEM_MCP_TIMING` (the older, narrower switch) still works as an alias for
 * the human mode.
 *
 * API-time attribution: Gateway.safeFetch is the single choke point every
 * get/post/patch/del goes through, and it calls `recordApiCall` with the
 * measured round-trip. Attribution to the *enclosing tool call* uses an
 * AsyncLocalStorage accumulator rather than a parameter threaded through
 * gateway → tools → facade: the tool handlers are ~3k lines of call sites that
 * would all have to change, and ALS is correct even if two calls ever overlap
 * (stdio dispatch is sequential today; the HTTP sidecar's is not guaranteed to
 * be). The ALS instance is only created when tracing is on, so the disabled
 * path pays a single boolean check.
 *
 * What "api" measures: time inside safeFetch — request sent → response headers
 * received (and the full wait on a timeout/failure). Reading and JSON-parsing
 * the body happens in the callers, so it lands in the handler-overhead bucket.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";

export type TraceMode = "off" | "human" | "json";

/** One completed tool call. */
export interface CallRecord {
  tool: string;
  /** Total handler wall time, ms. */
  ms: number;
  /** Sum of HTTP round-trips made during the call, ms. */
  apiMs: number;
  /** How many HTTP requests the call made. */
  apiCalls: number;
  ok: boolean;
  /** ISO timestamp, only set (and only emitted) in json mode. */
  ts?: string;
}

/** Rolled-up totals for one tool over the session. */
export interface ToolStat {
  tool: string;
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  apiMs: number;
  apiCalls: number;
}

/** The session summary, before formatting. */
export interface SummaryData {
  sessionMs: number;
  calls: number;
  errors: number;
  /** Sum of every call's handler duration. */
  handlerMs: number;
  /** Sum of every call's API time. */
  apiMs: number;
  /** handlerMs - apiMs: everything that wasn't waiting on the API. */
  overheadMs: number;
  apiCalls: number;
  /** Top N tools by total time, descending. */
  tools: ToolStat[];
  /** Tools omitted from `tools` by the top-N cut. */
  hiddenTools: number;
  hiddenMs: number;
}

const OFF_VALUES = new Set(["", "0", "off", "false", "no"]);

/** Shared "is this env value a disable?" vocabulary (`0`, `off`, `false`, `no`). */
export function isOffValue(raw: string | undefined): boolean {
  return OFF_VALUES.has((raw ?? "").trim().toLowerCase());
}

/**
 * Resolve the trace mode from an env bag. Pure — the runtime tracer reads
 * process.env once at module load, tests pass their own object.
 */
export function parseTraceMode(env: Record<string, string | undefined>): TraceMode {
  const raw = (env.MCP_TRACE ?? "").trim().toLowerCase();
  if (raw === "json") return "json";
  if (!OFF_VALUES.has(raw)) return "human";
  // Explicitly disabled wins over the legacy alias.
  if (raw !== "") return "off";
  const legacy = (env.TANDEM_MCP_TIMING ?? "").trim().toLowerCase();
  return OFF_VALUES.has(legacy) ? "off" : "human";
}

/** Round to one decimal — enough precision for ms, stable in assertions. */
function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The per-call line. `mode` must not be "off". */
export function formatCallLine(rec: CallRecord, mode: TraceMode): string {
  if (mode === "json") {
    return (
      JSON.stringify({
        t: "call",
        ...(rec.ts ? { ts: rec.ts } : {}),
        tool: rec.tool,
        ms: r1(rec.ms),
        apiMs: r1(rec.apiMs),
        apiCalls: rec.apiCalls,
        overheadMs: r1(rec.ms - rec.apiMs),
        ok: rec.ok,
      }) + "\n"
    );
  }
  return (
    `[tandem-mcp] call tool=${rec.tool} ms=${r1(rec.ms).toFixed(1)} ` +
    `api=${r1(rec.apiMs).toFixed(1)} api_calls=${rec.apiCalls} ` +
    `${rec.ok ? "ok" : "error"}\n`
  );
}

/** Percent of `total` that `part` is, as an integer; 0 when total is 0. */
function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/**
 * The session summary block. Every line carries the `[tandem-mcp] summary`
 * prefix so it stays greppable out of an interleaved agent log; json mode
 * collapses the whole thing to one object so it stays one scrape.
 */
export function formatSummary(data: SummaryData, mode: TraceMode): string {
  if (mode === "json") {
    return (
      JSON.stringify({
        t: "summary",
        sessionMs: r1(data.sessionMs),
        calls: data.calls,
        errors: data.errors,
        handlerMs: r1(data.handlerMs),
        apiMs: r1(data.apiMs),
        overheadMs: r1(data.overheadMs),
        apiPct: pct(data.apiMs, data.handlerMs),
        apiCalls: data.apiCalls,
        tools: data.tools.map((t) => ({
          tool: t.tool,
          calls: t.calls,
          errors: t.errors,
          totalMs: r1(t.totalMs),
          avgMs: r1(t.totalMs / t.calls),
          maxMs: r1(t.maxMs),
          apiMs: r1(t.apiMs),
          apiCalls: t.apiCalls,
        })),
        hiddenTools: data.hiddenTools,
        hiddenMs: r1(data.hiddenMs),
      }) + "\n"
    );
  }

  const P = "[tandem-mcp] summary";
  const lines = [
    `${P} session=${(data.sessionMs / 1000).toFixed(1)}s calls=${data.calls} ` +
      `errors=${data.errors} handler=${r1(data.handlerMs).toFixed(1)}ms ` +
      `api=${r1(data.apiMs).toFixed(1)}ms(${pct(data.apiMs, data.handlerMs)}%) ` +
      `overhead=${r1(data.overheadMs).toFixed(1)}ms http=${data.apiCalls}`,
  ];
  for (const t of data.tools) {
    lines.push(
      `${P} tool=${t.tool} calls=${t.calls} total=${r1(t.totalMs).toFixed(1)}ms ` +
        `avg=${r1(t.totalMs / t.calls).toFixed(1)}ms max=${r1(t.maxMs).toFixed(1)}ms ` +
        `api=${r1(t.apiMs).toFixed(1)}ms errors=${t.errors}`
    );
  }
  if (data.hiddenTools > 0) {
    lines.push(`${P} +${data.hiddenTools} more tools (total=${r1(data.hiddenMs).toFixed(1)}ms)`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Session accumulator. Pure aside from holding state — no clock, no I/O: the
 * caller supplies elapsed session time, which is what makes it testable with a
 * fake clock.
 */
export class TraceStats {
  private byTool = new Map<string, ToolStat>();
  private calls = 0;
  private errors = 0;
  private handlerMs = 0;
  private apiMs = 0;
  private apiCalls = 0;

  record(rec: CallRecord): void {
    this.calls += 1;
    if (!rec.ok) this.errors += 1;
    this.handlerMs += rec.ms;
    this.apiMs += rec.apiMs;
    this.apiCalls += rec.apiCalls;

    let stat = this.byTool.get(rec.tool);
    if (!stat) {
      stat = { tool: rec.tool, calls: 0, errors: 0, totalMs: 0, maxMs: 0, apiMs: 0, apiCalls: 0 };
      this.byTool.set(rec.tool, stat);
    }
    stat.calls += 1;
    if (!rec.ok) stat.errors += 1;
    stat.totalMs += rec.ms;
    stat.apiMs += rec.apiMs;
    stat.apiCalls += rec.apiCalls;
    if (rec.ms > stat.maxMs) stat.maxMs = rec.ms;
  }

  get callCount(): number {
    return this.calls;
  }

  /** Roll up; `sessionMs` is the caller's measured session length. */
  summarize(sessionMs: number, topN = 5): SummaryData {
    const sorted = [...this.byTool.values()].sort((a, b) => b.totalMs - a.totalMs);
    const shown = sorted.slice(0, topN);
    const hidden = sorted.slice(topN);
    return {
      sessionMs,
      calls: this.calls,
      errors: this.errors,
      handlerMs: this.handlerMs,
      apiMs: this.apiMs,
      overheadMs: this.handlerMs - this.apiMs,
      apiCalls: this.apiCalls,
      tools: shown,
      hiddenTools: hidden.length,
      hiddenMs: hidden.reduce((sum, t) => sum + t.totalMs, 0),
    };
  }
}

/** The per-call accumulator carried in AsyncLocalStorage. */
interface ApiAccumulator {
  ms: number;
  calls: number;
}

export interface TracerOptions {
  mode?: TraceMode;
  /** Monotonic clock in ms. Injectable so tests can fake time. */
  now?: () => number;
  /** Line sink. Defaults to stderr. */
  sink?: (line: string) => void;
  topN?: number;
}

/** stderr, best-effort. Used for the hot path (a call line every few seconds). */
function stderrSink(line: string): void {
  process.stderr.write(line);
}

/**
 * stderr, synchronously. Used only for the summary: it is emitted from a
 * process `exit` handler, where an async write to a pipe would be dropped.
 */
function syncStderrSink(line: string): void {
  try {
    writeSync(2, line);
  } catch {
    process.stderr.write(line);
  }
}

export class Tracer {
  readonly mode: TraceMode;
  private readonly now: () => number;
  private readonly sink?: (line: string) => void;
  private readonly topN: number;
  private storage: AsyncLocalStorage<ApiAccumulator> | null = null;
  private stats: TraceStats | null = null;
  private startedAt = 0;
  private summaryEmitted = false;

  constructor(options: TracerOptions = {}) {
    this.mode = options.mode ?? parseTraceMode(process.env);
    this.now = options.now ?? (() => performance.now());
    this.sink = options.sink;
    this.topN = options.topN ?? 5;
    // Nothing is allocated on the disabled path — no ALS, no stats, no clock read.
    if (this.mode !== "off") {
      this.storage = new AsyncLocalStorage<ApiAccumulator>();
      this.stats = new TraceStats();
      this.startedAt = this.now();
    }
  }

  get enabled(): boolean {
    return this.mode !== "off";
  }

  /**
   * Run one tool call under a fresh API accumulator, emitting its trace line.
   * When tracing is off this is `fn()` with one boolean check in front.
   *
   * `isOk` reads success out of the handler's own return value — the dispatcher
   * turns thrown errors into `{ isError: true }` results, so a rejected promise
   * (a bug, not a tool error) is recorded as an error and re-thrown untouched.
   */
  async call<T>(tool: string, fn: () => Promise<T>, isOk?: (result: T) => boolean): Promise<T> {
    if (!this.storage || !this.stats) return fn();
    const acc: ApiAccumulator = { ms: 0, calls: 0 };
    const start = this.now();
    let ok = true;
    try {
      const result = await this.storage.run(acc, fn);
      ok = isOk ? isOk(result) : true;
      return result;
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      const rec: CallRecord = {
        tool,
        ms: this.now() - start,
        apiMs: acc.ms,
        apiCalls: acc.calls,
        ok,
        ...(this.mode === "json" ? { ts: new Date().toISOString() } : {}),
      };
      this.stats.record(rec);
      this.write(formatCallLine(rec, this.mode));
    }
  }

  /**
   * Attribute one HTTP round-trip to the enclosing tool call. Called from
   * Gateway.safeFetch (success, timeout and failure alike). A no-op when
   * tracing is off, and when there is no enclosing call (the `init` CLI, the
   * sidecar's pre-dispatch auth probe).
   */
  recordApi(ms: number): void {
    const acc = this.storage?.getStore();
    if (!acc) return;
    acc.ms += ms;
    acc.calls += 1;
  }

  /** The rendered summary block, or null when there is nothing to report. */
  summary(): string | null {
    if (!this.stats || this.stats.callCount === 0) return null;
    return formatSummary(this.stats.summarize(this.now() - this.startedAt, this.topN), this.mode);
  }

  /**
   * Emit the summary once, synchronously. Safe to call from an exit handler.
   * A flush with nothing to report does NOT disarm it — the sidecar's stdin can
   * end at startup, long before the SIGTERM that should print the real summary.
   */
  flushSummary(): void {
    if (this.summaryEmitted) return;
    const block = this.summary();
    if (!block) return;
    this.summaryEmitted = true;
    (this.sink ?? syncStderrSink)(block);
  }

  private write(line: string): void {
    (this.sink ?? stderrSink)(line);
  }
}

/** The process-wide tracer, configured from the environment at load. */
export const tracer = new Tracer();

/** Convenience for the one call site in gateway.ts. */
export function recordApiCall(ms: number): void {
  tracer.recordApi(ms);
}

/**
 * Emit the session summary when the process goes away: SIGINT / SIGTERM, the
 * client closing stdin (which is how an MCP stdio session normally ends), or a
 * plain exit. No handlers are installed at all when tracing is off, so the
 * default signal behaviour is untouched for everyone else.
 */
export function installSessionSummary(target: Tracer = tracer): () => void {
  if (!target.enabled) return () => {};
  const emit = () => target.flushSummary();
  process.once("exit", emit);
  // stdin end/close is the normal end of a stdio MCP session. Listening for
  // these does not put the stream into flowing mode.
  process.stdin.once("end", emit);
  process.stdin.once("close", emit);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      emit();
      // We just took over the default disposition for this signal, so exit
      // explicitly rather than hanging.
      process.exit(0);
    });
  }
  return emit;
}
