/* ─────────────────────────────────────────────────────────────────────────────
   The ticket-quality contract, recomputed for the board (TDM-163)

   TDM-159 gave `epic_propose` a quality contract. Its HARD half refuses a batch
   outright (a body that is just the title again, a single-ticket "epic"); its
   SOFT half returns non-blocking warnings about individual tickets — names no
   surface, states no done condition, reads like more than one sitting, pastes
   context instead of linking it, repeats another ticket's context verbatim.

   Those warnings live ONLY on the `epic_propose` response. Nothing persists
   them, so the board — the surface where a human actually decides — has no way
   to read them back. This file recomputes them from the ticket text the board
   already holds, so the plan gate can show what the contract saw.

   THIS IS A SECOND COPY OF THE RULES, DELIBERATELY. The alternative was storing
   the gateway's warnings through the API, which is a larger change across files
   another ticket was rewriting at the same time. Two consequences, both worth
   knowing before touching either copy:

     · Everything in the VERBATIM block below is copied character-for-character
       from `apps/mcp-gateway/src/facade.ts`. Change a threshold or a regex
       there and change it here, or the board will quietly disagree with the
       tool that proposed the batch — which is worse than not showing warnings
       at all, because a warning you cannot reproduce is one you stop trusting.

     · In exchange the board warns on tickets the contract never saw: epics
       proposed before TDM-159 landed, tickets filed one at a time with
       `task_propose` (which runs no contract), and tickets a human amended in
       place afterwards. A stored warning could not have covered any of those.

   The right end state is ONE implementation in `internal/shared`, imported by
   the gateway and the web app alike. That is a ticket of its own — hoisting it
   mid-board-change would have put this file in another session's diff.

   What is NOT mirrored: the hard half (`ticketContractFailures`). It throws
   before a batch is written, so by the time the board sees a ticket that rule
   has either already run or was never going to. A ticket with no real body
   trips `no_surface_named` and `no_done_condition` anyway, which is the signal
   that matters here.

   Below the mirror sit two extractors the gateway has no need for: the board
   does not only ask "is this thin?", it has to SHOW the surface a ticket claims
   to touch and the condition it says it is done by. Those are display code and
   are kept clearly separate from the rules, so nobody mistakes a formatting
   tweak for a change to the contract.
   ──────────────────────────────────────────────────────────────────────────── */

/* ═════ VERBATIM from apps/mcp-gateway/src/facade.ts (TDM-159) ═══════════════
   Keep in sync. Do not "improve" anything in this block on its own. */

/** Past this, a body is heavy enough that its context belongs in `linkedIds`. */
const TICKET_CONTEXT_CHARS = 1200;
/** Past this, one ticket is very unlikely to be one sitting of work. */
const TICKET_SPRAWL_CHARS = 3000;
/** A numbered plan this long inside ONE ticket is an epic wearing a ticket. */
const TICKET_SPRAWL_STEPS = 6;
/** A line repeated verbatim across tickets counts as pasted context at this length. */
const PASTED_LINE_CHARS = 80;

/** Anything that names a concrete surface: a path, a file, an endpoint, an identifier. */
const NAMES_A_SURFACE: RegExp[] = [
  /[\w@.-]+\/[\w@./-]+/, // apps/api/internal/..., /api/canvas/state
  /\.(?:ts|tsx|js|jsx|mjs|cjs|go|sql|json|css|scss|md|py|rs|rb|java|kt|swift|sh|ya?ml|toml)\b/i,
  /`[^`]+`/, // a backticked identifier
  /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//, // an endpoint
  /\w\(\)/, // a function call
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/, // snake_case identifier
  /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/, // CamelCase identifier
];

/**
 * Phrases that state something a third party could CHECK. Deliberately not
 * "must" / "should": those state intent, and intent is what a vague ticket has
 * plenty of. A missed smell is cheap here; a warning on a good ticket is not.
 */
const STATES_DONE_CONDITION =
  /\b(?:done when|acceptance|verif(?:y|ies|ied|ication)|pass(?:es|ing)|green|assert\w*|expect\w*|returns?|renders?|succeeds?|exits?|no longer|results in|such that|so that)\b/i;

/** Two clauses of work bolted into one title. */
const TITLE_CONJUNCTION = /\s(?:and|&|\+|plus|then)\s/i;

/** The distinct top-level packages a ticket's text names, e.g. `apps/api`. */
function namedPackages(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(apps|internal|packages|services|libs|supabase)\/([\w.-]+)/g)) {
    out.add(`${m[1]}/${m[2]}`);
  }
  return out;
}

/** How many `1.` / `2)` steps a body enumerates. */
function numberedSteps(body: string): number {
  return (body.match(/^\s*\d+[.)]\s+\S/gm) ?? []).length;
}

/** The body's substantial lines, normalized — the unit we compare across tickets. */
function longLines(body: string): string[] {
  return body
    .split(/\n+/)
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter((l) => l.length >= PASTED_LINE_CHARS);
}

export type TicketWarningCode =
  | "no_surface_named"
  | "no_done_condition"
  | "may_exceed_one_sitting"
  | "context_not_linked"
  | "context_duplicated";

/** One non-blocking quality smell, always about exactly ONE ticket in the batch. */
export type TicketWarning = {
  code: TicketWarningCode;
  /** 0-based position in the batch as it was read. */
  index: number;
  title: string;
  /** One line: what is missing and what to do about it. */
  message: string;
};

/* ═════ END of the verbatim block ═════════════════════════════════════════ */

/** Every code, in the order the contract states its clauses — which is also the
 *  order they are worth reading in: what it touches, then how you would know it
 *  is finished, then whether it is one job, then where its context went. */
export const WARNING_ORDER: TicketWarningCode[] = [
  "no_surface_named",
  "no_done_condition",
  "may_exceed_one_sitting",
  "context_not_linked",
  "context_duplicated",
];

/** Chip-sized labels. The contract itself ships only the full `message` (which
 *  stays on the chip's tooltip); two or three words is what fits beside eleven
 *  tickets on a phone, and a code name would just be jargon on screen. */
export const WARNING_LABEL: Record<TicketWarningCode, string> = {
  no_surface_named: "names no surface",
  no_done_condition: "no done condition",
  may_exceed_one_sitting: "bigger than one sitting",
  context_not_linked: "context pasted, not linked",
  context_duplicated: "context repeated",
};

/** One ticket as the rules read it — id-keyed, because the board addresses
 *  tickets by id and the gateway addressed them by array position. */
export type ReviewTicket = {
  id: string;
  title: string;
  body: string;
  /** Whether the ticket itself links context (`payload.linkedIds`). */
  linked: boolean;
};

/**
 * The SOFT half, mirrored: everything a rule can smell but not prove.
 * Non-blocking on purpose — a heuristic that blocks is a heuristic you learn to
 * route around. Same inputs per rule as the gateway's (which deliberately
 * differ: `no_surface_named` reads title+body, `no_done_condition` the body
 * alone, `may_exceed_one_sitting` the title for its conjunction and both for
 * the packages it names).
 */
function ticketQualityWarnings(
  tickets: ReviewTicket[],
  epicHasLinkedContext: boolean,
): TicketWarning[] {
  const warnings: TicketWarning[] = [];

  // A substantial line repeated verbatim across tickets is context that was
  // pasted rather than linked. Counted across the whole batch, flagged per ticket.
  const lineCounts = new Map<string, number>();
  for (const t of tickets) {
    for (const line of new Set(longLines(t.body))) {
      lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
    }
  }

  for (const [index, t] of tickets.entries()) {
    const title = t.title.trim();
    const body = t.body.trim();
    const text = `${title}\n${body}`;
    const add = (code: TicketWarningCode, message: string) =>
      warnings.push({ code, index, title, message });

    if (!NAMES_A_SURFACE.some((re) => re.test(text))) {
      add(
        "no_surface_named",
        "Names no surface — say which file, package, endpoint or component this touches. " +
          "'Improve auth' is an area, not a ticket.",
      );
    }
    if (!STATES_DONE_CONDITION.test(body)) {
      add(
        "no_done_condition",
        "No done condition a third party could check — say what is true when it is finished " +
          "(a test, a build, an observable behaviour), not just what to go do.",
      );
    }
    if (
      body.length > TICKET_SPRAWL_CHARS ||
      numberedSteps(body) >= TICKET_SPRAWL_STEPS ||
      (TITLE_CONJUNCTION.test(title) && namedPackages(text).size >= 2)
    ) {
      add(
        "may_exceed_one_sitting",
        "Reads like more than one sitting of work — one ticket is one sitting. If it needs " +
          "three, it is an epic of its own, so split it.",
      );
    }
    if (body.length > TICKET_CONTEXT_CHARS && !t.linked && !epicHasLinkedContext) {
      add(
        "context_not_linked",
        `Heavy body (${body.length} chars) with nothing linked — link the note or roadmap item ` +
          `instead of pasting it; task_get hydrates links for whoever picks this up.`,
      );
    }
    if (longLines(body).some((l) => (lineCounts.get(l) ?? 0) > 1)) {
      add(
        "context_duplicated",
        "Repeats context verbatim from another ticket in this batch — write it once as a note " +
          "and link it from each ticket.",
      );
    }
  }
  return warnings;
}

/* ── Display extractors ───────────────────────────────────────────────────────
   Not part of the contract. The rules answer "is a surface named at all?" with
   a boolean; the board has to print WHICH one, and the same for the done
   condition. These are allowed to be choosier than the rules are — a rule that
   misses a smell is cheap, but a surface line showing `and/or` because it
   contains a slash is just noise on a card. */

/** Concrete surfaces, most specific first: real file paths, then package
 *  directories, then endpoints, then backticked identifiers. */
const SURFACE_PATTERNS: RegExp[] = [
  // apps/web/src/components/TaskBoard.tsx — a slashed path ending in a file
  /\b[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z]{1,6}\b/g,
  // apps/api/internal/api — a package directory under a known top level
  /\b(?:apps|internal|packages|services|libs|supabase)\/[\w.-]+(?:\/[\w.-]+)*/g,
  // POST /api/canvas/state
  /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[\w/{}:.-]*/g,
  // `queue_wait`, `TriageControls`
  /`([^`\n]{2,48})`/g,
];

/** What this ticket says it touches, deduped and in specificity order. A
 *  package directory that is merely the prefix of a file path already listed is
 *  dropped: "apps/web" tells you nothing you did not learn from the file. */
export function namedSurfaces(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of SURFACE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      // Trailing sentence punctuation rides along on a path that ends a line
      // ("…/App.tsx."), and it is the difference between one surface and two
      // that differ by a full stop.
      const hit = (m[1] ?? m[0]).trim().replace(/[.,;:!?)\]]+$/, "");
      if (!hit || seen.has(hit)) continue;
      seen.add(hit);
      out.push(hit);
    }
  }
  return out.filter((s) => !out.some((other) => other !== s && other.startsWith(`${s}/`)));
}

/** The clause that states how you would know this is finished. Line-oriented
 *  first, because a well-written ticket puts it on its own line ("Done when:
 *  …"), with a sentence-level fallback for the ones that bury it in a
 *  paragraph. Returns null when nothing states one — which is exactly when
 *  `no_done_condition` fires, so the card never shows an empty row. */
export function doneCondition(body: string): string | null {
  const strip = (s: string) => s.trim().replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "");
  for (const raw of body.split(/\n+/)) {
    const line = strip(raw);
    if (line && STATES_DONE_CONDITION.test(line)) return line;
  }
  // Sentence-level fallback. Split by matching runs rather than on a
  // sentinel or a lookbehind, so this stays portable and leaves no stray
  // character in the text it hands back to the card.
  for (const m of body.match(/[^.!?\n]+[.!?]*/g) ?? []) {
    const sentence = strip(m.replace(/\s+/g, " "));
    if (sentence && STATES_DONE_CONDITION.test(sentence)) return sentence;
  }
  return null;
}

/* ── The board's read of a whole plan ─────────────────────────────────────── */

/** One ticket, as the review renders it. */
export type TicketReview = {
  id: string;
  warnings: TicketWarning[];
  /** Everything it claims to touch, most specific first (may be empty). */
  surfaces: string[];
  /** How you would know it is done (null when nothing says). */
  done: string | null;
};

/** A proposed batch, read as a plan rather than as a pile of cards. */
export type PlanReview = {
  total: number;
  byId: Map<string, TicketReview>;
  /** Ticket ids carrying at least one warning. */
  flagged: Set<string>;
  /** How many TICKETS each code fired on (a code fires at most once per ticket). */
  counts: Map<TicketWarningCode, number>;
  /** The distinct top-level packages the whole batch names — "what it touches"
   *  at plan level, which is the first thing a reviewer wants and the last
   *  thing eleven separate cards will tell them. */
  packages: string[];
};

/**
 * Read a batch of proposed tickets the way the contract reads it.
 *
 * `epicHasLinkedContext` is the epic's own `linkedIds`: linking the shared note
 * on the BATCH suppresses `context_not_linked` for every ticket in it, exactly
 * as it does in the gateway (where it arrives as the call's `linkedIds`).
 */
export function reviewPlan(
  tickets: ReviewTicket[],
  epicHasLinkedContext: boolean,
): PlanReview {
  const warnings = ticketQualityWarnings(tickets, epicHasLinkedContext);
  const byIndex = new Map<number, TicketWarning[]>();
  const counts = new Map<TicketWarningCode, number>();
  for (const w of warnings) {
    byIndex.set(w.index, [...(byIndex.get(w.index) ?? []), w]);
    counts.set(w.code, (counts.get(w.code) ?? 0) + 1);
  }

  const byId = new Map<string, TicketReview>();
  const flagged = new Set<string>();
  const packages = new Set<string>();
  for (const [index, t] of tickets.entries()) {
    const text = `${t.title.trim()}\n${t.body.trim()}`;
    const own = byIndex.get(index) ?? [];
    byId.set(t.id, {
      id: t.id,
      warnings: own,
      surfaces: namedSurfaces(text),
      done: doneCondition(t.body),
    });
    if (own.length > 0) flagged.add(t.id);
    for (const pkg of namedPackages(text)) packages.add(pkg);
  }

  return {
    total: tickets.length,
    byId,
    flagged,
    counts,
    packages: [...packages].sort(),
  };
}
