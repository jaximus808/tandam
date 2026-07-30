import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { onConnStatus, reconnectNow, type ConnStatus } from "../lib/ws";

// TDM-134 — a lightweight connection-status chip. State is push-only over the
// WebSocket, so a transient drop (wifi blip, laptop sleep, server restart)
// freezes the board while the freshness clock keeps ticking — it LOOKS live
// while it is stale. This chip is the only visible signal of that: it stays
// hidden while connected, then surfaces the moment pushes stop.
//
//   reconnecting → amber, still inside the auto-retry budget
//   offline      → rose, budget exhausted; a Retry button is the manual way back
//
// Colours follow the codebase convention for status semantics (amber/rose, as
// in DocsMode's stale dot and RoadmapMode's state hues); the chip surface uses
// the paper/surface/ink tokens so it flips with the theme.

// A compact "last synced" phrase from an epoch-ms timestamp. Recomputed on a
// 1s tick while the chip is visible so the number actually counts up.
function agoLabel(lastSyncAt: number | null, now: number): string | null {
  if (lastSyncAt == null) return null;
  const secs = Math.max(0, Math.floor((now - lastSyncAt) / 1000));
  if (secs < 5) return "synced just now";
  if (secs < 60) return `last synced ${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `last synced ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `last synced ${hrs}h ago`;
}

export default function ConnectionStatus() {
  const [status, setStatus] = useState<ConnStatus>("connected");
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(
    () =>
      onConnStatus((s, ts) => {
        setStatus(s);
        setLastSyncAt(ts);
      }),
    [],
  );

  // Tick the relative clock only while the chip is actually showing.
  const visible = status !== "connected";
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [visible]);

  if (!visible) return null;

  const offline = status === "offline";
  const ago = agoLabel(lastSyncAt, now);

  return (
    <div
      role="status"
      aria-live="polite"
      className="tandem-toast-in fixed left-1/2 z-[90] flex -translate-x-1/2 items-center gap-2 rounded-full border border-ink/10 bg-surface/95 px-3 py-1.5 text-[12px] font-medium text-ink/80 shadow-lg backdrop-blur"
      style={{ bottom: "calc(var(--tandem-float-gap) + var(--tandem-safe-b))" }}
    >
      <span
        aria-hidden="true"
        className={[
          "h-1.5 w-1.5 shrink-0 rounded-full",
          offline ? "bg-rose-500" : "bg-amber-500 tandem-breathe",
        ].join(" ")}
      />
      {offline ? (
        <>
          <span className="text-ink">Connection lost</span>
          {ago && <span className="text-ink/50">· {ago}</span>}
          <button
            onClick={() => reconnectNow()}
            className="-my-0.5 ml-0.5 inline-flex items-center gap-1 rounded-full border border-ink/15 bg-ink/[0.03] px-2 py-0.5 text-[11px] font-semibold text-ink/70 transition-colors hover:border-ink/25 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            title="Reconnect and refresh the board"
          >
            <RotateCw size={11} strokeWidth={2} />
            Retry
          </button>
        </>
      ) : (
        <>
          <span className="text-ink">Reconnecting…</span>
          {ago && <span className="text-ink/50">· {ago}</span>}
        </>
      )}
    </div>
  );
}
