/**
 * THE TICKET-QUALITY CONTRACT — one implementation, imported by everyone (TDM-169).
 *
 * TDM-159 gave `epic_propose` a quality contract: a HARD half that refuses a
 * batch outright before anything is written (a body that is just the title
 * again, a single-ticket "epic"), and a SOFT half that returns non-blocking
 * warnings about individual tickets — names no surface, states no done
 * condition, reads like more than one sitting, pastes context instead of
 * linking it, repeats another ticket's context verbatim.
 *
 * TDM-163 needed the same rules on the board and, under concurrency, hand-copied
 * them into `apps/web/src/lib/ticketQuality.ts` — character-for-character, with
 * a header saying so and a note that the right end state was one module here.
 * That is this file. TDM-168 then made the gateway's copy self-contained and
 * read-time-derived, which is the shape the hoist folds into; TDM-169 lifted it
 * and deleted the duplicate. Two copies of a rule set drift the first time
 * someone tunes a threshold on one side, and a board warning you cannot
 * reproduce from the tool that proposed the batch is worse than no warning,
 * because it is one you stop trusting.
 *
 * ═════ WHY TYPESCRIPT, AND NOT THE GO API ═══════════════════════════════════
 *
 * Serving warnings from the API would look like the tidier "one implementation",
 * but it would be a THIRD one rather than a replacement for either consumer:
 *   · the gateway must evaluate LOCALLY and BEFORE any write — the hard half's
 *     whole promise is that a refused plan leaves nothing behind, which cannot
 *     depend on a validation round-trip;
 *   · the board must evaluate locally too, because it warns on text the human is
 *     editing in place (TDM-160); instant feedback is the point, and a server
 *     round-trip per keystroke is not that.
 * So both consumers need the rules in-process, in TypeScript, which is exactly
 * what a workspace package is for. The Go API stays rule-free and supplies only
 * the FACTS a derivation needs (see `hasLinkedContext` on the epic block of
 * GET /api/canvas/actions/{id}).
 *
 * ═════ DERIVED AT READ TIME, NOT STORED (TDM-168) ═══════════════════════════
 *
 * TDM-159 computed these warnings and then dropped them: they existed only on
 * the `epic_propose` response, handed to the agent that had just made the
 * mistake. The obvious fix is to persist them on the row at propose time. It is
 * the wrong one, and the choice is recorded here because the shape of this
 * module follows from it.
 *
 * A stored warning is a SECOND COPY OF THE TRUTH, snapshotted at the one moment
 * the ticket happened to pass through `epic_propose`. It cannot describe:
 *   · a ticket filed one at a time with `task_propose`, which runs no contract;
 *   · a ticket proposed before the contract existed;
 *   · a ticket a human amended in place afterwards (TDM-160) — the stored
 *     warning would then be describing text nobody can still read;
 *   · a rule we tighten next month, on any row written before we tightened it.
 * Deriving from the row's CURRENT text covers all four for free, and needs no
 * column, no migration and no backfill. It is the same discipline TDM-165 (gate
 * metrics) and TDM-161 (review feedback) already chose on this codebase: compute
 * at read time off rows that exist rather than grow a parallel store.
 *
 * ═════ TWO THINGS TO KEEP TRUE ══════════════════════════════════════════════
 *
 *   1. the module's inputs are normalized `QualityTicket`s, never MCP tool
 *      arguments and never board rows, so neither consumer's wire format leaks
 *      into the rules. `qualityTicketFrom*` are the funnels; add one per caller
 *      rather than teaching a rule a new shape.
 *   2. every rule declares its SCOPE (`WARNING_SCOPE`), because the callers do
 *      not all hold the same amount of the world — a batch read can compare
 *      tickets against each other, a single-ticket read cannot.
 *
 * The file is in two parts: THE CONTRACT (everything the gateway and the board
 * both run — change it and both surfaces change together, which is the point of
 * the hoist) and THE BOARD'S PLAN LAYER below it (ordering, chip labels, and the
 * display extractors that print WHICH surface a ticket names rather than
 * answering whether it names one at all). The second part is built on the first
 * and is deliberately allowed to be choosier than it; nothing in it is part of
 * the contract, so a formatting tweak there is never a change to what the rules
 * decide.
 */

/* ═════ THE CONTRACT ════════════════════════════════════════════════════════ */

/** Below either of these a `body` is a title with extra whitespace, not a ticket. */
export const TICKET_MIN_BODY_CHARS = 24;
export const TICKET_MIN_BODY_WORDS = 5;
/** Past this, a body is heavy enough that its context belongs in `linkedIds`. */
export const TICKET_CONTEXT_CHARS = 1200;
/** Past this, one ticket is very unlikely to be one sitting of work. */
export const TICKET_SPRAWL_CHARS = 3000;
/** A numbered plan this long inside ONE ticket is an epic wearing a ticket. */
export const TICKET_SPRAWL_STEPS = 6;
/** A line repeated verbatim across tickets counts as pasted context at this length. */
export const PASTED_LINE_CHARS = 80;

export type TicketWarningCode =
  | "no_surface_named"
  | "no_done_condition"
  | "may_exceed_one_sitting"
  | "context_not_linked"
  | "context_duplicated";

/**
 * What a rule needs to fire, and how much of the world it needs to see.
 *
 *  · "ticket" — answerable from ONE ticket's own text (plus, for
 *    `context_not_linked`, whether it or its batch links anything). Every read
 *    path can run these, including a single-ticket read.
 *  · "batch"  — only answerable by comparing tickets against each other.
 *    `context_duplicated` is the whole of this category: "this line also
 *    appears in another ticket" is not a property of the ticket.
 *
 * Declared rather than implied so a caller holding only one ticket can ask for
 * exactly what it can honestly answer, instead of silently getting a
 * batch-scoped rule evaluated against a batch of one (which never fires, and
 * would read as "checked and clean" when it means "not checked").
 */
export type WarningScope = "ticket" | "batch";

export const WARNING_SCOPE: Record<TicketWarningCode, WarningScope> = {
  no_surface_named: "ticket",
  no_done_condition: "ticket",
  context_not_linked: "ticket",
  may_exceed_one_sitting: "ticket",
  context_duplicated: "batch",
};

/**
 * One ticket as the RULES read it — normalized, so neither the MCP wire format
 * nor a stored row's payload shape reaches the rules themselves. Both callers
 * (a propose call's `tasks[]`, a stored task row) funnel through this.
 */
export type QualityTicket = {
  title: string;
  body: string;
  /** Whether the ticket itself links context (`linkedIds`). */
  linked: boolean;
};

/** One non-blocking quality smell, always about exactly ONE ticket. */
export type TicketWarning = {
  code: TicketWarningCode;
  /** 0-based position in the batch as it was read. Always 0 on a single-ticket read. */
  index: number;
  title: string;
  /** One line: what is missing and what to do about it. */
  message: string;
  /** Filled in once the batch has landed, so the agent can task_amend it. */
  taskId?: string;
  ticketId?: string;
};

/** Normalize an MCP `tasks[]` entry — untyped by the time it reaches us. */
export function qualityTicketFromArgs(t: Record<string, unknown>): QualityTicket {
  return {
    title: typeof t.title === "string" ? t.title.trim() : "",
    body: typeof t.body === "string" ? t.body.trim() : "",
    linked: Array.isArray(t.linkedIds) && t.linkedIds.length > 0,
  };
}

/** Normalize a STORED task row's payload — the read-time input (TDM-168). */
export function qualityTicketFromPayload(payload: unknown): QualityTicket {
  const p = (payload ?? {}) as Record<string, unknown>;
  return {
    title: typeof p.title === "string" ? p.title.trim() : "",
    body: typeof p.body === "string" ? p.body.trim() : "",
    linked: Array.isArray(p.linkedIds) && p.linkedIds.length > 0,
  };
}

/** Anything that names a concrete surface: a path, a file, an endpoint, an identifier. */
export const NAMES_A_SURFACE: RegExp[] = [
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
export const STATES_DONE_CONDITION =
  /\b(?:done when|acceptance|verif(?:y|ies|ied|ication)|pass(?:es|ing)|green|assert\w*|expect\w*|returns?|renders?|succeeds?|exits?|no longer|results in|such that|so that)\b/i;

/** Two clauses of work bolted into one title. */
export const TITLE_CONJUNCTION = /\s(?:and|&|\+|plus|then)\s/i;

/** Lowercased, punctuation-free and epic-prefix-free — for comparing two titles. */
export function normalizeTitle(s: string): string {
  return s
    .replace(/^\s*E\d+\s*[·.:•\-–—]\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The distinct top-level packages a ticket's text names, e.g. `apps/api`. */
export function namedPackages(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(apps|internal|packages|services|libs|supabase)\/([\w.-]+)/g)) {
    out.add(`${m[1]}/${m[2]}`);
  }
  return out;
}

/** How many `1.` / `2)` steps a body enumerates. */
export function numberedSteps(body: string): number {
  return (body.match(/^\s*\d+[.)]\s+\S/gm) ?? []).length;
}

/** The body's substantial lines, normalized — the unit we compare across tickets. */
export function longLines(body: string): string[] {
  return body
    .split(/\n+/)
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter((l) => l.length >= PASTED_LINE_CHARS);
}

/**
 * The HARD half: objective, cheap, and run before anything is written. Every
 * failure is collected so a lazy plan gets fixed in one pass instead of one
 * round-trip per ticket. Returns the messages; the caller throws.
 */
export function ticketContractFailures(epicTitle: string, tickets: QualityTicket[]): string[] {
  const failures: string[] = [];

  // One ticket is a task, not an epic: the container buys an approval step and
  // an epic summary that a single unit of work has no use for.
  if (tickets.length === 1) {
    failures.push(
      "This epic has exactly ONE ticket, which makes it a task, not an epic — propose it with " +
        "task_propose (passing `epicId` to file it under an existing batch), or split the work " +
        "into the several tickets it actually is."
    );
  }

  const epicKey = normalizeTitle(epicTitle);
  for (const [i, t] of tickets.entries()) {
    const title = t.title.trim();
    const body = t.body.trim();
    const where = `tasks[${i}] ("${title}")`;

    if (body.length < TICKET_MIN_BODY_CHARS || body.split(/\s+/).filter(Boolean).length < TICKET_MIN_BODY_WORDS) {
      failures.push(
        `${where} has no real \`body\` — a title on its own is not a ticket. Say what changes, ` +
          `on which surface, and how someone else would know it is done.`
      );
    }
    if (epicKey && normalizeTitle(title) === epicKey) {
      failures.push(
        `${where} just restates the epic title — a ticket has to name its own slice of the work, ` +
          `not the batch it sits in.`
      );
    }
  }
  return failures;
}

/**
 * The SOFT half: everything a rule can smell but not prove. Non-blocking on
 * purpose — a heuristic that blocks is a heuristic you learn to route around.
 *
 * PURE, and the ONE implementation of the soft rules: `epic_propose` runs it on
 * a batch it is about to write, `task_get` runs it on a row somebody already
 * wrote (TDM-168), and the board runs it on the plan it is rendering (TDM-163).
 * Same rules, same wording, whichever end you meet a ticket from — a read that
 * disagreed with the propose call would be worse than a read that said nothing.
 *
 * `only` narrows to one scope for a caller that cannot honestly run the rest;
 * see WARNING_SCOPE. `batchHasLinkedContext` is the batch's own `linkedIds`:
 * linking the shared note on the EPIC suppresses `context_not_linked` for every
 * ticket under it, because the context is then one hydrated link away.
 */
export function ticketQualityWarnings(
  tickets: QualityTicket[],
  opts: { batchHasLinkedContext?: boolean; only?: WarningScope } = {}
): TicketWarning[] {
  const warnings: TicketWarning[] = [];
  const inScope = (code: TicketWarningCode) => !opts.only || WARNING_SCOPE[code] === opts.only;
  const batchLinked = opts.batchHasLinkedContext === true;

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
    const linked = t.linked;
    const add = (code: TicketWarningCode, message: string) => {
      if (inScope(code)) warnings.push({ code, index, title, message });
    };

    if (!NAMES_A_SURFACE.some((re) => re.test(text))) {
      add(
        "no_surface_named",
        "Names no surface — say which file, package, endpoint or component this touches. " +
          "'Improve auth' is an area, not a ticket."
      );
    }
    if (!STATES_DONE_CONDITION.test(body)) {
      add(
        "no_done_condition",
        "No done condition a third party could check — say what is true when it is finished " +
          "(a test, a build, an observable behaviour), not just what to go do."
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
          "three, it is an epic of its own, so split it."
      );
    }
    if (body.length > TICKET_CONTEXT_CHARS && !linked && !batchLinked) {
      add(
        "context_not_linked",
        `Heavy body (${body.length} chars) with nothing in \`linkedIds\` — link the note or ` +
          `roadmap item instead of pasting it; task_get hydrates links for whoever picks this up.`
      );
    }
    if (longLines(body).some((l) => (lineCounts.get(l) ?? 0) > 1)) {
      add(
        "context_duplicated",
        "Repeats context verbatim from another ticket in this batch — write it once as a note " +
          "and link it from each ticket with `linkedIds`."
      );
    }
  }
  return warnings;
}

/** How to read a batch's warnings — what they are, and what they are not. */
export function ticketWarningsNote(warnings: TicketWarning[], total: number): string {
  const tickets = new Set(warnings.map((w) => w.index)).size;
  return (
    `${warnings.length} quality warning(s) across ${tickets} of ${total} ticket(s). The batch WAS ` +
    `created and these do NOT block approval — they are the slop a rule can see, handed back to ` +
    `you before a human reads it. Each carries a \`code\`, the ticket it is about (\`ticketId\` / ` +
    `\`taskId\` / \`index\`) and one line on what is missing. Fix the ones you agree with using ` +
    `task_amend — the tickets are still 'proposed', so they are yours to edit — and leave the ` +
    `rest: a warning is a smell, not a verdict. These are not ephemeral: the same rules run on ` +
    `the stored ticket, so task_get and the board re-derive them from whatever the text says ` +
    `NOW — an amend that fixes one makes it disappear everywhere, and one that does not, does not.`
  );
}

/**
 * States in which a ticket's own quality is still worth saying out loud
 * (TDM-168) — the same shape, and the same reasoning, as TDM-161's
 * reviewOutstandingStates.
 *
 * 'proposed' is the human gate's moment; 'approved' and 'executing' are the
 * worker's — "the ticket you are about to start names no surface and states no
 * done condition" is most actionable BEFORE any code is written, when going
 * back and asking is still cheap. 'done', 'failed' and 'rejected' are history:
 * nobody can act on the text any more, and a warning there is noise on a read
 * every session makes.
 */
export const QUALITY_OUTSTANDING_STATES = new Set(["proposed", "approved", "executing"]);

/**
 * The read-time derivation (TDM-168): the same soft rules, run against a STORED
 * task row instead of a propose call's arguments.
 *
 * Ticket-scoped rules only, and that is a correctness point rather than a
 * shortcut — a single-ticket read holds one ticket, so it cannot honestly
 * answer `context_duplicated` ("this line also appears in a sibling"). Running
 * it against a batch of one would never fire and would read as "checked and
 * clean". The batch-scoped rule stays where the batch is: the propose call, and
 * the board, which holds the whole plan.
 *
 * Returns [] for a row with no text at all — an epic, or a task whose payload
 * did not parse — rather than warning that an empty ticket names no surface.
 */
export function storedTicketWarnings(
  action: { state?: unknown; payload?: unknown } | undefined,
  epicHasLinkedContext: boolean
): TicketWarning[] {
  const state = typeof action?.state === "string" ? action.state : "";
  if (!QUALITY_OUTSTANDING_STATES.has(state)) return [];
  const ticket = qualityTicketFromPayload(action?.payload);
  if (!ticket.title && !ticket.body) return [];
  return ticketQualityWarnings([ticket], {
    batchHasLinkedContext: epicHasLinkedContext,
    only: "ticket",
  });
}

/** How to read ONE ticket's warnings on a read path, by who is reading it. */
export function storedWarningsNote(warnings: TicketWarning[], state: string): string {
  const head =
    `${warnings.length} quality warning(s) on this ticket, derived from the text it has RIGHT ` +
    `NOW (not stored at propose time, so an amend changes them and a ticket that never went ` +
    `through epic_propose still gets them). They do NOT block anything.`;
  const act =
    state === "proposed"
      ? ` It is still 'proposed', so it is editable: fix the ones you agree with with task_amend ` +
        `before a human reads it.`
      : ` This ticket is already ${state === "executing" ? "being worked" : "in the ready queue"}, ` +
        `so treat these as the questions to settle BEFORE you write code — if it names no surface ` +
        `or no done condition, decide what those are and say so in task_progress / task_complete ` +
        `rather than guessing quietly.`;
  return (
    head +
    act +
    ` Ticket-scoped rules only: cross-ticket smells need the whole batch and are reported by ` +
    `epic_propose and on the board. A warning is a smell, not a verdict.`
  );
}

/* ═════ THE BOARD'S PLAN LAYER (TDM-163) ════════════════════════════════════
   Everything above is the contract; everything below renders it. Built on the
   rules, never a second copy of them — the extractors here reuse the contract's
   own `STATES_DONE_CONDITION` and `namedPackages` rather than restating either.
   Nothing down here decides anything, so a change to a label or an extractor is
   never a change to what the gate says. */

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

/** One ticket as the BOARD holds it — a `QualityTicket` with the id the board
 *  addresses it by. The rules themselves never see the id: they take normalized
 *  tickets and answer by index, and `reviewPlan` maps the answers back. */
export type ReviewTicket = QualityTicket & { id: string };

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
 *  dropped: "apps/web" tells you nothing you did not learn from the file.
 *
 *  Allowed to be choosier than `NAMES_A_SURFACE` is: a rule that misses a smell
 *  is cheap, but a surface line showing `and/or` because it contains a slash is
 *  just noise on a card. */
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
 * Every scope runs here, batch-scoped rules included: the board is the one
 * caller that holds the whole plan, so it is the one caller that can honestly
 * answer `context_duplicated`.
 *
 * `epicHasLinkedContext` is the epic's own `linkedIds`: linking the shared note
 * on the BATCH suppresses `context_not_linked` for every ticket in it, exactly
 * as it does in the gateway (where it arrives as the call's `linkedIds`).
 */
export function reviewPlan(tickets: ReviewTicket[], epicHasLinkedContext: boolean): PlanReview {
  const warnings = ticketQualityWarnings(tickets, {
    batchHasLinkedContext: epicHasLinkedContext,
  });
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
