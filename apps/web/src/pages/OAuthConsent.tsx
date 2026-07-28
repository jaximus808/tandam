import { useEffect, useState } from "react";
import { ShieldCheck, Check, X } from "lucide-react";
import { fetchMe, getCachedUser, type User } from "../lib/auth";
import {
  parseAuthorizationRequest,
  getAuthorizationInfo,
  approveAuthorization,
  denyRedirectUrl,
  type AuthorizationRequest,
} from "../lib/oauth";
import TandemLogo from "../components/TandemLogo";
import SignInModal from "../components/SignInModal";

// OAuthConsent renders the authorization-server consent screen at /oauth/authorize
// (the endpoint advertised to MCP clients like claude.ai). It reuses the Google
// session — prompting sign-in inline if needed — validates the request against the
// backend, and on approval mints an authorization code and redirects back to the
// client. This is the browser leg of the OAuth handshake; the client did PKCE, so
// we only carry its code_challenge through.
export default function OAuthConsent() {
  const req = parseAuthorizationRequest(window.location.search);

  const [user, setUser] = useState<User | null>(getCachedUser);
  const [phase, setPhase] = useState<
    "loading" | "signedOut" | "consent" | "invalid" | "working"
  >("loading");
  const [clientName, setClientName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!req) {
      setError("This authorization link is missing required parameters.");
      setPhase("invalid");
      return;
    }
    let cancelled = false;
    (async () => {
      const me = await fetchMe();
      if (cancelled) return;
      setUser(me);
      if (!me) {
        setPhase("signedOut");
        return;
      }
      await loadInfo(req);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadInfo(r: AuthorizationRequest) {
    const lookup = await getAuthorizationInfo(r.clientId, r.redirectUri);
    if (lookup.status === "signedOut") {
      setPhase("signedOut");
      return;
    }
    if (lookup.status === "invalid") {
      setError(lookup.message);
      setPhase("invalid");
      return;
    }
    setClientName(lookup.info.clientName || "An application");
    setPhase("consent");
  }

  async function handleAllow() {
    if (!req) return;
    setPhase("working");
    try {
      const redirect = await approveAuthorization(req);
      window.location.href = redirect;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to authorize");
      setPhase("invalid");
    }
  }

  function handleDeny() {
    // redirectUri was validated as registered during loadInfo, so this is safe.
    if (req) window.location.href = denyRedirectUrl(req.redirectUri, req.state);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4 text-ink">
      <div className="w-full max-w-md rounded-2xl border border-ink/10 bg-surface p-7 shadow-xl shadow-ink/5 sm:p-8">
        <div className="flex items-center gap-2.5">
          <TandemLogo size={30} animate={false} />
          <span className="text-lg font-semibold tracking-tight">Tandem</span>
        </div>

        {phase === "loading" && (
          <div className="mt-6 space-y-3">
            <div className="h-6 w-3/4 animate-pulse rounded bg-ink/[0.06]" />
            <div className="h-20 animate-pulse rounded-xl bg-ink/[0.05]" />
            <div className="h-10 animate-pulse rounded-lg bg-ink/[0.05]" />
          </div>
        )}

        {phase === "signedOut" && (
          <>
            <h1 className="mt-6 text-xl font-semibold tracking-tight">
              Sign in to continue
            </h1>
            <p className="mt-1.5 text-sm text-ink/55">
              Sign in to your Tandem account to authorize this connection.
            </p>
            {/* SignInModal renders its own full-screen portal over this shell. */}
            <SignInModal
              onClose={handleDeny}
              onSignedIn={async (u) => {
                setUser(u);
                setPhase("loading");
                if (req) await loadInfo(req);
              }}
            />
          </>
        )}

        {phase === "invalid" && (
          <>
            <h1 className="mt-6 text-xl font-semibold tracking-tight">
              Authorization failed
            </h1>
            <p className="mt-1.5 text-sm text-ink/55">{error}</p>
            <p className="mt-4 text-xs text-ink/40">
              You can close this window and try connecting again.
            </p>
          </>
        )}

        {(phase === "consent" || phase === "working") && (
          <>
            <div className="mt-6 flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-500/10 text-sky-600">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h1 className="text-xl font-semibold leading-tight tracking-tight">
                  Authorize {clientName}
                </h1>
                <p className="mt-1 text-sm text-ink/55">
                  It will be able to act as you over MCP.
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-ink/10 bg-paper/50 p-4">
              <div className="text-xs font-medium uppercase tracking-[0.08em] text-ink/40">
                This grants access to
              </div>
              <ul className="mt-2 space-y-1.5 text-sm text-ink/75">
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-600" />
                  Read and edit canvases you own or that are shared with you
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-600" />
                  Create new canvases on your behalf
                </li>
              </ul>
              {user && (
                <div className="mt-3 border-t border-ink/[0.07] pt-3 text-xs text-ink/45">
                  Signed in as <span className="font-medium text-ink/70">{user.email}</span>
                </div>
              )}
            </div>

            <p className="mt-3 text-xs text-ink/45">
              You can revoke this access anytime from your account settings. Only authorize
              applications you trust.
            </p>

            <div className="mt-6 flex gap-3">
              <button
                onClick={handleDeny}
                disabled={phase === "working"}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-ink/15 px-4 py-2.5 text-sm font-medium text-ink/70 transition-colors hover:bg-paper disabled:opacity-50"
              >
                <X className="h-4 w-4" />
                Deny
              </button>
              <button
                onClick={handleAllow}
                disabled={phase === "working"}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {phase === "working" ? "Authorizing…" : "Allow"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
