import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/* ─────────────────────────────────────────────────────────────────────────────
   useCardFlight — kanban cards that visibly MOVE when an agent moves them.

   A state push re-renders the board with the card already in its new column;
   without this it teleports, and the single most legible fact on the whole
   surface ("the fleet just moved something") reads as a re-render. So we FLIP:

     1. after every board render, remember each card's column + screen rect;
     2. on the render where a card's column changed, clone it into a fixed-
        position GHOST at the old rect, hide the real card, and animate the
        ghost to the new rect;
     3. when it lands, drop the ghost and let the real card glow.

   The ghost lives on <body>, not in the column, because each column is its own
   overflow-y-auto scroller — an in-place transform would be clipped at the lane
   boundary, which is precisely the boundary the card is crossing.

   Honest limits, both benign: rects are remembered as of the last board change,
   so scrolling a column between two moves makes a flight start slightly off;
   and a card whose old position was off-screen skips the flight and just lands
   with the glow. Under prefers-reduced-motion there's no flight at all.
   ──────────────────────────────────────────────────────────────────────────── */

const FLIGHT_MS = 620;
// How long the landing ring stays on the card after it arrives.
const LAND_MS = 2_400;

interface Snapshot {
  col: string;
  rect: DOMRect;
}

function reduceMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// Is this rect somewhere we could actually have seen the card?
function onScreen(r: DOMRect): boolean {
  return (
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > 0 &&
    r.top < window.innerHeight &&
    r.right > 0 &&
    r.left < window.innerWidth
  );
}

function fly(el: HTMLElement, from: DOMRect, to: DOMRect, onDone: () => void) {
  const ghost = el.cloneNode(true) as HTMLElement;
  // The clone must not answer the queries the real board runs (spotlight scroll,
  // the agent-cursor halo) — it's decoration with a 600ms lifespan.
  ghost.removeAttribute("data-task-id");
  ghost.removeAttribute("data-agent-target");
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.cssText = [
    "position:fixed",
    `left:${from.left}px`,
    `top:${from.top}px`,
    `width:${from.width}px`,
    `height:${from.height}px`,
    "margin:0",
    "z-index:65",
    "pointer-events:none",
    "will-change:transform",
  ].join(";");
  document.body.appendChild(ghost);

  const dx = to.left - from.left;
  const dy = to.top - from.top;
  const prevOpacity = el.style.opacity;
  el.style.opacity = "0";

  const finish = () => {
    ghost.remove();
    el.style.opacity = prevOpacity;
    onDone();
  };

  // A slight lift at the midpoint reads as "carried across" rather than
  // "slid" — the one flourish this animation gets.
  const anim = ghost.animate(
    [
      { transform: "translate(0px, 0px) scale(1)", boxShadow: "0 2px 6px -4px rgba(0,0,0,0.4)" },
      {
        transform: `translate(${dx * 0.55}px, ${dy * 0.55}px) scale(1.035)`,
        boxShadow: "0 18px 34px -14px rgba(0,0,0,0.45)",
        offset: 0.55,
      },
      { transform: `translate(${dx}px, ${dy}px) scale(1)`, boxShadow: "0 2px 6px -4px rgba(0,0,0,0.4)" },
    ],
    { duration: FLIGHT_MS, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" },
  );
  anim.addEventListener("finish", finish);
  anim.addEventListener("cancel", finish);
}

/**
 * Watch the cards under `root` and animate any that change column.
 *
 * @param dep     whatever identity changes when the board's data changes
 *                (`state.actions`, the scope, the filter) — the sweep runs on
 *                these and only these, so ordinary re-renders stay free.
 * @returns the ids that just landed, mapped to the timestamp they landed at
 *          (the card reads it to draw its arrival ring).
 */
export function useCardFlight(
  root: RefObject<HTMLElement | null>,
  deps: unknown[],
  enabled = true,
): Record<string, number> {
  const prev = useRef<Map<string, Snapshot>>(new Map());
  const flying = useRef<Set<string>>(new Set());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [landed, setLanded] = useState<Record<string, number>>({});

  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    const cards = Array.from(host.querySelectorAll<HTMLElement>("[data-task-id]"));
    const next = new Map<string, Snapshot>();
    const movers: { id: string; el: HTMLElement; from: DOMRect; to: DOMRect }[] = [];

    for (const card of cards) {
      const id = card.dataset.taskId;
      if (!id) continue;
      const col = card.dataset.taskCol ?? "";
      const rect = card.getBoundingClientRect();
      const before = prev.current.get(id);
      if (before && before.col !== col) {
        movers.push({ id, el: card, from: before.rect, to: rect });
      }
      next.set(id, { col, rect });
    }
    prev.current = next;
    if (movers.length === 0) return;

    const now = Date.now();
    setLanded((cur) => {
      const out = { ...cur };
      for (const m of movers) out[m.id] = now;
      return out;
    });
    for (const m of movers) {
      clearTimeout(timers.current.get(m.id));
      timers.current.set(
        m.id,
        setTimeout(() => {
          timers.current.delete(m.id);
          setLanded((cur) => {
            if (!(m.id in cur)) return cur;
            const out = { ...cur };
            delete out[m.id];
            return out;
          });
        }, LAND_MS),
      );
    }

    if (!enabled || reduceMotion()) return;
    for (const m of movers) {
      // Already mid-flight (a second push during the animation), or it moved
      // from somewhere nobody could see — land it without the theatrics.
      if (flying.current.has(m.id)) continue;
      if (!onScreen(m.from) || !onScreen(m.to)) continue;
      if (Math.abs(m.to.left - m.from.left) < 4 && Math.abs(m.to.top - m.from.top) < 4) continue;
      flying.current.add(m.id);
      fly(m.el, m.from, m.to, () => flying.current.delete(m.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Drop any pending glow timers when the board unmounts.
  useLayoutEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  return landed;
}
