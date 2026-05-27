import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** Which edge the resize handle is on. "left" = panel docked on right side. */
  edge: "left" | "right";
}

interface ReturnShape {
  width: number;
  collapsed: boolean;
  toggleCollapsed: () => void;
  setCollapsed: (v: boolean) => void;
  resizing: boolean;
  /** Spread onto the visible <div> drag handle. */
  handleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    role: "separator";
    "aria-orientation": "vertical";
    tabIndex: 0;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
}

function readNum(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return fallback;
    return v === "1";
  } catch {
    return fallback;
  }
}

export function useResizablePanel(opts: Options): ReturnShape {
  const widthKey = `${opts.storageKey}.width`;
  const collapsedKey = `${opts.storageKey}.collapsed`;

  const clamp = useCallback(
    (n: number) => Math.max(opts.minWidth, Math.min(opts.maxWidth, n)),
    [opts.minWidth, opts.maxWidth]
  );

  const [width, setWidth] = useState<number>(() =>
    clamp(readNum(widthKey, opts.defaultWidth))
  );
  const [collapsed, setCollapsedState] = useState<boolean>(() =>
    readBool(collapsedKey, false)
  );
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(widthKey, String(width)); } catch { /* ignore */ }
  }, [width, widthKey]);

  useEffect(() => {
    try { localStorage.setItem(collapsedKey, collapsed ? "1" : "0"); } catch { /* ignore */ }
  }, [collapsed, collapsedKey]);

  const setCollapsed = useCallback((v: boolean) => setCollapsedState(v), []);
  const toggleCollapsed = useCallback(() => setCollapsedState((c) => !c), []);

  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (collapsed) return;
      e.preventDefault();
      (e.target as Element).setPointerCapture(e.pointerId);
      dragState.current = { startX: e.clientX, startWidth: width };
      setResizing(true);

      const onMove = (ev: PointerEvent) => {
        if (!dragState.current) return;
        const dx = ev.clientX - dragState.current.startX;
        // edge=left → panel grows when we drag LEFT (i.e. dx < 0 widens it)
        const delta = opts.edge === "left" ? -dx : dx;
        setWidth(clamp(dragState.current.startWidth + delta));
      };
      const onUp = () => {
        dragState.current = null;
        setResizing(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [collapsed, width, clamp, opts.edge]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (collapsed) return;
      const step = e.shiftKey ? 32 : 8;
      const grow = opts.edge === "left" ? "ArrowLeft" : "ArrowRight";
      const shrink = opts.edge === "left" ? "ArrowRight" : "ArrowLeft";
      if (e.key === grow) {
        e.preventDefault();
        setWidth((w) => clamp(w + step));
      } else if (e.key === shrink) {
        e.preventDefault();
        setWidth((w) => clamp(w - step));
      }
    },
    [collapsed, clamp, opts.edge]
  );

  return {
    width,
    collapsed,
    toggleCollapsed,
    setCollapsed,
    resizing,
    handleProps: {
      onPointerDown,
      role: "separator",
      "aria-orientation": "vertical",
      tabIndex: 0,
      onKeyDown,
    },
  };
}
