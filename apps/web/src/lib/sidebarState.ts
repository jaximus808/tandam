/* Per-viewer sidebar position, persisted per canvas. Which activity-bar view is
   selected (Documents / Agent tasks / Settings) and whether the panel is OPEN are
   local to this viewer and — like the open document tabs (lib/tabState) — remembered
   PER CANVAS, keyed by code. Each canvas is its own "playground": collapsing the
   sidebar on one board doesn't collapse it on another, and a genuine first visit to
   a canvas (no saved state here) is what lets App force the Documents explorer open.

   Gated by the same sliding-window expiry as tab state (viewState): a board left
   untouched for hours opens clean instead of resurrecting a stale layout. Panel
   WIDTH is a genuine size preference, kept global and un-gated elsewhere. */

import { touchViewState, viewStateExpired } from "./viewState";
import { parseSidebarView, type SidebarView } from "./sidebar";

const KEY_PREFIX = "tandem.sidebar.pos.";

export interface SidebarState {
  /** The selected activity-bar view, or null when nothing is selected. */
  view: SidebarView | null;
  /** Whether the side panel is open (vs collapsed to the rail). */
  open: boolean;
}

function keyFor(code: string): string {
  return KEY_PREFIX + code;
}

export function loadSidebarState(code: string | null): SidebarState | null {
  if (!code) return null;
  if (viewStateExpired()) return null; // lapsed after hours away → force open clean
  try {
    const raw = localStorage.getItem(keyFor(code));
    if (!raw) return null;
    const p = JSON.parse(raw) as unknown;
    if (typeof p !== "object" || p === null) return null;
    const s = p as Partial<SidebarState>;
    return {
      view: parseSidebarView(typeof s.view === "string" ? s.view : null),
      open: s.open === true,
    };
  } catch {
    return null;
  }
}

export function saveSidebarState(code: string, state: SidebarState) {
  try {
    localStorage.setItem(keyFor(code), JSON.stringify(state));
    touchViewState(); // refresh the expiry clock on every save (sliding window)
  } catch {
    // ignore quota / disabled-storage errors
  }
}
