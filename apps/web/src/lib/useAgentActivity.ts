import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { CanvasMode, CanvasState } from "../types";
import { onAgentActivity, type ChangeActor } from "./ws";

// How the agent's live presence behaves:
//   - CURSOR_MS: the cursor lingers this long on the last-touched element, then
//     fades. A new edit inside the window glides the cursor to it and resets.
//   - PRESENCE_MS: how long "Claude" stays shown as connected after its last
//     edit (the cursor is gone, but we still know it's around).
//   - READING_MS: how long the "reading" pulse glows after a state read.
const CURSOR_MS = 2000;
const PRESENCE_MS = 20_000;
const READING_MS = 1800;

// A batch push (canvas_*_add_batch etc.) touches many entities in one state
// broadcast. Instead of jumping the cursor once to the "best" one, we replay
// every created/updated entity in order, staggered by SEQUENCE_STEP_MS, so the
// canvas visibly hops across each item like the agent placed them one by one.
const SEQUENCE_STEP_MS = 320;
// Cap how many stops a single batch replays — a 200-item batch shouldn't spawn
// 200 timers or a minute-long light show. Large batches are down-sampled
// (evenly spaced) but always end on the true last item.
const MAX_SEQUENCE_STEPS = 20;

export interface AgentEdit {
  entityId: string;
  mode: CanvasMode;
}

export interface PresentAgent {
  name: string;
  isClaude: boolean;
}

export type AgentOp = "created" | "updated" | "removed";

// A single discrete agent change, classified for the notification feed. `nonce`
// is a monotonic counter so consumers fire an effect on every action — even two
// identical ones in a row ("created a doc", "created a doc").
export interface AgentAction {
  nonce: number;
  op: AgentOp;
  kind: string; // human noun: "doc", "spreadsheet", "map pin", …
  mode: CanvasMode;
  agentName: string;
  isClaude: boolean;
}

// updatedAt is typed as number but the wire actually carries RFC3339 strings —
// normalise either to epoch ms so diffs are reliable.
function toMs(u: number | string): number {
  if (typeof u === "number") return u;
  const ms = Date.parse(u);
  return Number.isNaN(ms) ? 0 : ms;
}

// Each editable collection mapped to its tab and the noun we narrate it as.
const KIND_MODE: { key: keyof CanvasState; mode: CanvasMode; noun: string }[] = [
  { key: "pins", mode: "map", noun: "map pin" },
  { key: "events", mode: "itinerary", noun: "itinerary event" },
  { key: "notes", mode: "docs", noun: "doc" },
  { key: "roadmapItems", mode: "roadmap", noun: "roadmap item" },
  { key: "sheets", mode: "sheets", noun: "spreadsheet" },
  { key: "sheetRows", mode: "sheets", noun: "spreadsheet row" },
  { key: "charts", mode: "charts", noun: "chart" },
];

type Snap = { ms: number; mode: CanvasMode; noun: string };

// Pick the agent to attribute a change to: prefer a registered online agent
// (Claude first), else fall back to a generic "Claude".
function resolveAgent(state: CanvasState | null): PresentAgent {
  const claudey = (a: { name?: string; model?: string }) =>
    /claude/i.test(a.model ?? "") || /claude/i.test(a.name ?? "");
  const online = state ? Object.values(state.agents).filter((a) => a.status === "online") : [];
  const pick = online.find(claudey) ?? online[0];
  if (pick) return { name: pick.name || "Agent", isClaude: claudey(pick) };
  return { name: "Claude", isClaude: true };
}

/**
 * Watches canvas state for agent-authored changes and exposes:
 *   - `edit`     — a transient "cursor target" (the element an agent just touched)
 *   - `agents`   — the connected-agents list
 *   - `online`   — whether an agent is presently around
 *   - `reading`  — true for a beat after an agent reads the canvas (state.read)
 *   - `lastAction` — the most recent classified change, for the notification feed
 *
 * The changed entity is found by diffing `updatedAt` against the previous
 * snapshot; whether to fire is gated on the server's `lastChangeBy` hint (read
 * from a ref), so a human editing an agent-created item never triggers it.
 */
export function useAgentActivity(
  canvasId: string | undefined,
  state: CanvasState | null,
  lastChangeBy: MutableRefObject<ChangeActor | undefined>,
) {
  // entityId -> last snapshot. Seeded once per canvas so the initial load
  // doesn't fire the cursor/feed for every pre-existing item.
  const prev = useRef<Map<string, Snap>>(new Map());
  const seededFor = useRef<string | undefined>(undefined);
  const cursorTimer = useRef<ReturnType<typeof setTimeout>>();
  const presenceTimer = useRef<ReturnType<typeof setTimeout>>();
  const readingTimer = useRef<ReturnType<typeof setTimeout>>();
  // Pending "replay next item" timers for an in-flight batch sequence. A new
  // state push cancels whatever's still queued here before starting its own.
  const sequenceTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const nonce = useRef(0);

  const clearSequence = () => {
    for (const t of sequenceTimers.current) clearTimeout(t);
    sequenceTimers.current = [];
  };

  const [edit, setEdit] = useState<AgentEdit | null>(null);
  const [online, setOnline] = useState(false);
  const [reading, setReading] = useState(false);
  const [lastAction, setLastAction] = useState<AgentAction | null>(null);

  // A state read by an agent → glow the "reading" pulse and count it as live
  // presence (so the agent lights up even before its first edit).
  useEffect(() => {
    return onAgentActivity((a) => {
      if (a.action !== "read") return;
      setReading(true);
      setOnline(true);
      clearTimeout(readingTimer.current);
      readingTimer.current = setTimeout(() => setReading(false), READING_MS);
      clearTimeout(presenceTimer.current);
      presenceTimer.current = setTimeout(() => setOnline(false), PRESENCE_MS);
    });
  }, []);

  useEffect(() => {
    if (!state) return;

    // A new push supersedes whatever replay sequence was still in flight —
    // stale timers must not go on firing setEdit for a previous push's items.
    clearSequence();

    // Snapshot every entity with its mode + last-touched time + noun.
    const cur = new Map<string, Snap>();
    for (const { key, mode, noun } of KIND_MODE) {
      const rec = state[key] as Record<string, { id: string; updatedAt: number | string }>;
      for (const e of Object.values(rec)) {
        cur.set(e.id, { ms: toMs(e.updatedAt), mode, noun });
      }
    }

    const snapshot = () => {
      prev.current = new Map(cur);
    };

    // First state for this canvas: seed silently, fire nothing.
    if (seededFor.current !== canvasId) {
      seededFor.current = canvasId;
      setEdit(null);
      setOnline(false);
      setReading(false);
      setLastAction(null);
      snapshot();
      return;
    }

    // Every entity created or updated since the last snapshot, oldest first —
    // that's replay order, so a batch add plays back in the order the agent
    // actually created the items. Classify created (new id) vs updated
    // (existing id, newer time).
    const changed: { id: string; snap: Snap; op: AgentOp }[] = [];
    for (const [id, v] of cur) {
      const before = prev.current.get(id);
      if (!before) {
        changed.push({ id, snap: v, op: "created" });
      } else if (v.ms > before.ms) {
        changed.push({ id, snap: v, op: "updated" });
      }
    }
    changed.sort((a, b) => a.snap.ms - b.snap.ms);

    // No add/update? Look for a removal (an id that vanished).
    let removed: Snap | null = null;
    if (changed.length === 0) {
      for (const [id, v] of prev.current) {
        if (!cur.has(id)) {
          removed = v;
          break;
        }
      }
    }
    snapshot();

    // Only an agent-authored broadcast lights up — a human editing an
    // agent-created item pushes "user" and is ignored.
    if (lastChangeBy.current !== "agent") return;

    const who = resolveAgent(state);
    const emit = (op: AgentOp, snap: Snap) => {
      nonce.current += 1;
      setLastAction({
        nonce: nonce.current,
        op,
        kind: snap.noun,
        mode: snap.mode,
        agentName: who.name,
        isClaude: who.isClaude,
      });
      setOnline(true);
      clearTimeout(presenceTimer.current);
      presenceTimer.current = setTimeout(() => setOnline(false), PRESENCE_MS);
    };

    if (changed.length > 0) {
      // Down-sample pathologically large batches: keep it a lively few-second
      // hop rather than a minute of timers, but always land on the real last
      // item so the final cursor position matches what actually happened.
      let steps = changed;
      if (steps.length > MAX_SEQUENCE_STEPS) {
        const stride = steps.length / MAX_SEQUENCE_STEPS;
        const sampled: typeof steps = [];
        for (let i = 0; i < MAX_SEQUENCE_STEPS - 1; i++) {
          sampled.push(steps[Math.floor(i * stride)]);
        }
        sampled.push(steps[steps.length - 1]);
        steps = sampled;
      }

      clearTimeout(cursorTimer.current);

      const applyStep = (step: (typeof steps)[number], isLast: boolean) => {
        setEdit({ entityId: step.id, mode: step.snap.mode });
        emit(step.op, step.snap);
        if (isLast) {
          cursorTimer.current = setTimeout(() => setEdit(null), CURSOR_MS);
        }
      };

      // First item jumps immediately — a single-change push (the common case)
      // gets one instant jump with no artificial delay. Any further items
      // trail behind on a stagger so the cursor visibly hops across each.
      applyStep(steps[0], steps.length === 1);
      for (let i = 1; i < steps.length; i++) {
        const step = steps[i];
        const isLast = i === steps.length - 1;
        const timer = setTimeout(() => applyStep(step, isLast), i * SEQUENCE_STEP_MS);
        sequenceTimers.current.push(timer);
      }
    } else if (removed) {
      emit("removed", removed);
    }
  }, [state, canvasId]);

  useEffect(
    () => () => {
      clearTimeout(cursorTimer.current);
      clearTimeout(presenceTimer.current);
      clearTimeout(readingTimer.current);
      clearSequence();
    },
    [],
  );

  const agents = useMemo<PresentAgent[]>(() => {
    const list: PresentAgent[] = [];
    for (const a of state ? Object.values(state.agents) : []) {
      if (a.status === "online") {
        list.push({
          name: a.name || "Agent",
          isClaude: /claude/i.test(a.model ?? "") || /claude/i.test(a.name ?? ""),
        });
      }
    }
    // No agent has formally registered, but we just saw it read/write — show it.
    if (list.length === 0 && online) list.push({ name: "Claude", isClaude: true });
    return list;
  }, [state, online]);

  return { edit, agents, online, reading, lastAction };
}
