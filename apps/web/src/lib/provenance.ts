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

// ── Approval provenance (TDM-147) ────────────────────────────────────────────
//
// `approvedBy` answers a DIFFERENT question from `authoredBy` — not who wrote
// this, but WHICH GATE it passed — and since TDM-145 that question has more than
// one answer. Under the 'peer' policy a registered agent can approve a task
// another agent proposed, and the server stamps it "agent:<identity>". So
// "approved" stopped being one thing, and a board that renders a peer approval
// and a human approval identically devalues every approval on it — including
// the human's, which is the only one that cost someone's attention.
//
// It shares the exact grammar `authoredBy` uses (that's why it lives here and
// not in a parallel module): "human", "agent:<identity>", plus two POLICY stamps
// that mean nobody pressed anything at all —
//
//   "human"        a signed-in person pressed Approve on THIS task
//   "agent:<id>"   a peer agent approved it (canvas policy 'peer')
//   "policy:epic"  born approved because a person approved its EPIC
//   "policy:auto"  born approved: this canvas has no gate
//   anything else  a legacy freeform label — shown verbatim, never interpreted
//
// Ranked by how much human attention the row actually got, that reads
// human > policy:epic > agent > policy:auto, and the UI weights it that way.

export type ApprovalKind = "human" | "agent" | "epic" | "auto" | "anonymous" | "other";

export interface Approval {
  kind: ApprovalKind;
  /** Chip text. EMPTY when the glyph alone is the whole fact (the human case:
   *  an unqualified approval is a person's, and every other kind is qualified). */
  label: string;
  /** Sentence form — reads after "approved by …". */
  phrase: string;
  /** Tooltip: what the stamp means and how much review it represents. */
  title: string;
  /** True only for a person approving THIS row — the strongest claim a task
   *  carries, and the one the board renders at firmer weight. */
  byHuman: boolean;
}

const POLICY_EPIC = "policy:epic";
const POLICY_AUTO = "policy:auto";

/**
 * Parses a raw `approvedBy` into something renderable, or null when the row was
 * never approved.
 *
 * Unlike parseAuthoredBy, an unrecognized value is NOT dropped: approvedBy has
 * always accepted freeform labels (rows predating the server-stamped vocabulary
 * carry things like "jaxon"), and silently hiding a stamp that exists would
 * turn a real approval into a blank. It comes back as `other` — shown verbatim,
 * with a tooltip that declines to say what it means.
 */
export function parseApproval(raw?: string | null): Approval | null {
  const value = raw?.trim();
  if (!value) return null;

  if (value === "human") {
    return {
      kind: "human",
      label: "",
      phrase: "a person",
      title:
        "Approved by a signed-in person, on this task. Derived from the session, so an agent can't claim it.",
      byHuman: true,
    };
  }

  if (value === POLICY_EPIC) {
    return {
      kind: "epic",
      label: "epic gate",
      phrase: "its approved epic",
      title:
        "Born approved: a person approved this task's EPIC, and the canvas 'epic' policy let its tasks through. Nobody reviewed this task on its own.",
      byHuman: false,
    };
  }

  if (value === POLICY_AUTO) {
    return {
      kind: "auto",
      label: "auto",
      phrase: "canvas policy — nobody reviewed it",
      title:
        "Born approved: this canvas runs on the 'auto' policy, so agent tasks skip the approval gate entirely. No person and no agent looked at this.",
      byHuman: false,
    };
  }

  if (value === "anonymous") {
    return {
      kind: "anonymous",
      label: "anonymous",
      phrase: "someone with the canvas link",
      title: "Approved by someone holding the canvas link who wasn't signed in.",
      byHuman: false,
    };
  }

  if (value.startsWith(AGENT_PREFIX)) {
    const name = value.slice(AGENT_PREFIX.length).trim() || "an agent";
    return {
      kind: "agent",
      label: name,
      phrase: `${name}, a peer agent`,
      title: `Peer-approved by ${name}, an agent — this canvas runs the 'peer' policy, so a registered agent may approve work a DIFFERENT agent proposed. The server enforced the non-self rule and stamped the name; no person saw this task.`,
      byHuman: false,
    };
  }

  return {
    kind: "other",
    label: value,
    phrase: value,
    title: `Approved by "${value}" — a label from before approvals were stamped from the session, so this build can't say whether a person or an agent opened the gate.`,
    byHuman: false,
  };
}

// ── Canvas approval policy, in words ─────────────────────────────────────────
// The per-row stamps above say what happened to ONE task. This says what the
// canvas will do to the NEXT one — the thing a human otherwise has to read the
// database to learn. A board silently running on 'peer' or 'auto' is the whole
// failure this vocabulary exists to prevent, so every surface that can show the
// policy says the same sentence.

export type ApprovalPolicyName = "strict" | "epic" | "auto" | "peer";

/** Absent/unknown reads as the server default, 'epic' (migration 0033). */
export function policyOf(raw?: string | null): ApprovalPolicyName {
  return raw === "strict" || raw === "auto" || raw === "peer" ? raw : "epic";
}

/** One sentence: what this policy does to agent-proposed tasks. */
export function approvalPolicySentence(policy: ApprovalPolicyName): string {
  switch (policy) {
    case "strict":
      return "Every agent-proposed task waits for your approval.";
    case "auto":
      return "Agent tasks are ready immediately — no approval gate.";
    case "peer":
      return "Agent tasks wait for approval, but another agent can give it — not just you.";
    case "epic":
      return "Approve an epic once; its tasks flow without per-task approval.";
  }
}

/** Short label for a chip / summary line. */
export function approvalPolicyLabel(policy: ApprovalPolicyName): string {
  switch (policy) {
    case "strict":
      return "Strict";
    case "auto":
      return "Auto";
    case "peer":
      return "Peer";
    case "epic":
      return "Epic";
  }
}

/**
 * True when this policy can let agent work through with no human in the loop —
 * the case worth saying out loud rather than leaving in a settings panel. Note
 * 'epic' is deliberately NOT loose: a person still approved the epic.
 */
export function policyIsLoose(policy: ApprovalPolicyName): boolean {
  return policy === "auto" || policy === "peer";
}
