import { applyFollowStyle, type FollowStyle } from "./followStyle";

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string;
  // Preference for whether canvases this user creates start "public" (anyone
  // with the code) or "private" (owner + shared accounts). Defaults "public".
  defaultCanvasVisibility?: "public" | "private";
  // Preference for what a bare code-holder gets on a PUBLIC canvas this user
  // creates: "read" (view only) or "write" (can edit). Defaults "read". Does not
  // affect the owner or shared members, who keep their own role.
  defaultPublicRole?: "read" | "write";
  // Preference for how the agent-activity showcase auto-scrolls a batch into
  // view: "cinematic" (glide top→bottom) or "minimal". Mirrored into localStorage
  // on load so the canvas can read it synchronously (see followStyle.ts).
  agentFollowStyle?: FollowStyle;
  createdAt?: string;
  lastSeenAt?: string;
}

// Public client id (not a secret). Inlined at build time by Vite. If unset,
// AccountMenu renders nothing and sign-in is unavailable.
export const GOOGLE_CLIENT_ID = (import.meta.env as Record<string, string | undefined>)
  .VITE_GOOGLE_CLIENT_ID;

// Optimistic identity cache. Every page mount used to start from `null` and
// flip to the real user once /api/auth/me resolved — a disorienting logged-out→
// logged-in flash on each navigation. We instead persist the last-known user and
// hydrate initial state from it synchronously (see getCachedUser), so the signed-
// in chrome paints immediately and fetchMe only reconciles differences (e.g. a
// changed avatar) or clears it on a definitive sign-out.
const USER_CACHE_KEY = "tandem.user";

// The last user the server confirmed, read synchronously — pass as the lazy
// initializer to useState so components render signed-in on first paint.
export function getCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

function cacheUser(user: User | null): void {
  try {
    if (user) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_CACHE_KEY);
  } catch {
    /* storage disabled / over quota — cache is best-effort */
  }
  // Mirror the account's follow-style down into the device-local layer so the
  // canvas honours it immediately (and it follows the user across devices). On
  // sign-out (user null) we leave the local value alone — it stays a device pref.
  if (user?.agentFollowStyle) applyFollowStyle(user.agentFollowStyle);
}

export async function fetchMe(): Promise<User | null> {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (res.ok) {
      const user = (await res.json()) as User;
      cacheUser(user);
      return user;
    }
    // A definitive "not authenticated" is the only thing that clears the cache —
    // this is the server "correcting" us to logged-out. Any other non-OK status
    // (5xx, proxy hiccup) is treated as transient: keep the last-known identity.
    if (res.status === 401 || res.status === 403) {
      cacheUser(null);
      return null;
    }
    return getCachedUser();
  } catch {
    // Network error — don't flap to logged-out; hold the optimistic identity.
    return getCachedUser();
  }
}

export async function loginWithGoogle(credential: string): Promise<User> {
  const res = await fetch("/api/auth/google", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ credential }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || "Sign-in failed");
  }
  const user = (await res.json()) as User;
  cacheUser(user);
  return user;
}

// setDefaultCanvasVisibility PATCHes the signed-in user's default-visibility
// preference and returns the server-confirmed user (also refreshing the identity
// cache). Throws on failure so callers can revert an optimistic UI.
export async function setDefaultCanvasVisibility(
  visibility: "public" | "private",
): Promise<User> {
  const res = await fetch("/api/auth/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ defaultCanvasVisibility: visibility }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || "Failed to update setting");
  }
  const user = (await res.json()) as User;
  cacheUser(user);
  return user;
}

// setDefaultPublicRole PATCHes the signed-in user's default public-role preference
// and returns the server-confirmed user (refreshing the identity cache). Throws
// on failure so callers can revert an optimistic UI.
export async function setDefaultPublicRole(role: "read" | "write"): Promise<User> {
  const res = await fetch("/api/auth/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ defaultPublicRole: role }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || "Failed to update setting");
  }
  const user = (await res.json()) as User;
  cacheUser(user);
  return user;
}

// setAgentFollowStyle PATCHes the signed-in user's follow-style preference and
// returns the server-confirmed user (refreshing the identity cache, which also
// mirrors the value into localStorage). Throws on failure.
export async function setAgentFollowStyle(style: FollowStyle): Promise<User> {
  const res = await fetch("/api/auth/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ agentFollowStyle: style }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || "Failed to update setting");
  }
  const user = (await res.json()) as User;
  cacheUser(user);
  return user;
}

// saveFollowStyle is the one-call setter for the follow-style preference used by
// the settings UIs. It writes the device-local value immediately (so the change
// is instant and works for signed-out visitors), then — only if signed in —
// persists it to the account so it follows the user across devices. An account
// PATCH failure is swallowed: the local write already took effect.
export async function saveFollowStyle(style: FollowStyle): Promise<void> {
  applyFollowStyle(style);
  if (!getCachedUser()) return;
  try {
    await setAgentFollowStyle(style);
  } catch {
    /* local write already applied; account sync will retry on next change */
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  } finally {
    cacheUser(null);
  }
}

// ── Google Identity Services loader ──────────────────────────────────────────

interface GoogleIdApi {
  initialize(cfg: { client_id: string; callback: (resp: { credential: string }) => void }): void;
  renderButton(parent: HTMLElement, opts: Record<string, unknown>): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdApi } };
  }
}

let gisPromise: Promise<GoogleIdApi> | null = null;

// loadGoogleId injects the GIS script once and resolves with the id API.
export function loadGoogleId(): Promise<GoogleIdApi> {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve(window.google.accounts.id);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google?.accounts?.id) resolve(window.google.accounts.id);
      else reject(new Error("GIS loaded but google.accounts.id is missing"));
    };
    script.onerror = () => reject(new Error("failed to load Google Identity Services"));
    document.head.appendChild(script);
  });
  return gisPromise;
}
