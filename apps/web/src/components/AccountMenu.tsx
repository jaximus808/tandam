import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Inbox } from "lucide-react";
import { fetchMe, logout, GOOGLE_CLIENT_ID, type User } from "../lib/auth";
import {
  listNotifications,
  markNotificationsRead,
  type AppNotification,
} from "../lib/api";
import SignInModal from "./SignInModal";

// AccountMenu shows the signed-in user's avatar (with a sign-out dropdown), or a
// "Sign in" button that opens SignInModal when signed out. Renders nothing if
// sign-in isn't configured (no VITE_GOOGLE_CLIENT_ID) so the header degrades
// cleanly.
//
// The account inbox lives here too: instead of a separate bell, unread
// notifications badge the avatar, and an "Inbox" row in the dropdown opens the
// list of invites (shared canvases). Pass `onOpenCanvas` to make those clickable.
export default function AccountMenu({
  onShowCanvases,
  onUserChange,
  onOpenCanvas,
}: {
  onShowCanvases?: () => void;
  // Notified whenever the signed-in user changes (initial load, sign-in,
  // sign-out) so a parent can keep its own copy of `me` in sync — e.g. App
  // needs this to auto-claim a canvas the moment a visitor signs in.
  onUserChange?: (u: User | null) => void;
  // Open a canvas from a notification (e.g. an invite someone sent).
  onOpenCanvas?: (code: string) => void;
} = {}) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  // Which face the dropdown is showing: the account menu or the inbox list.
  const [panel, setPanel] = useState<"menu" | "inbox">("menu");
  const [notes, setNotes] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMe().then((u) => {
      if (cancelled) return;
      setUser(u);
      setReady(true);
      onUserChange?.(u);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const { notifications, unread } = await listNotifications();
      setNotes(notifications);
      setUnread(unread);
    } catch {
      /* signed out or transient — leave state as-is */
    }
  }, [user]);

  // Poll the inbox while signed in so an invite that lands shows up without a
  // refresh. Clears when signed out.
  useEffect(() => {
    if (!user) {
      setNotes([]);
      setUnread(0);
      return;
    }
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [user, refresh]);

  // Close the dropdown on outside click / Escape, and reset it to the menu face.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) setPanel("menu");
  }, [menuOpen]);

  async function handleLogout() {
    await logout();
    window.google?.accounts.id.disableAutoSelect();
    setUser(null);
    setMenuOpen(false);
    onUserChange?.(null);
  }

  // Opening the inbox marks everything read (clears the avatar badge).
  async function openInbox() {
    setPanel("inbox");
    if (unread > 0) {
      setUnread(0);
      try {
        await markNotificationsRead();
      } catch {
        /* best effort — the badge reappears on next poll if it failed */
      }
    }
  }

  if (!GOOGLE_CLIENT_ID) return null;
  if (!ready) return null;

  if (!user) {
    return (
      <>
        <button
          onClick={() => setSignInOpen(true)}
          className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors shrink-0"
        >
          Sign in
        </button>
        {signInOpen && (
          <SignInModal
            onClose={() => setSignInOpen(false)}
            onSignedIn={(u) => {
              setUser(u);
              setSignInOpen(false);
              onUserChange?.(u);
            }}
          />
        )}
      </>
    );
  }

  const initials = (user.displayName || user.email || "?").trim().charAt(0).toUpperCase();

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        onClick={() => setMenuOpen((o) => !o)}
        className="relative flex h-8 w-8 items-center justify-center rounded-full overflow-hidden bg-blue-600 text-white text-sm font-semibold hover:ring-2 hover:ring-blue-300 transition"
        title={unread > 0 ? `${unread} new notification${unread === 1 ? "" : "s"}` : user.email}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt=""
            className="w-full h-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          initials
        )}
        {/* Unread badge — the notification signal now lives on the avatar. */}
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex min-w-[16px] items-center justify-center rounded-full border-2 border-paper bg-[#C75B39] px-1 text-[9px] font-bold leading-[14px] text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 z-50 w-72 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl shadow-ink/10"
        >
          {panel === "menu" ? (
            <>
              <div className="px-3 py-2.5 border-b border-gray-100">
                <div className="text-sm font-medium text-gray-900 truncate">
                  {user.displayName || "Account"}
                </div>
                <div className="text-xs text-gray-400 truncate">{user.email}</div>
              </div>
              <div className="py-1">
                <button
                  role="menuitem"
                  onClick={openInbox}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                >
                  <Inbox className="h-4 w-4 text-gray-400" aria-hidden="true" />
                  <span>Inbox</span>
                  {unread > 0 && (
                    <span className="ml-auto flex min-w-[18px] items-center justify-center rounded-full bg-[#C75B39] px-1.5 text-[10px] font-semibold leading-[18px] text-white">
                      {unread > 9 ? "9+" : unread}
                    </span>
                  )}
                </button>
                {onShowCanvases && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onShowCanvases();
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                  >
                    My canvases
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={handleLogout}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                >
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-gray-100 px-2 py-2">
                <button
                  onClick={() => setPanel("menu")}
                  aria-label="Back"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="font-display text-sm font-medium text-gray-900">Inbox</span>
              </div>
              {notes.length === 0 ? (
                <div className="px-4 py-8 text-center text-[13px] text-gray-400">
                  Nothing yet. When someone shares a canvas with you, it’ll show up here.
                </div>
              ) : (
                <ul className="max-h-[60vh] divide-y divide-gray-100 overflow-y-auto">
                  {notes.map((n) => (
                    <li key={n.id}>
                      <button
                        onClick={() => {
                          if (n.canvasCode && onOpenCanvas) onOpenCanvas(n.canvasCode);
                          setMenuOpen(false);
                        }}
                        disabled={!n.canvasCode || !onOpenCanvas}
                        className={[
                          "flex w-full items-start gap-2.5 px-3 py-3 text-left transition-colors hover:bg-gray-50 disabled:cursor-default disabled:hover:bg-transparent",
                          n.read ? "" : "bg-[#C75B39]/[0.04]",
                        ].join(" ")}
                      >
                        {!n.read && (
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#C75B39]" />
                        )}
                        <span className={n.read ? "min-w-0 pl-4" : "min-w-0"}>
                          <span className="block text-[13px] leading-snug text-gray-800">
                            <span className="font-medium">{n.actorName || "Someone"}</span> shared{" "}
                            <span className="font-medium">{n.canvasName || "a canvas"}</span> with you
                          </span>
                          <span className="mt-0.5 block font-code text-[11px] text-gray-400">
                            {n.role === "write" ? "Can edit" : "View only"} · {timeAgo(n.createdAt)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
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
