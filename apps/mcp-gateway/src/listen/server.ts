/**
 * The thin shell around the listen pipeline: an HTTP endpoint on loopback, and
 * a child process. Everything with a decision in it lives in verify.ts /
 * dedupe.ts / trigger.ts; this file is plumbing.
 *
 * Request path, in order:
 *
 *   POST /webhook
 *     → verify Tandem-Signature over the RAW bytes   (401 / 400)
 *     → dedupe on Tandem-Delivery-Id                 (200, no trigger)
 *     → event filter                                 (200, no trigger)
 *     → hand to the coordinator, ack 200
 *
 * The ack is written BEFORE anything can block: a delivery that isn't acked
 * inside 5s is retried by the sender (webhooks.RequestTimeout), and an
 * orchestrator run takes minutes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  DEFAULT_DEDUPE_CAPACITY,
  DEFAULT_HOST,
  DEFAULT_PATH,
  type ListenOptions,
} from "./args.js";
import { DeliveryDedupe } from "./dedupe.js";
import { canvasCodeOf, canvasIdOf, eventTypeOf, parseWebhookBody, ticketOf } from "./payload.js";
import { TriggerCoordinator, type TriggerBatch } from "./trigger.js";
import { HEADER_DELIVERY_ID, HEADER_EVENT, HEADER_SIGNATURE, HEADER_TIMESTAMP, verifySignature } from "./verify.js";

/** Hard cap on a request body. Tandem payloads are a couple of KB; anything
 *  near this is not us. */
export const MAX_BODY_BYTES = 1 << 20; // 1 MiB

/**
 * Env handed to the exec'd command, on top of the listener's own environment.
 * `TANDEM_TICKETS` carries EVERY ticket coalesced into this trigger, which is
 * the whole point of the debounce window: one epic approval → one run that
 * knows about all of its tasks.
 */
export function execEnv(batch: TriggerBatch): Record<string, string> {
  return {
    // Distinct types, comma-joined. In practice a single type, since the
    // default filter is task.approved alone.
    TANDEM_EVENT: batch.events.join(","),
    TANDEM_CANVAS_CODE: batch.canvasCode,
    TANDEM_CANVAS_ID: batch.canvasId,
    TANDEM_TICKETS: batch.tickets.join(","),
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Read the raw request bytes. Returns null if the body exceeds the cap (the
 *  connection is destroyed — we never buffer more than MAX_BODY_BYTES). */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

function reply(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

export interface ListenServerDeps {
  secret: string;
  /** Event types that trigger a run. */
  events: Set<string>;
  /** Called once per delivery that survives verify + dedupe + filter. */
  onTrigger: (ev: {
    event: string;
    canvasCode: string;
    canvasId: string;
    ticket?: string;
  }) => void;
  log: (line: string) => void;
  /** Ambient canvas code, used when the payload has none (it currently never
   *  does — the wire carries canvas_id). */
  canvasCodeFallback?: string;
  now?: () => number;
  dedupe?: DeliveryDedupe;
  path?: string;
}

/** Build the HTTP server. Exported unstarted so a caller owns listen/close. */
export function createListenServer(deps: ListenServerDeps): Server {
  const dedupe = deps.dedupe ?? new DeliveryDedupe(DEFAULT_DEDUPE_CAPACITY);
  const now = deps.now ?? (() => Date.now());
  const path = deps.path ?? DEFAULT_PATH;

  return createServer(async (req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (url !== path) {
      reply(res, 404, "not found\n");
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      reply(res, 405, "method not allowed\n");
      return;
    }

    const raw = await readBody(req);
    if (raw === null) {
      reply(res, 413, "payload too large\n");
      return;
    }

    const verdict = verifySignature({
      secret: deps.secret,
      signature: header(req, HEADER_SIGNATURE),
      timestamp: header(req, HEADER_TIMESTAMP),
      body: raw,
      nowMs: now(),
    });
    if (!verdict.ok) {
      deps.log(`rejected (${verdict.status}): ${verdict.reason}`);
      reply(res, verdict.status, `${verdict.reason}\n`);
      return;
    }

    const deliveryId = header(req, HEADER_DELIVERY_ID);
    const body = parseWebhookBody(raw);
    const event = eventTypeOf(header(req, HEADER_EVENT), body);
    const ticket = ticketOf(body);
    const label = `${event || "?"}${ticket ? ` ${ticket}` : ""}`;

    // Everything below acks 200 — the sender did its job; whether we act on the
    // delivery is our business, and a non-2xx would just earn us a retry.
    if (dedupe.seen(deliveryId)) {
      deps.log(`deduped ${label} (delivery ${deliveryId} already seen)`);
      reply(res, 200, "ok (duplicate)\n");
      return;
    }
    if (!deliveryId) {
      deps.log(`warning: delivery with no ${HEADER_DELIVERY_ID} — cannot dedupe`);
    }
    if (!deps.events.has(event)) {
      deps.log(`ignored ${label} (not in --events)`);
      reply(res, 200, "ok (ignored)\n");
      return;
    }

    deps.log(`received ${label}`);
    reply(res, 200, "ok\n");
    deps.onTrigger({
      event,
      canvasCode: canvasCodeOf(body, deps.canvasCodeFallback),
      canvasId: canvasIdOf(body),
      ticket,
    });
  });
}

/**
 * Run the orchestrator once for a coalesced batch. Resolves when the child has
 * exited — the coordinator uses that to hold the single-flight lock.
 */
export function runExecCommand(
  command: string,
  batch: TriggerBatch,
  log: (line: string) => void,
  onChild?: (child: ChildProcess | null) => void
): Promise<number | null> {
  return new Promise((resolve) => {
    const env = { ...process.env, ...execEnv(batch) };
    const tickets = batch.tickets.length ? batch.tickets.join(",") : "(none)";
    log(`triggered: ${batch.count} event(s), tickets ${tickets} — exec: ${command}`);

    let child: ChildProcess;
    try {
      // shell:true is the contract — `--exec` is a command line, not an argv.
      child = spawn(command, {
        shell: true,
        stdio: ["ignore", "inherit", "inherit"],
        env,
      });
    } catch (err) {
      log(`exec failed to start: ${err instanceof Error ? err.message : String(err)}`);
      resolve(null);
      return;
    }
    onChild?.(child);

    let settled = false;
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      onChild?.(null);
      log(signal ? `exec exited on ${signal}` : `exec exited with code ${code ?? "?"}`);
      resolve(code);
    };
    child.on("error", (err) => {
      log(`exec error: ${err.message}`);
      done(null, null);
    });
    child.on("exit", (code, signal) => done(code, signal));
  });
}

export interface RunListenDeps {
  log?: (line: string) => void;
  /** Test seam: skip installing SIGINT/SIGTERM handlers. */
  installSignals?: boolean;
}

/**
 * Start the listener and resolve with a process exit code once it is shut down.
 * The only impure entry point in `src/listen`.
 */
export function runListen(opts: ListenOptions, deps: RunListenDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`[tandem listen] ${line}\n`));
  const events = new Set(opts.events);

  let child: ChildProcess | null = null;
  const coordinator = new TriggerCoordinator({
    debounceMs: opts.debounceMs,
    log,
    run: async (batch) => {
      await runExecCommand(opts.exec, batch, log, (c) => {
        child = c;
      });
    },
  });

  const server = createListenServer({
    secret: opts.secret,
    events,
    log,
    canvasCodeFallback: process.env.TANDEM_CANVAS_CODE,
    onTrigger: (ev) => coordinator.push(ev),
  });

  return new Promise<number>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) {
        log(`second ${signal} — exiting now`);
        resolve(130);
        return;
      }
      shuttingDown = true;
      log(`${signal} — shutting down`);
      coordinator.stop();
      server.close(() => {
        if (!child) resolve(0);
      });
      // close() alone waits out every keep-alive socket the sender left open,
      // which would make Ctrl-C look wedged. Idle sockets go immediately;
      // anything still mid-request gets a short grace.
      server.closeIdleConnections?.();
      const grace = setTimeout(() => server.closeAllConnections?.(), 1000);
      grace.unref?.();
      // Hand the signal to the orchestrator and let it wind down; the exit
      // handler below resolves once it's gone.
      const running = child;
      if (running) {
        log(`waiting for the running exec to exit (Ctrl-C again to give up)`);
        running.once("exit", () => resolve(0));
        running.kill("SIGINT");
      }
    };

    if (deps.installSignals !== false) {
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    }

    server.on("error", (err) => {
      log(`server error: ${err.message}`);
      resolve(1);
    });

    server.listen(opts.port, DEFAULT_HOST, () => {
      log(
        `listening on http://${DEFAULT_HOST}:${opts.port}${DEFAULT_PATH} ` +
          `— events [${[...events].join(", ")}], debounce ${opts.debounceMs}ms`
      );
      log(`on trigger: ${opts.exec}`);
    });
  });
}
