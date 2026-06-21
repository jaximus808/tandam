/**
 * Tandem MCP — hosted HTTP sidecar.
 *
 * Same tool surface as the stdio CLI (see index.ts), but exposed over the MCP
 * Streamable HTTP transport so zero-install clients (the Claude.ai "custom
 * connector", desktop, web) can connect by URL instead of spawning a process.
 *
 * Deployment: runs as its own container on the same VM as the Go API, behind
 * Caddy. It proxies tool calls to the Go API over the internal docker network
 * (API_URL=http://tandem:7891) — NOT back out through the public domain.
 *
 * Multi-tenancy: one process serves every client, so each MCP session gets its
 * own Gateway (its own canvas binding / JWT), keyed by the transport's
 * mcp-session-id. The canvas binding is still established at runtime via the
 * `canvas_connect` tool — there is no shared/global canvas.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Gateway } from "./gateway.js";
import { createTandemServer, VERSION, DEFAULT_API_URL, DEFAULT_WEB_URL } from "./server.js";

const API_URL = (process.env.API_URL ?? DEFAULT_API_URL).replace(/\/$/, "");
// User-facing share/claim links must use the public domain, NOT the internal
// API_URL (http://tandem:7891) this sidecar talks to over the docker network.
const WEB_URL = (process.env.PUBLIC_URL ?? DEFAULT_WEB_URL).replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 8970);
// The single MCP endpoint path. Must match the Caddy route and the URL users
// paste into their MCP client (https://tandemcanvas.com/api/mcp).
const MCP_PATH = process.env.MCP_PATH ?? "/api/mcp";

interface Session {
  transport: StreamableHTTPServerTransport;
  createdAt: number;
}

// sessionId -> live session. In-memory: a restart drops bindings and clients
// transparently re-initialize (and re-`canvas_connect`). Fine for beta.
const sessions = new Map<string, Session>();

/** Read and JSON-parse a request body. Returns undefined for an empty body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/** JSON-RPC error envelope for the cases we reject before reaching a transport. */
function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers["mcp-session-id"];
  const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

  // GET (open SSE stream) and DELETE (terminate) must reference an existing
  // session; they carry no body to inspect.
  if (req.method === "GET" || req.method === "DELETE") {
    const existing = sid ? sessions.get(sid) : undefined;
    if (!existing) {
      rpcError(res, 400, "Unknown or missing mcp-session-id");
      return;
    }
    await existing.transport.handleRequest(req, res);
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
    return;
  }

  const body = await readJsonBody(req);

  // Existing session: route to its transport.
  if (sid) {
    const existing = sessions.get(sid);
    if (!existing) {
      rpcError(res, 404, "Session not found — re-initialize");
      return;
    }
    await existing.transport.handleRequest(req, res, body);
    return;
  }

  // No session id: only an `initialize` request may open a new one.
  if (!isInitializeRequest(body)) {
    rpcError(res, 400, "No mcp-session-id and not an initialize request");
    return;
  }

  // Fresh session: its own Gateway (canvas binding lives here) + Server.
  const gateway = new Gateway({ apiUrl: API_URL, webUrl: WEB_URL });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newId) => {
      sessions.set(newId, { transport, createdAt: Date.now() });
    },
  });

  // Drop the session from the map when the client disconnects / terminates.
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) sessions.delete(id);
  };

  const server = createTandemServer(gateway, VERSION);
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Lightweight liveness probe for the container healthcheck.
  if (url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true, sessions: sessions.size, apiUrl: API_URL });
    return;
  }

  if (url.pathname === MCP_PATH) {
    handleMcp(req, res).catch((err) => {
      process.stderr.write(`[tandem-http] request error: ${err}\n`);
      if (!res.headersSent) rpcError(res, 500, "Internal error");
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
});

httpServer.listen(PORT, () => {
  process.stderr.write(
    `[tandem-http] MCP Streamable HTTP listening on :${PORT}${MCP_PATH} → API ${API_URL}\n`
  );
});
