/**
 * Debounce + single-flight coordination between "a webhook arrived" and "run the
 * orchestrator".
 *
 * TWO PROBLEMS, both of which produce N runs where a human meant one:
 *
 *  1. FAN-OUT. Approving an epic approves every task under it, and the API fans
 *     one `task.approved` per task (see emitTaskApprovedEach) — a burst of five
 *     deliveries inside a second. We collect them in a TRAILING-EDGE window: the
 *     timer restarts on each event, and one trigger fires once the window goes
 *     quiet, carrying every ticket in the burst.
 *
 *  2. OVERLAP. An orchestrator run takes minutes; approvals keep arriving. Only
 *     ever one child process: events that land mid-run merge into a single
 *     PENDING batch that starts when the current child exits. Never dropped
 *     (that would silently lose an approval), never stacked (that would fork a
 *     second Claude at the same board).
 *
 * Timers are injected so the whole thing is testable without real time.
 */

export interface TriggerEvent {
  /** Event type, e.g. "task.approved". */
  event: string;
  /** Canvas code for the exec'd command; may be "". */
  canvasCode: string;
  /** Canvas UUID from the payload; may be "". */
  canvasId?: string;
  /** Ticket id ("TDM-56") if the event carried one. */
  ticket?: string;
}

/** The coalesced set of events one exec covers. */
export interface TriggerBatch {
  /** Distinct event types, first-seen order. */
  events: string[];
  /** First non-empty canvas code seen. */
  canvasCode: string;
  /** First non-empty canvas id seen. */
  canvasId: string;
  /** Distinct ticket ids, first-seen order. */
  tickets: string[];
  /** How many webhook deliveries were folded into this batch. */
  count: number;
}

/** Minimal timer seam — the globals in production, a fake clock in tests. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface CoordinatorOptions {
  /** Quiet period, ms. 0 disables debouncing (fire on the next tick of the loop
   *  is still avoided — a 0 window fires synchronously via a 0ms timer). */
  debounceMs: number;
  /** Runs the orchestrator. Resolves when the child has exited; must not throw
   *  (a rejection is caught and logged so the queue keeps draining). */
  run: (batch: TriggerBatch) => Promise<void>;
  timers?: Timers;
  log?: (line: string) => void;
}

/** Mutable accumulator behind TriggerBatch. */
class Accumulator {
  private readonly eventSet = new Set<string>();
  private readonly ticketSet = new Set<string>();
  canvasCode = "";
  canvasId = "";
  count = 0;

  add(ev: TriggerEvent): void {
    this.count++;
    if (ev.event) this.eventSet.add(ev.event);
    if (ev.ticket) this.ticketSet.add(ev.ticket);
    if (!this.canvasCode && ev.canvasCode) this.canvasCode = ev.canvasCode;
    if (!this.canvasId && ev.canvasId) this.canvasId = ev.canvasId;
  }

  merge(other: Accumulator): void {
    this.count += other.count;
    for (const e of other.eventSet) this.eventSet.add(e);
    for (const t of other.ticketSet) this.ticketSet.add(t);
    if (!this.canvasCode) this.canvasCode = other.canvasCode;
    if (!this.canvasId) this.canvasId = other.canvasId;
  }

  snapshot(): TriggerBatch {
    return {
      events: [...this.eventSet],
      canvasCode: this.canvasCode,
      canvasId: this.canvasId,
      tickets: [...this.ticketSet],
      count: this.count,
    };
  }
}

export class TriggerCoordinator {
  private readonly timers: Timers;
  private readonly log: (line: string) => void;

  /** Events collected in the currently-open debounce window. */
  private window: Accumulator | null = null;
  private windowTimer: unknown = null;

  /** A batch waiting for the in-flight child to exit. At most one, ever. */
  private queued: Accumulator | null = null;

  private running = false;
  private stopped = false;

  constructor(private readonly opts: CoordinatorOptions) {
    this.timers = opts.timers ?? realTimers;
    this.log = opts.log ?? (() => {});
  }

  /** True while a child process is in flight. */
  get isRunning(): boolean {
    return this.running;
  }

  /** True when work is buffered — either in the open window or waiting on the
   *  current child. */
  get hasPending(): boolean {
    return this.window !== null || this.queued !== null;
  }

  /** Feed one verified, deduped, filtered delivery in. Cheap and synchronous:
   *  the HTTP handler must never wait on an exec. */
  push(ev: TriggerEvent): void {
    if (this.stopped) return;
    if (!this.window) {
      this.window = new Accumulator();
    } else {
      this.log(`coalescing into open ${this.opts.debounceMs}ms window`);
    }
    this.window.add(ev);
    // Trailing edge: every event pushes the fire time out, so a burst produces
    // exactly one trigger once it stops.
    if (this.windowTimer !== null) this.timers.clearTimeout(this.windowTimer);
    this.windowTimer = this.timers.setTimeout(() => this.onWindowClosed(), this.opts.debounceMs);
  }

  /** Stop accepting work and drop anything buffered (SIGINT path). Does not
   *  touch a child that is already running — the caller owns that. */
  stop(): void {
    this.stopped = true;
    if (this.windowTimer !== null) this.timers.clearTimeout(this.windowTimer);
    this.windowTimer = null;
    this.window = null;
    this.queued = null;
  }

  private onWindowClosed(): void {
    this.windowTimer = null;
    const batch = this.window;
    this.window = null;
    if (!batch || this.stopped) return;

    if (this.running) {
      // Mid-run arrivals fold into the ONE pending batch.
      if (this.queued) {
        this.queued.merge(batch);
        this.log(`exec in flight — merged into the pending trigger (${this.queued.count} events)`);
      } else {
        this.queued = batch;
        this.log(`exec in flight — queued a follow-up trigger (${batch.count} events)`);
      }
      return;
    }
    void this.start(batch);
  }

  private async start(acc: Accumulator): Promise<void> {
    this.running = true;
    const batch = acc.snapshot();
    try {
      await this.opts.run(batch);
    } catch (err) {
      this.log(`exec failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
    // Drain: whatever piled up while the child ran goes now, as one run.
    const next = this.queued;
    this.queued = null;
    if (next && !this.stopped) {
      this.log(`running the follow-up trigger queued during the last exec`);
      await this.start(next);
    }
  }
}
