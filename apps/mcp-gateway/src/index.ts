/**
 * AgentCanvas MCP Gateway (Phase 2)
 *
 * Spawned by Claude Code as an MCP stdio process. The canvas binding is
 * established at runtime: Claude calls the `canvas.connect` tool with a
 * canvas code, the gateway exchanges it for a JWT, then proxies all
 * subsequent tool calls to the Go API server.
 *
 * MCP config:
 * {
 *   "agentcanvas": {
 *     "command": "node",
 *     "args": ["/path/to/mcp-gateway/dist/index.js"],
 *     "env": { "API_URL": "http://localhost:7891" }  // optional, this is the default
 *   }
 * }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Gateway } from "./gateway.js";
import { TOOLS, handleTool } from "./tools.js";

const API_URL = (process.env.API_URL ?? "http://localhost:7891").replace(/\/$/, "");

const gateway = new Gateway({ apiUrl: API_URL });

async function main() {
  const server = new Server(
    { name: "agentcanvas", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
      const result = await handleTool(gateway, name, a);

      // For state.read, decorate with the active canvas so Claude always knows where it is.
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[agentcanvas] Fatal: ${err}\n`);
  process.exit(1);
});
