/* ── Owner state controls (TDM-191) ───────────────────────────────────────────
   The one control that renders lib/ownerMoves' matrices — the moves that put an
   epic or a ticket back BEHIND the approval gate — on every surface that offers
   them: the sidebar epic row, the scoped epic header, the board's detail
   slide-over, and the ticket's own page.

   WHY IT IS ONE COMPONENT AND NOT FOUR COPIES. Every one of these moves overrules
   a decision the board already recorded, and the shape that makes that safe is
   the same everywhere: nothing fires on the first press, the confirm says in
   words what the move will do, and there is a reason field on the way through
   because the audit trail is the only place a future reader can learn WHY the
   batch they are looking at went backwards. Four hand-rolled copies of that is
   four chances for one of them to skip the confirm.

   THE PATTERN IS THE BOARD'S EXISTING ONE, deliberately: it is the same arm →
   confirm-with-optional-note → go strip that TaskDetail.renderMoves and
   TicketView.MoveControls already use for the E10 rewinds, down to the Enter /
   Escape keys. A person who has released a claim before should recognise this
   without being taught it twice.

   IT REPORTS BACK. A move here is one of the few board actions whose consequence
   is not fully visible in the card that moved: un-approving an epic also empties
   part of the ready queue. `onMove` returns the sentence to show afterwards, so
   the cascade count the server sent lands in front of the person who caused it
   rather than in a response nobody reads. The line expires on its own — it is a
   receipt for something you just did, not a state the surface stays in. */

import { useEffect, useState } from "react";
import { RotateCcw, Undo2 } from "lucide-react";

import { T_BTN, TAP } from "../lib/boardScale";
import { moveEpicState, moveTaskToGate } from "../lib/api";
import posthog from "../lib/posthog";
import {
  epicCascadePreview,
  epicOwnerMovesFor,
  taskOwnerMovesFor,
  type OwnerMove,
} from "../lib/ownerMoves";
import type { Action } from "../types";

/** How long the post-move receipt stays up. */
const RECEIPT_MS = 9_000;

export function ownerMoveIcon(move: OwnerMove) {
  return move.kind === "retire" ? <RotateCcw size={12} /> : <Undo2 size={12} />;
}

/* ── The two wired controls ───────────────────────────────────────────────────
   OwnerMoveControls below is the presentation; these are the two bindings of it,
   one per matrix. They live here rather than in TaskBoard because FOUR surfaces
   across two big modules render them — the sidebar epic row, the scoped epic
   header, the board's detail slide-over and the ticket's own page — and the
   write, the analytics and the wording should exist once. Only the reported
   `surface` differs between call sites. */

/* A BATCH (TDM-189). Approve / Reject are how an epic LEAVES 'proposed'; these
   are how it comes back — un-approve one approved by mistake, re-open one that
   drained too early, retire one that should not have run, re-propose one triaged
   away. A gate with no undo is a gate people approve nothing through.

   'proposed' renders nothing: epicOwnerMovesFor has no key for it, which is the
   server's rule too — approve/reject are the only door in and out of triage. */
export function EpicOwnerMoves({
  code,
  epic,
  epicTasks,
  surface,
  className = "",
}: {
  code: string;
  epic: Action;
  /** The batch's tickets, for the cascade preview. */
  epicTasks: Action[];
  surface: "board" | "board_detail";
  className?: string;
}) {
  // What ELSE un-approving does, predicted from live board state so the confirm
  // can say the number BEFORE the click — it is the fact that decides whether
  // you press the button. Only ever a prediction (see epicCascadePreview); the
  // server's count is the truth, and the receipt reports that afterwards.
  function cascadeSentence(move: OwnerMove): string | null {
    if (epic.state !== "approved" || move.to !== "proposed") return null;
    const n = epicCascadePreview(epicTasks);
    if (n === 0) return "Nothing of its is sitting unclaimed in the queue.";
    return `${n} unclaimed ticket${
      n === 1 ? "" : "s"
    } will go back to proposed with it — anything in flight or already finished stays put.`;
  }

  return (
    <OwnerMoveControls
      moves={epicOwnerMovesFor(epic.state)}
      stateKey={epic.state}
      className={className}
      previewFor={cascadeSentence}
      onMove={async (move, reason) => {
        const from = epic.state;
        const res = await moveEpicState(code, epic.id, move.to, reason || undefined);
        posthog.capture("epic_moved", {
          canvas_code: code,
          from,
          to: move.to,
          unapproved: res.unapprovedCount,
          noted: reason.length > 0,
          surface,
        });
        if (!res.moved) return "It was already there — nothing changed.";
        // Always a receipt, even for zero: "nothing else moved" is the answer to
        // the question the confirm just raised, and silence reads as "did the
        // cascade run?" rather than as "there was nothing to cascade".
        if (move.to === "rejected") return "Retired — the batch is archived as rejected.";
        if (res.unapprovedCount === 0) {
          return "Back at the gate. Nothing of its was sitting in the ready queue.";
        }
        return `Back at the gate — ${res.unapprovedCount} ticket${
          res.unapprovedCount === 1 ? "" : "s"
        } left the ready queue with it.`;
      }}
    />
  );
}

/* ONE TICKET (TDM-190). Two moves the board's matrix never had: an approved
   ticket back out of the ready queue, and a done one back to the GATE rather
   than to the queue. The overlapping third — re-propose a rejected one — is
   already the board's own Re-propose, and taskOwnerMovesFor drops it here so no
   surface shows two buttons with one meaning.

   NOT ON THE CARD, unlike the epic's, and that is lib/taskMoves' rule holding
   rather than an omission: "cards are a summary — the full set (including every
   rewind) lives in the detail panel, so the board never grows a row of buttons
   per card". An epic is a destination with room for controls; a ticket card is
   one of forty in a lane. So this renders in the detail slide-over and on the
   ticket's own page, next to the rewinds it belongs with. */
export function TaskOwnerMoves({
  code,
  task,
  surface,
  className = "",
}: {
  code: string;
  task: Action;
  surface: "board_detail" | "ticket_page";
  className?: string;
}) {
  return (
    <OwnerMoveControls
      moves={taskOwnerMovesFor(task.state)}
      stateKey={task.state}
      className={className}
      label="Back to the gate"
      onMove={async (move, reason) => {
        const from = task.state;
        const res = await moveTaskToGate(code, task.id, move.to, reason || undefined);
        posthog.capture("task_gate_moved", {
          canvas_code: code,
          from,
          to: move.to,
          noted: reason.length > 0,
          surface,
        });
        if (!res.moved) return "It was already there — nothing changed.";
        return from === "approved"
          ? "Out of the ready queue — it waits at the gate now."
          : "Back at the gate. Approve it again to put it in the queue.";
      }}
    />
  );
}

export default function OwnerMoveControls({
  moves,
  stateKey,
  onMove,
  className = "",
  label,
  previewFor,
}: {
  /** The legal moves out of this card's state. Renders nothing when empty. */
  moves: OwnerMove[];
  /**
   * The card's current state. When a socket push changes it underneath us the
   * armed move may no longer be legal, so the strip is dropped rather than left
   * pointing at a move the server is about to refuse.
   */
  stateKey: string;
  /**
   * Perform the move. Resolve with the line to show afterwards (or null for
   * none); throw to surface the failure in place. The caller owns the write so
   * each surface can report its own analytics `surface` property.
   */
  onMove: (move: OwnerMove, reason: string) => Promise<string | null>;
  className?: string;
  /** Optional quiet heading above the buttons, e.g. "Owner". */
  label?: string;
  /**
   * An extra sentence for the confirm — what ELSE this move will do, computed
   * from live board state. The epic un-approve uses it for the cascade count,
   * which is the fact that changes whether you press the button.
   */
  previewFor?: (move: OwnerMove) => string | null;
}) {
  const [pending, setPending] = useState<OwnerMove | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  // The card moved underneath us — disarm rather than fire something stale.
  useEffect(() => {
    setPending(null);
    setReason("");
    setError(null);
  }, [stateKey]);

  useEffect(() => {
    if (!receipt) return;
    const t = setTimeout(() => setReceipt(null), RECEIPT_MS);
    return () => clearTimeout(t);
  }, [receipt]);

  async function go(move: OwnerMove) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const said = await onMove(move, reason.trim());
      setPending(null);
      setReason("");
      setReceipt(said);
    } catch (err) {
      // A refusal carries the server's own sentence (MoveRefused.message),
      // which already explains what IS legal from here. Show it and leave the
      // strip armed so the person can read it against the button they pressed;
      // the websocket push that corrects the card will disarm it.
      setError(err instanceof Error ? err.message : "Could not move this");
    } finally {
      setBusy(false);
    }
  }

  if (moves.length === 0 && !receipt) return null;

  const primary = `flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:opacity-40 ${
    pending?.kind === "retire"
      ? "bg-rose-600 hover:bg-rose-700 focus-visible:ring-rose-500/40"
      : "bg-accent hover:bg-accent/90 focus-visible:ring-accent/40"
  } ${T_BTN} ${TAP}`;
  const quiet = `flex flex-1 items-center justify-center gap-1 rounded-md border border-ink/15 px-2 py-1 font-medium text-ink/60 transition-colors hover:border-ink/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${T_BTN} ${TAP}`;

  return (
    // stopPropagation: on the sidebar the whole row is a button that scopes the
    // board, and pressing Re-open inside it must not also navigate.
    <div className={`flex flex-col gap-1.5 ${className}`} onClick={(e) => e.stopPropagation()}>
      {error && (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-[11.5px] leading-snug text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}
      {receipt && !pending && (
        <div className="rounded-md border border-ink/10 bg-ink/[0.03] px-2 py-1 text-[11.5px] leading-snug text-ink/60">
          {receipt}
        </div>
      )}
      {pending ? (
        <>
          <p className="text-[11.5px] leading-snug text-ink/60">
            {[`${pending.hint}.`, previewFor?.(pending)].filter(Boolean).join(" ")}
          </p>
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              // Escape has to stop here: on the board this control sits inside
              // surfaces that read Escape as "close me".
              if (e.key === "Escape") {
                e.stopPropagation();
                setPending(null);
                setReason("");
              }
              if (e.key === "Enter") void go(pending);
            }}
            placeholder={pending.reasonPrompt}
            aria-label={pending.reasonPrompt}
            className={`w-full rounded-md border border-ink/15 bg-surface px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink/30 focus:border-accent/50 focus:ring-2 focus:ring-accent/40 ${TAP}`}
          />
          <div className="flex gap-1.5">
            <button onClick={() => void go(pending)} disabled={busy} className={primary}>
              {busy ? "Working…" : pending.label}
            </button>
            <button
              onClick={() => {
                setPending(null);
                setReason("");
              }}
              className={quiet}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        moves.length > 0 && (
          <>
            {label && (
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink/40">
                {label}
              </span>
            )}
            <div className="flex flex-wrap gap-1.5">
              {moves.map((m) => (
                <button
                  key={`${m.to}-${m.label}`}
                  onClick={() => {
                    setReason("");
                    setError(null);
                    setReceipt(null);
                    setPending(m);
                  }}
                  disabled={busy}
                  title={m.hint}
                  className={
                    m.kind === "retire"
                      ? `flex flex-1 items-center justify-center gap-1 rounded-md border border-rose-500/30 px-2 py-1 font-medium text-rose-600 transition-colors hover:border-rose-500/60 hover:bg-rose-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 disabled:opacity-40 dark:text-rose-400 ${T_BTN} ${TAP}`
                      : quiet
                  }
                >
                  {ownerMoveIcon(m)} {m.label}
                </button>
              ))}
            </div>
          </>
        )
      )}
    </div>
  );
}
