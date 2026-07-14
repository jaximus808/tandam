import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasMode } from "../types";
import type { AgentAction } from "./useAgentActivity";
import {
  getNotificationPrefs,
  setNotificationPrefs,
  type NotificationPrefs,
} from "./api";

// The client-side default: every category on (empty map = on), chatty minor edits
// off, in-app delivery on. Matches the backend's DefaultNotificationPrefs, and is
// what anonymous (no-account) viewers get since they have nowhere to persist.
const DEFAULT_PREFS: NotificationPrefs = {
  categories: {},
  minorEdits: false,
  channels: { inApp: true, email: false, push: false },
};

// shouldNotify is the delivery gate: given a user's prefs, does this agent action
// reach them at all? In-app off silences everything; minor edits (updates/removals)
// need the minorEdits opt-in; and the action's tab must not be explicitly muted.
// Creations always pass a live (non-muted) category.
export function shouldNotify(prefs: NotificationPrefs, action: AgentAction): boolean {
  if (!prefs.channels.inApp) return false;
  if ((action.op === "updated" || action.op === "removed") && !prefs.minorEdits) return false;
  return prefs.categories[action.mode] !== false;
}

/**
 * Loads the signed-in user's per-canvas notification preferences and exposes:
 *   - `prefs`          — the current preferences (defaults until loaded)
 *   - `toggleCategory` — flip a tab's notifications on/off (persists)
 *   - `toggleMinorEdits` — flip the chatty-updates gate (persists)
 *   - `allow`          — a stable `(action) => boolean` delivery predicate for
 *                        useAgentNotifications to filter on
 *
 * Persistence is best-effort: a signed-in user with a canvas code round-trips to
 * the API (optimistic — the toggle applies immediately, a failed PATCH reverts).
 * Anonymous viewers (no account) keep prefs in memory for the session only, so
 * the filter still works even though there's nowhere to save it.
 */
export function useNotifyPrefs(canvasCode: string | undefined, signedIn: boolean) {
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const persistable = signedIn && !!canvasCode;

  // (Re)load whenever the canvas or auth state changes. Ignore a stale response
  // if the code changed mid-flight. Fail open: on error keep the defaults.
  useEffect(() => {
    if (!persistable || !canvasCode) {
      setPrefs(DEFAULT_PREFS);
      return;
    }
    let live = true;
    getNotificationPrefs(canvasCode)
      .then((p) => {
        if (live) setPrefs(p);
      })
      .catch(() => {
        if (live) setPrefs(DEFAULT_PREFS);
      });
    return () => {
      live = false;
    };
  }, [canvasCode, persistable]);

  // Optimistically apply `next`, then persist. On failure roll back to `prev`.
  const commit = useCallback(
    (prev: NotificationPrefs, next: NotificationPrefs) => {
      setPrefs(next);
      if (!persistable || !canvasCode) return;
      setNotificationPrefs(canvasCode, next)
        .then((saved) => setPrefs(saved))
        .catch(() => setPrefs(prev));
    },
    [canvasCode, persistable],
  );

  const toggleCategory = useCallback(
    (mode: CanvasMode) => {
      setPrefs((cur) => {
        // Absent = on, so the first flip is always → off.
        const on = cur.categories[mode] !== false;
        const next: NotificationPrefs = {
          ...cur,
          categories: { ...cur.categories, [mode]: !on },
        };
        commit(cur, next);
        return next;
      });
    },
    [commit],
  );

  const toggleMinorEdits = useCallback(() => {
    setPrefs((cur) => {
      const next = { ...cur, minorEdits: !cur.minorEdits };
      commit(cur, next);
      return next;
    });
  }, [commit]);

  // Keep the latest prefs in a ref so `allow` stays referentially stable — the
  // notifications effect depends on it and shouldn't re-run on every toggle.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const allow = useCallback((action: AgentAction) => shouldNotify(prefsRef.current, action), []);

  return { prefs, toggleCategory, toggleMinorEdits, allow, persistable };
}
