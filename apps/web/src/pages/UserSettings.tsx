import { useEffect, useState } from "react";
import { LogOut, Bell, Lock, Trash2 } from "lucide-react";
import { fetchMe, logout, type User } from "../lib/auth";
import TandemLogo from "../components/TandemLogo";
import AccountMenu from "../components/AccountMenu";
import ThemeToggle from "../components/ThemeToggle";
import posthog from "../lib/posthog";

interface Props {
  onHome: () => void;
  onShowCanvases: () => void;
  onShowAbout: () => void;
  onOpenCanvas: (code: string) => void;
}

type Load =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "ready"; user: User };

function shortDate(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

// UserSettings is the account-level settings shell at /me. It surfaces the
// signed-in user's profile (name/avatar from Google) and sign-out today, and
// lays out placeholder homes for the settings we'll fill in later (notification
// prefs, default canvas visibility, delete account) so each is a follow-up task
// rather than a rebuild. Signed-out visitors get a prompt to sign in instead.
export default function UserSettings({ onHome, onShowCanvases, onShowAbout, onOpenCanvas }: Props) {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchMe().then((u) => {
      if (cancelled) return;
      setLoad(u ? { status: "ready", user: u } : { status: "signedOut" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the page in sync when the account menu signs the user in/out.
  function handleUserChange(u: User | null) {
    setLoad(u ? { status: "ready", user: u } : { status: "signedOut" });
  }

  async function handleLogout() {
    await logout();
    posthog.capture("user_signed_out");
    posthog.reset();
    window.google?.accounts.id.disableAutoSelect();
    setLoad({ status: "signedOut" });
  }

  const user = load.status === "ready" ? load.user : null;

  return (
    <div className="flex min-h-screen flex-col bg-paper font-brand text-ink">
      {/* Top chrome — breadcrumb + account menu, mirroring the Dashboard page. */}
      <header className="sticky top-0 z-40 flex items-center gap-2 border-b border-ink/10 bg-paper/85 px-4 py-3 backdrop-blur sm:px-6">
        <button onClick={onHome} className="group flex items-center gap-1.5" title="Back to home">
          <TandemLogo size={28} animate={false} />
          <span className="hidden font-semibold tracking-tight transition-colors group-hover:text-sky-600 sm:inline">
            Tandem
          </span>
        </button>
        <span className="text-ink/20">/</span>
        <button onClick={onShowCanvases} className="font-display text-[15px] font-medium text-ink/50 transition-colors hover:text-ink">
          Dashboard
        </button>
        <span className="text-ink/20">/</span>
        <span className="font-display text-[15px] font-medium">Settings</span>
        <div className="ml-auto flex items-center gap-2">
          <AccountMenu onShowCanvases={onShowCanvases} onShowAbout={onShowAbout} onUserChange={handleUserChange} onOpenCanvas={onOpenCanvas} />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {load.status === "loading" && (
          <div className="space-y-4">
            <div className="h-8 w-48 animate-pulse rounded-lg bg-surface/60" />
            <div className="h-32 animate-pulse rounded-2xl border border-ink/10 bg-surface/60" />
            <div className="h-40 animate-pulse rounded-2xl border border-ink/10 bg-surface/60" />
          </div>
        )}

        {load.status === "signedOut" && (
          <div className="mx-auto max-w-md rounded-2xl border border-ink/10 bg-surface px-8 py-10 text-center">
            <p className="font-display text-lg font-medium">Sign in to manage your account</p>
            <p className="mt-1.5 text-sm text-ink/55">
              Account settings live here once you’re signed in — your profile, preferences, and more.
            </p>
            <button
              onClick={onHome}
              className="mt-5 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper hover:opacity-90"
            >
              Back to home
            </button>
          </div>
        )}

        {user && (
          <>
            <div className="mb-8">
              <h1 className="font-display text-2xl font-medium tracking-tight">Account settings</h1>
              <p className="mt-1 text-sm text-ink/55">Manage your profile and preferences.</p>
            </div>

            {/* Profile — name / email / avatar from Google. */}
            <section className="rounded-2xl border border-ink/10 bg-surface p-5 sm:p-6">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-blue-600 text-lg font-semibold text-white">
                  {user.avatarUrl ? (
                    <img
                      src={user.avatarUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    (user.displayName || user.email || "?").trim().charAt(0).toUpperCase()
                  )}
                </div>
                <div className="min-w-0">
                  <div className="truncate font-display text-lg font-medium leading-tight">
                    {user.displayName || "Account"}
                  </div>
                  <div className="truncate text-sm text-ink/55">{user.email}</div>
                  {user.createdAt && (
                    <div className="mt-0.5 font-code text-[11px] text-ink/40">
                      Joined {shortDate(user.createdAt)}
                    </div>
                  )}
                </div>
                <button
                  onClick={handleLogout}
                  className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink/15 px-3 py-1.5 text-sm font-medium text-ink/70 transition-colors hover:border-ink/40 hover:bg-paper"
                >
                  <LogOut className="h-4 w-4" />
                  <span className="hidden sm:inline">Sign out</span>
                </button>
              </div>
              <p className="mt-4 border-t border-ink/[0.07] pt-3 text-xs text-ink/45">
                Your name and photo come from your Google account.
              </p>
            </section>

            {/* Appearance — theme preference. Device-local (persisted in this
                browser), defaults to your OS setting. */}
            <section className="mt-6 rounded-2xl border border-ink/10 bg-surface p-5 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">Appearance</div>
                  <div className="text-xs text-ink/50">
                    Light, dark, or match your device. Saved on this device.
                  </div>
                </div>
                <ThemeToggle />
              </div>
            </section>

            {/* Placeholder homes for account-level settings — each is a follow-up
                task. Kept visible (disabled) so the shell reads as intentional. */}
            <section className="mt-6 overflow-hidden rounded-2xl border border-ink/10 bg-surface">
              <SettingRow
                icon={Bell}
                title="Notifications"
                desc="Choose what agent activity and canvas invites email you."
              />
              <SettingRow
                icon={Lock}
                title="Default canvas visibility"
                desc="Whether new canvases start private or open to anyone with the code."
              />
            </section>

            {/* Danger zone — account deletion, wired up in a follow-up. */}
            <section className="mt-6 overflow-hidden rounded-2xl border border-red-200 bg-surface">
              <SettingRow
                icon={Trash2}
                title="Delete account"
                desc="Permanently remove your account and the canvases you own."
                danger
              />
            </section>
          </>
        )}
      </main>
    </div>
  );
}

// A single settings row: an icon, a title/description, and a disabled "Soon"
// affordance. The individual controls land as follow-up tasks; this keeps the
// shell laid out so adding one is a swap, not a rebuild.
function SettingRow({
  icon: Icon,
  title,
  desc,
  danger,
}: {
  icon: typeof Bell;
  title: string;
  desc: string;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center gap-3.5 border-b border-ink/[0.07] px-5 py-4 last:border-b-0 sm:px-6">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
          danger ? "bg-red-50 text-red-500" : "bg-ink/[0.04] text-ink/45"
        }`}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className={`text-sm font-medium ${danger ? "text-red-600" : "text-ink"}`}>{title}</div>
        <div className="text-xs text-ink/50">{desc}</div>
      </div>
      <span className="ml-auto shrink-0 rounded-full border border-ink/10 bg-ink/[0.03] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-ink/40">
        Soon
      </span>
    </div>
  );
}
