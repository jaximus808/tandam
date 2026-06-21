import type { CanvasMeta } from "../types";

// Image upload is disabled for v1 (no durable-storage story yet). Reading
// stays available so any imageRefs left from dev still render via the
// `/canvas-images/*` route.
export function imageUrl(canvasId: string, filename: string): string {
  return `/canvas-images/${canvasId}/${filename}`;
}

// The signed-in user's owned canvases (newest-edited first). Needs the session
// cookie — 401 if not signed in.
export async function listMyCanvases(): Promise<CanvasMeta[]> {
  const res = await fetch("/api/me/canvases", { credentials: "same-origin" });
  if (!res.ok) throw new Error("Failed to load your canvases");
  return (await res.json()) as CanvasMeta[];
}

// ── Form submit (direct-input layer) ─────────────────────────────────────────
// Submitting a form is an HTTP POST that needs a canvas JWT. We obtain one with
// the same code→JWT exchange the MCP gateway uses (no Google login needed) and
// cache it per canvas code for the session. The backend broadcasts the resulting
// state over WS, so the board updates itself — we just need the call to land.
const tokenCache = new Map<string, string>();

async function canvasToken(code: string): Promise<string> {
  const cached = tokenCache.get(code);
  if (cached) return cached;
  const res = await fetch("/api/mcp/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error("Could not authenticate to this canvas");
  const { token } = (await res.json()) as { token: string };
  tokenCache.set(code, token);
  return token;
}

export async function submitForm(
  code: string,
  formId: string,
  values: Record<string, unknown>,
  submissionId?: string,
): Promise<void> {
  const doPost = async (token: string) =>
    fetch(`/api/canvas/forms/${formId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ values, submissionId }),
    });

  let res = await doPost(await canvasToken(code));
  // A cached token can go stale (expiry); refresh once on 401.
  if (res.status === 401) {
    tokenCache.delete(code);
    res = await doPost(await canvasToken(code));
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let msg = detail;
    try {
      msg = (JSON.parse(detail) as { error?: string }).error ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(msg || "Submit failed");
  }
}

// Take ownership of an unowned (agent-created) canvas using its private claim
// token. Unlike copyCanvas this transfers THE canvas itself — the same one the
// agent keeps editing — and the API voids the token on success (single-use).
// Needs the session cookie (must be signed in).
export async function claimCanvas(code: string, claimToken: string): Promise<CanvasMeta> {
  const res = await fetch(`/api/canvases/${code}/claim`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claimToken }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let msg = detail;
    try {
      msg = (JSON.parse(detail) as { error?: string }).error ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(msg || "Claim failed");
  }
  return (await res.json()) as CanvasMeta;
}

// Deep-copy a canvas into the signed-in user's account; returns the new canvas.
export async function copyCanvas(code: string): Promise<CanvasMeta> {
  const res = await fetch(`/api/canvases/${code}/copy`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || "Copy failed");
  }
  return (await res.json()) as CanvasMeta;
}
