import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import {
  listNotifications,
  markNotificationsRead,
  type AppNotification,
} from "../lib/api";

// InboxBell is the account-level inbox shown in the homepage header when signed
// in. It surfaces "a canvas was shared with you" notifications (migration 0022)
// with an unread badge; opening the panel marks them read, and a click opens the
// shared canvas. Renders nothing when signed out (`enabled` false) so the header
// degrades cleanly.
export default function InboxBell({
  enabled,
  onOpenCanvas,
}: {
  enabled: boolean;
  onOpenCanvas: (code: string) => void;
}) {
  const [notes, setNotes] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const { notifications, unread } = await listNotifications();
      setNotes(notifications);
      setUnread(unread);
    } catch {
      /* signed out or transient — leave state as-is */
    }
  }, [enabled]);

  // Initial load + light polling so a share that lands while the homepage is open
  // shows up without a refresh.
  useEffect(() => {
    if (!enabled) {
      setNotes([]);
      setUnread(0);
      return;
    }
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [enabled, refresh]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!enabled) return null;

  async function toggle() {
    const next = !open;
    setOpen(next);
    // Opening the panel clears the badge (mark the whole inbox read).
    if (next && unread > 0) {
      setUnread(0);
      try {
        await markNotificationsRead();
      } catch {
        /* best effort — the badge will reappear on next poll if it failed */
      }
    }
  }

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        onClick={toggle}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-ink/60 transition-colors hover:bg-ink/5 hover:text-ink"
        title="Notifications"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Bell className="h-[18px] w-[18px]" aria-hidden="true" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex min-w-[16px] items-center justify-center rounded-full bg-[#C75B39] px-1 text-[10px] font-semibold leading-[16px] text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-ink/10 bg-white shadow-xl shadow-ink/10"
        >
          <div className="border-b border-ink/10 px-4 py-2.5">
            <p className="font-display text-sm font-medium text-ink">Notifications</p>
          </div>
          {notes.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-ink/45">
              Nothing yet. When someone shares a canvas with you, it’ll show up here.
            </div>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-ink/5 overflow-y-auto">
              {notes.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => {
                      if (n.canvasCode) onOpenCanvas(n.canvasCode);
                      setOpen(false);
                    }}
                    disabled={!n.canvasCode}
                    className={[
                      "flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-ink/[0.03] disabled:cursor-default",
                      n.read ? "" : "bg-[#C75B39]/[0.04]",
                    ].join(" ")}
                  >
                    {!n.read && (
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#C75B39]" />
                    )}
                    <span className={n.read ? "min-w-0" : "min-w-0"}>
                      <span className="block text-[13px] leading-snug text-ink">
                        <span className="font-medium">{n.actorName || "Someone"}</span> shared{" "}
                        <span className="font-medium">{n.canvasName || "a canvas"}</span> with you
                      </span>
                      <span className="mt-0.5 block font-code text-[11px] text-ink/40">
                        {n.role === "write" ? "Can edit" : "View only"} · {timeAgo(n.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(then).toLocaleDateString();
}
