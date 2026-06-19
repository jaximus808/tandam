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
import { TOOLS, handleTool } from "./tools.js";

export const SERVER_NAME = "tandem";

// Keep in sync with package.json `version`. Surfaced via `--version` and the
// MCP server's self-identification over both transports.
export const VERSION = "2.0.4";

// Hosted backend. Override with the API_URL env var to point at a local or
// self-hosted instance (the HTTP sidecar sets this to the in-cluster Go API).
export const DEFAULT_API_URL = "https://tandemcanvas.com";

/**
 * Build an MCP Server bound to `gateway`. One Gateway (and therefore one
 * Server) per session — for stdio that's the whole process; for HTTP it's one
 * per connected client.
 */
export function createTandemServer(gateway: Gateway, version: string): Server {
  const server = new Server(
    { name: SERVER_NAME, version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
      const result = await handleTool(gateway, name, a);

      // For state.read, decorate with the active canvas so the agent always knows where it is.
      if (name === "canvas.state.read" && gateway.isConnected()) {
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
  });

  return server;
}
