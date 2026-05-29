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

export async function fetchMe(): Promise<User | null> {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!res.ok) return null;
    return (await res.json()) as User;
  } catch {
    return null;
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
  return (await res.json()) as User;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
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
