import { useRef, useState, type ReactNode } from "react";

/* ─────────────────────────────────────────────────────────────────────────────
   SidePanel — the shared frame for every left-dock view (Documents / Tasks /
   Settings). It owns the panel width and the drag-to-resize handle on the right
   edge so each view just renders its header + body. Drag the handle to resize
   within [MIN, MAX]; drag it narrower than CLOSE_AT and the panel snaps shut.
   ──────────────────────────────────────────────────────────────────────────── */

export const SIDE_PANEL_MIN = 200;
export const SIDE_PANEL_MAX = 520;
export const SIDE_PANEL_DEFAULT = 300;
// Drag the right edge left of this (measured from the panel's own left edge) and
// the panel closes instead of clamping — a natural "shove it away" gesture.
const CLOSE_AT = 180;
// Dragging the collapsed edge past this (from the dock's left) opens the panel.
const OPEN_AT = 120;

export default function SidePanel({
  width,
  onWidthChange,
  onClose,
  children,
}: {
  width: number;
  onWidthChange: (w: number) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const left = ref.current?.getBoundingClientRect().left ?? 0;
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const raw = ev.clientX - left;
      if (raw < CLOSE_AT) {
        cleanup();
        onClose();
        return;
      }
      onWidthChange(Math.min(SIDE_PANEL_MAX, Math.max(SIDE_PANEL_MIN, raw)));
    };
    const cleanup = () => {
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    const onUp = () => cleanup();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <aside
      ref={ref}
      style={{ width }}
      className="relative z-20 hidden shrink-0 flex-col border-r border-ink/10 bg-surface/90 backdrop-blur sm:flex"
    >
      {children}
      {/* Resize handle: a wide invisible hit area straddling the right edge with a
          hairline that lights up on hover / during a drag. */}
      <div
        onPointerDown={startResize}
        onDoubleClick={() => onWidthChange(SIDE_PANEL_DEFAULT)}
        className="group absolute inset-y-0 -right-1 z-30 w-2 cursor-col-resize"
        title="Drag to resize · double-click to reset · drag left to close"
      >
        <span
          className={[
            "absolute inset-y-0 right-1 w-px transition-colors",
            dragging ? "bg-ink/40" : "bg-transparent group-hover:bg-ink/25",
          ].join(" ")}
        />
      </div>
    </aside>
  );
}

/* SidePanelReopenHandle — the grab strip shown at the dock's left edge while the
   panel is COLLAPSED (a view is still selected). Drag it right to pull the panel
   back open at that width, or click it to reopen at the remembered width. It
   shows the col-resize cursor so the edge reads as draggable. */
export function SidePanelReopenHandle({
  defaultWidth,
  onOpen,
}: {
  defaultWidth: number;
  onOpen: (width: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  function startReopen(e: React.PointerEvent) {
    e.preventDefault();
    const left = ref.current?.getBoundingClientRect().left ?? 0;
    const startX = e.clientX;
    let opened = false;
    setActive(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const raw = ev.clientX - left;
      if (raw >= OPEN_AT) {
        opened = true;
        onOpen(Math.min(SIDE_PANEL_MAX, Math.max(SIDE_PANEL_MIN, raw)));
      }
    };
    const cleanup = () => {
      setActive(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    const onUp = (ev: PointerEvent) => {
      // A click (no real drag) reopens at the remembered width.
      if (!opened && Math.abs(ev.clientX - startX) < 4) onOpen(defaultWidth);
      cleanup();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      ref={ref}
      onPointerDown={startReopen}
      className="group relative z-30 hidden w-1.5 shrink-0 cursor-col-resize sm:block"
      title="Drag or click to open the panel"
    >
      <span
        className={[
          "absolute inset-y-0 left-0 w-px transition-colors",
          active ? "bg-ink/40" : "bg-transparent group-hover:bg-ink/25",
        ].join(" ")}
      />
    </div>
  );
}
