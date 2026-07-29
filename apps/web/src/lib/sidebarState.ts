/* Per-viewer workspace position, persisted per canvas. Which top-level SURFACE
   is showing (Board / Documents), which side-panel view is selected (explorer /
   settings), and whether that panel is OPEN are local to this viewer and — like
   the open document tabs (lib/tabState) — remembered PER CANVAS, keyed by code.
   Each canvas is its own "playground": collapsing the explorer on one board
   doesn't collapse it on another.

   A genuine first visit (no saved state here) is what lets App land the viewer
   on the Board — the default surface teaches what the product is.

   Gated by the same sliding-window expiry as tab state (viewState): a board left
   untouched for hours opens clean instead of resurrecting a stale layout. Panel
   WIDTH is a genuine size preference, kept global and un-gated elsewhere. */

import { touchViewState, viewStateExpired } from "./viewState";
import { parseSidebarView, parseSurface, type SidebarView, type Surface } from "./sidebar";

const KEY_PREFIX = "tandem.sidebar.pos.";

export interface SidebarState {
  /** Which top-level surface was showing. */
  surface: Surface;
  /** The selected side-panel view, or null when nothing is selected. */
  view: SidebarView | null;
  /** Whether the side panel is open (vs collapsed). */
  open: boolean;
}

function keyFor(code: string): string {
  return KEY_PREFIX + code;
}

export function loadSidebarState(code: string | null): SidebarState | null {
  if (!code) return null;
  if (viewStateExpired()) return null; // lapsed after hours away → open clean
  try {
    const raw = localStorage.getItem(keyFor(code));
    if (!raw) return null;
    const p = JSON.parse(raw) as unknown;
    if (typeof p !== "object" || p === null) return null;
    const s = p as Partial<SidebarState> & { view?: unknown; surface?: unknown };
    return {
      // Pre-surface saves (and anything unrecognized) land on the Board — the
      // product's front door under the new navigation.
      surface: parseSurface(s.surface) ?? "board",
      // Legacy "tasks" view parses to null (the panel no longer exists).
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
