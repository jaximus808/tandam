import { useEffect, useRef, type CSSProperties } from "react";
import type { AgentShowcase } from "../lib/useAgentActivity";

interface Props {
  showcase: AgentShowcase | null;
  name: string;
}

// Present-tense verb for the live label ("Adding", "Updating", "Removing").
const LIVE_VERB: Record<AgentShowcase["op"], string> = {
  created: "Adding",
  updated: "Updating",
  removed: "Removing",
};

// "Adding 10 itinerary events" / "Adding a doc". Batches lead with the count;
// singles read naturally with an article. Every noun pluralises with a plain -s.
function liveLabel(s: AgentShowcase): string {
  const verb = LIVE_VERB[s.op];
  if (s.count > 1) return `${verb} ${s.count} ${s.noun}s`;
  const article = /^[aeiou]/i.test(s.noun) ? "an" : "a";
  return `${verb} ${article} ${s.noun}`;
}

/**
 * The live agent "showcase" overlay. Instead of hopping a cursor to each item in
 * a batch, one glowing halo wraps the *union* of every touched element and a
 * labelled pointer names what's happening ("Adding 10 events"). App pans the
 * viewport top→bottom across the same members, and because this reads the live
 * rects each frame the halo stretches to hold them all as they scroll into view.
 *
 * Positioning is driven by a single always-on rAF that writes transforms
 * straight to the DOM — following + scrolling stay smooth without re-rendering
 * React each frame. Label text is plain JSX (it only changes once per batch).
 */
export default function AgentCursor({ showcase, name }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<HTMLDivElement>(null);
  // Latest showcase, read inside the rAF loop without restarting it.
  const showRef = useRef<AgentShowcase | null>(showcase);
  showRef.current = showcase;

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const s = showRef.current;
      const halo = haloRef.current;
      const pointer = pointerRef.current;
      const root = rootRef.current;
      if (halo && pointer && root) {
        // Union of every member's rect that's actually on screen. Inactive tabs
        // stay mounted but display:none (keep-alive) — those report no client
        // rects, so they're naturally skipped.
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        if (s) {
          for (const id of s.memberIds) {
            const el = document.querySelector<HTMLElement>(`[data-agent-target="${id}"]`);
            if (!el || el.getClientRects().length === 0) continue;
            const r = el.getBoundingClientRect();
            left = Math.min(left, r.left);
            top = Math.min(top, r.top);
            right = Math.max(right, r.right);
            bottom = Math.max(bottom, r.bottom);
          }
        }
        const visible = s && left !== Infinity;
        if (visible) {
          halo.style.transform = `translate(${left - 5}px, ${top - 5}px)`;
          halo.style.width = `${right - left + 10}px`;
          halo.style.height = `${bottom - top + 10}px`;
          halo.style.opacity = "1";
          // Keep the label on screen even when the block is taller than the
          // viewport and its top has scrolled away — clamp into the frame.
          const px = Math.min(Math.max(left, 12), window.innerWidth - 150);
          const py = Math.min(Math.max(top, 14), window.innerHeight - 72);
          pointer.style.transform = `translate(${px}px, ${py}px)`;
          pointer.style.opacity = "1";
        } else {
          // Nothing to show (idle, or every member is on a hidden tab) — fade.
          halo.style.opacity = "0";
          pointer.style.opacity = "0";
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const label = showcase ? liveLabel(showcase) : "";
  const who = showcase?.agentName || name;

  return (
    // Agent activity is terracotta everywhere: the halo/pointer draw from the
    // themed `agent` token, not the touched mode's content hue (/DESIGN.md —
    // modeTheme stays content-level semantics only, e.g. docTypes icons).
    <div
      ref={rootRef}
      className="pointer-events-none fixed inset-0 z-[70]"
      aria-hidden="true"
      style={
        {
          "--agent-accent": "rgb(var(--color-agent))",
          "--agent-soft": "rgb(var(--color-agent) / 0.10)",
        } as CSSProperties
      }
    >
      {/* Halo wrapping the whole batch. */}
      <div
        ref={haloRef}
        className="absolute left-0 top-0 rounded-[12px] opacity-0"
        style={{
          border: "1.5px solid var(--agent-accent)",
          background: "var(--agent-soft)",
          boxShadow:
            "0 0 0 4px color-mix(in srgb, var(--agent-accent) 12%, transparent), 0 8px 24px -8px var(--agent-accent)",
          transition:
            "transform .32s cubic-bezier(.22,1,.36,1), width .32s cubic-bezier(.22,1,.36,1), height .32s cubic-bezier(.22,1,.36,1), opacity .35s ease",
        }}
      />

      {/* Pointer + label, tip anchored to the block's top-left corner. */}
      <div
        ref={pointerRef}
        className="absolute left-0 top-0 opacity-0"
        style={{
          transition: "transform .3s cubic-bezier(.22,1,.36,1), opacity .35s ease",
        }}
      >
        {/* Pulsing ring at the tip — the "live" tell. */}
        <span className="absolute -left-1 -top-1 flex h-3.5 w-3.5">
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
            style={{ background: "var(--agent-accent)" }}
          />
        </span>

        {/* Custom arrow pointer. */}
        <svg width="20" height="20" viewBox="0 0 20 20" className="drop-shadow-sm">
          <path
            d="M3 2 L3 16 L7 12 L10 18 L13 16.5 L10 11 L15.5 11 Z"
            fill="var(--agent-accent)"
            stroke="white"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>

        {/* Name + live action pill, offset to sit beside the arrow. */}
        <div
          className="absolute left-[15px] top-[13px] flex items-center gap-1.5 whitespace-nowrap rounded-[4px] px-2 py-1 font-code text-[10px] font-medium text-white shadow-sm"
          style={{ background: "var(--agent-accent)" }}
        >
          <SparkleGlyph />
          <span className="font-semibold">{who}</span>
          {label && <span className="opacity-90">· {label}</span>}
          <span className="ml-0.5 inline-flex gap-[2px]">
            <Dot delay="0ms" />
            <Dot delay="160ms" />
            <Dot delay="320ms" />
          </span>
        </div>
      </div>
    </div>
  );
}

function SparkleGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M6 0.5 C6.4 3 7.2 3.8 9.5 4.2 C7.2 4.6 6.4 5.4 6 7.8 C5.6 5.4 4.8 4.6 2.5 4.2 C4.8 3.8 5.6 3 6 0.5 Z"
        fill="white"
      />
      <circle cx="10" cy="9" r="1.1" fill="white" opacity="0.85" />
    </svg>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-[3px] w-[3px] rounded-full bg-white/90"
      style={{ animation: "agentCursorBlink 1s ease-in-out infinite", animationDelay: delay }}
    />
  );
}
