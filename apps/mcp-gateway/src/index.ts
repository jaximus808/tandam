/**
 * Tandem MCP Gateway
 *
 * Spawned by an MCP-aware agent (Claude Code, Cursor, Codex, OpenAI Agents
 * SDK, custom orchestrators) as a stdio process. The canvas binding is
 * established at runtime: the agent calls the `canvas_connect` tool with a
 * canvas code, the gateway exchanges it for a JWT, then proxies all
 * subsequent tool calls to the Tandem HTTP API.
 *
 * Example MCP config (npx form):
 *   {
 *     "mcpServers": {
 *       "tandem": {
 *         "command": "npx",
 *         "args": ["-y", "@jaximus/tandem-mcp"]
 *       }
 *     }
 *   }
 *
 * Defaults to the hosted backend (https://tandemcanvas.com). Set the API_URL
 * env var only to point at a local or self-hosted instance.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Gateway } from "./gateway.js";
import { createTandemServer, VERSION, DEFAULT_API_URL } from "./server.js";

function printHelp() {
  process.stdout.write(
    `@jaximus/tandem-mcp ${VERSION} — MCP server for Tandem.\n` +
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
  process.stdout.write(`@jaximus/tandem-mcp ${VERSION}\n`);
  process.exit(0);
}
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  printHelp();
  process.exit(0);
}

const apiUrlFromEnv = process.env.API_URL;
const API_URL = (apiUrlFromEnv ?? DEFAULT_API_URL).replace(/\/$/, "");
// Public origin for share/claim links. Defaults to the API base, which is
// correct for the common stdio case (API_URL = public domain) and for local
// dev (links point at the same local instance the canvas lives in).
const WEB_URL = (process.env.PUBLIC_URL ?? API_URL).replace(/\/$/, "");

const gateway = new Gateway({ apiUrl: API_URL, webUrl: WEB_URL });

async function main() {
  const server = createTandemServer(gateway, VERSION);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[tandem] Fatal: ${err}\n`);
  process.exit(1);
});
