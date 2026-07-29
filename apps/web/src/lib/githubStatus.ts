import { useEffect, useState } from "react";
import { fetchGitHubStatus, type GitHubLinkStatus } from "./api";

/* GitHub status, client side (TDM-45).
 *
 * ONE module-level cache for the whole app, not one per component, because the
 * same PR link shows on a card AND in the detail panel AND on a second card in
 * a re-run epic — and the endpoint behind it is spending a 60-requests-per-hour
 * budget shared by every viewer of the deployment. Every request is deduped
 * (in-flight promises are shared) and cached for a minute, which mirrors the
 * server's own TTL: asking again inside it could only return the same answer.
 *
 * The hook is LAZY BY CONTRACT: it fetches only when `enabled` is true. The
 * board turns it on for the detail panel and for a small, recent slice of
 * cards, so opening a board with 200 done tasks costs nothing. A chip whose
 * status was never fetched renders exactly like one whose status came back
 * unknown — no dot — so nothing on screen depends on whether a lookup happened.
 */

const TTL_MS = 60_000;

type Entry = { at: number; value: GitHubLinkStatus };

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<GitHubLinkStatus | null>>();

function key(code: string, url: string): string {
  return `${code} ${url}`;
}

/** Cached value if it's still fresh. Exported for tests and for warm reads. */
export function cachedStatus(code: string, url: string): GitHubLinkStatus | null {
  const hit = cache.get(key(code, url));
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key(code, url));
    return null;
  }
  return hit.value;
}

async function loadStatus(code: string, url: string): Promise<GitHubLinkStatus | null> {
  const k = key(code, url);
  const pending = inFlight.get(k);
  if (pending) return pending;

  const p = fetchGitHubStatus(code, url)
    .then((value) => {
      cache.set(k, { at: Date.now(), value });
      return value;
    })
    // A failed lookup is CACHED as nothing and simply not retried by this
    // render: the chip stays a plain link. The board must never turn a GitHub
    // outage into an error state of its own.
    .catch(() => null)
    .finally(() => inFlight.delete(k));

  inFlight.set(k, p);
  return p;
}

/**
 * Resolve one link's status, if and when the caller says it's worth it.
 * Returns null until (and unless) an answer exists.
 */
export function useGitHubStatus(
  code: string,
  url: string | null,
  enabled: boolean,
): GitHubLinkStatus | null {
  const [status, setStatus] = useState<GitHubLinkStatus | null>(() =>
    url ? cachedStatus(code, url) : null,
  );

  useEffect(() => {
    if (!url) {
      setStatus(null);
      return;
    }
    const warm = cachedStatus(code, url);
    if (warm) {
      setStatus(warm);
      return;
    }
    if (!enabled) return;

    let live = true;
    void loadStatus(code, url).then((value) => {
      if (live) setStatus(value);
    });
    return () => {
      live = false;
    };
  }, [code, url, enabled]);

  // Fall back to the shared cache on every render, so a chip that was never
  // allowed to fetch still shows the answer once something else (the detail
  // panel, another card with the same PR) has paid for it. Free: no request,
  // no state.
  return status ?? (url ? cachedStatus(code, url) : null);
}
