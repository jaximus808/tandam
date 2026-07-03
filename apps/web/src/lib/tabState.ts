/* Per-viewer tab state, persisted per canvas (roadmap item 11 — smart
   default-open). Which documents this viewer has OPEN as tabs, which it has
   explicitly CLOSED, and which one is focused are local to the viewer (never
   broadcast). We remember them across reloads so a refresh lands you back on the
   same tabs — instead of re-opening every document and focusing whatever sorts
   first ("why does it open to sheets"). Keyed by canvas code. */

const KEY_PREFIX = "tandem.tabs.";

export interface TabState {
  /** Open tab document ids, in display order. */
  open: string[];
  /** Documents this viewer explicitly closed (so the sync won't reopen them). */
  closed: string[];
  /** The focused document id (effective), or null if none / on the welcome page. */
  active: string | null;
  /** Whether the viewer was following the agent (vs pinned to their own tab). */
  following: boolean;
}

function keyFor(code: string): string {
  return KEY_PREFIX + code;
}

export function loadTabState(code: string | null): TabState | null {
  if (!code) return null;
  try {
    const raw = localStorage.getItem(keyFor(code));
    if (!raw) return null;
    const p = JSON.parse(raw) as unknown;
    if (typeof p !== "object" || p === null) return null;
    const s = p as Partial<TabState>;
    if (!Array.isArray(s.open) || !Array.isArray(s.closed)) return null;
    return {
      open: s.open.filter((x): x is string => typeof x === "string"),
      closed: s.closed.filter((x): x is string => typeof x === "string"),
      active: typeof s.active === "string" ? s.active : null,
      following: s.following !== false, // default to following
    };
  } catch {
    return null;
  }
}

export function saveTabState(code: string, state: TabState) {
  try {
    localStorage.setItem(keyFor(code), JSON.stringify(state));
  } catch {
    // ignore quota / disabled-storage errors
  }
}
