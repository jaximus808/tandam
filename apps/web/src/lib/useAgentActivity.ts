import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { CanvasMode, CanvasState } from "../types";
import type { ChangeActor } from "./ws";

// How the agent's live presence behaves:
//   - CURSOR_MS: the cursor lingers this long on the last-touched element, then
//     fades. A new edit inside the window glides the cursor to it and resets.
//   - PRESENCE_MS: how long "Claude" stays shown as connected after its last
//     edit (the cursor is gone, but we still know it's around).
const CURSOR_MS = 2000;
const PRESENCE_MS = 20_000;

export interface AgentEdit {
  entityId: string;
  mode: CanvasMode;
}

export interface PresentAgent {
  name: string;
  isClaude: boolean;
}

// updatedAt is typed as number but the wire actually carries RFC3339 strings —
// normalise either to epoch ms so diffs are reliable.
function toMs(u: number | string): number {
  if (typeof u === "number") return u;
  const ms = Date.parse(u);
  return Number.isNaN(ms) ? 0 : ms;
}

const KIND_MODE: { key: keyof CanvasState; mode: CanvasMode }[] = [
  { key: "pins", mode: "map" },
  { key: "events", mode: "itinerary" },
  { key: "notes", mode: "docs" },
  { key: "roadmapItems", mode: "roadmap" },
  { key: "sheets", mode: "sheets" },
  { key: "sheetRows", mode: "sheets" },
  { key: "charts", mode: "charts" },
];

/**
 * Watches canvas state for agent-authored changes and exposes a transient
 * "cursor target" (the element an agent just touched) plus a connected-agents
 * list. The changed entity is found by diffing `updatedAt` against the previous
 * snapshot; whether to fire is gated on the server's `lastChangeBy` hint (read
 * from a ref), so a human editing an agent-created item never triggers it.
 */
export function useAgentActivity(
  canvasId: string | undefined,
  state: CanvasState | null,
  lastChangeBy: MutableRefObject<ChangeActor | undefined>,
) {
  // entityId -> last-seen updatedAt(ms). Seeded once per canvas so the initial
  // load doesn't fire the cursor for every pre-existing item.
  const prev = useRef<Map<string, number>>(new Map());
  const seededFor = useRef<string | undefined>(undefined);
  const cursorTimer = useRef<ReturnType<typeof setTimeout>>();
  const presenceTimer = useRef<ReturnType<typeof setTimeout>>();

  const [edit, setEdit] = useState<AgentEdit | null>(null);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    if (!state) return;

    // Snapshot every entity with its mode + last-touched time.
    const cur = new Map<string, { ms: number; mode: CanvasMode }>();
    for (const { key, mode } of KIND_MODE) {
      const rec = state[key] as Record<string, { id: string; updatedAt: number | string }>;
      for (const e of Object.values(rec)) {
        cur.set(e.id, { ms: toMs(e.updatedAt), mode });
      }
    }

    const snapshot = () => {
      const m = new Map<string, number>();
      for (const [id, v] of cur) m.set(id, v.ms);
      prev.current = m;
    };

    // First state for this canvas: seed silently, fire nothing.
    if (seededFor.current !== canvasId) {
      seededFor.current = canvasId;
      setEdit(null);
      setOnline(false);
      snapshot();
      return;
    }

    // The most-recently-changed entity since the last snapshot wins the cursor.
    let best: { id: string; ms: number; mode: CanvasMode } | null = null;
    for (const [id, v] of cur) {
      const before = prev.current.get(id);
      const changed = before === undefined || v.ms > before;
      if (changed && (!best || v.ms > best.ms)) {
        best = { id, ms: v.ms, mode: v.mode };
      }
    }
    snapshot();

    // Only an agent-authored broadcast lights the cursor — a human editing an
    // agent-created item pushes "user" and is ignored.
    if (best && lastChangeBy.current === "agent") {
      setEdit({ entityId: best.id, mode: best.mode });
      setOnline(true);
      clearTimeout(cursorTimer.current);
      cursorTimer.current = setTimeout(() => setEdit(null), CURSOR_MS);
      clearTimeout(presenceTimer.current);
      presenceTimer.current = setTimeout(() => setOnline(false), PRESENCE_MS);
    }
  }, [state, canvasId]);

  useEffect(
    () => () => {
      clearTimeout(cursorTimer.current);
      clearTimeout(presenceTimer.current);
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
    // No agent has formally registered, but we just saw it write — show it.
    if (list.length === 0 && online) list.push({ name: "Claude", isClaude: true });
    return list;
  }, [state, online]);

  return { edit, agents, online };
}
