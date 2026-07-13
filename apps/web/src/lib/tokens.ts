// Personal access tokens — user-scoped MCP credentials. A token lets Claude (or
// any MCP client) act as you on your private / shared canvases: mint one here,
// set it as the TANDEM_TOKEN env var in your MCP client config. The plaintext is
// returned only once, from createToken; the list endpoint returns metadata only.

export interface AccessToken {
  id: string;
  name: string;
  lastFour: string;
  createdAt: string;
  lastUsedAt?: string;
}

// The mint response — same metadata plus the one-time plaintext secret.
export interface MintedToken extends AccessToken {
  token: string;
}

export async function listTokens(): Promise<AccessToken[]> {
  const res = await fetch("/api/me/tokens", { credentials: "same-origin" });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || "Failed to load tokens");
  }
  return (await res.json()) as AccessToken[];
}

export async function createToken(name: string): Promise<MintedToken> {
  const res = await fetch("/api/me/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || "Failed to create token");
  }
  return (await res.json()) as MintedToken;
}

export async function revokeToken(id: string): Promise<void> {
  const res = await fetch(`/api/me/tokens/${id}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || "Failed to revoke token");
  }
}
