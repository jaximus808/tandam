import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, Check } from "lucide-react";
import { modeTheme } from "../lib/modeTheme";
import { actionPhrase, shortAgo } from "../lib/agentPhrase";
import type { Notification } from "../lib/useAgentNotifications";

interface Props {
  log: Notification[];
  unread: number;
  muted: boolean;
  toggleMute: () => void;
  markRead: () => void;
  clearLog: () => void;
}

/**
 * Header bell: the always-present "an agent changed something" notifier. Rings +
 * badges on new activity (even while popups are muted), and opens a dropdown
 * with the recent-activity log and the popup mute toggle. Lives in the top-left
 * chrome, next to the tabs.
 */
export default function NotificationBell({ log, unread, muted, toggleMute, markRead, clearLog }: Props) {
  const [open, setOpen] = useState(false);
  const [ringing, setRinging] = useState(false);
  const lastSeen = useRef<number | undefined>(log[0]?.id);
  const now = Date.now();

  // Ring the bell whenever a brand-new entry lands at the top of the log.
  useEffect(() => {
    const top = log[0]?.id;
    if (top !== undefined && top !== lastSeen.current) {
      lastSeen.current = top;
      setRinging(true);
      const tm = setTimeout(() => setRinging(false), 700);
      return () => clearTimeout(tm);
    }
  }, [log]);

  function toggleOpen() {
    setOpen((o) => {
      const next = !o;
      if (next) markRead();
      return next;
    });
  }

  return (
    <div className="relative shrink-0">
      <button
        onClick={toggleOpen}
        className={[
          "relative grid h-8 w-8 place-items-center rounded-lg transition-colors",
          open ? "bg-ink/[0.06] text-ink" : "text-gray-500 hover:bg-gray-900/5 hover:text-gray-800",
        ].join(" ")}
        title={muted ? "Agent alerts — popups muted" : "Agent activity"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={unread > 0 ? `${unread} new agent change${unread > 1 ? "s" : ""}` : "Agent activity"}
      >
        <span className={ringing ? "tandem-bell-ring inline-flex" : "inline-flex"}>
          {muted ? <BellOff className="h-[17px] w-[17px]" /> : <Bell className="h-[17px] w-[17px]" />}
        </span>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-[15px] place-items-center rounded-full bg-agent px-1 font-code text-[9px] font-semibold leading-[15px] text-white ring-2 ring-paper">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="tandem-fade-in absolute left-0 z-40 mt-1.5 w-[18rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[4px_4px_0_rgba(28,25,23,0.06)]"
          >
            {/* Header — title + the popup mute toggle the bell controls. */}
            <div className="flex items-center justify-between gap-2 border-b border-ink/[0.07] px-3 py-2">
              <span className="font-code text-[10.5px] uppercase tracking-[0.16em] text-ink/45">
                Agent activity
              </span>
              <button
                onClick={toggleMute}
                className={[
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-code text-[10px] font-medium transition-colors",
                  muted
                    ? "bg-ink/[0.05] text-ink/45 hover:text-ink/70"
                    : "bg-agent/10 text-agent hover:bg-agent/15",
                ].join(" ")}
                title={muted ? "Turn agent popups on" : "Mute agent popups"}
              >
                {muted ? <BellOff className="h-3 w-3" /> : <Bell className="h-3 w-3" />}
                {muted ? "Popups off" : "Popups on"}
              </button>
            </div>

            {/* The tailing log. */}
            {log.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <p className="text-[13px] text-ink/45">No agent activity yet.</p>
                <p className="mt-1 font-code text-[10px] uppercase tracking-[0.13em] text-ink/30">
                  changes appear here live
                </p>
              </div>
            ) : (
              <ul className="max-h-[18rem] overflow-y-auto py-1">
                {log.map((n) => {
                  const accent = modeTheme(n.mode).solid;
                  return (
                    <li key={n.id} className="flex items-center gap-2.5 px-3 py-1.5">
                      <span
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-[5px]"
                        style={{ background: n.isClaude ? "#C75B39" : "#1C1917" }}
                      >
                        <Sparkle />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] leading-tight text-ink">
                        <span className="font-semibold">{n.agentName}</span>{" "}
                        <span className="text-ink/60">{actionPhrase(n.op, n.kind)}</span>
                      </span>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
                      <span className="shrink-0 font-code text-[10px] tabular-nums text-ink/35">
                        {shortAgo(n.at, now)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            {log.length > 0 && (
              <button
                onClick={clearLog}
                className="flex w-full items-center justify-center gap-1.5 border-t border-ink/[0.07] py-2 font-code text-[10.5px] uppercase tracking-[0.13em] text-ink/40 transition-colors hover:bg-ink/[0.03] hover:text-ink/70"
              >
                <Check className="h-3 w-3" />
                Clear
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Sparkle() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M6 0.5 C6.4 3 7.2 3.8 9.5 4.2 C7.2 4.6 6.4 5.4 6 7.8 C5.6 5.4 4.8 4.6 2.5 4.2 C4.8 3.8 5.6 3 6 0.5 Z"
        fill="white"
      />
      <circle cx="10" cy="9" r="1" fill="white" opacity="0.85" />
    </svg>
  );
}
