// Provenance (TDM-40) — reading the server-derived `authoredBy` field.
//
// The API stamps this from the auth context on every create and it is the one
// authorship signal a caller can't set: `proposedBy` / `createdBy` are freeform
// labels the client sends, `authoredBy` is what the server concluded. See
// apps/api/internal/api/provenance.go and migration 0039.
//
// Three shapes, and one absence:
//   "human"            a signed-in person wrote it
//   "agent:<identity>" an agent wrote it, calling itself <identity>
//   "anonymous"        someone with the canvas link and no account
//   undefined / ""     the row predates provenance — UNKNOWN, and the UI must
//                      render nothing rather than guess

export type Provenance =
  | { kind: "human"; label: string }
  | { kind: "agent"; label: string }
  | { kind: "anonymous"; label: string };

const AGENT_PREFIX = "agent:";

/**
 * Parses a raw authoredBy into something renderable, or null when there's
 * nothing trustworthy to show.
 *
 * Unrecognized values also return null. A value outside the vocabulary means the
 * server and the client disagree about what provenance is, and showing a raw
 * mystery string next to a task is worse than showing nothing.
 */
export function parseAuthoredBy(raw?: string | null): Provenance | null {
  const value = raw?.trim();
  if (!value) return null;

  if (value === "human") return { kind: "human", label: "a person" };
  if (value === "anonymous") return { kind: "anonymous", label: "anonymous" };

  if (value.startsWith(AGENT_PREFIX)) {
    const name = value.slice(AGENT_PREFIX.length).trim();
    // An agent that named itself nothing is still an agent.
    return { kind: "agent", label: name || "an agent" };
  }
  return null;
}

/**
 * Tooltip copy. Says what the value means AND where it came from, because the
 * whole point of this field is that it's the trustworthy one — a chip that
 * doesn't explain that is just another label.
 */
export function provenanceTitle(p: Provenance): string {
  switch (p.kind) {
    case "human":
      return "Written by a signed-in person. Derived from the session, so it can't be claimed by an agent.";
    case "agent":
      return `Written by ${p.label}, an agent. The server confirmed an agent wrote it; the name is the agent's own.`;
    case "anonymous":
      return "Written by someone with the canvas link who wasn't signed in.";
  }
}
