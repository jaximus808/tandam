import { useEffect, useState } from "react";
import { LogOut, Bell, Lock, Globe, Trash2, Eye, Pencil } from "lucide-react";
import {
  fetchMe,
  getCachedUser,
  logout,
  setDefaultCanvasVisibility,
  setDefaultPublicRole,
  type User,
} from "../lib/auth";
import TandemLogo from "../components/TandemLogo";
import AccountMenu from "../components/AccountMenu";
import AccessTokensSection from "../components/AccessTokensSection";
import ConnectedAppsSection from "../components/ConnectedAppsSection";
import ThemeToggle from "../components/ThemeToggle";
import FollowStyleControl from "../components/FollowStyleControl";
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
  // Seed from the optimistic identity cache so a signed-in return visit paints
  // the account immediately instead of flashing the loading state; fetchMe below
  // still reconciles (updated profile, or a server-confirmed sign-out).
  const [load, setLoad] = useState<Load>(() => {
    const cached = getCachedUser();
    return cached ? { status: "ready", user: cached } : { status: "loading" };
  });

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

  // Optimistically flip the default-visibility preference, then reconcile with
  // the server; revert the toggle if the PATCH fails.
  const [savingVisibility, setSavingVisibility] = useState(false);
  async function handleVisibilityChange(next: "public" | "private") {
    if (load.status !== "ready") return;
    const prev = load.user;
    if ((prev.defaultCanvasVisibility ?? "public") === next) return;
    setLoad({ status: "ready", user: { ...prev, defaultCanvasVisibility: next } });
    setSavingVisibility(true);
    try {
      const updated = await setDefaultCanvasVisibility(next);
      setLoad({ status: "ready", user: updated });
    } catch {
      setLoad({ status: "ready", user: prev });
    } finally {
      setSavingVisibility(false);
    }
  }

  // Same optimistic pattern for the default public-role preference.
  const [savingRole, setSavingRole] = useState(false);
  async function handleRoleChange(next: "read" | "write") {
    if (load.status !== "ready") return;
    const prev = load.user;
    if ((prev.defaultPublicRole ?? "read") === next) return;
    setLoad({ status: "ready", user: { ...prev, defaultPublicRole: next } });
    setSavingRole(true);
    try {
      const updated = await setDefaultPublicRole(next);
      setLoad({ status: "ready", user: updated });
    } catch {
      setLoad({ status: "ready", user: prev });
    } finally {
      setSavingRole(false);
    }
  }

  const user = load.status === "ready" ? load.user : null;

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      {/* Top chrome — breadcrumb + account menu, mirroring the Dashboard page. */}
      <header className="sticky top-0 z-40 flex items-center gap-2 border-b border-ink/10 bg-paper px-4 py-3 sm:px-6">
        <button onClick={onHome} className="group flex items-center gap-1.5" title="Back to home">
          <TandemLogo size={28} animate={false} />
          <span className="hidden font-semibold tracking-tight transition-colors group-hover:text-accent sm:inline">
            Tandem
          </span>
        </button>
        <span className="text-ink/20">/</span>
        <button onClick={onShowCanvases} className="text-[15px] font-medium text-ink/50 transition-colors hover:text-ink">
          Dashboard
        </button>
        <span className="text-ink/20">/</span>
        <span className="text-[15px] font-medium">Settings</span>
        <div className="ml-auto flex items-center gap-2">
          <AccountMenu onShowCanvases={onShowCanvases} onShowAbout={onShowAbout} onUserChange={handleUserChange} onOpenCanvas={onOpenCanvas} />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {load.status === "loading" && (
          <div className="space-y-4">
            <div className="h-8 w-48 animate-pulse rounded-lg bg-surface/60" />
            <div className="h-32 animate-pulse rounded-lg border border-ink/10 bg-surface/60" />
            <div className="h-40 animate-pulse rounded-lg border border-ink/10 bg-surface/60" />
          </div>
        )}

        {load.status === "signedOut" && (
          <div className="mx-auto max-w-md rounded-lg border border-ink/10 bg-surface px-8 py-10 text-center">
            <p className="text-lg font-semibold tracking-tight">Sign in to manage your account</p>
            <p className="mt-1.5 text-sm text-ink/55">
              Account settings live here once you’re signed in — your profile, preferences, and more.
            </p>
            <button
              onClick={onHome}
              className="mt-5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Back to home
            </button>
          </div>
        )}

        {user && (
          <>
            <div className="mb-8">
              <h1 className="text-2xl font-semibold tracking-tight">Account settings</h1>
              <p className="mt-1 text-sm text-ink/55">Manage your profile and preferences.</p>
            </div>

            {/* Profile — name / email / avatar from Google. */}
            <section className="rounded-lg border border-ink/10 bg-surface p-5 sm:p-6">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent text-lg font-semibold text-white">
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
                  <div className="truncate text-lg font-semibold leading-tight tracking-tight">
                    {user.displayName || "Account"}
                  </div>
                  <div className="truncate text-sm text-ink/55">{user.email}</div>
                  {user.createdAt && (
                    <div className="mt-0.5 text-[11px] text-ink/40">
                      Joined {shortDate(user.createdAt)}
                    </div>
                  )}
                </div>
                <button
                  onClick={handleLogout}
                  className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md border border-ink/15 bg-surface px-3 py-1.5 text-sm font-medium text-ink/70 transition-colors hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
            <section className="mt-6 rounded-lg border border-ink/10 bg-surface p-5 sm:p-6">
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

            {/* Agent activity — how dramatic the batch-reveal auto-scroll is when
                you're following an agent. Saved to your account (and this device).*/}
            <section className="mt-6 rounded-lg border border-ink/10 bg-surface p-5 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">Agent activity reveal</div>
                  <div className="text-xs text-ink/50">
                    When an agent adds a batch while you follow it, Cinematic glides from the top of
                    the changes to the bottom so you see everything; Minimal just settles it into view.
                  </div>
                </div>
                <FollowStyleControl />
              </div>
            </section>

            {/* Default canvas visibility — per-account preference applied to
                canvases you create. Reads from `me`, PATCHes optimistically. */}
            <section className="mt-6 rounded-lg border border-ink/10 bg-surface p-5 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">Default canvas visibility</div>
                  <div className="text-xs text-ink/50">
                    Whether new canvases you create start private or open to anyone with the code.
                  </div>
                </div>
                <VisibilitySegmented
                  value={user.defaultCanvasVisibility ?? "public"}
                  disabled={savingVisibility}
                  onChange={handleVisibilityChange}
                />
              </div>
            </section>

            {/* Default public access — for canvases created public, whether a bare
                code-holder can edit or only view. Owners and people you share with
                keep their own access regardless. */}
            <section className="mt-6 rounded-lg border border-ink/10 bg-surface p-5 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">Default public access</div>
                  <div className="text-xs text-ink/50">
                    For public canvases, whether someone with just the link can edit or only view.
                    People you share with (and you) always keep full access.
                  </div>
                </div>
                <PublicRoleSegmented
                  value={user.defaultPublicRole ?? "read"}
                  disabled={savingRole}
                  onChange={handleRoleChange}
                />
              </div>
            </section>

            {/* Access tokens — user-scoped MCP credentials so an agent can act
                as this user on their private / shared canvases. */}
            <AccessTokensSection />

            {/* Connected apps — OAuth authorizations (hosted MCP connector).
                Self-hides when the user hasn't authorized anything. */}
            <ConnectedAppsSection />

            {/* Placeholder home for the remaining account setting — a follow-up
                task. Kept visible (disabled) so the shell reads as intentional. */}
            <section className="mt-6 overflow-hidden rounded-lg border border-ink/10 bg-surface">
              <SettingRow
                icon={Bell}
                title="Notifications"
                desc="Choose what agent activity and canvas invites email you."
              />
            </section>

            {/* Danger zone — account deletion, wired up in a follow-up. */}
            <section className="mt-6 overflow-hidden rounded-lg border border-rose-500/25 bg-surface">
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
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${
          danger ? "bg-rose-500/10 text-rose-600 dark:text-rose-400" : "bg-ink/[0.04] text-ink/45"
        }`}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className={`text-sm font-medium ${danger ? "text-rose-600 dark:text-rose-400" : "text-ink"}`}>{title}</div>
        <div className="text-xs text-ink/50">{desc}</div>
      </div>
      <span className="ml-auto shrink-0 rounded-full border border-ink/10 bg-ink/[0.03] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink/40">
        Soon
      </span>
    </div>
  );
}

// A Private / Public segmented control. Controlled — `value` reflects the saved
// preference (optimistically updated by the parent), `disabled` while a save is
// in flight so a rapid double-toggle can't race.
function VisibilitySegmented({
  value,
  disabled,
  onChange,
}: {
  value: "public" | "private";
  disabled?: boolean;
  onChange: (v: "public" | "private") => void;
}) {
  const opts: { key: "private" | "public"; label: string; icon: typeof Lock }[] = [
    { key: "private", label: "Private", icon: Lock },
    { key: "public", label: "Public", icon: Globe },
  ];
  return (
    <div className="inline-flex shrink-0 rounded-md border border-ink/10 bg-ink/[0.03] p-0.5">
      {opts.map(({ key, label, icon: Icon }) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(key)}
            className={`inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60 ${
              active ? "bg-accent text-white" : "text-ink/50 hover:text-ink"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

// A View-only / Can edit segmented control for the default public role. Same
// mechanics as VisibilitySegmented.
function PublicRoleSegmented({
  value,
  disabled,
  onChange,
}: {
  value: "read" | "write";
  disabled?: boolean;
  onChange: (v: "read" | "write") => void;
}) {
  const opts: { key: "read" | "write"; label: string; icon: typeof Eye }[] = [
    { key: "read", label: "View only", icon: Eye },
    { key: "write", label: "Can edit", icon: Pencil },
  ];
  return (
    <div className="inline-flex shrink-0 rounded-md border border-ink/10 bg-ink/[0.03] p-0.5">
      {opts.map(({ key, label, icon: Icon }) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(key)}
            className={`inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60 ${
              active ? "bg-accent text-white" : "text-ink/50 hover:text-ink"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
