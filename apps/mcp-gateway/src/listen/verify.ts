/**
 * Tandem webhook signature verification — the receiver half of
 * `apps/api/internal/webhooks/sign.go`.
 *
 * WIRE CONTRACT (copied from sign.go; if the two ever disagree, sign.go wins):
 *
 *   Tandem-Signature    lowercase hex HMAC-SHA256, bare — no `t=`/`v1=` prefix,
 *                       no comma syntax. (Migration 0038's comments describe a
 *                       Stripe-style single header; the SHIPPED scheme splits
 *                       signature and timestamp into two headers.)
 *   Tandem-Timestamp    unix SECONDS the attempt was signed. Part of the signed
 *                       string, so it can't be slid forward in transit.
 *   Tandem-Delivery-Id  delivery row id, STABLE ACROSS RETRIES → the dedupe key.
 *   Tandem-Event        "task.approved" | "task.completed" | "task.claim_expired"
 *
 * Signed string is `<unix_seconds> "." <raw request body>` over the EXACT bytes
 * on the wire. Never re-serialize the parsed JSON before hashing: key order is
 * not preserved and the digest would differ from what the sender computed.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Header names, verbatim from sign.go. Compared case-insensitively (node
 *  lowercases incoming header keys). */
export const HEADER_SIGNATURE = "tandem-signature";
export const HEADER_TIMESTAMP = "tandem-timestamp";
export const HEADER_DELIVERY_ID = "tandem-delivery-id";
export const HEADER_EVENT = "tandem-event";

/** Clock skew a receiver tolerates between Tandem-Timestamp and its own clock.
 *  Mirrors webhooks.ReplayWindow (60s). */
export const REPLAY_WINDOW_SEC = 60;

/** Prefix every Tandem webhook secret carries (store.WebhookSecretPrefix). */
export const SECRET_PREFIX = "whsec_";

export interface VerifyInput {
  /** Shared secret, `whsec_…`. Signed as raw UTF-8 bytes, prefix included. */
  secret: string;
  /** Raw `Tandem-Signature` header value. */
  signature: string | undefined;
  /** Raw `Tandem-Timestamp` header value (unix seconds, as a string). */
  timestamp: string | undefined;
  /** The exact request bytes. A string is treated as UTF-8. */
  body: Buffer | string;
  /** Receiver clock, ms since epoch. */
  nowMs: number;
  /** Replay window in seconds. Defaults to REPLAY_WINDOW_SEC (60). */
  windowSec?: number;
}

export type VerifyResult =
  | { ok: true }
  /** `status` is what the HTTP shell should reply with: 400 for a malformed or
   *  stale timestamp (the sign.go recipe's step 1), 401 for a signature that
   *  is missing or doesn't match (step 3). */
  | { ok: false; status: 400 | 401; reason: string };

/** The exact byte sequence that is HMAC'd: `<ts>.<body>`. */
export function signingString(ts: number, body: Buffer | string): Buffer {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return Buffer.concat([Buffer.from(`${ts}.`, "utf8"), raw]);
}

/** Lowercase hex HMAC-SHA256 of the signing string — the header value a sender
 *  writes, and what a receiver recomputes. */
export function sign(secret: string, ts: number, body: Buffer | string): string {
  return createHmac("sha256", secret).update(signingString(ts, body)).digest("hex");
}

/**
 * Verify one delivery: replay window first (cheap, and a stale attempt is a
 * different failure from a forged one), then a TIMING-SAFE digest compare.
 *
 * Never compares hex strings with `===` — response timing would leak how many
 * leading bytes of a guess were right.
 */
export function verifySignature(input: VerifyInput): VerifyResult {
  const window = input.windowSec ?? REPLAY_WINDOW_SEC;

  if (!input.timestamp) {
    return { ok: false, status: 400, reason: "missing Tandem-Timestamp" };
  }
  // Unix seconds, integral. `Number()` on "" is 0, hence the explicit guard above.
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) {
    return { ok: false, status: 400, reason: "malformed Tandem-Timestamp" };
  }
  const skew = Math.abs(Math.floor(input.nowMs / 1000) - ts);
  if (skew > window) {
    return { ok: false, status: 400, reason: `timestamp outside ${window}s replay window (skew ${skew}s)` };
  }

  const got = (input.signature ?? "").trim();
  if (!got) {
    return { ok: false, status: 401, reason: "missing Tandem-Signature" };
  }
  // Reject non-hex up front: Buffer.from(…, "hex") silently truncates at the
  // first invalid pair, which would turn "deadbeefZZ…" into a short buffer that
  // could accidentally match a prefix-length digest.
  if (!/^[0-9a-fA-F]+$/.test(got) || got.length % 2 !== 0) {
    return { ok: false, status: 401, reason: "malformed Tandem-Signature" };
  }

  const want = Buffer.from(sign(input.secret, ts, input.body), "hex");
  const have = Buffer.from(got.toLowerCase(), "hex");
  // timingSafeEqual throws on length mismatch, so the length check has to be
  // explicit. Digest length is public (always 32 bytes), so leaking it is fine.
  if (want.length !== have.length || !timingSafeEqual(want, have)) {
    return { ok: false, status: 401, reason: "signature mismatch" };
  }
  return { ok: true };
}
