/**
 * Gateway — holds the JWT and proxies all tool calls to the Tandem API.
 * One instance per MCP session (per agent client process).
 *
 * The canvas binding is established at runtime via `canvas_connect`,
 * not from process env. Until that tool is called, all other tools
 * fail with a "not connected" error.
 */

export interface GatewayConfig {
  apiUrl: string;
}

export interface CanvasSession {
  token: string;
  canvasId: string;
  canvasName: string;
  canvasCode: string;
  // Set by the `agent_register` tool; used as `proposedBy` on action.propose so
  // the canvas records which agent authored each action (v1 provenance).
  agentId?: string;
  // One-time secret returned only when WE created the canvas (canvas_create).
  // Lets the user claim ownership of this exact canvas; never available for a
  // canvas joined via canvas_connect (we never hold its token).
  claimToken?: string;
}

export class Gateway {
  private config: GatewayConfig;
  private session: CanvasSession | null = null;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  /** Exchange canvas code for JWT. Called by the `canvas_connect` tool. */
  async connectWithCode(code: string): Promise<CanvasSession> {
    const res = await this.safeFetch("/api/mcp/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (!res.ok) {
      const body = await res.text();
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
      headers: { "Content-Type": "application/json" },
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
    const session = await this.connectWithCode(canvas.code);
    // The claim token is returned only on create; stash it on the session so the
    // canvas_create tool can hand the user a claim link.
    session.claimToken = canvas.claimToken;
    return session;
  }

  /** The shareable web URL for a canvas code (same origin as the API). */
  canvasUrl(code: string): string {
    return `${this.config.apiUrl}/c/${code}`;
  }

  /**
   * The private claim URL for a freshly-created canvas — the view URL plus the
   * one-time claim token. Whoever opens this (and signs in) becomes the owner of
   * this exact canvas. Distinct from canvasUrl, which is safe to share for
   * viewing without granting ownership.
   */
  claimUrl(code: string, claimToken: string): string {
    return `${this.canvasUrl(code)}?claim=${encodeURIComponent(claimToken)}`;
  }

  isConnected(): boolean {
    return this.session !== null;
  }

  /** Remember the registered agent id on the session (set by agent_register). */
  setAgentId(agentId: string): void {
    if (this.session) this.session.agentId = agentId;
  }

  getSession(): CanvasSession {
    if (!this.session) {
      throw new Error(
        "Not connected to a canvas. Call the `canvas_connect` tool with a canvas code first."
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
   * `TypeError: fetch failed` with no context.
   */
  private async safeFetch(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.config.apiUrl}${path}`, init);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not reach Tandem API at ${this.config.apiUrl} — check the API_URL env var. (${reason})`
      );
    }
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.safeFetch(path, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  /** GET an endpoint that does not require auth (e.g. /api/maps). */
  async getPublic<T>(path: string): Promise<T> {
    const res = await this.safeFetch(path);
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.safeFetch(path, {
      method: "POST",
      headers: this.authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await this.safeFetch(path, {
      method: "PATCH",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async del<T>(path: string): Promise<T> {
    const res = await this.safeFetch(path, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }
}
