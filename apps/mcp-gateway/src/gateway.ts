/**
 * Gateway — holds the JWT and proxies all tool calls to the Tandem API.
 * One instance per MCP session (per agent client process).
 *
 * The canvas binding is established at runtime via `canvas_connect`,
 * not from process env. Until that tool is called, all other tools
 * fail with a "not connected" error.
 */

import { recordApiCall } from "./trace.js";

export interface GatewayConfig {
  // Base URL the gateway makes API calls against. For the hosted HTTP sidecar
  // this is the internal docker address (http://tandem:7891).
  apiUrl: string;
  // Public, user-facing base URL used to build shareable canvas / claim links.
  // Distinct from apiUrl because the sidecar talks to the API over the internal
  // network but must hand users the public domain. Defaults to apiUrl.
  webUrl?: string;
  // Optional personal access token (TANDEM_TOKEN). When set, the gateway acts as
  // the user who minted it: forwarded on the auth handshake so the API resolves
  // that user's real role on their private / shared-with-them canvases instead of
  // anonymous. Only used on the stdio path — the multi-tenant HTTP sidecar leaves
  // this unset (it can't hold one user's secret for every client).
  userToken?: string;
  // Per-request timeout in ms for calls made through safeFetch, enforced via
  // AbortController. Configurable via REQUEST_TIMEOUT_MS. Defaults to 15000.
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

export interface CanvasSession {
  token: string;
  canvasId: string;
  canvasName: string;
  canvasCode: string;
  // Private "own this canvas" token, present only for an anonymous canvas this
  // gateway just CREATED (never for one connected-to by code). Surfaced to the
  // user as a claim link so they can take ownership; kept out of the plain share
  // URL. See the API's migration 0020.
  claimToken?: string;
  // Set by the `agent_register` tool; used as `proposedBy` on action.propose so
  // the canvas records which agent authored each action (v1 provenance).
  agentId?: string;
  // Human-readable name given at agent_register; preferred over agentId as the
  // claimant identity on task_start so the board shows WHO holds a claim.
  agentName?: string;
  // Fallback claimant identity for sessions that never called agent_register —
  // see Gateway.claimant(). Minted eagerly at connect/create time so it rides
  // inside the session handle: the hosted HTTP sidecar builds a FRESH Gateway
  // per call, and a lazily-minted id would differ between calls, making the
  // API's claim-ownership guard reject a task_complete for a task this same
  // logical session claimed via task_start (TDM-1).
  claimantId?: string;
}

/**
 * Pure handle codec — the session handle IS the session state on the hosted
 * transport, so everything identity-related (agentId/agentName/claimantId)
 * must round-trip through these two functions.
 */
export function serializeSession(session: CanvasSession): string {
  return Buffer.from(JSON.stringify(session)).toString("base64url");
}

/** Parse a handle produced by serializeSession; throws on garbage. */
export function parseSession(handle: string): CanvasSession {
  let parsed: CanvasSession;
  try {
    parsed = JSON.parse(Buffer.from(handle, "base64url").toString("utf8"));
  } catch {
    throw new Error(
      "Invalid session handle. Re-run `canvas_connect` (or `canvas_create`) to get a fresh one."
    );
  }
  if (!parsed?.token || !parsed?.canvasId) {
    throw new Error(
      "Invalid session handle. Re-run `canvas_connect` (or `canvas_create`) to get a fresh one."
    );
  }
  return parsed;
}

/** Fallback claimant id for sessions that never agent_register. */
export function mintClaimantId(): string {
  return `session-${Math.random().toString(36).slice(2, 8)}`;
}

export class Gateway {
  private config: GatewayConfig;
  private session: CanvasSession | null = null;
  // Per-request user credential for the multi-tenant HTTP sidecar: the OAuth
  // access token from the incoming Authorization header, set by http.ts before
  // each dispatch. Takes precedence over config.userToken (the stdio env token),
  // so one shared gateway process still acts as whichever user made the call.
  private sessionUserToken?: string;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  /**
   * Set (or clear) the per-request user token. Called by the HTTP sidecar with
   * the bearer from the incoming request so connect/create forward it and the
   * API resolves that user. No-op token clears it (anonymous).
   */
  setUserToken(token?: string): void {
    this.sessionUserToken = token && token.trim() ? token.trim() : undefined;
  }

  /**
   * Credential headers for the PRE-JWT calls (auth handshake + create). Carries
   * the personal access token when configured so the API resolves the user's real
   * role; empty otherwise (anonymous → public canvases only). Not used on
   * canvas-scoped calls, which authenticate with the issued canvas JWT.
   */
  private userAuthHeaders(): Record<string, string> {
    // Per-request token (sidecar, from the request) wins over the env token (stdio).
    const token = this.sessionUserToken ?? this.config.userToken;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** Exchange canvas code for JWT. Called by the `canvas_connect` tool. */
  async connectWithCode(code: string): Promise<CanvasSession> {
    const res = await this.safeFetch("/api/mcp/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.userAuthHeaders() },
      body: JSON.stringify({ code }),
    });

    if (!res.ok) {
      const body = await res.text();
      // 403 = the canvas is private/shared and this caller resolved as anonymous
      // (no user credential). Surface an actionable message: on the hosted
      // connector the user needs to authorize their account; on stdio they set
      // TANDEM_TOKEN. Keeps public canvases seamless while pointing the way in.
      if (res.status === 403) {
        throw new Error(
          `This canvas is private or shared, so it needs your account. ` +
            `Authorize Tandem for this connector (or set a TANDEM_TOKEN) and try again. (${body})`
        );
      }
      throw new Error(`Auth failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as {
      token: string;
      canvasId: string;
      canvasName: string;
      canvasCode: string;
    };

    this.session = {
      token: data.token,
      canvasId: data.canvasId,
      canvasName: data.canvasName,
      canvasCode: data.canvasCode,
      // Mint the fallback claimant identity NOW (not lazily in claimant()) so
      // it is baked into every handle this session hands out — a fresh Gateway
      // rebuilt from the handle then presents the same identity on every call.
      claimantId: mintClaimantId(),
    };

    process.stderr.write(
      `[tandem] Connected to canvas "${this.session.canvasName}" (${this.session.canvasCode})\n`
    );

    return this.session;
  }

  /**
   * Create a brand-new canvas and bind this session to it — the zero-setup
   * path. Posts to the public create endpoint, then exchanges the returned
   * code for a JWT via connectWithCode. Lets an agent stand up a canvas with
   * no human needing to make one in the browser first.
   */
  async createCanvas(name: string): Promise<CanvasSession> {
    const res = await this.safeFetch("/api/canvases", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.userAuthHeaders() },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Create canvas failed (${res.status}): ${body}`);
    }
    const canvas = (await res.json()) as { code: string; claimToken?: string };
    if (!canvas?.code) {
      throw new Error("Create canvas returned no code");
    }
    // connectWithCode (via /api/mcp/auth) issues the JWT but doesn't carry the
    // claim token — that's only on the create response — so attach it after.
    const session = await this.connectWithCode(canvas.code);
    session.claimToken = canvas.claimToken;
    return session;
  }

  /** The shareable web URL for a canvas code (public origin, not the API host). */
  canvasUrl(code: string): string {
    return `${this.webUrl()}/c/${code}`;
  }

  /** Public origin for user-facing links; falls back to the API base. */
  private webUrl(): string {
    return (this.config.webUrl ?? this.config.apiUrl).replace(/\/$/, "");
  }

  /**
   * The PRIVATE claim URL: the share URL plus the one-time claim token. Whoever
   * opens this while logged in can take ownership of the canvas. Hand it only to
   * the intended human — never use it as the share link.
   */
  canvasClaimUrl(code: string, claimToken: string): string {
    return `${this.webUrl()}/c/${code}?claim=${encodeURIComponent(claimToken)}`;
  }

  isConnected(): boolean {
    return this.session !== null;
  }

  /**
   * Serialize the active binding into an opaque handle the model can carry and
   * pass back on later calls. The hosted HTTP connector (claude.ai) does not
   * keep one MCP session alive across an idle gap — the in-gateway binding can
   * vanish between calls — so connect/create hand this back and every other
   * tool accepts it, making each call self-sufficient. It's the whole session
   * (JWT included), so adopting it fully restores the binding on a fresh gateway.
   */
  exportSession(): string {
    return serializeSession(this.getSession());
  }

  /** Restore a binding from a handle produced by exportSession. */
  adoptSession(handle: string): void {
    this.session = parseSession(handle);
  }

  /** Remember the registered agent identity on the session (set by agent_register). */
  setAgentId(agentId: string, name?: string): void {
    if (this.session) {
      this.session.agentId = agentId;
      if (name) this.session.agentName = name;
    }
  }

  /**
   * Stable claimant identity for task_start / task_complete. Prefers the
   * agent_register name/id, then the claimantId minted at connect time (and
   * carried inside the session handle, so it survives the hosted sidecar's
   * fresh-Gateway-per-call model). Never returns undefined — an anonymous
   * claimant would be stored as the generic "agent", which is excluded from
   * the API's idempotent-reclaim rule, so a retried task_start after a
   * timed-out response would be told it lost its OWN claim. The lazy mint
   * remains only as a fallback for handles minted by older gateways.
   */
  claimant(): string {
    const s = this.getSession();
    if (s.agentName) return s.agentName;
    if (s.agentId) return s.agentId;
    if (!s.claimantId) {
      s.claimantId = mintClaimantId();
    }
    return s.claimantId;
  }

  getSession(): CanvasSession {
    if (!this.session) {
      throw new Error(
        "Not connected to a canvas. If you already connected this session, pass the `session` " +
          "handle returned by canvas_connect/canvas_create as the `session` argument on this call. " +
          "Otherwise call `canvas_connect` with a canvas code first."
      );
    }
    return this.session;
  }

  private authHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.getSession().token}`,
    };
  }

  /**
   * Wraps fetch so network-level failures (DNS, refused, timeout) surface a
   * clear "API_URL is wrong / unreachable" message instead of the default
   * `TypeError: fetch failed` with no context. Also enforces a request
   * timeout via AbortController and logs latency for every call — this is
   * the single choke point every get/getPublic/post/patch/del goes through.
   *
   * Because it IS the choke point, it is also where MCP_TRACE attributes API
   * time to the enclosing tool call (see trace.ts): every exit path — 2xx,
   * non-2xx, timeout, transport failure — reports its round-trip, so a slow
   * call that failed still shows where the time went. `recordApiCall` is a
   * single boolean check when tracing is off.
   */
  private async safeFetch(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    try {
      const res = await fetch(`${this.config.apiUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      const ms = Date.now() - start;
      recordApiCall(ms);
      process.stderr.write(`[tandem] ${method} ${path} -> ${res.status} (${ms}ms)\n`);
      return res;
    } catch (err) {
      const ms = Date.now() - start;
      recordApiCall(ms);
      if (err instanceof Error && err.name === "AbortError") {
        process.stderr.write(`[tandem] ${method} ${path} -> timeout (${ms}ms)\n`);
        // The abort is CLIENT-side: the API may still be processing the request
        // and a slow-but-successful write often persists after this deadline.
        // A blind retry of a mutating call would then double-write (observed
        // with canvas_map_add_batch: the batch fully landed despite the timeout
        // being reported). So for mutating methods, steer the model to verify
        // before retrying instead of claiming the API "did not respond".
        const mutating = method !== "GET" && method !== "HEAD";
        throw new Error(
          `Request to ${path} timed out after ${timeoutMs}ms waiting for the Tandem API to respond.` +
            (mutating
              ? ` IMPORTANT: this was a ${method} (a write) and the timeout is client-side — the change may still have been APPLIED on the server after the deadline. Do NOT retry it blindly, or you may create duplicates. First re-read the affected state (canvas_state_read, or the matching list/get tool) and check whether the change already landed; retry only what is actually missing.`
              : ` This was a read-only request, so retrying it is safe.`)
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tandem] ${method} ${path} -> error (${ms}ms): ${reason}\n`);
      throw new Error(
        `Could not reach Tandem API at ${this.config.apiUrl} — check the API_URL env var. (${reason})`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Turn a non-2xx response into a thrown error. A 401 means the canvas JWT
   * expired (or was revoked) mid-session — the agent's token is time-limited.
   * The agent has no way to know that from a generic "failed: 401", so we make
   * the message actionable: tell it to re-run `canvas_connect` for a fresh
   * token and retry. The code is on the session, so name it explicitly.
   */
  private async assertOk(method: string, path: string, res: Response): Promise<void> {
    if (res.ok) return;
    const body = await res.text();
    if (res.status === 401) {
      const code = this.session?.canvasCode;
      const reconnect = code
        ? `call \`canvas_connect\` with code "${code}" again`
        : "call `canvas_connect` with your canvas code again";
      throw new Error(
        `Your canvas session token has expired (401). Tokens are time-limited — ` +
          `${reconnect} to get a fresh token, then retry this operation. (${method} ${path})`
      );
    }
    throw new Error(`${method} ${path} failed: ${res.status} ${body}`);
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.safeFetch(path, { headers: this.authHeaders() });
    await this.assertOk("GET", path, res);
    return res.json() as Promise<T>;
  }

  /**
   * GET an endpoint that MAY NOT EXIST on the connected API yet, returning null
   * instead of throwing when it isn't there. Used by the intent facade's
   * `context_get`, which prefers a server-built briefing (TDM-29 / E1.3) but must
   * keep working against an API deployed before that endpoint landed.
   *
   * "Isn't there" is broader than a 404: the API mounts the SPA on `/*`, so an
   * unrouted `/api/...` path is answered with index.html and a 200. So treat
   * anything that isn't a 2xx JSON body as absent, and only surface real errors
   * (401 expiry, 5xx) through assertOk.
   */
  async getIfAvailable<T>(path: string): Promise<T | null> {
    const res = await this.safeFetch(path, { headers: this.authHeaders() });
    if (res.status === 404) return null;
    await this.assertOk("GET", path, res);
    if (!(res.headers.get("content-type") ?? "").includes("json")) return null;
    try {
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  /** GET an endpoint that does not require auth (e.g. /api/maps). */
  async getPublic<T>(path: string): Promise<T> {
    const res = await this.safeFetch(path);
    await this.assertOk("GET", path, res);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.safeFetch(path, {
      method: "POST",
      headers: this.authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    await this.assertOk("POST", path, res);
    return res.json() as Promise<T>;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await this.safeFetch(path, {
      method: "PATCH",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    await this.assertOk("PATCH", path, res);
    return res.json() as Promise<T>;
  }

  /**
   * PATCH that surfaces an HTTP 409 as structured data instead of throwing.
   * task_start uses it: losing an atomic task claim is an EXPECTED outcome the
   * model should route on ("pick the next task"), not an error string.
   */
  async patchWithConflict<T, C>(
    path: string,
    body: unknown
  ): Promise<{ data?: T; conflict?: C }> {
    const res = await this.safeFetch(path, {
      method: "PATCH",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (res.status === 409) return { conflict: (await res.json()) as C };
    await this.assertOk("PATCH", path, res);
    return { data: (await res.json()) as T };
  }

  async del<T>(path: string): Promise<T> {
    const res = await this.safeFetch(path, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    await this.assertOk("DELETE", path, res);
    return res.json() as Promise<T>;
  }
}
