/* Shared expiry clock for this viewer's UI *position* — which document tabs are
   open and which side-panel view (the task bar) is showing. We restore these on
   refresh so you land back where you were, but let them lapse after a spell away
   so a canvas you haven't touched in hours opens clean instead of resurrecting a
   stale layout you no longer care about.

   Sliding window: every save refreshes the clock, so the state stays alive while
   you're using it and only expires once it's gone untouched for the TTL. Genuine
   preferences (e.g. panel width) are NOT gated by this — only position. */

const TOUCHED_KEY = "tandem.viewstate.touchedAt";

// How long persisted view position survives without a save before it's dropped.
// A few hours — long enough to survive a reload or a lunch break, short enough
// that a stale board doesn't follow you around the next day.
export const VIEW_STATE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function touchViewState() {
  try {
    localStorage.setItem(TOUCHED_KEY, String(Date.now()));
  } catch {
    /* ignore quota / disabled-storage */
  }
}

export function viewStateExpired(): boolean {
  try {
    const raw = localStorage.getItem(TOUCHED_KEY);
    if (!raw) return false; // never stamped → honor any legacy state until first save
    const t = Number(raw);
    if (!Number.isFinite(t)) return false;
    return Date.now() - t > VIEW_STATE_TTL_MS;
  } catch {
    return false;
  }
}
