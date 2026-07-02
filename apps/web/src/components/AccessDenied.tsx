import { Lock } from "lucide-react";
import type { AccessStatus } from "../lib/ws";
import type { User } from "../lib/auth";
import TandemLogo from "./TandemLogo";
import AccountMenu from "./AccountMenu";

// AccessDenied is the screen shown when a canvas can't be opened — it's private
// and you're not a member, it doesn't exist, or your access was just revoked. It
// replaces the endless "Joining canvas" spinner with a clear next step: sign in
// (the account menu is right there) or ask the owner. Signing in auto-retries
// the connection (App watches `me`).
export default function AccessDenied({
  status,
  me,
  onHome,
  onShowCanvases,
  onUserChange,
}: {
  status: AccessStatus;
  me: User | null;
  onHome: () => void;
  onShowCanvases: () => void;
  onUserChange: (u: User | null) => void;
}) {
  const notFound = status.kind === "notFound";

  return (
    <div className="flex h-screen flex-col bg-paper font-brand text-ink">
      <header className="flex items-center gap-2 border-b border-ink/10 px-4 py-3">
        <button onClick={onHome} className="group flex items-center gap-1.5" title="Back to home">
          <TandemLogo size={28} animate={false} />
          <span className="hidden font-semibold tracking-tight transition-colors group-hover:text-sky-600 sm:inline">
            Tandem
          </span>
        </button>
        <div className="ml-auto">
          <AccountMenu onShowCanvases={onShowCanvases} onUserChange={onUserChange} />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-md rounded-2xl border-[1.5px] border-ink/15 bg-white px-8 py-10 text-center shadow-[8px_8px_0_rgba(28,25,23,0.06)]">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-ink/[0.06] text-ink/60">
            <Lock className="h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="mt-5 font-display text-xl font-medium tracking-tight">
            {notFound ? "Canvas not found" : "You don’t have access"}
          </h1>
          <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-ink/60">{status.message}</p>

          {!notFound &&
            (me ? (
              <p className="mx-auto mt-3 max-w-xs text-[13px] leading-relaxed text-ink/50">
                You’re signed in as <span className="font-medium text-ink/70">{me.email}</span>. Ask
                the owner to share this canvas with that account.
              </p>
            ) : (
              <p className="mx-auto mt-3 max-w-xs text-[13px] leading-relaxed text-ink/50">
                Signed in with a different account? Use{" "}
                <span className="font-medium text-ink/70">Sign in</span> above — if it’s shared with
                you, it’ll open automatically.
              </p>
            ))}

          <div className="mt-6 flex items-center justify-center gap-2">
            <button
              onClick={onHome}
              className="btn-press rounded-md border-[1.5px] border-ink bg-white px-4 py-2 text-sm font-medium text-ink shadow-[3px_3px_0_rgba(28,25,23,0.15)]"
            >
              Back to home
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
