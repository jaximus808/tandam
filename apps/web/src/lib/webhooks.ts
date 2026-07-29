// Outbound webhooks — per-canvas endpoints that receive task-queue events, and
// the delivery log behind them (TDM-39).
//
// Every call here is OWNER-ONLY and SESSION-ONLY. `credentials: "same-origin"`
// sends the login cookie, which is the whole point: the API deliberately refuses
// bearer tokens on these routes, so nothing holding a canvas JWT, a personal
// access token, or an OAuth token can reach them — only the signed-in owner in a
// browser. A webhook names an endpoint and carries a signing secret, so an agent
// able to create one could redirect the board's whole task stream to a server it
// controls. There is no MCP tool for any of this, by design.
//
// These types live here rather than in internal/shared for the same reason: the
// MCP gateway will never need them.

export type WebhookEvent = "task.approved" | "task.completed" | "task.claim_expired";

export interface Webhook {
  id: string;
  canvasId: string;
  url: string;
  /** Trailing 4 chars of the signing secret — the only part any read exposes. */
  secretLastFour?: string;
  events: string[];
  enabled: boolean;
  name: string;
  description: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** The create/rotate response: the config plus the plaintext secret, which is
 *  returned exactly once and is unrecoverable afterwards. */
export interface MintedWebhook extends Webhook {
  secret: string;
}

export interface WebhookListResponse {
  webhooks: Webhook[];
  /** Served by the API so a new event type doesn't need a web release. */
  knownEvents: string[];
  maxWebhooks: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  canvasId: string;
  eventId: string;
  eventType: string;
  status: "pending" | "delivering" | "ok" | "failed" | "dead";
  attemptCount: number;
  lastAttemptAt?: string;
  nextAttemptAt: string;
  responseStatus?: number;
  responseBody?: string;
  error?: string;
  createdAt: string;
}

export interface WebhookInput {
  url: string;
  name?: string;
  description?: string;
  events?: string[];
  enabled?: boolean;
}

/** Human-facing labels for the three event types. The chip itself always shows
 *  the wire value — this is the sentence under it. */
export const EVENT_LABELS: Record<string, string> = {
  "task.approved": "A task is approved and ready to work",
  "task.completed": "A task finishes, with its result",
  "task.claim_expired": "An agent's claim goes stale and is released",
};

// Mirrors apiError in lib/api.ts: the API answers with { "error": "…" }, so a
// raw body would surface JSON to the user.
async function webhookError(res: Response, fallback: string): Promise<Error> {
  const detail = await res.text().catch(() => "");
  let msg = detail;
  try {
    msg = (JSON.parse(detail) as { error?: string }).error ?? detail;
  } catch {
    /* not json — use the raw text */
  }
  return new Error(msg || fallback);
}

const base = (code: string) => `/api/canvases/${encodeURIComponent(code)}/webhooks`;

export async function listWebhooks(code: string): Promise<WebhookListResponse> {
  const res = await fetch(base(code), { credentials: "same-origin" });
  if (!res.ok) throw await webhookError(res, "Could not load webhooks");
  return (await res.json()) as WebhookListResponse;
}

export async function createWebhook(code: string, input: WebhookInput): Promise<MintedWebhook> {
  const res = await fetch(base(code), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await webhookError(res, "Could not add the endpoint");
  return (await res.json()) as MintedWebhook;
}

export async function updateWebhook(
  code: string,
  id: string,
  patch: Partial<WebhookInput>,
): Promise<Webhook> {
  const res = await fetch(`${base(code)}/${id}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await webhookError(res, "Could not save the endpoint");
  return (await res.json()) as Webhook;
}

/** Mints a new signing secret. The old one stops working the moment this
 *  returns, and the new one is shown once. */
export async function rotateWebhookSecret(code: string, id: string): Promise<MintedWebhook> {
  const res = await fetch(`${base(code)}/${id}/rotate`, {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) throw await webhookError(res, "Could not rotate the secret");
  return (await res.json()) as MintedWebhook;
}

export async function deleteWebhook(code: string, id: string): Promise<void> {
  const res = await fetch(`${base(code)}/${id}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok) throw await webhookError(res, "Could not delete the endpoint");
}

export async function listWebhookDeliveries(
  code: string,
  opts: { status?: string; webhookId?: string; limit?: number } = {},
): Promise<WebhookDelivery[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.webhookId) params.set("webhookId", opts.webhookId);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await fetch(`${base(code)}/deliveries${qs ? `?${qs}` : ""}`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw await webhookError(res, "Could not load deliveries");
  return ((await res.json()) as { deliveries: WebhookDelivery[] }).deliveries ?? [];
}

/** Puts a failed or dead delivery back on the queue. It keeps its delivery id,
 *  so a receiver that already applied it can still dedupe. */
export async function retryWebhookDelivery(
  code: string,
  deliveryId: string,
): Promise<WebhookDelivery> {
  const res = await fetch(`${base(code)}/deliveries/${deliveryId}/retry`, {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) throw await webhookError(res, "Could not retry the delivery");
  return ((await res.json()) as { delivery: WebhookDelivery }).delivery;
}
