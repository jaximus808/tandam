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
  // The session's Gateway, kept so we can push the per-request user token (the
  // OAuth bearer) onto it before each dispatch — this is how the multi-tenant
  // sidecar acts as whichever user made the call.
  gateway: Gateway;
  createdAt: number;
}

// When true, the sidecar challenges unauthenticated connections with a 401 +
// WWW-Authenticate so claude.ai runs the OAuth flow up front (connector-level
// auth). Default OFF: anonymous access to public canvases stays seamless, and
// OAuth is entered only when the user chooses to (step-up). Kept as a switch so
// the full OAuth handshake can be exercised end-to-end while we confirm how the
// hosted connector triggers auth. See the MCP-OAuth design note.
const REQUIRE_AUTH = process.env.MCP_REQUIRE_AUTH === "1";

/** The bearer token on an incoming request, if any. */
function bearerFrom(req: IncomingMessage): string | undefined {
  const header = req.headers["authorization"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith("Bearer ")) return undefined;
  const token = value.slice("Bearer ".length).trim();
  return token || undefined;
}

/**
 * Emit the RFC 9728 challenge that points a client at our protected-resource
 * metadata, kicking off OAuth discovery. resource_metadata lives on the Go API
 * at <PUBLIC_URL>/.well-known/oauth-protected-resource.
 */
function respondUnauthorized(res: ServerResponse, id: unknown = null): void {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer resource_metadata="${WEB_URL}/.well-known/oauth-protected-resource"`
  );
  rpcError(res, 401, "Authorization required", id);
}

/**
 * Pull a `tools/call` out of a request body: the tool name and its arguments.
 * Returns undefined for anything that isn't a tool call. Used for lazy step-up,
 * where we peek at `canvas_connect` before dispatching it to the transport.
 */
function toolCall(
  body: unknown
): { name: string; args: Record<string, unknown> } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (b.method !== "tools/call") return undefined;
  const name = typeof b.params?.name === "string" ? b.params.name : undefined;
  if (!name) return undefined;
  const args =
    b.params?.arguments && typeof b.params.arguments === "object"
      ? (b.params.arguments as Record<string, unknown>)
      : {};
  return { name, args };
}

/**
 * Lazy step-up probe: does connecting to `code` require the user's account?
 * Posts to the API's canvas-code exchange WITHOUT any credential — a 403 means
 * the canvas is private/shared and resolved as anonymous, i.e. OAuth is needed.
 * A public canvas returns 200 (the throwaway JWT is discarded; the real
 * canvas_connect call re-mints one). Any error/other status → treat as "no
 * challenge" so the actual tool call runs and surfaces the true error.
 */
async function canvasRequiresAuth(code: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/mcp/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    return res.status === 403;
  } catch {
    return false;
  }
}

// sessionId -> live session. In-memory: a restart drops bindings and clients
// transparently re-initialize (and re-`canvas_connect`). Fine for beta.
const sessions = new Map<string, Session>();

// Request tracing for the "not connected between calls" bug: when on, logs one
// line per /api/mcp request with the mcp-session-id, the JSON-RPC method/tool,
// and whether that session id hit the in-memory Map. This makes it visible
// whether claude.ai reuses the canvas_connect session for later tool calls
// (same sid, hit=yes) or lands them on a fresh/other session (sid changes or
// hit=no) — the latter is why writes come back "not connected". On by default
// while we chase it; set MCP_TRACE=0 to silence.
const TRACE = process.env.MCP_TRACE !== "0";

/** Pull the JSON-RPC method and (for tools/call) the tool name out of a body. */
function describeRpc(body: unknown): string {
  if (!body || typeof body !== "object") return "-";
  const b = body as { method?: unknown; params?: { name?: unknown } };
  const method = typeof b.method === "string" ? b.method : "?";
  const tool = typeof b.params?.name === "string" ? b.params.name : undefined;
  return tool ? `${method}(${tool})` : method;
}

function trace(
  method: string | undefined,
  sid: string | undefined,
  rpc: string,
  note: string
): void {
  if (!TRACE) return;
  process.stderr.write(
    `[tandem-http] ${method ?? "?"} sid=${sid ?? "-"} rpc=${rpc} ${note} sessions=${sessions.size}\n`
  );
}

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
function rpcError(res: ServerResponse, status: number, message: string, id: unknown = null): void {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: id ?? null,
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers["mcp-session-id"];
  const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

  // GET (open SSE stream) and DELETE (terminate) must reference an existing
  // session; they carry no body to inspect.
  if (req.method === "GET" || req.method === "DELETE") {
    const existing = sid ? sessions.get(sid) : undefined;
    trace(req.method, sid, "-", existing ? "hit" : "MISS");
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
  const rpc = describeRpc(body);

  // Existing session: route to its transport, carrying the caller's user token
  // (OAuth bearer) so tool calls resolve as that user.
  if (sid) {
    const existing = sessions.get(sid);
    trace("POST", sid, rpc, existing ? "hit" : "MISS→404");
    if (!existing) {
      rpcError(res, 404, "Session not found — re-initialize");
      return;
    }
    const bearer = bearerFrom(req);
    // Lazy step-up: an unauthenticated `canvas_connect` to a private/shared
    // canvas returns a 401 + WWW-Authenticate challenge so the hosted connector
    // runs OAuth, instead of surfacing an in-band "this canvas is private" error
    // the client can't act on. Public canvases (and already-authenticated calls)
    // fall straight through — anonymous public access stays seamless.
    if (!bearer) {
      const call = toolCall(body);
      const code = typeof call?.args.code === "string" ? call.args.code.trim() : "";
      if (call?.name === "canvas_connect" && code && (await canvasRequiresAuth(code))) {
        trace("POST", sid, rpc, "private-canvas, no-auth→401-challenge");
        const id = (body as { id?: unknown })?.id ?? null;
        respondUnauthorized(res, id);
        return;
      }
    }
    existing.gateway.setUserToken(bearer);
    await existing.transport.handleRequest(req, res, body);
    return;
  }

  // No session id: only an `initialize` request may open a new one.
  if (!isInitializeRequest(body)) {
    trace("POST", sid, rpc, "no-sid, not-initialize→400");
    rpcError(res, 400, "No mcp-session-id and not an initialize request");
    return;
  }

  // Optional connector-level auth: challenge an unauthenticated new connection so
  // the client runs OAuth. Off by default — anonymous public access stays seamless.
  if (REQUIRE_AUTH && !bearerFrom(req)) {
    trace("POST", sid, rpc, "initialize, no-auth→401-challenge");
    respondUnauthorized(res);
    return;
  }

  trace("POST", sid, rpc, "new-session");

  // Fresh session: its own Gateway (canvas binding lives here) + Server.
  const gateway = new Gateway({ apiUrl: API_URL, webUrl: WEB_URL });
  gateway.setUserToken(bearerFrom(req));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newId) => {
      sessions.set(newId, { transport, gateway, createdAt: Date.now() });
      trace("POST", newId, "initialize", "session-created");
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
