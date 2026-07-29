import { useCallback, useEffect, useState } from "react";

/* ─────────────────────────────────────────────────────────────────────────────
   Follow preferences — "pull me to whatever the fleet is doing".

   This is the camera switch. When follow is ON, an agent-authored change takes
   the viewer to it: a document edit opens that tab and pans the batch into view;
   a board transition (ready → working → done) switches to the Board and
   spotlights the card as it flies between columns.

   Two dials, both per-canvas and device-local (localStorage — no auth, works for
   a signed-out visitor):

     · on      — follow at all
     · agents  — null = every agent; otherwise the SUBSET of agent names being
                 followed, so a viewer with six agents running can watch the two
                 they care about and let the rest work quietly.

   Agent identity here is the NAME, because that's what the fleet lifecycle
   pings carry as their actor (see lib/ws FleetActivity) — the same string the
   roster and the board's claimant chips show.

   What follow deliberately does NOT do is override the viewer while they're
   writing: that gate lives in useFocusGuard, not here.
   ──────────────────────────────────────────────────────────────────────────── */

export interface FollowPrefs {
  on: boolean;
  /** null = follow every agent; otherwise the agent names (verbatim) to follow. */
  agents: string[] | null;
}

// Following everyone is the default: the whole point of the surface is that a
// fleet feels alive without you configuring anything first.
export const DEFAULT_FOLLOW: FollowPrefs = { on: true, agents: null };

const KEY_PREFIX = "tandem.follow.";
// Same-tab change signal — `storage` only fires cross-tab, and several mounted
// consumers (the header control, App's follow effects) must agree immediately.
const EVENT = "tandem:followprefschange";

function storageKey(code: string): string {
  return `${KEY_PREFIX}${code}`;
}

function parse(raw: string | null): FollowPrefs | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<FollowPrefs>;
    if (typeof v.on !== "boolean") return null;
    const agents = Array.isArray(v.agents)
      ? v.agents.filter((a): a is string => typeof a === "string")
      : null;
    // An empty subset would mean "follow nobody", which is just follow off —
    // normalise it away so the two dials can't disagree.
    return { on: v.on, agents: agents && agents.length > 0 ? agents : null };
  } catch {
    return null;
  }
}

export function readFollowPrefs(code: string | undefined): FollowPrefs {
  if (!code) return DEFAULT_FOLLOW;
  try {
    return parse(localStorage.getItem(storageKey(code))) ?? DEFAULT_FOLLOW;
  } catch {
    return DEFAULT_FOLLOW;
  }
}

export function writeFollowPrefs(code: string | undefined, prefs: FollowPrefs) {
  if (!code) return;
  try {
    localStorage.setItem(storageKey(code), JSON.stringify(prefs));
  } catch {
    /* preference only */
  }
  try {
    window.dispatchEvent(new CustomEvent<{ code: string }>(EVENT, { detail: { code } }));
  } catch {
    /* ignore */
  }
}

/**
 * The live preference for a canvas plus a setter that persists and notifies
 * every other mounted consumer in the tab.
 */
export function useFollowPrefs(code: string | undefined): [FollowPrefs, (next: FollowPrefs) => void] {
  const [prefs, setPrefs] = useState<FollowPrefs>(() => readFollowPrefs(code));

  // Re-read on canvas change (each board carries its own camera setting).
  useEffect(() => {
    setPrefs(readFollowPrefs(code));
  }, [code]);

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ code: string }>).detail;
      if (!code || detail?.code !== code) return;
      setPrefs(readFollowPrefs(code));
    };
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, [code]);

  const update = useCallback(
    (next: FollowPrefs) => {
      setPrefs(next);
      writeFollowPrefs(code, next);
    },
    [code],
  );

  return [prefs, update];
}

/**
 * Is this actor one we're following? `actor` is a fleet-ping actor string: an
 * agent name, "human" (your own approve / reject — never follow yourself
 * around), or "agent" when the acting surface never registered a name.
 *
 * An anonymous agent can't match a NAMED subset, so it only rides the
 * follow-everyone setting. That's the honest reading: we can't prove it's one
 * of the two you picked.
 */
export function isFollowedActor(prefs: FollowPrefs, actor: string | undefined): boolean {
  if (!prefs.on) return false;
  const name = (actor ?? "").trim();
  if (!name || name === "human") return false;
  if (prefs.agents === null) return true;
  return prefs.agents.some((a) => a.toLowerCase() === name.toLowerCase());
}

/** Toggle one agent in/out of the followed subset (from the "all" state, that
 *  means "only this one"). Selecting everyone collapses back to `null` = all. */
export function toggleFollowedAgent(
  prefs: FollowPrefs,
  name: string,
  allNames: string[],
): FollowPrefs {
  const current = prefs.agents ?? allNames;
  const has = current.some((a) => a.toLowerCase() === name.toLowerCase());
  const next = has
    ? current.filter((a) => a.toLowerCase() !== name.toLowerCase())
    : [...current, name];
  // Nobody left → that's follow off, said a different way. Everybody → back to
  // the open-ended "all" so a newly-registered agent is followed too.
  if (next.length === 0) return { on: false, agents: null };
  if (allNames.length > 0 && next.length >= allNames.length) return { on: true, agents: null };
  return { on: true, agents: next };
}

/** Short label for the header control: "Following" / "2 agents" / "Off". */
export function followSummary(prefs: FollowPrefs): string {
  if (!prefs.on) return "Follow off";
  if (prefs.agents === null) return "Following";
  return `Following ${prefs.agents.length}`;
}
