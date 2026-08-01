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
//
// The same log holds a SECOND kind of entry (E10, surfaced in TDM-97): a human
// STATE MOVE — someone pressed Start, Mark done, Release, Re-queue, Reopen or
// Reconsider on the board. Those carry change: ["state"] and are always
// `reverted: false`, because moving a card never costs an approval. That is
// exactly why they were invisible: every reader here keyed on `reverted`, so a
// trail the server had been faithfully recording since E10 rendered as nothing.
// Tell the two kinds apart by `change` — never by `reverted`.

import type { Action, ContentAuditEntry, EpicPayload, TaskPayload } from "../types";
import { parseAuthoredBy, type Provenance } from "./provenance";

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
    // `reverted` alone would be enough today — a state move is written with
    // reverted:false by construction — but saying "a content edit that reverted"
    // out loud means this notice can never start speaking for the move entries
    // that now share the log.
    if (e?.reverted && !isStateMove(e)) return e;
  }
  return null;
}

/**
 * True when this entry records a human board MOVE rather than a content edit.
 *
 * `change` is the discriminator the server documents (store/content_gate.go):
 * a move carries the literal "state" in place of the content field names, and
 * "state" is deliberately not a content field, so the two sets never overlap.
 */
export function isStateMove(entry: ContentAuditEntry | null | undefined): boolean {
  return !!entry && (entry.change ?? []).includes("state");
}

/** The most recent human move, or null when nobody has moved this by hand. */
export function lastStateMove(
  payload: TaskPayload | EpicPayload | undefined,
): ContentAuditEntry | null {
  const trail = payload?.audit;
  if (!Array.isArray(trail)) return null;
  for (let i = trail.length - 1; i >= 0; i--) {
    if (isStateMove(trail[i])) return trail[i];
  }
  return null;
}

/**
 * What the person DID, as a past-tense verb phrase — "started this", "marked
 * this done". Keyed by the from→to pair, which is the server's move matrix
 * (api/task_move.go humanMoveTargets) and the client's mirror of it
 * (lib/taskMoves.ts) said backwards: those name the button you press, this
 * names the thing that happened.
 *
 * A pair neither table knows falls back to a plain "moved this" rather than a
 * guess — the from→to is rendered beside it either way, so the record stays
 * complete even for a move this build has never heard of.
 */
const MOVE_VERB: Record<string, string> = {
  "approved→executing": "started this",
  "executing→done": "marked this done",
  "executing→failed": "marked this failed",
  "executing→approved": "released this",
  "failed→approved": "re-queued this",
  "done→approved": "reopened this",
  "rejected→proposed": "sent this back to triage",
};

export function moveVerbLabel(entry: ContentAuditEntry): string {
  // done → approved is ONE transition with two readings: a person reopening
  // work that wasn't really finished, and a reviewer bouncing somebody else's
  // (TDM-154, which reuses the same rewind rather than widening the state
  // machine). The actor is the only thing that tells them apart, and calling an
  // agent's block "reopened" would bury the fact the move exists to state.
  if (
    entry.fromState === "done" &&
    entry.toState === "approved" &&
    parseAuthoredBy(entry.actor)?.kind === "agent"
  ) {
    return "sent this back";
  }
  return MOVE_VERB[`${entry.fromState}→${entry.toState}`] ?? "moved this";
}

/** Short form for a card, where there is no room for a sentence: "reopened". */
export function moveVerbShort(entry: ContentAuditEntry): string {
  return moveVerbLabel(entry).replace(/\s*\bthis\b\s*/, " ").trim();
}

// The server writes a move's summary as `state: "from" → "to"` with the human's
// optional note appended after an em-dash separator (store.NewStateAudit). The
// from→to half is rendered structurally from fromState/toState, so quoting the
// whole machine string underneath would say everything twice — this pulls the
// note back out so it can be typeset as what it is: a person's own words.
const MOVE_SUMMARY = /^state:\s*"[^"]*"\s*→\s*"[^"]*"(?:\s+—\s+([\s\S]+))?$/;

/**
 * The note the mover typed, or null when they didn't.
 *
 * `entry.note` is the verbatim field (TDM-154) and is preferred whenever it is
 * there; the summary parse is the fallback for entries written before it
 * existed, where the excerpt is all there is. Never the other way round — the
 * summary truncates at 80 runes, and on a rework bounce that is a truncated
 * instruction.
 */
export function stateMoveNote(entry: ContentAuditEntry): string | null {
  const verbatim = entry.note?.trim();
  if (verbatim) return verbatim;
  const note = MOVE_SUMMARY.exec(entry.summary ?? "")?.[1]?.trim();
  return note ? note : null;
}

/* ── The reviewer's bounce (TDM-154 / TDM-157) ────────────────────────────────
   Finished work sent BACK: done → approved, the claim and the stale result
   cleared, the task in the ready queue again for its author to revise. Under
   the 'peer' policy an agent reviewer makes this move (POST …/rework); a person
   makes the identical one from the board (Reopen). The audit entry is the same
   shape for both, and so is what it means to whoever picks the task up — the
   only difference is WHO said no, which is exactly what the provenance
   vocabulary is for.

   THE ENTRY IS THE ONLY RECORD. The rewind clears `result` and `claimedBy` by
   design, so nothing on the row itself remembers that this approved task is not
   a fresh one. Without this read, a bounced ticket is indistinguishable from a
   ticket nobody has ever worked. */

export interface Bounce {
  /** The audit entry itself, for a caller that wants the raw record. */
  entry: ContentAuditEntry;
  /** Who sent it back, in the board's provenance vocabulary. Null when the
   *  server could not attribute the move ("unknown"), which is rare and honest. */
  by: Provenance | null;
  /** Their name, always renderable: "reviewer-b", "a person", "someone". */
  who: string;
  /** The reviewer's own words. Empty only for a legacy entry with no note —
   *  /rework REQUIRES a reason, so a bounce from an agent always carries one. */
  reason: string;
  /** When it came back. */
  at: string;
}

/**
 * The bounce this task is CURRENTLY sitting under, or null.
 *
 * "Currently" is the whole subtlety. The bounce is live only while it is the
 * last thing a hand did to the card: if someone has since reopened, released or
 * re-queued it, that later move is the state the task is in and this one is
 * history. So the last state move must BE the done → approved rewind — scanning
 * for the most recent bounce anywhere in the trail would make a badge that,
 * once earned, never comes off.
 *
 * Note what this deliberately does NOT check: the task's own state. A caller
 * decides whether a bounce is worth showing where it is showing it — the board
 * shows it on the two states where it is still an instruction (waiting in the
 * queue, and being revised), and stops the moment the work is finished again.
 */
export function lastBounce(payload: TaskPayload | EpicPayload | undefined): Bounce | null {
  const entry = lastStateMove(payload);
  if (!entry || entry.fromState !== "done" || entry.toState !== "approved") return null;
  const by = parseAuthoredBy(entry.actor);
  return {
    entry,
    by,
    who: by?.label ?? "someone",
    reason: stateMoveNote(entry) ?? "",
    at: entry.at,
  };
}

/**
 * The bounce a TASK should be wearing on the board, or null.
 *
 * Two states qualify and the reason is the same for both: the reviewer's words
 * are an instruction that has not been carried out yet. In 'approved' the task
 * is re-queued and nobody has picked the note up; in 'executing' somebody is
 * acting on it and needs to be able to read it without opening a panel. Once
 * the task reports done again the instruction is spent — and an agent's own
 * completion writes no audit entry, so the state is the only thing that can
 * retire this.
 */
export function blockedBounce(action: Action): Bounce | null {
  if (action.type !== "task") return null;
  if (action.state !== "approved" && action.state !== "executing") return null;
  return lastBounce((action.payload ?? {}) as TaskPayload);
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
