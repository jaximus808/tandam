/**
 * Shared MCP server wiring.
 *
 * Both entrypoints build their server from here so the tool surface stays
 * single-sourced:
 *   - index.ts  → stdio transport (the published `tandem-mcp` CLI)
 *   - http.ts   → Streamable HTTP transport (the hosted sidecar)
 *
 * The only per-transport difference is how the Server is connected, so this
 * factory takes a Gateway (which holds the canvas binding) and returns a
 * fully-wired, not-yet-connected Server.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Gateway } from "./gateway.js";
import { TOOLS, decorateTools, handleTool } from "./tools.js";
import { FACADE_RAW_TOOLS, handleFacadeTool, isFacadeTool } from "./facade.js";
import { tracer } from "./trace.js";

export const SERVER_NAME = "tandem";

/**
 * The server-level briefing surfaced to the model at `initialize`
 * (InitializeResult.instructions, TDM-131). A cold client — or any client
 * without CLAUDE.md — is otherwise taught ONLY by the tool descriptions, and the
 * one rule that failed in the field (an orchestrator dispatching subagents BEFORE
 * the work existed, approved, on the board) lived in none of them. This is the
 * standard channel every MCP client sees; keep it compact and load-bearing.
 *
 * It carries the four things a session must not get wrong:
 *   1. connect first, then carry the `session` handle on EVERY later call;
 *   2. the executor loop (queue_next → task_claim → task_progress → task_complete);
 *   3. the human approval gate (proposals wait; never approve your own);
 *   4. orchestrator SEQUENCING — propose, WAIT for the human's approval, and only
 *      then dispatch; dispatch only board handoffs; pass the CODE, never the
 *      session handle. Nothing else binds those three into a sequence.
 */
export const SERVER_INSTRUCTIONS =
  "Tandem is a shared task board humans and agents co-edit. " +
  "START by calling canvas_connect with the canvas code; it returns a `session` handle — pass it " +
  "back as `session` on EVERY later call (the hosted connection resets between calls; the handle " +
  "re-binds you). " +
  "EXECUTOR loop: queue_next (the ready, approved queue) → task_claim ONE task (claimed:false " +
  "means another session won it: take a different one, never work a task you did not claim) → do " +
  "the work, task_progress as you go (it also heartbeats your claim) → task_complete. task_get " +
  "hydrates a task's full brief. " +
  "APPROVAL GATE: anything you propose (task_propose / epic_propose) lands as 'proposed' and a " +
  "HUMAN approves it on the board before it can be claimed — never work unapproved work, and " +
  "never try to approve your own. " +
  "ORCHESTRATOR (dispatching to subagents): propose the epic, then WAIT for the human's approval " +
  "before dispatching — the approved board queue is the go signal, not your own plan; work must " +
  "exist, approved, on the board before you dispatch it. Dispatch ONLY tasks queue_next returns " +
  "with a `handoff` block, one subagent per task, and pass the canvas CODE, never your `session` " +
  "handle. You claim nothing; the workers claim their own.";

// Keep in sync with package.json `version`. Surfaced via `--version` and the
// MCP server's self-identification over both transports.
export const VERSION = "2.3.0";

// Hosted backend. Override with the API_URL env var to point at a local or
// self-hosted instance (the HTTP sidecar sets this to the in-cluster Go API).
export const DEFAULT_API_URL = "https://tandemcanvas.com";

// Public origin used to build shareable canvas / claim links handed to users.
// Override with the PUBLIC_URL env var. The HTTP sidecar must set this (or rely
// on this default) so links use the public domain rather than the internal
// API_URL (e.g. http://tandem:7891).
export const DEFAULT_WEB_URL = "https://tandemcanvas.com";

// The intent facade (facade.ts), decorated exactly like the CRUD surface.
export const FACADE_TOOLS = decorateTools(FACADE_RAW_TOOLS);

/**
 * Is the full ~80-tool CRUD surface opted in? Default is FACADE ONLY: the
 * facade is the product's agent UX, and the CRUD manifest costs a large slice
 * of the context window before a session does anything.
 *
 * Opt in with TANDEM_FULL_TOOLS=1 (also accepts true/yes), or `tandem-mcp
 * --full-tools`, which index.ts passes through as an explicit override.
 */
export function fullToolsEnabled(override?: boolean): boolean {
  if (override !== undefined) return override;
  const v = (process.env.TANDEM_FULL_TOOLS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * The advertised manifest. When the full surface is opted in it is ADDITIVE:
 * facade first, then every CRUD tool the facade doesn't already own by name
 * (only canvas_connect overlaps, and the facade's version wins because its
 * description teaches the queue-first workflow). Additive rather than
 * either/or because the facade covers the queue but not maps, sheets, charts
 * or forms — a session that opts in usually wants both.
 */
export function manifestFor(fullTools: boolean) {
  if (!fullTools) return FACADE_TOOLS;
  const owned = new Set(FACADE_TOOLS.map((t) => t.name));
  return [...FACADE_TOOLS, ...TOOLS.filter((t) => !owned.has(t.name))];
}

/**
 * When the MCP config pins a canvas code (env TANDEM_CANVAS_CODE, written by
 * `tandem-mcp init`), say so IN the canvas_connect description: the model reads
 * the manifest, not the process env, so this is the only way it learns which
 * canvas this project belongs to without the human repeating the code. Pure and
 * non-mutating — returns a new array; every other tool passes through.
 */
export function withConfiguredCanvasCode<T extends { name: string; description: string }>(
  tools: T[],
  code?: string
): T[] {
  const pinned = code?.trim();
  if (!pinned) return tools;
  return tools.map((tool) =>
    tool.name === "canvas_connect"
      ? {
          ...tool,
          description:
            `THIS PROJECT'S CANVAS IS \`${pinned}\` — call this with that code, first thing. ` +
            tool.description,
        }
      : tool
  );
}

/**
 * Build an MCP Server bound to `gateway`. One Gateway (and therefore one
 * Server) per session — for stdio that's the whole process; for HTTP it's one
 * per connected client.
 *
 * `options.fullTools` overrides the TANDEM_FULL_TOOLS env check (the stdio
 * entrypoint passes it for the --full-tools CLI flag).
 */
export function createTandemServer(
  gateway: Gateway,
  version: string,
  options?: { fullTools?: boolean }
): Server {
  const server = new Server(
    { name: SERVER_NAME, version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  const fullTools = fullToolsEnabled(options?.fullTools);
  const tools = withConfiguredCanvasCode(
    manifestFor(fullTools),
    process.env.TANDEM_CANVAS_CODE
  );
  process.stderr.write(
    `[tandem] tool manifest: ${fullTools ? "facade + full CRUD" : "intent facade"} (${tools.length} tools)\n`
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Normalize legacy dotted tool names (canvas.connect) to the underscore
    // form we now advertise (canvas_connect) — see handleTool for why.
    const name = request.params.name.replace(/\./g, "_");
    const a = (request.params.arguments ?? {}) as Record<string, unknown>;

    // Per-call trace (MCP_TRACE, see trace.ts): duration, the API time inside
    // it, and ok/error. A pass-through when tracing is off. `isError` on the
    // dispatch result is the tool-level failure signal — dispatch catches
    // throws and turns them into an error payload.
    return tracer.call(
      name,
      () => dispatch(gateway, name, a),
      (result) => !(result as { isError?: boolean }).isError
    );
  });

  async function dispatch(gateway: Gateway, name: string, a: Record<string, unknown>) {
    try {
      // Routing is by NAME, not by manifest: the CRUD tools stay CALLABLE even
      // when they aren't advertised, so saved prompts, older clients, and agents
      // told to "use canvas_task_list" keep working after the manifest shrank.
      // Gating the manifest is a context-window decision, not an access control.
      const result = isFacadeTool(name)
        ? await handleFacadeTool(gateway, name, a)
        : await handleTool(gateway, name, a);

      // For state.read, decorate with the active canvas so the agent always knows where it is.
      if (name === "canvas_state_read" && gateway.isConnected()) {
        const session = gateway.getSession();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              activeCanvasId: session.canvasId,
              activeCanvasName: session.canvasName,
              activeCanvasCode: session.canvasCode,
              _note: "All tools in this session operate on this canvas. Never pass a canvas ID.",
              ...(result as object),
            }),
          }],
        };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: String(err) }) }],
        isError: true,
      };
    }
  }

  return server;
}
