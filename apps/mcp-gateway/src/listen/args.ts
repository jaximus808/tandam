/**
 * `tandem-mcp listen` flag parsing. Same shape as `init`'s parser (both
 * `--flag value` and `--flag=value`, unknown flags are a usage error rather
 * than a silent no-op).
 */

import { REPLAY_WINDOW_SEC, SECRET_PREFIX } from "./verify.js";

/** Env var carrying the shared secret when `--secret` isn't passed. */
export const SECRET_ENV = "TANDEM_WEBHOOK_SECRET";

export const DEFAULT_PORT = 8787;
export const DEFAULT_PATH = "/webhook";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_EVENTS = ["task.approved"];
export const DEFAULT_DEBOUNCE_MS = 5000;
/** Bound on the in-memory delivery-id set. */
export const DEFAULT_DEDUPE_CAPACITY = 1000;

export interface ListenOptions {
  /** Shell command run when work is approved. Required. */
  exec: string;
  port: number;
  /** Shared secret (`whsec_…`). Resolved from --secret, else SECRET_ENV. */
  secret: string;
  /** Event types that trigger the exec. Anything else is acked and ignored. */
  events: string[];
  /** Trailing-edge coalescing window, ms. */
  debounceMs: number;
  help: boolean;
}

export class ListenUsageError extends Error {}

/**
 * Parse argv AFTER the `listen` word. `env` is the process env, consulted for
 * the secret only — the flag always wins.
 */
export function parseListenArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): ListenOptions {
  let exec: string | undefined;
  let secret: string | undefined;
  let port = DEFAULT_PORT;
  let events = [...DEFAULT_EVENTS];
  let debounceMs = DEFAULT_DEBOUNCE_MS;
  let help = false;

  const valueOf = (flag: string, next: string | undefined): string => {
    if (next === undefined) throw new ListenUsageError(`${flag} needs a value`);
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith("--") && eq > 0 ? arg.slice(eq + 1) : undefined;
    const take = (): string => (inline !== undefined ? inline : valueOf(flag, argv[++i]));

    switch (flag) {
      case "--exec":
        // Deliberately NOT `.startsWith("-")`-guarded like init's parser: a
        // command legitimately looks like `-p …` after a shell word, and the
        // whole thing arrives as one quoted argv entry anyway.
        exec = take();
        break;
      case "--port": {
        const raw = take().trim();
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          throw new ListenUsageError(`--port must be a port number 1-65535, got "${raw}"`);
        }
        port = n;
        break;
      }
      case "--secret":
        secret = take().trim();
        break;
      case "--events":
        events = take()
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean);
        if (events.length === 0) {
          throw new ListenUsageError(`--events needs at least one event type`);
        }
        break;
      case "--debounce": {
        const raw = take().trim();
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          throw new ListenUsageError(`--debounce must be a non-negative integer (ms), got "${raw}"`);
        }
        debounceMs = n;
        break;
      }
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new ListenUsageError(`Unknown option "${arg}" for \`tandem-mcp listen\``);
    }
  }

  if (help) {
    return { exec: exec ?? "", port, secret: secret ?? "", events, debounceMs, help: true };
  }

  if (!exec || !exec.trim()) {
    throw new ListenUsageError(`--exec is required: the command to run when work is approved`);
  }
  // Flag wins over env — an explicit secret on the command line should never be
  // shadowed by a stale one in the shell.
  const resolved = (secret || env[SECRET_ENV] || "").trim();
  if (!resolved) {
    throw new ListenUsageError(
      `no webhook secret: pass --secret ${SECRET_PREFIX}… or set ${SECRET_ENV}`
    );
  }

  return { exec, port, secret: resolved, events, debounceMs, help: false };
}

export function listenHelp(): string {
  return (
    `tandem-mcp listen — run a command when work is approved on your board.\n` +
    `\n` +
    `A local HTTP listener for Tandem outbound webhooks. A human approves tasks,\n` +
    `Tandem POSTs a signed event here, and this launches your orchestrator.\n` +
    `\n` +
    `Usage:\n` +
    `  tandem-mcp listen --exec '<command>' [options]\n` +
    `\n` +
    `Options:\n` +
    `  --exec <command>     REQUIRED. Run via the shell on trigger.\n` +
    `  --port <n>           Port on ${DEFAULT_HOST}. Default: ${DEFAULT_PORT}\n` +
    `  --secret <whsec_…>   Webhook signing secret. Default: $${SECRET_ENV}\n` +
    `  --events <csv>       Event types that trigger. Default: ${DEFAULT_EVENTS.join(",")}\n` +
    `                       (task.approved, task.completed, task.claim_expired)\n` +
    `  --debounce <ms>      Coalesce a burst of events into one run.\n` +
    `                       Default: ${DEFAULT_DEBOUNCE_MS}\n` +
    `  --help, -h           Show this help.\n` +
    `\n` +
    `Webhook endpoint:  POST http://${DEFAULT_HOST}:<port>${DEFAULT_PATH}\n` +
    `Signature:         Tandem-Signature (HMAC-SHA256 over "<ts>.<body>"),\n` +
    `                   ±${REPLAY_WINDOW_SEC}s replay window, deduped on Tandem-Delivery-Id.\n` +
    `\n` +
    `Environment given to the exec'd command (on top of your own):\n` +
    `  TANDEM_EVENT         Event type, e.g. task.approved\n` +
    `  TANDEM_CANVAS_CODE   Canvas code (falls back to $TANDEM_CANVAS_CODE)\n` +
    `  TANDEM_CANVAS_ID     Canvas UUID from the event payload\n` +
    `  TANDEM_TICKETS       Comma-separated tickets, e.g. TDM-56,TDM-57 ("" if none)\n` +
    `\n` +
    `Example:\n` +
    `  tandem-mcp listen --exec 'claude -p "Connect to canvas $TANDEM_CANVAS_CODE, \\\n` +
    `    run queue_next, claim and complete the approved tasks"'\n`
  );
}
