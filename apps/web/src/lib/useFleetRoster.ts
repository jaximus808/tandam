import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAgentRoster, type FleetRoster } from "./api";
import { onFleetActivity, onFleetWaiting } from "./ws";

/* useFleetRoster — the live "who is working on what" read (TDM-47).
 *
 * The roster is a REST read, kept fresh by the WS lifecycle pings rather than
 * by polling: every claim / completion / approval pushes one `activity` message
 * carrying an actionId, and each of those is exactly a moment the roster can
 * have changed. Pings are coalesced (a batch approve fires one per action) so a
 * flood costs a single refetch.
 *
 * Two other triggers, both cheap:
 *   - `agentCount` changes — agent_register writes a state broadcast but no
 *     lifecycle ping, so a brand-new agent would otherwise not surface until the
 *     next claim.
 *   - a slow poll while the panel is OPEN, so `lastSeen`-derived staleness and
 *     server-side sort drift settle even on a quiet board. Closed, the chip
 *     rides on pings alone and costs nothing.
 */

const PING_COALESCE_MS = 400;
const OPEN_POLL_MS = 60_000;

export function useFleetRoster(code: string | undefined, open: boolean, agentCount: number) {
  const [roster, setRoster] = useState<FleetRoster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Monotonic request id: a slow response from an earlier load must never
  // overwrite a newer one (pings can arrive faster than the round trip).
  const reqId = useRef(0);
  const coalesce = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(async () => {
    if (!code) return;
    const id = ++reqId.current;
    setLoading(true);
    try {
      const next = await fetchAgentRoster(code);
      if (id !== reqId.current) return;
      setRoster(next);
      setError(null);
    } catch (err) {
      if (id !== reqId.current) return;
      setError(err instanceof Error ? err.message : "Could not load the fleet");
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [code]);

  // New canvas: drop the previous board's roster before the first read lands,
  // so the chip never shows another canvas's fleet for a beat.
  useEffect(() => {
    setRoster(null);
    setError(null);
    if (!code) return;
    void load();
  }, [code, load]);

  // A registration (or a departure) shows up in canvas state, not in the
  // lifecycle stream — refetch when the count moves. Skips the mount run, which
  // the effect above already covers.
  const seenCount = useRef<number | null>(null);
  useEffect(() => {
    if (seenCount.current === null) {
      seenCount.current = agentCount;
      return;
    }
    if (seenCount.current === agentCount) return;
    seenCount.current = agentCount;
    void load();
  }, [agentCount, load]);

  useEffect(() => {
    return onFleetActivity(() => {
      clearTimeout(coalesce.current);
      coalesce.current = setTimeout(() => void load(), PING_COALESCE_MS);
    });
  }, [load]);

  // An agent parked on (or left) the queue long poll — a presence change with no
  // action behind it, so it has its own ping (TDM-151). Coalesced through the
  // same timer: an agent that starts waiting the instant another stops costs one
  // refetch, not two.
  useEffect(() => {
    return onFleetWaiting(() => {
      clearTimeout(coalesce.current);
      coalesce.current = setTimeout(() => void load(), PING_COALESCE_MS);
    });
  }, [load]);

  useEffect(() => () => clearTimeout(coalesce.current), []);

  useEffect(() => {
    if (!open) return;
    void load(); // opening is itself a refresh
    const t = setInterval(() => void load(), OPEN_POLL_MS);
    return () => clearInterval(t);
  }, [open, load]);

  return { roster, error, loading, reload: load };
}
