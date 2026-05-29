import { useEffect, useState } from "react";
import { fetchMe, logout, GOOGLE_CLIENT_ID, type User } from "../lib/auth";
import SignInModal from "./SignInModal";

// AccountMenu shows the signed-in user's avatar (with a sign-out dropdown), or a
// "Sign in" button that opens SignInModal when signed out. Renders nothing if
// sign-in isn't configured (no VITE_GOOGLE_CLIENT_ID) so the header degrades
// cleanly.
export default function AccountMenu() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchMe().then((u) => {
      if (cancelled) return;
      setUser(u);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    await logout();
    window.google?.accounts.id.disableAutoSelect();
    setUser(null);
    setMenuOpen(false);
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
            }}
          />
        )}
      </>
    );
  }

  const initials = (user.displayName || user.email || "?").trim().charAt(0).toUpperCase();

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setMenuOpen((o) => !o)}
        className="flex items-center justify-center w-8 h-8 rounded-full overflow-hidden bg-blue-600 text-white text-sm font-semibold hover:ring-2 hover:ring-blue-300 transition"
        title={user.email}
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
      </button>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
          <div
            role="menu"
            className="absolute right-0 mt-1 z-20 min-w-[12rem] rounded-md bg-white border border-gray-200 shadow-lg py-1"
          >
            <div className="px-3 py-2 border-b border-gray-100">
              <div className="text-sm font-medium text-gray-900 truncate">
                {user.displayName || "Account"}
              </div>
              <div className="text-xs text-gray-400 truncate">{user.email}</div>
            </div>
            <button
              role="menuitem"
              onClick={handleLogout}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
