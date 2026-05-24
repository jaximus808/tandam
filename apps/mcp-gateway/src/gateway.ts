/**
 * Gateway — holds the JWT and proxies all tool calls to the Go API.
 * One instance per MCP session (per Claude Code process).
 *
 * The canvas binding is established at runtime via `canvas.connect`,
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
}

export class Gateway {
  private config: GatewayConfig;
  private session: CanvasSession | null = null;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  /** Exchange canvas code for JWT. Called by the `canvas.connect` tool. */
  async connectWithCode(code: string): Promise<CanvasSession> {
    const res = await fetch(`${this.config.apiUrl}/api/mcp/auth`, {
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
      `[agentcanvas] Connected to canvas "${this.session.canvasName}" (${this.session.canvasCode})\n`
    );

    return this.session;
  }

  isConnected(): boolean {
    return this.session !== null;
  }

  getSession(): CanvasSession {
    if (!this.session) {
      throw new Error(
        "Not connected to a canvas. Call the `canvas.connect` tool with a canvas code first."
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

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      method: "POST",
      headers: this.authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      method: "PATCH",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async del<T>(path: string): Promise<T> {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }
}
