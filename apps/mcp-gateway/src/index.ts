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
      `  tandem-mcp --full-tools    Also advertise the full CRUD tool surface\n` +
      `                             (maps, sheets, charts, forms, …) alongside\n` +
      `                             the default 10-tool intent facade.\n` +
      `  tandem-mcp --version, -v   Print version and exit.\n` +
      `  tandem-mcp --help, -h      Show this help.\n` +
      `\n` +
      `Environment:\n` +
      `  API_URL                    Tandem API base URL.\n` +
      `                             Default: ${DEFAULT_API_URL}\n` +
      `  TANDEM_FULL_TOOLS          Set to 1 for the same effect as --full-tools.\n` +
      `  TANDEM_TOKEN               Personal access token — lets Claude act as you\n` +
      `                             on your private / shared canvases. Mint one at\n` +
      `                             ${DEFAULT_API_URL}/me. Optional; without it the\n` +
      `                             gateway can only reach public canvases.\n` +
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
// Opt in to the full CRUD surface on top of the default intent facade. The flag
// is an explicit override; without it, TANDEM_FULL_TOOLS decides (see server.ts).
const FULL_TOOLS = cliArgs.includes("--full-tools") ? true : undefined;

const apiUrlFromEnv = process.env.API_URL;
const API_URL = (apiUrlFromEnv ?? DEFAULT_API_URL).replace(/\/$/, "");
// Public origin for share/claim links. Defaults to the API base, which is
// correct for the common stdio case (API_URL = public domain) and for local
// dev (links point at the same local instance the canvas lives in).
const WEB_URL = (process.env.PUBLIC_URL ?? API_URL).replace(/\/$/, "");
// Optional personal access token. Set it to let Claude act as you on your
// private / shared canvases — mint one at https://tandemcanvas.com/me. Without
// it the gateway is anonymous and can only reach public canvases.
const USER_TOKEN = process.env.TANDEM_TOKEN?.trim() || undefined;
// Optional per-request timeout override (ms) for calls to the Tandem API.
// Defaults to 15000 in the Gateway when unset or unparsable.
const requestTimeoutFromEnv = Number(process.env.REQUEST_TIMEOUT_MS);
const REQUEST_TIMEOUT_MS =
  Number.isFinite(requestTimeoutFromEnv) && requestTimeoutFromEnv > 0
    ? requestTimeoutFromEnv
    : undefined;

const gateway = new Gateway({
  apiUrl: API_URL,
  webUrl: WEB_URL,
  userToken: USER_TOKEN,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
});

async function main() {
  const server = createTandemServer(gateway, VERSION, { fullTools: FULL_TOOLS });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[tandem] Fatal: ${err}\n`);
  process.exit(1);
});
