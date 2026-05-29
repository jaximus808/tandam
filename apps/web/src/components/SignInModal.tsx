import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Sparkles, Bot, Share2, Lock, type LucideIcon } from "lucide-react";
import { loadGoogleId, loginWithGoogle, GOOGLE_CLIENT_ID, type User } from "../lib/auth";
import TandemLogo from "./TandemLogo";

interface Props {
  onClose: () => void;
  onSignedIn: (user: User) => void;
}

function FeatureRow({
  icon: Icon,
  tint,
  title,
  desc,
}: {
  icon: LucideIcon;
  tint: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${tint}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-900">{title}</div>
        <div className="text-xs text-gray-500 leading-snug">{desc}</div>
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
              onSignedIn(u);
            } catch (e) {
              console.error("Google sign-in failed:", e);
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

  // Portal to body: the header that renders AccountMenu uses backdrop-blur,
  // which creates a containing block for position:fixed — without the portal
  // the modal anchors to the ~56px header instead of the viewport.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="signin-title"
        className="w-full max-w-sm bg-white rounded-2xl shadow-xl overflow-hidden"
      >
        {/* Banner: the orbit logo doubles as "agents around a canvas". */}
        <div className="relative h-32 bg-gradient-to-br from-sky-100 via-blue-50 to-indigo-100 overflow-hidden">
          <div
            aria-hidden="true"
            className="absolute -top-8 -left-6 w-28 h-28 rounded-full bg-sky-300/40 blur-2xl"
          />
          <div
            aria-hidden="true"
            className="absolute -bottom-10 right-0 w-32 h-32 rounded-full bg-indigo-300/40 blur-2xl"
          />
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute top-2 right-2 z-10 w-7 h-7 flex items-center justify-center rounded-full bg-white/70 text-gray-500 hover:bg-white hover:text-gray-700 backdrop-blur transition"
          >
            ✕
          </button>
          <div className="relative h-full flex flex-col items-center justify-center gap-2">
            <TandemLogo size={52} />
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-white/80 text-[11px] font-semibold text-blue-700 shadow-sm backdrop-blur">
              <Sparkles className="w-3 h-3" />
              Access Tandem agents
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 pt-5">
          <h2 id="signin-title" className="text-lg font-semibold text-gray-900">
            Sign in to Tandem
          </h2>
          <p className="mt-1 text-sm text-gray-600 leading-relaxed">
            Create a free account to do more with your canvases:
          </p>

          <div className="mt-4 space-y-3">
            <FeatureRow
              icon={Bot}
              tint="bg-blue-50 text-blue-600"
              title="Tandem agents"
              desc="Chat with a built-in agent — no setup of your own."
            />
            <FeatureRow
              icon={Share2}
              tint="bg-emerald-50 text-emerald-600"
              title="Share with people"
              desc="Invite specific teammates to a canvas."
            />
            <FeatureRow
              icon={Lock}
              tint="bg-violet-50 text-violet-600"
              title="Private canvases"
              desc="Keep canvases only your account can open."
            />
          </div>

          <div className="mt-5 flex justify-center min-h-[44px]">
            {GOOGLE_CLIENT_ID ? (
              <div ref={googleBtnRef} />
            ) : (
              <p className="text-sm text-red-600">Sign-in isn't configured.</p>
            )}
          </div>

          <p className="mt-4 text-center text-xs text-gray-400">More sign-in options coming soon.</p>
        </div>
      </div>
    </div>,
    document.body
  );
}
