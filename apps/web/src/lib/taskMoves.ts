// The human board moves (E10) — the client's mirror of the API's move matrix.
//
// WHY IT EXISTS. Everything on the board except approve/reject was an AGENT
// transition: a card moved when an MCP session claimed it and again when it
// reported back. A person looking at their own todo sitting in Ready had no way
// to say "I started this" or "this is done" — which made the board a viewer for
// other people's work rather than a queue you actually run your day from.
//
// THE MATRIX IS THE SERVER'S. apps/api/internal/api/task_move.go owns it and
// re-validates every move; this table exists so the UI can render the right
// buttons without a round trip, and its 400 even carries the legal targets so a
// stale board corrects itself. If the two ever disagree the server wins — the
// worst case is a button that returns a 400 the panel then shows.
//
// 'proposed' IS DELIBERATELY ABSENT, here as well as there: a proposed task
// leaves ONLY through the approval gate (Approve / Reject), which is the whole
// product. No move control may offer a way around it.

import type { ActionState } from "../types";

/**
 * forward = walking the work along (start it, finish it). rewind = undoing a
 * state the task can't leave on its own (release a claim, re-queue a failure,
 * reopen something that wasn't really done). The distinction is purely about
 * presentation: forward moves are the primary action, rewinds are quiet and
 * confirm first, because they discard the last attempt's result.
 */
export type MoveKind = "forward" | "rewind";

export interface HumanMove {
  to: ActionState;
  /** Button label — an imperative, what pressing it does. */
  label: string;
  /** The one-line explanation: tooltip on a button, prompt in a confirm. */
  hint: string;
  kind: MoveKind;
  /**
   * Placeholder for the optional note, when the move is worth annotating. A
   * note on a terminal move lands in the task's result / error; on a rewind it
   * lives only in the audit trail (both columns are cleared by design).
   */
  notePrompt?: string;
}

const START: HumanMove = {
  to: "executing",
  label: "Start",
  hint: "Take this task and show it as in progress on the board",
  kind: "forward",
};

const COMPLETE: HumanMove = {
  to: "done",
  label: "Mark done",
  hint: "Finish this task",
  kind: "forward",
  notePrompt: "What you did (optional)",
};

const GIVE_UP: HumanMove = {
  to: "failed",
  label: "Mark failed",
  hint: "Stop working this task and record why",
  kind: "forward",
  notePrompt: "What blocked it (optional)",
};

const RELEASE: HumanMove = {
  to: "approved",
  label: "Release",
  hint: "Clear the claim and put this task back in the queue",
  kind: "rewind",
};

const REQUEUE: HumanMove = {
  to: "approved",
  label: "Re-queue",
  hint: "Clear the error and send this task back for another attempt",
  kind: "rewind",
  notePrompt: "Why it deserves another go (optional)",
};

const REOPEN: HumanMove = {
  to: "approved",
  label: "Reopen",
  hint: "It wasn't really finished — clear the result and put it back in the queue",
  kind: "rewind",
  notePrompt: "What's still missing (optional)",
};

// The one move in this table that lands BEHIND the gate — rejected is already
// outside the queue, so putting it back in triage takes nothing out. TDM-191
// gave it the note the other rewinds have: its twin on the owner matrix
// (lib/ownerMoves' TASK_REPROPOSE, the same transition through the newer
// endpoint) records a reason, and the same move should not lose the ability to
// say why depending on which button you happened to reach. Labelled to match
// that twin and the epic's, so one transition reads as one word everywhere.
const RECONSIDER: HumanMove = {
  to: "proposed",
  label: "Re-propose",
  hint: "Send this back to triage so it can be approved or rejected again",
  kind: "rewind",
  notePrompt: "What changed your mind (optional)",
};

/**
 * Legal moves out of each state, primary first. Keyed by the state the card is
 * IN — the same shape as the server's humanMoveTargets, and with the same
 * missing key.
 */
export const HUMAN_MOVES: Record<string, HumanMove[]> = {
  approved: [START],
  executing: [COMPLETE, GIVE_UP, RELEASE],
  failed: [REQUEUE],
  done: [REOPEN],
  rejected: [RECONSIDER],
};

/** Every move a person may make on a task in this state (empty for proposed). */
export function humanMovesFor(state: string): HumanMove[] {
  return HUMAN_MOVES[state] ?? [];
}

/**
 * The one move a CARD offers inline: the forward one, or nothing. Cards are a
 * summary — the full set (including every rewind) lives in the detail panel, so
 * the board never grows a row of buttons per card.
 */
export function primaryMoveFor(state: string): HumanMove | null {
  return humanMovesFor(state).find((m) => m.kind === "forward") ?? null;
}
