/**
 * Tandem MCP Gateway
 *
 * Spawned by an MCP-aware agent (Claude Code, Cursor, Codex, OpenAI Agents
 * SDK, custom orchestrators) as a stdio process. The canvas binding is
 * established at runtime: the agent calls the `canvas.connect` tool with a
 * canvas code, the gateway exchanges it for a JWT, then proxies all
 * subsequent tool calls to the Tandem HTTP API.
 *
 * Example MCP config (npx form):
 *   {
 *     "mcpServers": {
 *       "tandem": {
 *         "command": "npx",
 *         "args": ["-y", "@tandem/mcp-gateway"]
 *       }
 *     }
 *   }
 *
 * Defaults to the hosted backend (https://tandemcanvas.com). Set the API_URL
 * env var only to point at a local or self-hosted instance.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Gateway } from "./gateway.js";
import { TOOLS, handleTool } from "./tools.js";

// Keep in sync with package.json `version`. Surfaced via `--version` and the
// MCP server's self-identification.
const VERSION = "2.0.1";

const DEFAULT_API_URL = "https://tandemcanvas.com";

function printHelp() {
  process.stdout.write(
    `@tandem/mcp-gateway ${VERSION} — MCP server for Tandem.\n` +
      `\n` +
      `Usage:\n` +
      `  tandem-mcp                 Run as an MCP stdio server (default).\n` +
      `  tandem-mcp --version, -v   Print version and exit.\n` +
      `  tandem-mcp --help, -h      Show this help.\n` +
      `\n` +
      `Environment:\n` +
      `  API_URL                    Tandem API base URL.\n` +
      `                             Default: ${DEFAULT_API_URL}\n` +
      `\n` +
      `This binary is normally spawned by an MCP client (Claude Code, Cursor,\n` +
      `Codex, OpenAI Agents SDK, …) over stdio. See:\n` +
      `  https://github.com/jaximus808/tandam#readme\n`
  );
}

const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
  process.stdout.write(`@tandem/mcp-gateway ${VERSION}\n`);
  process.exit(0);
}
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  printHelp();
  process.exit(0);
}

const apiUrlFromEnv = process.env.API_URL;
const API_URL = (apiUrlFromEnv ?? DEFAULT_API_URL).replace(/\/$/, "");

const gateway = new Gateway({ apiUrl: API_URL });

async function main() {
  const server = new Server(
    { name: "tandem", version: VERSION },
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[tandem] Fatal: ${err}\n`);
  process.exit(1);
});
