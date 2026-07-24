import type { AgentOp } from "./useAgentActivity";

const VERB: Record<AgentOp, string> = {
  created: "created",
  updated: "updated",
  removed: "removed",
};

// "a doc" / "an itinerary event" — pick the article off the leading vowel.
function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/**
 * "created a doc", "updated a spreadsheet", "removed a map pin" — and for a
 * batch, "created 10 itinerary events" (count-led, pluralised). Every noun we
 * narrate pluralises with a plain -s, so that's all we do.
 */
export function actionPhrase(op: AgentOp, kind: string, count = 1): string {
  if (count > 1) return `${VERB[op]} ${count} ${kind}s`;
  return `${VERB[op]} ${withArticle(kind)}`;
}

/** Compact relative time for the bell log: "now", "3m", "2h", "4d". */
export function shortAgo(at: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - at) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
