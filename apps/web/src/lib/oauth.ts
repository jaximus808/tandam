// OAuth consent flow (hosted MCP connector). The authorization server advertises
// GET /oauth/authorize as its authorization_endpoint; that path falls through to
// the SPA, which renders the consent screen (OAuthConsent), reuses the Google
// session, and drives these two backend calls. The client (claude.ai) does PKCE;
// we just carry its code_challenge through to the code we mint.

// The OAuth authorization-request parameters the client puts on the /oauth/authorize
// URL. We validate + echo them; we never generate the PKCE challenge ourselves.
export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
  resource: string;
}

// parseAuthorizationRequest reads the current URL's query string into a typed
// request. Returns null when the mandatory params for an auth-code + PKCE flow
// are absent (so the page can show a clear error instead of a broken consent).
export function parseAuthorizationRequest(search: string): AuthorizationRequest | null {
  const q = new URLSearchParams(search);
  const req: AuthorizationRequest = {
    clientId: q.get("client_id") ?? "",
    redirectUri: q.get("redirect_uri") ?? "",
    responseType: q.get("response_type") ?? "",
    codeChallenge: q.get("code_challenge") ?? "",
    codeChallengeMethod: q.get("code_challenge_method") ?? "S256",
    state: q.get("state") ?? "",
    scope: q.get("scope") ?? "",
    resource: q.get("resource") ?? "",
  };
  if (!req.clientId || !req.redirectUri || !req.codeChallenge) return null;
  if (req.responseType && req.responseType !== "code") return null;
  return req;
}

export interface AuthorizationInfo {
  clientId: string;
  clientName: string;
}

// Result of validating the request against the backend as the signed-in user.
export type AuthorizationLookup =
  | { status: "ok"; info: AuthorizationInfo }
  | { status: "signedOut" }
  | { status: "invalid"; message: string };

export async function getAuthorizationInfo(
  clientId: string,
  redirectUri: string,
): Promise<AuthorizationLookup> {
  const qs = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri });
  const res = await fetch(`/api/oauth/authorize?${qs}`, { credentials: "same-origin" });
  if (res.status === 401) return { status: "signedOut" };
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { status: "invalid", message: detail || "This authorization request is invalid." };
  }
  return { status: "ok", info: (await res.json()) as AuthorizationInfo };
}

// approveAuthorization mints the authorization code and returns the client
// callback URL (redirect_uri + code + state) to navigate to. Throws on failure.
export async function approveAuthorization(req: AuthorizationRequest): Promise<string> {
  const res = await fetch("/api/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      clientId: req.clientId,
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      codeChallengeMethod: req.codeChallengeMethod,
      state: req.state,
      scope: req.scope,
      resource: req.resource,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || "Failed to authorize");
  }
  const { redirectUri } = (await res.json()) as { redirectUri: string };
  return redirectUri;
}

// denyRedirectUrl builds the OAuth error callback for a declined consent. Safe to
// use only after the backend has confirmed redirectUri is registered.
export function denyRedirectUrl(redirectUri: string, state: string): string {
  const sep = redirectUri.includes("?") ? "&" : "?";
  let url = `${redirectUri}${sep}error=access_denied`;
  if (state) url += `&state=${encodeURIComponent(state)}`;
  return url;
}
