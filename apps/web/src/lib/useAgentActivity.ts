import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { CanvasMode, CanvasState } from "../types";
import { onAgentActivity, type ChangeActor } from "./ws";

// How the agent's live presence behaves:
//   - PRESENCE_MS: how long "Claude" stays shown as connected after its last
//     edit (the cursor is gone, but we still know it's around).
//   - READING_MS: how long the "reading" pulse glows after a state read.
const PRESENCE_MS = 20_000;
const READING_MS = 1800;

// A batch push (canvas_*_add_batch etc.) touches many entities in one state
// broadcast. Rather than hop the cursor across each item — which reads as
// whiplash — we treat the whole batch as ONE "showcase": a single highlight
// around every touched element and a smooth top→bottom pan (driven in App). A
// showcase stays up for SHOWCASE_MIN_MS, growing SHOWCASE_PER_ITEM_MS per item
// up to SHOWCASE_MAX_MS, so bigger batches linger a little longer.
const SHOWCASE_MIN_MS = 1700;
const SHOWCASE_PER_ITEM_MS = 110;
const SHOWCASE_MAX_MS = 5200;
// Showcases play one-at-a-time from a queue (two batches don't stomp each
// other — the first finishes its animation before the second starts). Cap the
// backlog so a flood can't build a minute-long tail; oldest queued get dropped.
const QUEUE_CAP = 8;

export interface AgentEdit {
  entityId: string;
  mode: CanvasMode;
}

// A batch of same-mode changes from one broadcast, shown as a single unit: one
// highlight wrapping all `memberIds`, a smooth pan down them, and an "adding X"
// label. `id` is unique per segment so effects re-fire even for back-to-back
// segments of the same shape. A single-item change is just a segment of size 1.
export interface AgentShowcase {
  id: number;
  mode: CanvasMode;
  memberIds: string[];
  op: AgentOp;
  noun: string;
  count: number;
  agentName: string;
  isClaude: boolean;
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
  count: number; // how many of `kind` this action touched (batch size)
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

type Change = { id: string; snap: Snap; op: AgentOp };

// Group a broadcast's changes into per-mode segments, ordered by the mode the
// agent touched first. Each segment becomes one queued showcase — so a batch
// that spans two modes plays as two clean sweeps (mode A fully, then mode B)
// rather than interleaving tabs. Within a segment the member order doesn't
// matter here; App resolves top→bottom from the live DOM when it pans.
function segmentByMode(changed: Change[]): { mode: CanvasMode; noun: string; op: AgentOp; ids: string[] }[] {
  const groups = new Map<CanvasMode, { noun: string; firstMs: number; created: number; ids: string[] }>();
  for (const c of changed) {
    const g = groups.get(c.snap.mode);
    if (g) {
      g.ids.push(c.id);
      g.firstMs = Math.min(g.firstMs, c.snap.ms);
      if (c.op === "created") g.created += 1;
    } else {
      groups.set(c.snap.mode, {
        noun: c.snap.noun,
        firstMs: c.snap.ms,
        created: c.op === "created" ? 1 : 0,
        ids: [c.id],
      });
    }
  }
  return [...groups.entries()]
    .sort((a, b) => a[1].firstMs - b[1].firstMs)
    .map(([mode, g]) => ({
      mode,
      noun: g.noun,
      // A mixed group is labelled by its dominant intent; adds win ties.
      op: g.created >= g.ids.length - g.created ? "created" : "updated",
      ids: g.ids,
    }));
}

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
 *   - `showcase` — the batch currently being spotlighted (all its member ids,
 *                  mode, and an "adding X" label); App pans it, AgentCursor
 *                  wraps it. Batches queue and play one-at-a-time.
 *   - `edit`     — the showcase's first member as a lone cursor target, for
 *                  consumers that just need "is it editing and where"
 *   - `agents`   — the connected-agents list
 *   - `online`   — whether an agent is presently around
 *   - `reading`  — true for a beat after an agent reads the canvas (state.read)
 *   - `lastAction` — the most recent classified change, for the notification feed
 *
 * Changes are found by diffing `updatedAt` against the previous snapshot and
 * grouped per mode into showcases; whether to fire is gated on the server's
 * `lastChangeBy` hint (read from a ref), so a human editing an agent-created
 * item never triggers it.
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
  const presenceTimer = useRef<ReturnType<typeof setTimeout>>();
  const readingTimer = useRef<ReturnType<typeof setTimeout>>();
  // FIFO of showcases waiting to play, plus the timer that ends the one on
  // screen. A broadcast appends to `queue`; a single driver plays them strictly
  // one-at-a-time so two batches never stomp each other's animation.
  const queue = useRef<AgentShowcase[]>([]);
  const showcaseTimer = useRef<ReturnType<typeof setTimeout>>();
  const showcaseSeq = useRef(0);
  const nonce = useRef(0);

  const [showcase, setShowcase] = useState<AgentShowcase | null>(null);
  const [online, setOnline] = useState(false);
  const [reading, setReading] = useState(false);
  const [lastAction, setLastAction] = useState<AgentAction | null>(null);

  // The single cursor target, derived from the active showcase's first member —
  // kept for consumers (e.g. header presence chip) that only need "is it editing
  // and where". The rich per-batch view lives in `showcase`.
  const edit = useMemo<AgentEdit | null>(
    () => (showcase && showcase.memberIds.length > 0
      ? { entityId: showcase.memberIds[0], mode: showcase.mode }
      : null),
    [showcase],
  );

  // Play the next queued showcase (if idle). Firing this on completion drains
  // the queue in order; calling it while one is playing is a no-op — the running
  // timer will pull the next when it ends.
  const advance = useRef<() => void>(() => {});
  advance.current = () => {
    if (showcaseTimer.current) return; // one is on screen; it'll pull the next
    const next = queue.current.shift();
    if (!next) {
      setShowcase(null);
      return;
    }
    setShowcase(next);
    // One notification per batch: "created 10 itinerary events".
    nonce.current += 1;
    setLastAction({
      nonce: nonce.current,
      op: next.op,
      kind: next.noun,
      count: next.count,
      mode: next.mode,
      agentName: next.agentName,
      isClaude: next.isClaude,
    });
    setOnline(true);
    clearTimeout(presenceTimer.current);
    presenceTimer.current = setTimeout(() => setOnline(false), PRESENCE_MS);

    const dur = Math.min(
      SHOWCASE_MAX_MS,
      SHOWCASE_MIN_MS + Math.max(0, next.count - 1) * SHOWCASE_PER_ITEM_MS,
    );
    showcaseTimer.current = setTimeout(() => {
      showcaseTimer.current = undefined;
      advance.current();
    }, dur);
  };

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

    // First state for this canvas: seed silently, fire nothing, reset the queue.
    if (seededFor.current !== canvasId) {
      seededFor.current = canvasId;
      queue.current = [];
      clearTimeout(showcaseTimer.current);
      showcaseTimer.current = undefined;
      setShowcase(null);
      setOnline(false);
      setReading(false);
      setLastAction(null);
      snapshot();
      return;
    }

    // Every entity created or updated since the last snapshot. Classify created
    // (new id) vs updated (existing id, newer time).
    const changed: Change[] = [];
    for (const [id, v] of cur) {
      const before = prev.current.get(id);
      if (!before) {
        changed.push({ id, snap: v, op: "created" });
      } else if (v.ms > before.ms) {
        changed.push({ id, snap: v, op: "updated" });
      }
    }

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

    // Turn this broadcast into one-or-more queued showcases (per mode). Removals
    // have no on-screen anchor left, so they show as a label-only segment.
    const segments =
      changed.length > 0
        ? segmentByMode(changed)
        : removed
          ? [{ mode: removed.mode, noun: removed.noun, op: "removed" as AgentOp, ids: [] }]
          : [];

    for (const seg of segments) {
      showcaseSeq.current += 1;
      queue.current.push({
        id: showcaseSeq.current,
        mode: seg.mode,
        memberIds: seg.ids,
        op: seg.op,
        noun: seg.noun,
        count: Math.max(1, seg.ids.length),
        agentName: who.name,
        isClaude: who.isClaude,
      });
    }
    // Bound the backlog — drop the oldest queued so a flood can't tail forever.
    if (queue.current.length > QUEUE_CAP) {
      queue.current.splice(0, queue.current.length - QUEUE_CAP);
    }
    if (segments.length > 0) advance.current();
  }, [state, canvasId, lastChangeBy]);

  useEffect(
    () => () => {
      clearTimeout(showcaseTimer.current);
      clearTimeout(presenceTimer.current);
      clearTimeout(readingTimer.current);
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

  return { edit, showcase, agents, online, reading, lastAction };
}
