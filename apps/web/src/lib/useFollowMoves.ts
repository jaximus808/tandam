import { useEffect, useRef, useState } from "react";
import { onFleetActivity, type FleetActivity, type FleetActivityAction } from "./ws";
import { isFollowedActor, type FollowPrefs } from "./followAgents";

/* ─────────────────────────────────────────────────────────────────────────────
   useFollowMoves — fleet lifecycle pings → "take me to the board, now".

   The server already sends one `activity` message per action transition (TDM-46)
   carrying the actor, the action id, and the state it landed in. That stream IS
   the choreography: every ping is a card about to move between kanban columns.
   This hook turns the ones you're following into a single current MOVE, which
   App uses to switch to the Board and spotlight the card while TaskBoard flies
   it from its old column to its new one.

   Three behaviours matter more than the plumbing:

     · ONE AT A TIME. A batch approve fires a ping per task; jumping five times
       in 200ms is a seizure, not a feature. Pings coalesce over COALESCE_MS and
       only the newest becomes the move.
     · NEVER MID-SENTENCE. While the viewer is writing (useFocusGuard), moves go
       into a pending buffer instead of yanking the page. When they stop, the
       newest buffered move plays after a short beat — so you see what happened
       while you typed, without losing your place while typing it.
     · YOUR OWN MOVES DON'T COUNT. Approving a task in the UI is a "human" ping;
       isFollowedActor drops it. Following is about watching THEM work.
   ──────────────────────────────────────────────────────────────────────────── */

const COALESCE_MS = 400;
// After the viewer stops typing, wait a beat before playing what they missed —
// an instant jump on the heels of the last keystroke feels like a misclick.
const RESUME_MS = 900;
// Buffered moves while busy. We only ever play the newest, but the count is
// shown ("3 moves while you were typing"), so keep a bounded tail.
const PENDING_CAP = 20;

/** The kanban lanes, as TaskBoard's COLUMNS keys them. */
export type BoardColumn = "proposed" | "ready" | "working" | "done" | "closed";

export interface FollowMove {
  /** Monotonic — every move re-fires the consumers, even two identical ones. */
  nonce: number;
  actionId: string;
  ticketId?: string;
  title?: string;
  actor?: string;
  verb: FleetActivityAction;
  from?: BoardColumn;
  to: BoardColumn;
  /** "Picked up TDM-7" — the live label on the follow cursor. */
  label: string;
}

// Where each transition lands a card, and where it came from. `from` is what the
// column WAS, used only for narration — the flight animation reads the real
// before/after positions off the DOM.
const TRANSITIONS: Record<FleetActivityAction, { from?: BoardColumn; to: BoardColumn; verb: string }> = {
  proposed: { to: "proposed", verb: "Proposed" },
  approved: { from: "proposed", to: "ready", verb: "Approved" },
  rejected: { from: "proposed", to: "closed", verb: "Rejected" },
  claimed: { from: "ready", to: "working", verb: "Picked up" },
  completed: { from: "working", to: "done", verb: "Finished" },
  released: { from: "working", to: "ready", verb: "Released" },
  requeued: { from: "closed", to: "ready", verb: "Re-queued" },
  claim_expired: { from: "working", to: "ready", verb: "Lost the claim on" },
};

function toMove(a: FleetActivity, nonce: number): FollowMove | null {
  const t = TRANSITIONS[a.action];
  if (!t) return null;
  // A completion can land in either terminal lane; the ping says which.
  const failed = a.action === "completed" && a.state === "failed";
  const to: BoardColumn = failed ? "closed" : t.to;
  const verb = failed ? "Failed" : t.verb;
  return {
    nonce,
    actionId: a.actionId,
    ticketId: a.ticketId,
    title: a.title,
    actor: a.actor,
    verb: a.action,
    from: t.from,
    to,
    label: `${verb} ${a.ticketId ?? a.title ?? "a task"}`,
  };
}

export interface FollowMovesResult {
  /** The move to play right now (null once consumed by nothing newer). */
  move: FollowMove | null;
  /** How many followed moves happened while the viewer was writing. */
  pending: number;
}

export function useFollowMoves(
  prefs: FollowPrefs,
  busy: boolean,
  busyRef: React.MutableRefObject<boolean>,
): FollowMovesResult {
  const [move, setMove] = useState<FollowMove | null>(null);
  const [pending, setPending] = useState(0);
  const seq = useRef(0);
  // The newest move waiting on the coalesce window, and the newest one buffered
  // behind a busy viewer. Both are "latest wins" — a queue would replay a stale
  // board position after the interesting one.
  const nextRef = useRef<FollowMove | null>(null);
  const pendingRef = useRef<FollowMove | null>(null);
  const coalesceTimer = useRef<ReturnType<typeof setTimeout>>();
  const resumeTimer = useRef<ReturnType<typeof setTimeout>>();
  // Read inside the WS handler, which is registered once.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    return onFleetActivity((a) => {
      if (!a.actionId) return; // presence pulse, not a lifecycle fact
      if (!isFollowedActor(prefsRef.current, a.actor)) return;
      seq.current += 1;
      const m = toMove(a, seq.current);
      if (!m) return;
      if (busyRef.current) {
        pendingRef.current = m;
        setPending((n) => Math.min(PENDING_CAP, n + 1));
        return;
      }
      nextRef.current = m;
      clearTimeout(coalesceTimer.current);
      coalesceTimer.current = setTimeout(() => {
        const queued = nextRef.current;
        nextRef.current = null;
        if (queued) setMove(queued);
      }, COALESCE_MS);
    });
  }, [busyRef]);

  // Stopped writing with something buffered → show what was missed.
  useEffect(() => {
    if (busy || !pendingRef.current) return;
    clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => {
      const queued = pendingRef.current;
      pendingRef.current = null;
      setPending(0);
      if (queued) setMove(queued);
    }, RESUME_MS);
    return () => clearTimeout(resumeTimer.current);
  }, [busy, pending]);

  // Follow turned off (or narrowed): drop anything in flight so flipping the
  // switch stops the page moving immediately, not after the next timer.
  useEffect(() => {
    if (prefs.on) return;
    clearTimeout(coalesceTimer.current);
    clearTimeout(resumeTimer.current);
    nextRef.current = null;
    pendingRef.current = null;
    setPending(0);
    setMove(null);
  }, [prefs.on]);

  useEffect(
    () => () => {
      clearTimeout(coalesceTimer.current);
      clearTimeout(resumeTimer.current);
    },
    [],
  );

  return { move, pending };
}
