// Reading the content-mutation audit trail (TDM-41).
//
// The approval gate binds to CONTENT, not to a row id: editing an approved (or
// executing) task's title or body sends it back to 'proposed' and releases its
// claim. The state chip shows that automatically — the card moves columns. What
// the chip CAN'T say is that this proposed task is not new: it was approved
// once, someone rewrote it, and the approval was withdrawn. That's the
// difference between "read this and decide" and "read this AGAIN, because it
// changed under you", and it's the whole reason to surface the trail.
//
// The API stamps every entry from the request's auth context, re-attaches its
// own copy on each write, and caps the log at 20. So this module only reads.

import type { ContentAuditEntry, EpicPayload, TaskPayload } from "../types";
import { parseAuthoredBy } from "./provenance";

/**
 * The most recent edit that cost an approval, or null when there isn't one.
 *
 * Ordinary edits (to a task still in triage) are recorded too and deliberately
 * ignored here — surfacing "someone fixed a typo before approval" as a warning
 * would train people to dismiss the notice that matters.
 */
export function lastReapprovalEdit(
  payload: TaskPayload | EpicPayload | undefined,
): ContentAuditEntry | null {
  const trail = payload?.audit;
  if (!Array.isArray(trail)) return null;
  for (let i = trail.length - 1; i >= 0; i--) {
    const e = trail[i];
    if (e?.reverted) return e;
  }
  return null;
}

/** "title", "body", or "title and body" — what a person would say out loud. */
export function auditChangeLabel(change: ContentAuditEntry["change"]): string {
  const fields = (change ?? []).filter(Boolean);
  if (fields.length === 0) return "content";
  if (fields.length === 1) return fields[0];
  return `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}`;
}

/**
 * Who made the edit, in the same words the provenance chip uses ("a person",
 * "planner-1", "anonymous"). Falls back to "someone" for an actor the client
 * doesn't recognize — including the server's own "unknown", which means
 * provenance wasn't derived. Guessing harder would be a lie.
 */
export function auditActorLabel(actor: string | undefined): string {
  return parseAuthoredBy(actor)?.label ?? "someone";
}
