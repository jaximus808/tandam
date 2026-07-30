import { useCallback, useEffect, useRef, useState } from "react";

/* ─────────────────────────────────────────────────────────────────────────────
   useFocusGuard — "is the human mid-thought right now?"

   Following an agent means the page moves under you. That is exactly what you
   want while you're WATCHING, and exactly what you don't want while you're
   WRITING. This hook draws that line at focus, not at the keyboard:

     BUSY  = a text field / contenteditable holds focus. Follow holds its fire;
             anything it wanted to show you is buffered and played once you
             blur. Keystrokes outside a field (shortcuts, navigation) never
             count as writing — only a focused editing surface does.

     SCROLLING (separate, softer) = a wheel/touch gesture within SCROLL_GRACE_MS.
             This does NOT stop following — it only tells the auto-pan to skip
             THIS batch so we're never fighting a gesture mid-flick. Scrolling
             around to look at things is browsing, not editing, and the whole
             complaint about the old behaviour was that a stray scroll silently
             dropped you out of follow.

   Both are exposed as refs (read inside event handlers, always current) and as
   reactive state (for the chrome that says "paused while you're typing").
   ──────────────────────────────────────────────────────────────────────────── */

// How long a noteInteraction() stamp (e.g. a drag) counts as deliberate work.
// Focused text fields don't need this — they hold busy for as long as they
// hold focus, and release it the moment they blur.
const GRACE_MS = 5_000;
// A wheel/touch gesture suppresses the next auto-pan for this long.
const SCROLL_GRACE_MS = 1_200;

function isTextEntry(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node || typeof node.tagName !== "string") return false;
  if (node.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName);
}

export interface FocusGuard {
  /** Reactive "the viewer is writing" — for UI that explains why follow paused. */
  busy: boolean;
  /** Same fact, readable synchronously inside a WS event handler. */
  busyRef: React.MutableRefObject<boolean>;
  /** True while a user scroll gesture is still warm (auto-pan should stand down). */
  scrollingRef: React.MutableRefObject<boolean>;
  /** Stamp "the viewer is doing something deliberate" from outside (e.g. a drag). */
  noteInteraction: () => void;
}

export function useFocusGuard(): FocusGuard {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const scrollingRef = useRef(false);
  // A text field currently holds focus.
  const fieldRef = useRef(false);
  const lastTypedRef = useRef(0);
  const lastScrollRef = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>();

  // Recompute busy from the two inputs and, if we're only busy because of the
  // typing grace, schedule the wake-up that clears it.
  const settle = useCallback(() => {
    const since = Date.now() - lastTypedRef.current;
    const typingWarm = since < GRACE_MS;
    const next = fieldRef.current || typingWarm;
    busyRef.current = next;
    setBusy((prev) => (prev === next ? prev : next));
    clearTimeout(timer.current);
    if (!fieldRef.current && typingWarm) {
      timer.current = setTimeout(settle, GRACE_MS - since + 40);
    }
  }, []);

  const noteInteraction = useCallback(() => {
    lastTypedRef.current = Date.now();
    settle();
  }, [settle]);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      fieldRef.current = isTextEntry(e.target);
      settle();
    };
    const onFocusOut = () => {
      fieldRef.current = false;
      // Unfocusing IS the end of the edit — resume immediately. (Tabbing to
      // another field re-arms via the focusin that follows in the same beat.)
      lastTypedRef.current = 0;
      settle();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Keys only count as writing when they land in an editing surface.
      // Anywhere else they're shortcuts or navigation — never a reason to
      // pause follow. The focus check (not a grace clock) is what keeps busy
      // true, so this is just a fallback for a field focused before mount.
      if (!isTextEntry(e.target)) return;
      fieldRef.current = true;
      settle();
    };
    const onScroll = () => {
      lastScrollRef.current = Date.now();
      scrollingRef.current = true;
      clearTimeout(scrollTimer.current);
      scrollTimer.current = setTimeout(() => {
        scrollingRef.current = Date.now() - lastScrollRef.current < SCROLL_GRACE_MS;
      }, SCROLL_GRACE_MS);
    };

    const passive: AddEventListenerOptions = { passive: true, capture: true };
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("wheel", onScroll, passive);
    window.addEventListener("touchmove", onScroll, passive);
    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("wheel", onScroll, passive);
      window.removeEventListener("touchmove", onScroll, passive);
      clearTimeout(timer.current);
      clearTimeout(scrollTimer.current);
    };
  }, [settle]);

  return { busy, busyRef, scrollingRef, noteInteraction };
}
