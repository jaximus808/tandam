import { useEffect, useRef } from "react";
import { modeTheme } from "../lib/modeTheme";
import type { AgentEdit } from "../lib/useAgentActivity";

interface Props {
  edit: AgentEdit | null;
  name: string;
}

/**
 * A live "agent cursor": when an agent touches an element (data-agent-target),
 * a glowing halo wraps it and a labelled pointer flies in. A new edit within
 * the linger window glides everything to the next element; idle, it fades.
 *
 * Position is driven by a single always-on rAF that reads the target's rect and
 * writes transforms straight to the DOM — so following + scrolling stay smooth
 * without re-rendering React each frame. CSS transitions do the gliding/fading.
 */
export default function AgentCursor({ edit, name }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<HTMLDivElement>(null);
  // Latest edit, read inside the rAF loop without restarting it.
  const editRef = useRef<AgentEdit | null>(edit);
  editRef.current = edit;

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const e = editRef.current;
      const halo = haloRef.current;
      const pointer = pointerRef.current;
      const root = rootRef.current;
      if (halo && pointer && root) {
        const el = e ? document.querySelector<HTMLElement>(`[data-agent-target="${e.entityId}"]`) : null;
        // Inactive tabs stay mounted but display:none (keep-alive) — those have
        // no client rects, so only track an element that's actually visible.
        if (e && el && el.getClientRects().length > 0) {
          const r = el.getBoundingClientRect();
          const t = modeTheme(e.mode);
          root.style.setProperty("--agent-accent", t.solid);
          root.style.setProperty("--agent-soft", t.soft);
          halo.style.transform = `translate(${r.left - 4}px, ${r.top - 4}px)`;
          halo.style.width = `${r.width + 8}px`;
          halo.style.height = `${r.height + 8}px`;
          halo.style.opacity = "1";
          pointer.style.transform = `translate(${r.left}px, ${r.top}px)`;
          pointer.style.opacity = "1";
        } else {
          // No edit, or its element isn't on screen (different tab) — fade out.
          halo.style.opacity = "0";
          pointer.style.opacity = "0";
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={rootRef} className="pointer-events-none fixed inset-0 z-[70]" aria-hidden="true">
      {/* Halo wrapping the changed element. */}
      <div
        ref={haloRef}
        className="absolute left-0 top-0 rounded-[10px] opacity-0"
        style={{
          border: "1.5px solid var(--agent-accent)",
          background: "var(--agent-soft)",
          boxShadow: "0 0 0 4px color-mix(in srgb, var(--agent-accent) 12%, transparent), 0 8px 24px -8px var(--agent-accent)",
          transition:
            "transform .3s cubic-bezier(.22,1,.36,1), width .3s cubic-bezier(.22,1,.36,1), height .3s cubic-bezier(.22,1,.36,1), opacity .35s ease",
        }}
      />

      {/* Pointer + label, tip anchored to the element's top-left corner. */}
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

        {/* Name pill, offset to sit beside the arrow. */}
        <div
          className="absolute left-[15px] top-[13px] flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm"
          style={{ background: "var(--agent-accent)" }}
        >
          <SparkleGlyph />
          {name}
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
