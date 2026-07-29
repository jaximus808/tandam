/**
 * The Tandem webhook body, as seen by a receiver.
 *
 * Shape is `taskEvent` in `apps/api/internal/api/task_events.go` — the envelope
 * is snake_case (wire vocabulary), `task` mirrors the canvas API's camelCase
 * action shape:
 *
 *   {
 *     "event_id":  "8f0a…",
 *     "type":      "task.approved",
 *     "timestamp": "2026-07-29T09:41:02.114Z",
 *     "canvas_id": "3c11…",
 *     "task": { "id": "…", "ticketId": "TDM-56", "title": "…", "state": "approved",
 *               "epicId": "…", "assignee": "…", "claimedBy": "…",
 *               "result": "…", "error": "…" },
 *     "expired_claim": { "claimed_by": "…", "claimed_at": "…" }   // claim_expired only
 *   }
 *
 * NOTE: the payload carries `canvas_id` (a UUID), NOT the human canvas CODE that
 * `canvas_connect` takes. `canvas_code` is read opportunistically in case the API
 * grows it; otherwise the listener falls back to the ambient TANDEM_CANVAS_CODE
 * (the var `tandem-mcp init` writes into `.mcp.json`). See `canvasCodeOf`.
 */

export interface TandemWebhookTask {
  id?: string;
  ticketId?: string;
  title?: string;
  state?: string;
  epicId?: string;
  assignee?: string;
  claimedBy?: string;
  result?: string;
  error?: string;
}

export interface TandemWebhookBody {
  event_id?: string;
  type?: string;
  timestamp?: string;
  canvas_id?: string;
  /** Not currently sent by the API; read if it ever appears. */
  canvas_code?: string;
  task?: TandemWebhookTask;
  expired_claim?: { claimed_by?: string; claimed_at?: string };
}

/** Parse the raw body. A body that isn't a JSON object yields `null` — the
 *  delivery is still acked (the sender did nothing wrong), just not acted on. */
export function parseWebhookBody(raw: Buffer | string): TandemWebhookBody | null {
  try {
    const v = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as TandemWebhookBody) : null;
  } catch {
    return null;
  }
}

/** Event type: the header is authoritative (it's what the sender routes on),
 *  the body's `type` is the fallback. */
export function eventTypeOf(header: string | undefined, body: TandemWebhookBody | null): string {
  return (header ?? "").trim() || (body?.type ?? "").trim();
}

/** Ticket id ("TDM-56") if the event has one. Absent on tasks with no ticket. */
export function ticketOf(body: TandemWebhookBody | null): string | undefined {
  const t = body?.task?.ticketId;
  return typeof t === "string" && t.trim() ? t.trim() : undefined;
}

/**
 * Canvas CODE for the exec'd command. The payload has no code today, so this is
 * `canvas_code` if present, else the listener's own TANDEM_CANVAS_CODE (which
 * `tandem-mcp init` puts in `.mcp.json` and which the operator running `listen`
 * for one project will have set anyway), else "".
 */
export function canvasCodeOf(
  body: TandemWebhookBody | null,
  fallback: string | undefined
): string {
  const fromBody = body?.canvas_code;
  if (typeof fromBody === "string" && fromBody.trim()) return fromBody.trim();
  return (fallback ?? "").trim();
}

/** Canvas UUID from the payload, exported alongside the code so the identity in
 *  the event is never thrown away. */
export function canvasIdOf(body: TandemWebhookBody | null): string {
  const id = body?.canvas_id;
  return typeof id === "string" ? id.trim() : "";
}
