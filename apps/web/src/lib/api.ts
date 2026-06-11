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
