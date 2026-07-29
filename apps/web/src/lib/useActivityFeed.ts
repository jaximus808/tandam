import { useCallback, useEffect, useRef, useState } from "react";
import { fetchActivityFeed, type ActivityEvent } from "./api";
import { onFleetActivity } from "./ws";

/* useActivityFeed — the fleet's chronological record (TDM-48).
 *
 * TWO SOURCES, ONE LIST. The REST backfill is derived from action rows, so it
 * knows the shape of history but misses everything that leaves no column behind
 * (claim expiries, releases, requeues). The WS lifecycle stream sees all of it
 * but only from the moment you connected. Neither is the feed on its own, so
 * this merges them and dedupes on (actionId, action) — the identity of a FACT,
 * not of an action, since one task legitimately appears as proposed / approved /
 * claimed / completed.
 *
 * WHO WINS A DUPLICATE. Whatever is already on screen. A live ping and a later
 * backfill can describe the same fact; keeping the incumbent means a row never
 * re-mounts (and so never re-animates) just because we refreshed.
 *
 * COST. Nothing is fetched until the Feed is actually looked at — a board where
 * nobody opens the tab pays zero. After that, each activation refreshes once;
 * between activations the socket keeps the list current for free.
 */

const FEED_LIMIT = 50;
// Kept entries. The panel shows the recent past, not an archive — an unbounded
// list on a busy board would grow all session for rows nobody scrolls to.
const MAX_KEPT = 100;

export type FeedEvent = ActivityEvent & {
  /** Arrived over the socket while the feed was on screen — the one row we animate. */
  fresh?: boolean;
};

/** A fact's identity: the same action legitimately yields several facts. */
export function factKey(e: Pick<ActivityEvent, "actionId" | "action">): string {
  return `${e.actionId}:${e.action}`;
}

// Incumbent-wins merge, newest first, capped.
function merge(existing: FeedEvent[], incoming: FeedEvent[]): FeedEvent[] {
  const seen = new Set<string>();
  const out: FeedEvent[] = [];
  for (const e of existing.concat(incoming)) {
    const k = factKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return out.length > MAX_KEPT ? out.slice(0, MAX_KEPT) : out;
}

export function useActivityFeed(code: string | undefined, active: boolean) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Facts that landed while you were looking somewhere else. Drives the small
  // count on the Feed tab; cleared the moment the feed is on screen.
  const [unseen, setUnseen] = useState(0);
  // Monotonic request id — a slow backfill must not clobber a newer one.
  const reqId = useRef(0);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const load = useCallback(async () => {
    if (!code) return;
    const id = ++reqId.current;
    setLoading(true);
    try {
      const feed = await fetchActivityFeed(code, FEED_LIMIT);
      if (id !== reqId.current) return;
      setEvents((prev) => merge(prev, feed.events ?? []));
      setError(null);
    } catch (err) {
      if (id !== reqId.current) return;
      setError(err instanceof Error ? err.message : "Could not load the activity feed");
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [code]);

  // New canvas: another board's history is not this board's.
  useEffect(() => {
    reqId.current++;
    setEvents([]);
    setError(null);
    setLoading(false);
    setUnseen(0);
  }, [code]);

  // The live stream, always on — the count on the tab has to accrue whether or
  // not anyone has opened the feed yet. Rides the same onFleetActivity seam the
  // roster uses; no second WS handler.
  useEffect(() => {
    return onFleetActivity((a) => {
      const watching = activeRef.current;
      setEvents((prev) => merge(prev, [{ ...a, fresh: watching }]));
      if (!watching) setUnseen((n) => Math.min(n + 1, 99));
    });
  }, []);

  // Opening the feed IS the fetch trigger, and every reopen is a cheap refresh.
  useEffect(() => {
    if (!active || !code) return;
    setUnseen(0);
    void load();
  }, [active, code, load]);

  return { events, error, loading, unseen, reload: load };
}
