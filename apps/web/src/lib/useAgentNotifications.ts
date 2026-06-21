import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentAction } from "./useAgentActivity";

// One entry in the activity feed — an AgentAction stamped with a stable id and
// a wall-clock time for the "just now / 2m ago" label in the bell log.
export interface Notification extends AgentAction {
  id: number;
  at: number;
}

const TOAST_MS = 2600; // how long a popup lingers before it fades out
const LOG_CAP = 40; // keep the bell log bounded
const MUTE_KEY = "tandem:notify-muted";

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The notification center. Fed the latest `lastAction` from useAgentActivity,
 * it maintains three things:
 *   - `toasts` — transient popups (suppressed while muted), auto-expiring
 *   - `log`    — the persistent recent-activity list shown in the bell dropdown
 *   - `unread` — count since the bell was last opened, for the badge
 *
 * Muting (the bell toggle) silences popups but never the log/badge — the bell
 * still tells you something happened; it just doesn't shout.
 */
export function useAgentNotifications(lastAction: AgentAction | null) {
  const [muted, setMuted] = useState(readMuted);
  const [toasts, setToasts] = useState<Notification[]>([]);
  const [log, setLog] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const lastNonce = useRef(0);
  const expiryTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
    const tm = expiryTimers.current.get(id);
    if (tm) {
      clearTimeout(tm);
      expiryTimers.current.delete(id);
    }
  }, []);

  // New action → log it, badge it, and (unless muted) pop a toast.
  useEffect(() => {
    if (!lastAction || lastAction.nonce === lastNonce.current) return;
    lastNonce.current = lastAction.nonce;
    const item: Notification = { ...lastAction, id: lastAction.nonce, at: Date.now() };

    setLog((cur) => [item, ...cur].slice(0, LOG_CAP));
    setUnread((u) => u + 1);

    if (!muted) {
      setToasts((cur) => [...cur, item]);
      const tm = setTimeout(() => dismissToast(item.id), TOAST_MS);
      expiryTimers.current.set(item.id, tm);
    }
  }, [lastAction, muted, dismissToast]);

  useEffect(() => {
    const timers = expiryTimers.current;
    return () => {
      for (const tm of timers.values()) clearTimeout(tm);
      timers.clear();
    };
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      try {
        localStorage.setItem(MUTE_KEY, next ? "1" : "0");
      } catch {
        /* private mode — fine, just won't persist */
      }
      // Going muted clears any popups already on screen.
      if (next) setToasts([]);
      return next;
    });
  }, []);

  const markRead = useCallback(() => setUnread(0), []);
  const clearLog = useCallback(() => {
    setLog([]);
    setUnread(0);
  }, []);

  return { muted, toggleMute, toasts, dismissToast, log, unread, markRead, clearLog };
}
