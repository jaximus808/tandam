import { useEffect, useState } from "react";

// How the agent-activity showcase auto-scrolls a batch change into view while
// you're following:
//   'cinematic' — start at the top of the change block and glide all the way to
//                 the bottom, so you watch every added item scroll past.
//   'minimal'   — a quick settle-into-view; less motion.
//
// This is the DEVICE-LOCAL layer (localStorage), read synchronously so the
// canvas can honour it with no async/auth dependency — it works for signed-out
// visitors too. For a signed-in user it's kept in sync with their account
// preference (users.agent_follow_style), which auth.cacheUser mirrors down here
// on load and auth.saveFollowStyle writes up on change.
export type FollowStyle = "cinematic" | "minimal";

const STORAGE_KEY = "tandem.followStyle";
// Same-tab change signal — the `storage` event only fires cross-tab, so every
// mounted consumer (canvas animation, in-canvas settings, /me page) listens for
// this to stay in agreement.
const FOLLOW_EVENT = "tandem:followstylechange";

const DEFAULT_STYLE: FollowStyle = "cinematic";

export function readFollowStyle(): FollowStyle {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "cinematic" || v === "minimal") return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_STYLE;
}

// Write the device-local value and notify same-tab listeners. This is the local
// half only — account persistence for signed-in users lives in auth.saveFollowStyle.
export function applyFollowStyle(style: FollowStyle) {
  try {
    localStorage.setItem(STORAGE_KEY, style);
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent<FollowStyle>(FOLLOW_EVENT, { detail: style }));
  } catch {
    /* ignore */
  }
}

// useFollowStyle exposes the current preference and re-renders when it changes
// (via any control, or an account value mirrored down on load). Read-only — to
// change it, call auth.saveFollowStyle (local + account in one).
export function useFollowStyle(): FollowStyle {
  const [style, setStyle] = useState<FollowStyle>(readFollowStyle);
  useEffect(() => {
    const onChange = (e: Event) => {
      const s = (e as CustomEvent<FollowStyle>).detail;
      if (s === "cinematic" || s === "minimal") setStyle(s);
    };
    window.addEventListener(FOLLOW_EVENT, onChange);
    return () => window.removeEventListener(FOLLOW_EVENT, onChange);
  }, []);
  return style;
}
