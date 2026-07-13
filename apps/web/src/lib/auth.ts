export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string;
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
