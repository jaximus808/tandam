/* Contention on the client (TDM-100) — did anyone else go for this task, and
   what happened when they did?

   WHY THIS EXISTS. The coordination protocol was already correct and already
   invisible. A claim is atomic, so a second agent asking for a held task is
   refused (TDM-98's fence); a write from an agent whose lease has been superseded
   is refused too; the loser is told to tap out rather than retry (TDM-99). All of
   that lived in a 409 the loser read and discarded, plus two counters on
   /api/metrics that no human looks at. The board — the one place someone watches a
   fleet — showed a task being claimed and never showed the race.

   So the server records the collisions on the task (payload.contention[], capped
   at 20, coalescing repeats) and this file is the reading of them. Nothing is
   fetched: the trail rides the same canvas-state push everything else does, so a
   collision recorded on the server re-renders the marker over the existing socket.

   THE TWO KINDS, and why the UI keeps them apart:

     RACED    a claim lost at the door. Nobody did any duplicate work — one agent
              asked, was told no, and went to find other work. This is the system
              working, and it is the ordinary case on a busy queue.
     FENCED   a write refused because the writer no longer held the claim. Its
              lease had lapsed and the task moved on, and it came back and tried
              to finish work that was no longer its own. That is a double
              execution that DIDN'T happen — a near miss, not a routine yield.

   Collapsing them into one number would throw away the only distinction a human
   acts on, so every surface here reports them separately and leads with the one
   that matters more. */

import type { Action, ContentionEvent, TaskPayload } from "../types";

/** Counts for one task or one agent. `raced` = claims lost, `fenced` = writes
 *  refused. `events` is how many trail ENTRIES those came from — lower than the
 *  totals when repeats have been coalesced. */
export interface ContentionTally {
  raced: number;
  fenced: number;
  total: number;
  events: number;
}

const EMPTY: ContentionTally = { raced: 0, fenced: 0, total: 0, events: 0 };

/** Repeats coalesced onto an entry. The server writes `count` only when it is
 *  above one, so absent means once — never read the field raw. */
export function repeatsOf(e: ContentionEvent): number {
  return e.count && e.count > 1 ? e.count : 1;
}

/** The trail on an action, oldest first, or empty. Only tasks have one. */
export function taskContention(action: Action | undefined): ContentionEvent[] {
  if (!action || action.type !== "task") return [];
  return (action.payload as TaskPayload | undefined)?.contention ?? [];
}

/** Tally a trail. */
export function tallyContention(events: ContentionEvent[]): ContentionTally {
  if (events.length === 0) return EMPTY;
  let raced = 0;
  let fenced = 0;
  for (const e of events) {
    const n = repeatsOf(e);
    if (e.kind === "fenced_write") fenced += n;
    else raced += n;
  }
  return { raced, fenced, total: raced + fenced, events: events.length };
}

/** Tally one task straight from its action. */
export function contentionOf(action: Action | undefined): ContentionTally {
  return tallyContention(taskContention(action));
}

/**
 * Per-AGENT tallies across the whole board, keyed by the agent name the trail
 * records — which is the same string `claimedBy` uses, so the fleet roster can
 * look an agent up by name with no join.
 *
 * Derived from canvas state rather than fetched: every task's payload is already
 * in hand and already live, so a collision anywhere on the board updates the
 * fleet view on the same push that updates the card.
 */
export function contentionByAgent(actions: Record<string, Action>): Map<string, ContentionTally> {
  const out = new Map<string, ContentionTally>();
  for (const action of Object.values(actions)) {
    for (const e of taskContention(action)) {
      if (!e.agent) continue;
      const cur = out.get(e.agent) ?? { raced: 0, fenced: 0, total: 0, events: 0 };
      const n = repeatsOf(e);
      if (e.kind === "fenced_write") cur.fenced += n;
      else cur.raced += n;
      cur.total += n;
      cur.events += 1;
      out.set(e.agent, cur);
    }
  }
  return out;
}

// ── Words ────────────────────────────────────────────────────────────────────

/**
 * The card marker's label. Compact, because it sits in a metadata row next to
 * the lease chip and the epic chip:
 *
 *   raced        one agent asked and yielded
 *   raced ×3     three did
 *   fenced ×2    two writes refused — the more serious kind wins the label
 *
 * A task with both kinds leads with `fenced`, because "somebody nearly did this
 * work twice" outranks "somebody asked and moved on", and the hover title spells
 * out both. One word plus a count is the whole budget: the marker's job is to
 * make you hover, not to be the report.
 */
export function contentionLabel(t: ContentionTally): string | null {
  if (t.total === 0) return null;
  const word = t.fenced > 0 ? "fenced" : "raced";
  const n = t.fenced > 0 ? t.fenced : t.raced;
  return n > 1 ? `${word} ×${n}` : word;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The whole sentence behind the marker: the hover title and the screen-reader
 * text. Order is what someone deciding whether to care needs — what happened,
 * how many times, and who was involved.
 */
export function contentionSentence(events: ContentionEvent[]): string {
  const t = tallyContention(events);
  if (t.total === 0) return "";

  const parts: string[] = [];
  if (t.raced > 0) {
    parts.push(
      `${plural(t.raced, "agent asked for this task and yielded", "claims for this task were refused")}`,
    );
  }
  if (t.fenced > 0) {
    parts.push(
      `${plural(t.fenced, "write was refused", "writes were refused")} from an agent that no longer held the claim`,
    );
  }

  // Name the people involved — the whole reason this is a trail and not a
  // counter. Two names is the readable limit for a tooltip.
  const losers = [...new Set(events.map((e) => e.agent).filter(Boolean))];
  const holders = [...new Set(events.map((e) => e.holder).filter((h): h is string => !!h && h !== "nobody"))];
  const who =
    losers.length > 0
      ? ` ${listNames(losers)} ${losers.length === 1 ? "was" : "were"} refused${
          holders.length > 0 ? `; ${listNames(holders)} held the task` : ""
        }.`
      : "";

  const tail =
    t.fenced > 0
      ? " The fence stopped work being done twice."
      : " Nothing was done twice — the losers went and took other work.";

  return `${sentenceCase(parts.join(", and "))}.${who}${tail}`;
}

function listNames(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length - 2 === 1 ? "" : "s"}`;
}

function sentenceCase(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** One trail entry, as a line of prose — the ticket page's history list. */
export function eventSentence(e: ContentionEvent): string {
  const n = repeatsOf(e);
  const times = n > 1 ? ` (${n} times)` : "";
  const holder = e.holder && e.holder !== "nobody" ? e.holder : null;

  if (e.kind === "fenced_write") {
    const stale =
      e.presented && e.generation && e.presented !== e.generation
        ? ` It wrote under claim generation ${e.presented}; the live claim was generation ${e.generation}.`
        : "";
    const whose = holder
      ? holder === e.agent
        ? " Its own lease had been superseded — same name, different claim."
        : ` ${holder} held the task.`
      : " The claim had already been cleared.";
    return `${e.agent}'s write was refused${times} — it no longer held the claim.${whose}${stale}`;
  }

  return holder
    ? `${e.agent} asked for this task${times} and yielded to ${holder}.`
    : `${e.agent}'s claim was refused${times}.`;
}

/** The short verb for an entry's own chip in the history list. */
export function eventLabel(e: ContentionEvent): string {
  return e.kind === "fenced_write" ? "fenced" : "raced";
}
