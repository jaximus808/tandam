/**
 * `tandem-mcp init` — zero to a connected canvas in ONE command (TDM-33).
 *
 * Run inside a project directory:
 *
 *   npx @jaximus/tandem-mcp init
 *
 * and it (1) creates a canvas on the hosted API, (2) registers the MCP server
 * in a project-scoped `.mcp.json` (merged, never clobbered) with the canvas
 * code in `env.TANDEM_CANVAS_CODE`, (3) prints the share code + board URL, and
 * (4) prints an AGENTS.md/CLAUDE.md snippet teaching the queue-first workflow
 * (`--write` appends it for you).
 *
 * Re-running is a NO-OP: the canvas code lives in `.mcp.json`, so a second run
 * reprints it and touches nothing (exit 0). `--force` creates a fresh canvas.
 *
 * Everything here is pure except `runInit`, which takes its filesystem and
 * network as injected deps (see `InitDeps`) so the logic is unit-testable
 * without touching either.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// ── Config shapes ────────────────────────────────────────────────────────────

/** The MCP server key we own inside `mcpServers`. */
export const MCP_SERVER_KEY = "tandem";

/** Env var carrying the project's canvas code into the spawned gateway. */
export const CANVAS_CODE_ENV = "TANDEM_CANVAS_CODE";

/** Marker that makes the AGENTS.md/CLAUDE.md snippet idempotently detectable. */
export const SNIPPET_MARKER = "<!-- tandem:queue -->";

/** Files `--write` appends the snippet to, in preference order. */
export const AGENT_DOC_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

// ── Args ─────────────────────────────────────────────────────────────────────

export interface InitOptions {
  /** Project directory to configure. Defaults to cwd. */
  dir: string;
  /** Canvas name for a freshly created canvas. Defaults to the folder name. */
  name?: string;
  /** Wire an EXISTING canvas by code instead of creating one. */
  code?: string;
  /** Append the agent snippet to AGENTS.md / CLAUDE.md. */
  write: boolean;
  /** Create a new canvas even if this project is already wired up. */
  force: boolean;
  help: boolean;
}

export class InitUsageError extends Error {}

/**
 * Parse `init`'s flags (argv AFTER the `init` word). Unknown flags are a usage
 * error rather than being ignored — a silently-dropped `--name` would leave the
 * user with a canvas called the wrong thing and no signal.
 */
export function parseInitArgs(argv: string[], cwd: string): InitOptions {
  const opts: InitOptions = { dir: cwd, write: false, force: false, help: false };

  const valueOf = (flag: string, next: string | undefined): string => {
    if (next === undefined || next.startsWith("-")) {
      throw new InitUsageError(`${flag} needs a value`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Support both `--name x` and `--name=x`.
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith("--") && eq > 0 ? arg.slice(eq + 1) : undefined;
    const take = (): string => (inline !== undefined ? inline : valueOf(flag, argv[++i]));

    switch (flag) {
      case "--name":
        opts.name = take().trim();
        break;
      case "--code":
        opts.code = take().trim().toUpperCase();
        break;
      case "--dir":
        opts.dir = resolve(cwd, take());
        break;
      case "--write":
        opts.write = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new InitUsageError(`Unknown option "${arg}" for \`tandem-mcp init\``);
    }
  }

  if (opts.name === "") delete opts.name;
  if (opts.code === "") delete opts.code;
  return opts;
}

/** Canvas name to use when `--name` wasn't given: the project folder's name. */
export function defaultCanvasName(dir: string): string {
  const base = basename(resolve(dir)).trim();
  return base && base !== "/" && base !== "." ? base : "Untitled canvas";
}

// ── .mcp.json: read / decide / merge ─────────────────────────────────────────

/** Path of the project-scoped MCP config Claude Code reads. */
export function mcpConfigPath(dir: string): string {
  return join(dir, ".mcp.json");
}

/**
 * The canvas code this project is already wired to, if any. Source of truth for
 * idempotency: it is the one place `init` writes the binding, and the gateway
 * reads the same var at runtime.
 */
export function readExistingCode(config: McpConfig | null | undefined): string | undefined {
  const entry = config?.mcpServers?.[MCP_SERVER_KEY];
  const code = entry?.env?.[CANVAS_CODE_ENV];
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

export interface InitDecision {
  /** `reuse` = already wired, do nothing; `configure` = create/attach + write. */
  action: "reuse" | "configure";
  /** Present on `reuse`: the code already in `.mcp.json`. */
  existingCode?: string;
  reason: string;
}

/**
 * Should this run change anything? Pure so the idempotency contract is pinned
 * by a test rather than by reading the flow.
 */
export function decideInit(
  config: McpConfig | null | undefined,
  opts: { force?: boolean; code?: string }
): InitDecision {
  const existingCode = readExistingCode(config);
  if (opts.force) {
    return { action: "configure", reason: "--force: creating a new canvas" };
  }
  if (!existingCode) {
    return { action: "configure", reason: "no tandem server configured yet" };
  }
  if (opts.code && opts.code !== existingCode) {
    return {
      action: "configure",
      existingCode,
      reason: `repointing from ${existingCode} to ${opts.code}`,
    };
  }
  return {
    action: "reuse",
    existingCode,
    reason: "already configured",
  };
}

/**
 * Merge the tandem server into an existing `.mcp.json`, non-destructively:
 * other servers and unknown top-level keys are preserved verbatim, and an
 * existing tandem entry keeps its own `command`/`args` (a local-dev entry
 * pointing at `node dist/index.js` must survive an `init`) plus any extra env
 * it had. Only the canvas code is authoritative from this run.
 */
export function mergeMcpConfig(
  existing: McpConfig | null | undefined,
  opts: { code: string; apiUrl?: string }
): McpConfig {
  const base: McpConfig = existing ? { ...existing } : {};
  const servers: Record<string, McpServerEntry> = { ...(base.mcpServers ?? {}) };
  const prior: McpServerEntry = { ...(servers[MCP_SERVER_KEY] ?? {}) };

  const env: Record<string, string> = { ...(prior.env ?? {}) };
  env[CANVAS_CODE_ENV] = opts.code;
  // Only pin API_URL when pointing somewhere other than the hosted default —
  // baking the default in would freeze the package's own default forever.
  if (opts.apiUrl) env.API_URL = opts.apiUrl;

  servers[MCP_SERVER_KEY] = {
    ...prior,
    command: prior.command ?? "npx",
    args: prior.args ?? ["-y", "@jaximus/tandem-mcp"],
    env,
  };

  base.mcpServers = servers;
  return base;
}

/** Stable on-disk form: 2-space JSON with a trailing newline. */
export function serializeMcpConfig(config: McpConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Parse `.mcp.json`, turning a syntax error into an actionable message. */
export function parseMcpConfig(raw: string, path: string): McpConfig {
  const text = raw.trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON, so it can't be merged safely — fix it (or move it aside) and re-run. (${err})`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON object.`);
  }
  return parsed as McpConfig;
}

// ── Agent snippet ────────────────────────────────────────────────────────────

/**
 * The 10-ish lines that turn a generic coding agent into a queue-first one.
 * Uses the intent-facade tool names (TDM-32), which are what the default
 * manifest advertises.
 */
export function agentSnippet(opts: { code: string; url: string; canvasName?: string }): string {
  const name = opts.canvasName?.trim();
  const title = name ? `## Tandem task queue — ${name} (\`${opts.code}\`)` : `## Tandem task queue (\`${opts.code}\`)`;
  return [
    SNIPPET_MARKER,
    title,
    "",
    `This project's work queue is a Tandem canvas: ${opts.url}`,
    "Start every session from the queue — never by reading the whole board.",
    "",
    `1. \`canvas_connect\` with code \`${opts.code}\` — returns a \`session\` handle; pass it on every later call.`,
    "2. `queue_next` — the approved tasks ready to pick up. Take ONE.",
    "3. `task_get` it for the full brief, then `task_claim` before touching anything.",
    "   `claimed: false` means a parallel session won it — go back to `queue_next`.",
    "4. `task_progress` with one line whenever long work moves or changes direction.",
    "5. `task_complete` with what you did and where (files / commit) when it's done.",
    "",
    "New work goes through `task_propose`; it lands as `proposed` for a human to approve.",
    "",
  ].join("\n");
}

/**
 * Append the snippet to an agent doc, unless it is already there (marker match
 * OR the code already appears — someone may have pasted it by hand without the
 * marker). Returns null when nothing needs writing.
 */
export function appendSnippet(existing: string, snippet: string, code: string): string | null {
  if (existing.includes(SNIPPET_MARKER) || existing.includes(code)) return null;
  const body = existing.replace(/\s*$/, "");
  return body ? `${body}\n\n${snippet}` : snippet;
}

// ── Flow ─────────────────────────────────────────────────────────────────────

export interface CanvasHandle {
  code: string;
  name: string;
  url: string;
  /** Private one-time ownership link, only for a canvas this run created. */
  claimUrl?: string;
}

export interface InitDeps {
  /** Create a new canvas on the API. */
  createCanvas(name: string): Promise<CanvasHandle>;
  /** Validate + resolve an existing canvas by code (`--code`). */
  connectCanvas(code: string): Promise<CanvasHandle>;
  /** Public web origin, for printing a board URL without a network call. */
  webUrl: string;
  /** API base, pinned into .mcp.json only when it isn't the hosted default. */
  apiUrl?: string;
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  out(line: string): void;
}

/** Real deps backed by node:fs + stdout. Network deps are supplied by index.ts. */
export function fsDeps(): Pick<InitDeps, "readFile" | "writeFile" | "exists" | "out"> {
  return {
    readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    writeFile: (p, c) => writeFileSync(p, c, "utf8"),
    exists: (p) => existsSync(p),
    out: (line) => process.stdout.write(`${line}\n`),
  };
}

export function initHelp(): string {
  return [
    "tandem-mcp init — create a canvas, wire it into this project, print the agent snippet.",
    "",
    "Usage:",
    "  npx @jaximus/tandem-mcp init [options]",
    "",
    "Options:",
    "  --name <name>   Name for the new canvas. Default: this folder's name.",
    "  --code <CODE>   Use an EXISTING canvas instead of creating one.",
    "  --write         Append the agent snippet to AGENTS.md / CLAUDE.md.",
    "  --force         Create a new canvas even if this project is already wired.",
    "  --dir <path>    Project directory to configure. Default: cwd.",
    "  -h, --help      Show this help.",
    "",
    "Writes .mcp.json (merged — other MCP servers are left alone) with the canvas",
    `code in env.${CANVAS_CODE_ENV}. Re-running prints the existing code and`,
    "changes nothing.",
  ].join("\n");
}

/**
 * Run the init flow. Returns the process exit code (0 = success or no-op).
 */
export async function runInit(opts: InitOptions, deps: InitDeps): Promise<number> {
  if (opts.help) {
    deps.out(initHelp());
    return 0;
  }

  const configPath = mcpConfigPath(opts.dir);
  const raw = deps.readFile(configPath);
  const config = raw === null ? null : parseMcpConfig(raw, configPath);
  const decision = decideInit(config, { force: opts.force, code: opts.code });

  // ── Already wired: print and get out without touching disk or the network.
  if (decision.action === "reuse") {
    const code = decision.existingCode!;
    deps.out("");
    deps.out("  Tandem is already set up in this project.");
    deps.out("");
    deps.out(`  Code    ${code}`);
    deps.out(`  Board   ${deps.webUrl}/c/${code}`);
    deps.out("");
    deps.out(`  .mcp.json already points the "${MCP_SERVER_KEY}" MCP server at it — nothing changed.`);
    deps.out("  Re-run with --force to create a NEW canvas, or --code <CODE> to point at another.");
    deps.out("");
    return 0;
  }

  // ── Get a canvas: attach to the given code, or create one.
  const canvas = opts.code
    ? await deps.connectCanvas(opts.code)
    : await deps.createCanvas(opts.name || defaultCanvasName(opts.dir));

  // ── Register the MCP server (merge, never clobber).
  const merged = mergeMcpConfig(config, { code: canvas.code, apiUrl: deps.apiUrl });
  deps.writeFile(configPath, serializeMcpConfig(merged));
  const otherServers = Object.keys(merged.mcpServers ?? {}).filter((k) => k !== MCP_SERVER_KEY);

  const snippet = agentSnippet({ code: canvas.code, url: canvas.url, canvasName: canvas.name });

  // ── Optionally append the snippet to the project's agent docs.
  const written: string[] = [];
  const skipped: string[] = [];
  if (opts.write) {
    const targets = AGENT_DOC_FILES.filter((f) => deps.exists(join(opts.dir, f)));
    // No agent doc yet? `--write` is explicit consent, so start AGENTS.md.
    const files = targets.length ? targets : [AGENT_DOC_FILES[0]];
    for (const file of files) {
      const path = join(opts.dir, file);
      const next = appendSnippet(deps.readFile(path) ?? "", snippet, canvas.code);
      if (next === null) skipped.push(file);
      else {
        deps.writeFile(path, next.endsWith("\n") ? next : `${next}\n`);
        written.push(file);
      }
    }
  }

  // ── Report.
  deps.out("");
  deps.out(`  Canvas  ${canvas.name}`);
  deps.out(`  Code    ${canvas.code}`);
  deps.out(`  Board   ${canvas.url}`);
  if (canvas.claimUrl) {
    deps.out(`  Claim   ${canvas.claimUrl}`);
    deps.out("          ^ private — open it once while signed in to own this canvas.");
  }
  deps.out("");
  deps.out(
    `  Wrote ${configPath} (mcpServers.${MCP_SERVER_KEY})` +
      (otherServers.length ? ` — left ${otherServers.length} other server(s) untouched.` : ".")
  );
  deps.out("  Restart your agent CLI (Claude Code, Cursor, …) so it picks up the new MCP server.");
  if (written.length) deps.out(`  Appended the queue snippet to ${written.join(", ")}.`);
  if (skipped.length) deps.out(`  ${skipped.join(", ")} already mentions this canvas — left alone.`);
  deps.out("");

  if (!opts.write) {
    deps.out("  Paste this into AGENTS.md / CLAUDE.md (or re-run with --write):");
    deps.out("");
    for (const line of snippet.split("\n")) deps.out(`  ${line}`);
  }
  return 0;
}
