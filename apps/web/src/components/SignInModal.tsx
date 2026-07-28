import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Sparkles, Save, MonitorSmartphone, Copy, type LucideIcon } from "lucide-react";
import { loadGoogleId, loginWithGoogle, GOOGLE_CLIENT_ID, type User } from "../lib/auth";
import TandemLogo from "./TandemLogo";
import posthog from "../lib/posthog";

interface Props {
  onClose: () => void;
  onSignedIn: (user: User) => void;
}

function FeatureRow({
  icon: Icon,
  title,
  desc,
}: {
  icon: LucideIcon;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="shrink-0 w-8 h-8 rounded-md bg-accent/10 text-accent flex items-center justify-center">
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">{title}</div>
        <div className="text-xs text-ink/55 leading-snug">{desc}</div>
      </div>
    </div>
  );
}

// SignInModal explains why an account is worth it, then offers the providers.
// Today that's just Google; the layout leaves room to add more later. The
// Google button is rendered imperatively here (not in the header) so its iframe
// is created on open and torn down with the modal on close.
export default function SignInModal({ onClose, onSignedIn }: Props) {
  const googleBtnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const clientId = GOOGLE_CLIENT_ID;
    if (!clientId) return;
    let cancelled = false;
    loadGoogleId()
      .then((id) => {
        if (cancelled || !googleBtnRef.current) return;
        id.initialize({
          client_id: clientId,
          callback: async (resp) => {
            try {
              const u = await loginWithGoogle(resp.credential);
              posthog.identify(u.id, { name: u.displayName });
              posthog.capture("user_signed_in", { method: "google" });
              onSignedIn(u);
            } catch (e) {
              console.error("Google sign-in failed:", e);
              posthog.captureException(e instanceof Error ? e : new Error(String(e)));
            }
          },
        });
        googleBtnRef.current.innerHTML = "";
        id.renderButton(googleBtnRef.current, {
          theme: "outline",
          size: "large",
          type: "standard",
          shape: "pill",
          text: "signin_with",
          width: 260,
        });
      })
      .catch((e) => console.error(e));
    return () => {
      cancelled = true;
    };
  }, [onSignedIn]);

  // Portal to body: header filter/transform effects can create a containing
  // block for position:fixed — without the portal the modal could anchor to
  // the ~56px header instead of the viewport.
  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="signin-title"
        className="w-full max-w-sm bg-surface rounded-[10px] border border-ink/10 shadow-lg overflow-hidden"
      >
        {/* Banner: the orbit logo doubles as "agents around a canvas". Follows
            the app theme like every other modal. */}
        <div className="relative h-32 bg-paper border-b border-ink/10 dark:border-white/10 overflow-hidden">
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute top-2 right-2 z-10 w-7 h-7 flex items-center justify-center rounded-full text-ink/55 hover:bg-ink/5 hover:text-ink/70 transition-colors"
          >
            ✕
          </button>
          <div className="relative h-full flex flex-col items-center justify-center gap-2">
            <TandemLogo size={52} />
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-accent/10 text-[11px] font-medium text-accent">
              <Sparkles className="w-3 h-3" />
              Your canvases, saved
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 pt-5">
          <h2 id="signin-title" className="text-lg font-semibold text-ink">
            Sign in to Tandem
          </h2>
          <p className="mt-1 text-sm text-ink/60 leading-relaxed">
            Create a free account to keep your canvases:
          </p>

          <div className="mt-4 space-y-3">
            <FeatureRow
              icon={Save}
              title="Keep your canvases"
              desc="Saved to your account — not just a link you might lose."
            />
            <FeatureRow
              icon={MonitorSmartphone}
              title="On every device"
              desc="Sign in on your laptop or phone — they're all here."
            />
            <FeatureRow
              icon={Copy}
              title="Make any canvas yours"
              desc="Copy a canvas you have the code to into your account."
            />
          </div>

          <div className="mt-5 flex justify-center min-h-[44px]">
            {GOOGLE_CLIENT_ID ? (
              <div ref={googleBtnRef} />
            ) : (
              <p className="text-sm text-rose-600 dark:text-rose-400">Sign-in isn't configured.</p>
            )}
          </div>

          <p className="mt-4 text-center text-xs text-ink/45">More sign-in options coming soon.</p>
        </div>
      </div>
    </div>,
    document.body
  );
}
