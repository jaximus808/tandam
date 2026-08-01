// The OWNER's gate moves (TDM-189 / TDM-190 / TDM-191) — the client's mirror of
// the two server matrices that put work back BEHIND the approval gate.
//
// WHY THIS IS A SECOND FILE AND NOT MORE ROWS IN taskMoves.ts. That table is the
// BOARD's matrix: the moves that walk a card forward through its life and rewind
// it as far as the ready queue. Every one of its rewinds stops at 'approved', and
// its header says so as a rule — "'proposed' IS DELIBERATELY ABSENT ... a proposed
// task leaves ONLY through the approval gate". These moves break that rule on
// purpose, and they are gated differently for it:
//
//   · the board's /move is human-only BY SURFACE (no MCP tool maps to it) and
//     not checked;
//   · these two endpoints check callerIsHuman server-side, because un-approving
//     is the undo of a human's approval and "no tool advertises it" is not a
//     strong enough rail.
//
// Widening taskMoves.ts would make its header stop meaning what it says — the
// same argument apps/api's task_owner_move.go makes for keeping its matrix out of
// humanMoveTargets. So: same shape, separate table, separate door.
//
// THE MATRIX IS THE SERVER'S, in both cases. apps/api/internal/api/epic_move.go
// and task_owner_move.go own it and re-validate every move; this table exists so
// the UI can render the right buttons without a round trip. When the two
// disagree the server wins, and it says so in a way the UI can act on: an illegal
// move answers 400 with the card's real `state` and the `moves` that ARE legal
// from it (see MoveRefused in lib/api.ts), so a stale board corrects itself
// instead of leaving a dead button on screen.

import type { Action, ActionState } from "../types";
import { humanMovesFor } from "./taskMoves";

/**
 * gate    — puts the work back in front of the human who owns it ('proposed').
 * retire  — ends a drained batch as rejected. Epic-only, and the one move here
 *           that isn't reversible by pressing another button, so it reads
 *           destructive.
 */
export type OwnerMoveKind = "gate" | "retire";

export interface OwnerMove {
  to: ActionState;
  /** Button label — an imperative, what pressing it does. */
  label: string;
  /** The one-line explanation: tooltip on the button, prompt in the confirm. */
  hint: string;
  kind: OwnerMoveKind;
  /**
   * Placeholder for the optional reason. Every move here takes one, because
   * every one of them is somebody overruling a decision the board already
   * recorded — and the reason lands verbatim on the audit trail, where (for a
   * re-opened ticket) the next attempt reads it back as its brief.
   */
  reasonPrompt: string;
}

/* ── Epic moves (TDM-189) ───────────────────────────────────────────────────
   from       →  to         what the person means
   ─────────     ─────────  ──────────────────────────────────────────────────
   proposed      (nothing)  the GATE: approve / reject only
   approved   →  proposed   un-approve — "this batch isn't ready after all"
   done       →  proposed   re-open — the batch is live again
   done       →  rejected   retire — it drained, and it should not have run
   rejected   →  proposed   re-propose — reconsider a batch triaged away      */

const EPIC_UNAPPROVE: OwnerMove = {
  to: "proposed",
  label: "Send back to proposed",
  hint: "Un-approve this batch — it returns to the gate, and its unclaimed tickets leave the ready queue with it",
  kind: "gate",
  reasonPrompt: "Why it isn't ready (optional)",
};

const EPIC_REOPEN: OwnerMove = {
  to: "proposed",
  label: "Re-open",
  hint: "This batch isn't finished after all — put it back at the gate so it can be approved and run again",
  kind: "gate",
  reasonPrompt: "What's still missing (optional)",
};

const EPIC_RETIRE: OwnerMove = {
  to: "rejected",
  label: "Retire",
  hint: "It drained, and it should not have run — archive the batch as rejected",
  kind: "retire",
  reasonPrompt: "Why it should not have run (optional)",
};

const EPIC_REPROPOSE: OwnerMove = {
  to: "proposed",
  label: "Re-propose",
  hint: "Bring this batch back to the gate for another look",
  kind: "gate",
  reasonPrompt: "What changed your mind (optional)",
};

/**
 * Legal owner moves out of each EPIC state, primary first — the same order the
 * server offers them in, so a client rendering straight off a 400's `moves`
 * list puts the same button first. 'proposed' has no key, and that is the rule:
 * approve/reject are the only door in and out of the gate.
 */
export const EPIC_OWNER_MOVES: Record<string, OwnerMove[]> = {
  approved: [EPIC_UNAPPROVE],
  done: [EPIC_REOPEN, EPIC_RETIRE],
  rejected: [EPIC_REPROPOSE],
};

export function epicOwnerMovesFor(state: string): OwnerMove[] {
  return EPIC_OWNER_MOVES[state] ?? [];
}

/* ── Ticket moves (TDM-190) ─────────────────────────────────────────────────
   Every target is 'proposed': the point of all three is the same point, which
   is to put this ticket back in front of the human who owns it.

   'executing' and 'failed' are ABSENT on purpose. Executing is the claim guard
   — a ticket a worker is holding must not be yanked to the gate underneath it,
   so the owner releases it first (that IS a board move) and then un-approves,
   two deliberate clicks. Failed already has the board's Re-queue.             */

const TASK_UNAPPROVE: OwnerMove = {
  to: "proposed",
  label: "Send back to proposed",
  hint: "Un-approve this ticket — it leaves the ready queue and waits at the gate, so nobody starts it",
  kind: "gate",
  reasonPrompt: "Why it isn't ready (optional)",
};

const TASK_REOPEN_TO_GATE: OwnerMove = {
  to: "proposed",
  label: "Re-open to proposed",
  hint: "That isn't finished — clear the result and send it back to the gate rather than straight to the queue",
  kind: "gate",
  reasonPrompt: "What's still missing (optional)",
};

const TASK_REPROPOSE: OwnerMove = {
  to: "proposed",
  label: "Re-propose",
  hint: "Bring this ticket back to the gate for another look",
  kind: "gate",
  reasonPrompt: "What changed your mind (optional)",
};

/** The server's full task matrix, before the de-duplication below. */
export const TASK_OWNER_MOVES: Record<string, OwnerMove[]> = {
  approved: [TASK_UNAPPROVE],
  done: [TASK_REOPEN_TO_GATE],
  rejected: [TASK_REPROPOSE],
};

/**
 * The owner moves a TICKET surface should actually render: the matrix above
 * minus anything the board's own matrix already offers on that state.
 *
 * The overlap is real and exactly one row. A rejected ticket's re-propose IS
 * lib/taskMoves' Re-propose (rejected → proposed) — the identical rewind, which
 * the board has offered since E10 through the older endpoint. Rendering both
 * would put two buttons with one meaning side by side, so the established one
 * wins and this returns nothing for 'rejected'. What's left is the two moves
 * that genuinely did not exist before: un-approving an approved ticket, and
 * re-opening a done one to the GATE rather than to the ready queue (the board's
 * Reopen still goes to 'approved', and is still the right move when the plan is
 * fine and only the work was short).
 */
export function taskOwnerMovesFor(state: string): OwnerMove[] {
  const covered = new Set(humanMovesFor(state).map((m) => m.to));
  return (TASK_OWNER_MOVES[state] ?? []).filter((m) => !covered.has(m.to));
}

/**
 * How many of an epic's tickets an un-approve would pull back out of the ready
 * queue, predicted client-side so the confirm can say the number BEFORE the
 * click rather than only reporting it after.
 *
 * Mirrors store.UnapproveEpicTasks' SQL predicate exactly: a task, approved,
 * stamped by the epic cascade, and unclaimed. A ticket a human approved one at
 * a time keeps that approval, and a ticket somebody is holding is never taken
 * off them — the same two carve-outs, said in TypeScript. It is a PREDICTION,
 * not a promise: the response's `unapprovedCount` is the truth, and the control
 * reports that afterwards.
 */
export const EPIC_APPROVAL_STAMP = "policy:epic";

export function epicCascadePreview(epicTasks: Action[]): number {
  return epicTasks.filter(
    (t) =>
      t.type === "task" &&
      t.state === "approved" &&
      t.approvedBy === EPIC_APPROVAL_STAMP &&
      !t.claimedBy,
  ).length;
}
