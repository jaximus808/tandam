// Low-level scroll helpers for the agent-activity showcase pan. Kept out of
// App.tsx so the follow effect reads as intent, not scroll math.

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// The nearest scrollable ancestor of `el` — the element whose scrollTop we drive.
// Falls back to the document scroller when a mode scrolls the page itself.
export function scrollParentOf(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const s = getComputedStyle(node);
    if (/(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 1) {
      return node;
    }
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

// The container's top edge in viewport coordinates (0 for the page scroller).
function containerViewportTop(container: HTMLElement): number {
  if (container === document.scrollingElement || container === document.documentElement) return 0;
  return container.getBoundingClientRect().top;
}

// scrollTop that would put viewport-Y `clientTop` at the container's top + margin.
export function alignTopScroll(container: HTMLElement, clientTop: number, margin = 16): number {
  return container.scrollTop + (clientTop - containerViewportTop(container)) - margin;
}

// scrollTop that would put viewport-Y `clientBottom` at the container's bottom - margin.
export function alignBottomScroll(container: HTMLElement, clientBottom: number, margin = 16): number {
  return (
    container.scrollTop +
    (clientBottom - containerViewportTop(container)) -
    container.clientHeight +
    margin
  );
}

const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// Animate container.scrollTop to `to` over `duration` ms (clamped to the
// scrollable range). Returns a cancel fn. A near-zero move snaps immediately.
export function animateScrollTop(
  container: HTMLElement,
  to: number,
  duration: number,
): () => void {
  const from = container.scrollTop;
  const max = container.scrollHeight - container.clientHeight;
  const target = clamp(to, 0, max);
  if (Math.abs(target - from) < 2 || duration <= 0) {
    container.scrollTop = target;
    return () => {};
  }
  let raf = 0;
  const start = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / duration);
    container.scrollTop = from + (target - from) * easeInOutCubic(p);
    if (p < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
