/**
 * The INTENT FACADE — Tandem's default MCP surface (TDM-32 / E2.1).
 *
 * The CRUD surface in tools.ts is ~80 tools that mirror the API one endpoint at
 * a time. That's a fine machine interface and a bad agent interface: it costs a
 * large slice of the context window before the session does anything, and it
 * leaves the model to invent the workflow. This file replaces it as the DEFAULT
 * manifest with a small set of tools shaped like the things an agent session
 * actually wants to do, in the order it wants to do them:
 *
 *     canvas_connect (+ role: register) → context_get → queue_next → task_get
 *              → task_claim → (work, task_progress) → doc_write → task_complete
 *
 * …or, with subagents, the same queue forks at queue_next: every ready task
 * comes back with a `handoff` block (TDM-62) the orchestrator pastes into one
 * subagent per task. It dispatches; the workers claim. See buildHandoff.
 *
 * And where that flow used to STOP — nothing approved yet, so the session ends
 * its turn and waits for a human to prompt it again — there is now queue_wait
 * (TDM-149): one call that returns when work is approved. It is the same queue,
 * with the same handoffs; the only difference is that the waiting happens on the
 * server, where an agent with no sleep can actually do it.
 *
 * agent_register is here too, but only as the SECOND chance: identity is meant
 * to be minted by canvas_connect's `role` argument (TDM-61), because a separate
 * registration call is a step a subagent can skip — and then the fleet tree the
 * board draws never forms.
 *
 * Implementation rule: these are a FACADE, not a second backend. Every tool
 * either delegates to the matching CRUD handler in tools.ts (so claim
 * atomicity, identity handling, and error shaping stay single-sourced) or
 * composes a couple of existing endpoints into one round trip. Nothing here
 * talks to a route that the CRUD surface doesn't already use.
 *
 * SECURITY INVARIANT: there is NO webhook tool here, and there must never be
 * one in ANY manifest. Outbound HTTP configured through an agent-facing tool is
 * a prompt-injection exfiltration primitive — canvas content is attacker-
 * influenced, so a tool that posts it anywhere is a data-exfil channel with
 * extra steps. Webhooks are configured by a human in the web UI only.
 *
 * The full CRUD surface stays one env var away: TANDEM_FULL_TOOLS=1 (or
 * `tandem-mcp --full-tools`) advertises it ALONGSIDE this facade.
 */

import type { Gateway } from "./gateway.js";
import {
  RAW_TOOL_BY_NAME,
  adoptCarriedSession,
  handleTool,
  projectTaskRows,
  type RawTaskAction,
  type RawTool,
} from "./tools.js";
import {
  alreadyFinishedMessage,
  fenceRejectionMessage,
  findAnyLoss,
  forgetLoss,
  notYourClaimMessage,
  readConflict,
  recordLoss,
  sessionKey,
  tapOutBlock,
  writeReason,
  type ConflictBody,
} from "./tapout.js";

// ── Ticket quality ───────────────────────────────────────────────────────────

/**
 * The rules THEMSELVES no longer live here. They are one module,
 * `@agentcanvas/shared/ticket-quality`, imported by this file and by the board
 * (TDM-169) — which is what the header of the old block here promised and what
 * `apps/web/src/lib/ticketQuality.ts` used to be a hand-copied duplicate of.
 * Read that module for the whole argument: why the contract is split hard/soft,
 * why it is derived at read time rather than stored, and why it stays in
 * TypeScript instead of moving into the Go API (both consumers must evaluate
 * in-process, so a Go copy would be a THIRD implementation, not a replacement).
 *
 * What stays in the gateway is only the WIRING: which call runs which half, and
 * how the answer is shaped for an agent. `epic_propose` runs the hard half
 * before any write (a refused plan leaves nothing behind) and the soft half over
 * the batch it just created; `task_get` runs `storedTicketWarnings` on the
 * stored row, ticket-scoped, using the one fact it cannot derive —
 * `epic.hasLinkedContext` from the API (action_handler.go).
 *
 * A note on the dependency: `@agentcanvas/shared` is a workspace package and is
 * declared as a devDependency on purpose. tsup externalizes `dependencies` and
 * BUNDLES everything else, so the published `@jaximus/tandem-mcp` ships the
 * rules inside dist/ rather than declaring a dependency npm could never resolve.
 */
import {
  qualityTicketFromArgs,
  storedTicketWarnings,
  storedWarningsNote,
  ticketContractFailures,
  ticketQualityWarnings,
  ticketWarningsNote,
} from "@agentcanvas/shared/ticket-quality";

type Args = Record<string, unknown>;

/** Reuse a CRUD tool's input schema verbatim, so the two can't drift. */
function schemaOf(name: string) {
  return rawOf(name).inputSchema;
}

/**
 * Reuse a CRUD tool's description verbatim. Facade tools normally get their own
 * (intent-shaped) prose; this is for the few tools the facade advertises but
 * does not reimplement, where one description serves both surfaces.
 */
function descriptionOf(name: string) {
  return rawOf(name).description;
}

function rawOf(name: string): RawTool {
  const raw = RAW_TOOL_BY_NAME.get(name);
  if (!raw) throw new Error(`facade: no CRUD tool named ${name} to borrow from`);
  return raw;
}

/**
 * task_complete's schema is the CRUD one PLUS `epicSummary` (TDM-93) — the
 * epic-level write path. Added here rather than on canvas_task_complete because
 * the facade composes it: the CRUD tool finishes the task and knows nothing
 * about the batch it belonged to.
 */
function withEpicSummaryArg(schema: RawTool["inputSchema"]) {
  return {
    ...schema,
    properties: {
      ...(schema as { properties?: Record<string, unknown> }).properties,
      epicSummary: {
        type: "string",
        description:
          "What the whole EPIC achieved, when this completion finishes the batch — the epic-level " +
          "counterpart of `result`. One short paragraph a human can read instead of opening every " +
          "ticket: what shipped, what changed, what was decided. It is stored on the epic (and " +
          "shown on the board above its tickets), NOT on this task, and writing it does not " +
          "disturb the epic's approval. Omit it when tasks in the epic are still open — the answer " +
          "tells you how many are left. Rewriting an existing summary replaces it.",
      },
    },
  };
}

// The one line every facade description repeats, because the handle is the
// single thing a session must carry and the most common cause of a dead call.
const SESSION_CONVENTION =
  "Pass the `session` handle from canvas_connect on this call (the hosted MCP " +
  "connection can reset between calls; the handle re-binds you without reconnecting).";

// ── Composed reads ───────────────────────────────────────────────────────────

type TaskRow = {
  id: string;
  ticketId?: string;
  state: string;
  proposedBy?: string;
  claimedBy?: string;
  // When the current claim was taken (or last heartbeated). The board's whole
  // "is anyone actually working this?" question is answered from this field.
  claimedAt?: string;
  result?: string;
  createdAt?: string;
  payload?: {
    title?: string;
    body?: string;
    assignee?: string;
    epicId?: string;
    progress?: unknown;
  };
};

/** Every agent task on the canvas, in one read. The basis of queue/board views. */
async function listAgentTasks(gateway: Gateway): Promise<TaskRow[]> {
  const res = (await gateway.get("/api/canvas/actions?type=task&assignee=agent")) as {
    actions?: TaskRow[];
  };
  return res.actions ?? [];
}

function compactTask(a: TaskRow) {
  return {
    id: a.id,
    ...(a.ticketId ? { ticketId: a.ticketId } : {}),
    title: a.payload?.title ?? "",
    state: a.state,
    ...(a.claimedBy ? { claimedBy: a.claimedBy } : {}),
    ...(a.payload?.epicId ? { epicId: a.payload.epicId } : {}),
  };
}

function countByState(tasks: TaskRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  return counts;
}

// ── Epic rollups (TDM-93) ────────────────────────────────────────────────────

/**
 * What GET /api/canvas/epics answers: every batch with its SUMMARY (what it
 * achieved) and its server-derived rollup. Composed API-side so a board-level
 * question costs one round trip instead of one read per ticket.
 */
type EpicRollup = {
  id: string;
  title: string;
  state: string;
  summary?: string;
  summaryBy?: string;
  summaryAt?: string;
  tasks: { total: number; byState: Record<string, number> };
  firstActivity?: string;
  lastActivity?: string;
  done: Array<{ id: string; ticketId?: string; title: string; state: string; result?: string }>;
  drained: boolean;
  /** Drained with nobody saying what it delivered — the story is about to be lost. */
  summaryNeeded: boolean;
  truncated?: number;
  /** The tickets that came BACK, each with the reason (TDM-161). */
  returned?: ReturnedTicket[];
  returnedTruncated?: number;
  /** Feedback on the EPIC itself — a human rejecting the whole batch. */
  review?: ReviewFeedback;
};

// ── Review feedback (TDM-161) ────────────────────────────────────────────────

/**
 * Why a piece of work came back, derived server-side (api/review_feedback.go)
 * into ONE shape whatever produced it: a human's rejection at the gate, or a
 * reviewer agent's rework bounce after it was finished. To the agent that wrote
 * the ticket those are the same event — "this came back, and here is why" — so
 * they arrive as one block with `outcome` naming which and `by` naming who.
 *
 * The gateway derives NOTHING here. It reads the server's answer and turns it
 * into the author's next move, which is the same division task_review keeps.
 */
type ReviewFeedback = {
  outcome: "rejected" | "rework";
  /** The decider's own words — VERBATIM on a task read. The reason IS the
   *  correction, so it is never excerpted here. */
  reason?: string;
  /** "human" | "agent:<identity>" | "anonymous" — server-derived. */
  by?: string;
  at?: string;
  /** Where the ticket sits NOW: 'rejected' is over, anything else is live. */
  state: string;
  /** Set only on the LIST read (an epic's returned[]), never on a task read. */
  reasonTruncated?: boolean;
};

/** One came-back ticket as the epic rollup lists it. */
type ReturnedTicket = ReviewFeedback & {
  id: string;
  ticketId?: string;
  title: string;
};

/**
 * The sentence a proposing agent needs about its own returned ticket — what
 * happened, and what to do about it. Empty when nothing came back.
 *
 * Written in the redirecting voice the refusal copy uses, and pointed at the
 * NEXT action rather than at the feeling: a rejection's value is in the
 * neighbouring tickets it also condemns, and a bounce's value is that the reason
 * is this attempt's brief. Both say what NOT to do too — re-proposing a rejected
 * ticket and re-completing over a bounce are the two ways this loop turns into a
 * treadmill.
 */
function reviewNote(fb: ReviewFeedback | undefined): { _review?: string } {
  if (!fb) return {};
  const by = fb.by ? ` by ${fb.by}` : "";
  const quoted = fb.reason ? ` The reason: "${fb.reason}"` : "";
  if (fb.outcome === "rejected") {
    return {
      _review:
        `This ticket was REJECTED${by}, so nobody will work it — do not claim it, and do not ` +
        `re-propose the same ticket, which lands the same way.${quoted}` +
        (fb.reason
          ? " Treat that as a correction to the PLAN, not just to this ticket: it usually " +
            "condemns neighbours too. Read the batch (the epic read lists every ticket that " +
            "came back with its reason) and task_amend the ones it also applies to before a " +
            "worker picks them up."
          : " No reason was recorded, so ask rather than guess at what was wrong.") +
        " If it contradicts the brief you were working from, say so — do not quietly re-file it.",
    };
  }
  return {
    _review:
      `This task was SENT BACK${by} and is '${fb.state}' again — it is the SAME ticket, still ` +
      `open, so do not re-propose it as a new one.${quoted}` +
      (fb.reason
        ? " That is the brief for this attempt, not a comment on the last one: do the work it " +
          "names, then task_complete again. If it is wrong or impossible, say so with " +
          "task_progress and ask — completing over it only spends the reviewer's next pass."
        : " No reason was recorded, which is worth asking about before redoing anything — " +
          "otherwise you are guessing at what changed."),
  };
}

/**
 * Read the rollups, or null on an API deployed before the endpoint existed
 * (same getIfAvailable contract context_get uses for /api/canvas/context).
 */
async function fetchEpicRollups(
  gateway: Gateway,
  opts: { full?: boolean } = {}
): Promise<EpicRollup[] | null> {
  try {
    // COMPACT is the default read (TDM-183, api side): per-ticket lines only
    // where there is still open work, and no `summaryBy` stamp. `?full=1` asks
    // for the archive — one line per finished ticket in every batch — and is
    // what the single-epic reads below want, because they quote exactly one
    // batch back and the trimming they need is their own.
    const res = await gateway.getIfAvailable<{ epics?: EpicRollup[] }>(
      `/api/canvas/epics${opts.full ? "?full=1" : ""}`
    );
    return res?.epics ?? null;
  } catch {
    // SUPPLEMENTARY, so it fails soft. Every caller of this asks its real
    // question through another endpoint (the board census, a task read, a
    // completion) and uses the rollup to enrich the answer — so a rollup that
    // 500s, times out, or isn't deployed must degrade the answer, never replace
    // it with an error. A completion in particular has already written to the
    // board by the time we get here: throwing would report a finished task as
    // failed.
    return null;
  }
}

/**
 * One rollup by id, or null when the endpoint or the epic is absent. Reads the
 * FULL shape: this feeds epicSnapshot, whose `summaryBy` attribution the compact
 * read drops, and it quotes a single batch rather than the whole board — so the
 * size argument that put the board read on a diet does not apply here.
 */
async function fetchEpicRollup(gateway: Gateway, epicId: string): Promise<EpicRollup | null> {
  const all = await fetchEpicRollups(gateway, { full: true });
  return all?.find((e) => e.id === epicId) ?? null;
}

/**
 * Terminal states, mirroring the API's epicTerminalStates (epic_rollup.go) and
 * the web's TERMINAL_STATES. Duplicated across the three surfaces because each
 * needs it locally; they must agree on WHICH states are over, or the three will
 * disagree about whether a batch is finished.
 */
const EPIC_TERMINAL_STATES = ["done", "failed", "rejected"] as const;

/** How many of an epic's tasks will never move again on their own. */
function terminalCount(e: EpicRollup): number {
  return EPIC_TERMINAL_STATES.reduce((n, s) => n + (e.tasks.byState[s] ?? 0), 0);
}

/**
 * The compact epic block a task-shaped answer carries: what the batch is, what
 * it achieved so far, and where it stands. Deliberately drops `done[]` — a
 * worker finishing ONE ticket doesn't need forty of its siblings quoted back;
 * board_status is where the full account belongs.
 */
function epicSnapshot(e: EpicRollup) {
  return {
    id: e.id,
    title: e.title,
    state: e.state,
    ...(e.summary ? { summary: e.summary, ...(e.summaryBy ? { summaryBy: e.summaryBy } : {}) } : {}),
    tasks: e.tasks,
    drained: e.drained,
    summaryNeeded: e.summaryNeeded,
    // The tickets in this batch that came back, with their reasons (TDM-161).
    // Kept where done[] is dropped, because the two are not the same weight: a
    // worker does not need forty siblings quoted at it, but it very much needs
    // to know that the human already cut three tickets next to the one it is
    // about to start — that is the correction most likely to apply to its own.
    // Absent (not empty) on the overwhelming majority of batches, which cost
    // nothing here.
    ...(e.returned && e.returned.length > 0 ? { returned: e.returned } : {}),
    ...(e.review ? { review: e.review } : {}),
  };
}

// ── The board read's epic rows (TDM-184) ─────────────────────────────────────

/**
 * How much of a batch's summary the BOARD read quotes. The board answers "where
 * does this project stand", which a first line answers; "what exactly did E15
 * deliver" is the expanded read, one argument away. Capped rather than dropped
 * because a bare list of epic titles is not a status report — and capped at all
 * because every finished batch keeps its summary forever, so an uncapped one
 * would make the board read grow with the project's whole history.
 */
const BOARD_SUMMARY_CHARS = 200;

/** First line, cut to `max`, with a flag saying whether anything was left out. */
function excerptLine(text: string, max: number): { text: string; truncated: boolean } {
  const firstLine = text.trim().split("\n")[0]!.trim();
  const cut = firstLine.length > max;
  return {
    text: cut ? `${firstLine.slice(0, max)}…` : firstLine,
    truncated: cut || firstLine.length < text.trim().length,
  };
}

/**
 * One epic as the DEFAULT board read shows it: bounded in size no matter how
 * many tickets the batch has or how long the project has run.
 *
 * The board read used to quote one line per finished ticket for every batch on
 * the canvas, so it grew with the archive — 34 batches and 250 tickets in, the
 * answer to "where does this stand?" was ~79KB of mostly-finished history, and
 * the live rows an orchestrator actually needed were buried in it. The per-ticket
 * account did not stop being useful; it stopped being something every read should
 * pay for. So it moves behind `epic:` — expand exactly one batch — and what stays
 * here is what a status answer is made of: the counts, the state, the first line
 * of what the batch achieved, and whether anything came back.
 *
 * `doneOmitted` is what keeps that honest: a row never quietly drops lines, it
 * says how many and where to get them. Activity timestamps are dropped too —
 * they are per-batch trivia the expanded read still carries.
 */
function boardEpicRow(e: EpicRollup) {
  const summary = e.summary ? excerptLine(e.summary, BOARD_SUMMARY_CHARS) : undefined;
  // Either the server already compacted this batch (it says how many lines it
  // left out) or it sent them and we are dropping them here. Both are the same
  // fact to the reader.
  const omitted = e.doneOmitted ?? e.done?.length ?? 0;
  return {
    id: e.id,
    title: e.title,
    state: e.state,
    tasks: e.tasks,
    ...(summary
      ? { summary: summary.text, ...(summary.truncated ? { summaryTruncated: true } : {}) }
      : {}),
    // Flags only when true: on a board of mostly-finished batches, `false` on
    // every row is pure weight.
    ...(e.drained ? { drained: true } : {}),
    ...(e.summaryNeeded ? { summaryNeeded: true } : {}),
    ...(omitted > 0 ? { doneOmitted: omitted } : {}),
    // Never trimmed here (TDM-161): a ticket that came BACK carries the
    // decider's reason, which is the most actionable thing on the whole read.
    // The server already excerpts these, and they are rare.
    ...(e.returned && e.returned.length > 0 ? { returned: e.returned } : {}),
    ...(e.review ? { review: e.review } : {}),
  };
}

/**
 * Resolve the `epic` argument — an id, or a title the caller half-remembers
 * ("E15", "the token diet one") — against the batches on this board.
 *
 * Refusals come back as DATA, never as a throw: the board read still answers,
 * and the caller is told which names exist rather than having to go looking.
 */
function matchBoardEpic(
  epics: EpicRollup[],
  ref: string
): { epic?: EpicRollup; problem?: string } {
  const needle = ref.trim().toLowerCase();
  if (!needle) return {};
  const byId = epics.find((e) => e.id.toLowerCase() === needle);
  if (byId) return { epic: byId };
  const exact = epics.filter((e) => (e.title ?? "").trim().toLowerCase() === needle);
  if (exact.length === 1) return { epic: exact[0] };
  const partial = epics.filter((e) => (e.title ?? "").toLowerCase().includes(needle));
  if (partial.length === 1) return { epic: partial[0] };
  const names = (partial.length > 1 ? partial : epics)
    .slice(0, 12)
    .map((e) => `"${e.title}"`)
    .join(", ");
  if (partial.length > 1) {
    return {
      problem:
        `\`epic: "${ref}"\` matches ${partial.length} batches (${names}) — nothing was expanded. ` +
        `Pass the epic's id, or enough of one title to name it alone.`,
    };
  }
  return {
    problem:
      `No epic here matches \`epic: "${ref}"\` — nothing was expanded, and the rest of this ` +
      `board read is unaffected. The batches on this canvas are: ${names}` +
      (epics.length > 12 ? `, …(+${epics.length - 12} more)` : "") +
      `. Pass an id or a title from that list.`,
  };
}

/**
 * Merge a summary into an epic's payload and PATCH it back.
 *
 * A payload PATCH REPLACES the payload, so the existing fields have to be read
 * and carried — the same read-merge-write task_amend does. Safe against the
 * approval gate by construction: `summary` is not a content field (title/body),
 * so this write does NOT revert an approved epic to 'proposed', which is the
 * only reason an agent can be trusted with it at all.
 *
 * summaryBy / summaryAt are deliberately NOT sent: the API stamps them from
 * request provenance and discards anything a caller puts there.
 */
async function writeEpicSummary(
  gateway: Gateway,
  epicId: string,
  summary: string
): Promise<{ title: string; state: string }> {
  const { action } = (await gateway.get(`/api/canvas/actions/${encodeURIComponent(epicId)}`)) as {
    action?: { type?: string; state?: string; payload?: Record<string, unknown> };
  };
  if (!action) throw new Error(`No epic "${epicId}" found on this canvas.`);
  if (action.type !== "epic") {
    throw new Error(
      `"${epicId}" is a ${action.type ?? "unknown"}, not an epic — epicId must name an epic ` +
        `(board_status lists them). For a TASK's outcome use task_complete's \`result\`.`
    );
  }
  const payload: Record<string, unknown> = { ...(action.payload ?? {}), summary };
  await gateway.patch(`/api/canvas/actions/${encodeURIComponent(epicId)}`, {
    payload,
    agentName: gateway.claimant(),
  });
  return {
    title: typeof action.payload?.title === "string" ? action.payload.title : "",
    state: action.state ?? "",
  };
}

// ── In-flight reporting (TDM-95) ─────────────────────────────────────────────

/**
 * How long the API honours a claim before another session may take the task over
 * (CLAIM_TTL_MINUTES on the server, default 15). The gateway cannot read the
 * server's setting, so this is only used to LABEL a claim as stale in
 * board_status — it enforces nothing, and the server remains the authority on
 * whether a lease actually lapsed.
 */
const DEFAULT_CLAIM_LEASE_MINUTES = 15;

/** How long a progress note may be in a board read before it gets trimmed. */
const BOARD_PROGRESS_CHARS = 200;

/**
 * How many un-summarized batches the board read NAMES. The count is always
 * exact and every such epic is flagged on its own row; this only caps the
 * convenience list, which on a long-running board is otherwise two dozen ids and
 * titles quoted a second time.
 */
const UNSUMMARIZED_LISTED = 6;

type ProgressEntry = { at?: string; agent?: string; note?: string };

/** Whole minutes since an ISO timestamp; undefined if it isn't usable. */
function minutesSince(iso: string | undefined, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.round((now - at) / 60_000));
}

/**
 * The task's most recent progress note, trimmed. This is what makes a board read
 * a REPORT rather than a list of names: without it an orchestrator asked "how is
 * the fleet doing?" had to task_get every executing task to find out. It costs
 * nothing extra — progress is stored on the task payload the board read already
 * fetched.
 */
function lastProgressOf(task: TaskRow) {
  const hist: ProgressEntry[] = Array.isArray(task.payload?.progress)
    ? (task.payload?.progress as ProgressEntry[])
    : [];
  const last = hist[hist.length - 1];
  const note = typeof last?.note === "string" ? last.note.trim() : "";
  if (!note) return undefined;
  const ageMinutes = minutesSince(last?.at);
  return {
    note: note.length > BOARD_PROGRESS_CHARS ? `${note.slice(0, BOARD_PROGRESS_CHARS)}…` : note,
    ...(last?.at ? { at: last.at } : {}),
    ...(ageMinutes === undefined ? {} : { ageMinutes }),
    entries: hist.length,
  };
}

/**
 * One executing task, as a fleet report line: who holds it, how long they have
 * held it, whether that claim has outlived its lease, and the last thing they
 * said. `ticketId` is absent only for a task created before ticket numbering
 * (migration 0034) — those are still addressable by `id`.
 */
function inFlightRow(task: TaskRow) {
  const claimAgeMinutes = minutesSince(task.claimedAt);
  const progress = lastProgressOf(task);
  return {
    ...compactTask(task),
    claimedBy: task.claimedBy ?? "agent",
    ...(task.claimedAt ? { claimedAt: task.claimedAt } : {}),
    ...(claimAgeMinutes === undefined ? {} : { claimAgeMinutes }),
    // Past the default lease with no heartbeat since: the holder has probably
    // gone dark, and the server will let the task be reclaimed.
    ...(claimAgeMinutes !== undefined && claimAgeMinutes >= DEFAULT_CLAIM_LEASE_MINUTES
      ? { staleClaim: true }
      : {}),
    ...(progress ? { lastProgress: progress } : {}),
  };
}

const BRIEFING_NAMES_PER_KIND = 20;

/** Trim the summary's per-kind name lists to briefing size, marking what's hidden. */
function capNames(names: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [kind, list] of Object.entries(names)) {
    out[kind] =
      list.length > BRIEFING_NAMES_PER_KIND
        ? [...list.slice(0, BRIEFING_NAMES_PER_KIND), `…(+${list.length - BRIEFING_NAMES_PER_KIND} more)`]
        : list;
  }
  return out;
}

/** Canvas identity block shared by context_get and board_status. */
function canvasBlock(gateway: Gateway) {
  const s = gateway.getSession();
  return {
    id: s.canvasId,
    name: s.canvasName,
    code: s.canvasCode,
    url: gateway.canvasUrl(s.canvasCode),
  };
}

// ── Who may open the approval gate (TDM-145 / TDM-146) ───────────────────────
//
// The canvas approval policy decides it, and it is the SERVER's decision — the
// gateway never re-implements the rule, it only stops SAYING the wrong thing.
// On strict|epic|auto (every canvas by default) approval is human-only and the
// surface's long-standing prose is exactly right. On 'peer' it is not: there, a
// registered REVIEWER agent may approve a task a DIFFERENT agent proposed, so
// "a human approves this" would send a reviewer away from work it is allowed to
// do. Hence: read the policy, condition the prose, change no behaviour.

/** The 'peer' approval policy (API: apps/api/internal/api/peer_approval.go). */
const POLICY_PEER = "peer";

/**
 * Per-Gateway memo of the canvas's approval policy. A WeakMap rather than a field
 * on CanvasSession ON PURPOSE: the session is serialized into the handle the model
 * carries for the rest of its run, and a policy baked in there would go stale the
 * moment the owner changed it — while this memo dies with the Gateway (per process
 * on stdio, per call on the hosted sidecar, which is exactly when a re-read is
 * cheap and correct). `""` records a LOOKUP THAT FAILED, so an API that cannot
 * answer is asked once, not on every call.
 */
const approvalPolicyMemo = new WeakMap<Gateway, string>();

/**
 * Best-effort read of this canvas's approval policy. Returns undefined when it
 * cannot be determined — and every caller treats undefined as "assume the human
 * gate", which is both the default and the safe thing to say.
 *
 * Reads the cheap state SUMMARY (`fields=agents`: one small table plus the canvas
 * row) rather than the whole board, and goes through getIfAvailable so an older
 * API — or a 404 — degrades to undefined instead of failing the call the caller
 * was actually making. Nothing here decides anything: the API refuses or allows
 * the approval regardless of what this returns.
 */
async function approvalPolicyOf(gateway: Gateway): Promise<string | undefined> {
  const memo = approvalPolicyMemo.get(gateway);
  if (memo !== undefined) return memo || undefined;
  let policy = "";
  try {
    const res = await gateway.getIfAvailable<{ canvas?: { approvalPolicy?: unknown } }>(
      "/api/canvas/state?fields=agents"
    );
    if (typeof res?.canvas?.approvalPolicy === "string") policy = res.canvas.approvalPolicy;
  } catch {
    // NOTHING here may fail the caller's actual operation. This probe only picks
    // which sentence to append to an answer that has already been computed, so a
    // timeout, an expired token or an unreachable API costs a slightly less
    // specific hint — never the queue read, the amend refusal, or the epic that
    // was just created. Recorded as a failed lookup so it is tried once, not once
    // per call in a polling loop that has lost the network.
  }
  approvalPolicyMemo.set(gateway, policy);
  return policy || undefined;
}

/** Is this canvas the one place an agent may approve a peer's task? */
async function canvasAllowsPeerApproval(gateway: Gateway): Promise<boolean> {
  return (await approvalPolicyOf(gateway)) === POLICY_PEER;
}

/**
 * The one sentence the MANIFEST can say about peer approval. Tool descriptions
 * are built once, before any canvas is bound, so they cannot be conditioned the
 * way the runtime answers above are — the qualifier has to be static, and has to
 * stay TRUE on the three policies where approval really is human-only.
 */
const PEER_APPROVAL_CLAUSE =
  "(One exception, off by default: on a canvas whose owner turned on the 'peer' approval policy, " +
  "a reviewer agent may approve a task a DIFFERENT agent proposed, and send that agent's finished " +
  "work back for changes — task_review. Never your own work, and never on any other canvas.)";

/**
 * The refusal a coded 403 carries, normalized.
 *
 * THE SUBTLETY THAT MATTERS: a canvas that is NOT on 'peer' answers the legacy
 * `{"error": "only a signed-in human can approve an action"}` — prose in `error`,
 * no code, byte-identical to what it answered before peer approval existed (the
 * API has a regression test pinning exactly that). A coded refusal instead puts a
 * stable code in `error` and prose in `message`. So the presence of `message` is
 * the discriminator; assuming a code would mislabel every strict/epic/auto canvas.
 */
type ApprovalRefusal = {
  /** Stable server code (peer_self_approval, …), or undefined on a legacy refusal. */
  code?: string;
  message: string;
  /** Whatever else the server attached — `approver`, `proposedBy`, `actionType`. */
  extra: Record<string, string>;
};

function readApprovalRefusal(body: unknown): ApprovalRefusal {
  const row = (body ?? {}) as Record<string, unknown>;
  const error = typeof row.error === "string" ? row.error : "";
  const message = typeof row.message === "string" ? row.message : "";
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "error" || k === "message") continue;
    if (typeof v === "string") extra[k] = v;
  }
  // Coded envelope (error = code, message = prose) vs legacy (error = prose).
  return message
    ? { code: error || undefined, message, extra }
    : { message: error || "the server refused this approval", extra };
}

/**
 * A refusal this gateway has no bespoke copy for — a code the API grew after this
 * build shipped. The ONLY safe thing to do is hand the server's own sentence back
 * as the instruction and say clearly that it is a refusal, not a fault: a
 * reviewer that reads "unknown error" retries, and a reviewer that reads the
 * server's reason stops. This is why a new API refusal code never needs a gateway
 * release to be usable — only to be phrased better.
 */
function unknownRefusalNext(refusal: ApprovalRefusal): string {
  return (
    `The server refused, with a reason this gateway has no specific advice for (\`${refusal.code}\`), ` +
    `so its own words ARE the instruction: "${refusal.message}". This is a decision, not a ` +
    `transport error — do not retry the same call. Fix what it names if that is in your power, ` +
    `otherwise leave the task where it is and report the reason to the human.`
  );
}

/**
 * The same-model refusal (TDM-155): a canvas whose owner turned on cross-model
 * review requires the reviewer to be a different MODEL from the author, not
 * merely a different agent. The API ships it on BOTH review paths with distinct
 * codes — `peer_same_model` on approve, `rework_same_model` on the bounce
 * (peer_approval.go) — because a client should be able to tell which door closed.
 *
 * Matched on the shared SHAPE of those codes rather than listed one by one: the
 * advice is identical on both paths (get a different model, or the human), so a
 * substring test is the honest expression of "these are the same answer", and it
 * keeps working if the rule ever grows a third door. Anything it misses still
 * lands in unknownRefusalNext and reads as the server's own words.
 */
function isSameModelRefusal(code?: string): boolean {
  return !!code && code.includes("same_model");
}

function sameModelNext(refusal: ApprovalRefusal): string {
  // The API names the colliding model in `approverModel` (approve) or
  // `reviewerModel` (rework); it is absent only if the shape changes.
  const model = refusal.extra.reviewerModel || refusal.extra.approverModel;
  return (
    `You and the agent whose work this is are the same MODEL${model ? ` (${model})` : ""}, and this ` +
    `canvas requires review from a different one — same-model review is the theatre peer review ` +
    `exists to avoid, not a technicality. Nothing you can do from here changes that: hand it to a ` +
    `reviewer agent running on a different model, or to the human, and report it as still ` +
    `awaiting review.`
  );
}

/** The refusal every canvas that is NOT on 'peer' answers — uncoded, and the default. */
const HUMAN_APPROVAL_ONLY_NEXT =
  "Approval on this canvas is the human's — it is not on the 'peer' approval policy, which " +
  "is the only mode where an agent may approve another agent's task, and only the canvas " +
  "owner can turn that on. Report the task as waiting for approval on the board and move on.";

/**
 * What the reviewer should DO about a refusal. Keyed off the server's code so the
 * gateway adds routing, not rules — every one of these is the server's decision
 * restated as a next call.
 */
function approvalRefusalNext(refusal: ApprovalRefusal): string {
  if (isSameModelRefusal(refusal.code)) return sameModelNext(refusal);
  switch (refusal.code) {
    case "peer_self_approval":
      return (
        "You proposed this task, so you cannot be the one who approves it — that is the whole " +
        "point of peer review. A DIFFERENT registered agent has to approve it, or a human does " +
        "on the board. Leave it and report it as awaiting review."
      );
    case "peer_identity_required":
      return (
        "This session has no agent identity the server can see. Reconnect with canvas_connect " +
        "passing a `name` and `role` (that one call registers you), then approve under that " +
        "identity."
      );
    case "peer_agent_unregistered":
      return (
        "Your identity is not on this canvas's roster. Register it — canvas_connect with a `name` " +
        "and `role`, or agent_register — and try again under that name."
      );
    case "peer_epic_human_only":
      return (
        "Epics stay human-only everywhere: approving one releases every task under it. Ask the " +
        "human to approve the epic on the board, or review its tasks one at a time."
      );
    case "peer_proposer_unknown":
      return (
        "The server cannot tell who proposed this task, so it cannot prove you are not the " +
        "proposer, and it refuses rather than guess. A human approves this one on the board."
      );
  }
  // NO `default:` — an unrecognized CODE and the uncoded LEGACY refusal are two
  // different answers and used to share one sentence. The legacy body (prose in
  // `error`, no `message`) is what every strict|epic|auto canvas still returns,
  // and the human-only wording is exactly right for it. A code this build has
  // never heard of is NOT that: telling a reviewer "this canvas isn't on peer"
  // when the server actually said something else sends it away from work it may
  // be allowed to do. (TDM-155's same-model refusal is the immediate case.)
  return refusal.code ? unknownRefusalNext(refusal) : HUMAN_APPROVAL_ONLY_NEXT;
}

/**
 * POST the approve endpoint — the reviewer's YES, one call site.
 *
 * Shared by task_review (outcome 'pass') and the legacy task_approve alias so
 * the two can never drift into approving differently. The body is empty because
 * the approver identity rides the X-Tandem-Agent header the gateway already
 * sends; an `approvedBy` in the body is the forgery vector TDM-40 / TDM-129
 * closed, and the server ignores it either way.
 */
async function postApproval(gateway: Gateway, id: string, alsoRefusalStatuses?: number[]) {
  return gateway.postWithRefusal<
    { action?: TaskRow & { type?: string; approvedBy?: string } },
    unknown
  >(`/api/canvas/actions/${encodeURIComponent(id)}/approve`, {}, alsoRefusalStatuses);
}

// ── Sending finished work back (TDM-154 / TDM-156) ───────────────────────────
//
// The reviewer's OTHER answer. `POST /api/canvas/actions/{id}/rework` rewinds a
// done task to 'approved' with a required reason, and is gated the same way the
// peer approve is: 'peer' canvas only, reviewer ≠ the agent that finished the
// work, both identities server-derived. Rejection — which destroys a proposal —
// stays human-only; the bounce is the reversible move, which is why it is the one
// an agent gets.
//
// Same division of labour as approvalRefusalNext: the API decides, this only
// turns its decision into the reviewer's next move.

/** What to do about a refused bounce, by the server's stable code (TDM-154). */
function reworkRefusalNext(refusal: ApprovalRefusal): string {
  if (isSameModelRefusal(refusal.code)) return sameModelNext(refusal);
  switch (refusal.code) {
    case "rework_not_finished":
      return (
        `Only FINISHED work can be sent back, and this task is '${refusal.extra.state ?? "not done"}'. ` +
        `If it is still 'proposed' you are looking at a PLAN, not work: review it with ` +
        `outcome 'pass' to release it, or leave it unapproved and say why — an agent cannot ` +
        `reject a proposal, that stays the human's. If it is 'approved' or 'executing', nobody ` +
        `has submitted anything to review yet: leave it alone and come back once it is done.`
      );
    case "rework_self_review":
      return (
        `You finished this task${refusal.extra.completedBy ? ` (the server has it completed by ${refusal.extra.completedBy})` : ""}, ` +
        `so you cannot be the one who sends it back — reviewing your own work is the thing peer ` +
        `review exists to prevent. Another registered agent, or the human on the board, has to ` +
        `make that call. Say what you would have changed and leave the task done.`
      );
    case "rework_policy_required":
      return (
        "This canvas is not on the 'peer' approval policy, and that is the only mode where an " +
        "agent can bounce another agent's finished work. Only the canvas owner can turn it on. " +
        "Write what you would have sent back — in a task_progress note, a doc_write, or your " +
        "report — and leave the task done for the human to judge."
      );
    case "rework_identity_required":
      return (
        "This session has no agent identity the server can see, and an anonymous bounce is " +
        "refused on purpose. Reconnect with canvas_connect passing a `name` and `role` (that one " +
        "call registers you), then review again under that identity."
      );
    case "rework_agent_unregistered":
      return (
        "Your identity is not on this canvas's roster. Register it — canvas_connect with a `name` " +
        "and `role`, or agent_register — and review again under that name."
      );
    case "rework_task_only":
      return (
        `Only a TASK can be sent back for rework; this is a ${refusal.extra.actionType ?? "different kind of action"}. ` +
        `Epics are not reviewed as a unit — review the tasks under it one at a time.`
      );
    case "rework_completer_unknown":
      return (
        "The server cannot tell WHO finished this task, so it cannot prove you are not that " +
        "agent, and it fails closed rather than guess. This one is the human's on the board — " +
        "report what you found and why you would send it back."
      );
    case "rework_reason_required":
      return (
        "The bounce carries the reason the author works from, so an empty one is refused. Call " +
        "again with a `reason` naming what is wrong and what 'fixed' looks like."
      );
  }
  return refusal.code
    ? unknownRefusalNext(refusal)
    : `The server refused to send this back: "${refusal.message}". Leave the task as it is and ` +
      `report that, rather than retrying.`;
}

/**
 * The briefing bundle, composed from endpoints that exist TODAY: the canvas
 * state SUMMARY (counts + capped names — never the full board), the document
 * tabs, and the agent task queue.
 *
 * TODO(TDM-29 / E1.3): a server-built `GET /api/canvas/context` is landing in a
 * parallel epic and will return a better-curated briefing (pinned context,
 * conventions, recent activity). context_get already probes for it first and
 * returns it untouched when present; this composition is the fallback for any
 * API deployed before that endpoint. When the endpoint's contract is final,
 * decide whether to keep this fallback or drop it with a min-API-version check.
 */
async function composeContext(gateway: Gateway) {
  const [summary, docs, tasks] = await Promise.all([
    gateway.get("/api/canvas/state") as Promise<{
      mode?: string;
      version?: number;
      counts?: Record<string, number>;
      names?: Record<string, string[]>;
    }>,
    gateway.get("/api/canvas/documents") as Promise<{
      documents?: Array<{ id: string; type: string; name: string; parentId?: string }>;
    }>,
    listAgentTasks(gateway),
  ]);

  const byState = countByState(tasks);
  const ready = tasks.filter((t) => t.state === "approved").map(compactTask);

  return {
    source: "composed" as const,
    canvas: canvasBlock(gateway),
    mode: summary.mode,
    version: summary.version,
    // Counts + names only — a briefing must never cost a full-canvas read.
    // The API already caps names per kind (at 200); cap harder here, because a
    // briefing is meant to orient, not to enumerate.
    contents: { counts: summary.counts ?? {}, names: capNames(summary.names ?? {}) },
    documents: (docs.documents ?? []).map((d) => ({
      id: d.id,
      type: d.type,
      name: d.name,
      ...(d.parentId ? { parentId: d.parentId } : {}),
    })),
    queue: {
      byState,
      ready: ready.slice(0, 10),
      ...(ready.length > 10 ? { readyTruncated: ready.length - 10 } : {}),
    },
    _next:
      ready.length > 0
        ? "There is approved work waiting. Call queue_next: it returns a paste-ready `handoff` per " +
          "task to dispatch a subagent with, or task_get + task_claim the one you'll do yourself."
        : "No approved work. Ask the human what to do, or draft tasks with task_propose (they land as 'proposed' for approval).",
  };
}

// ── Lookup by name (TDM-95) ──────────────────────────────────────────────────

/**
 * THE LAST REASON TO READ THE WHOLE BOARD, removed.
 *
 * A ticket ref reaches a task in one call (every task_* tool accepts "TDM-21").
 * A NAME did not: told "finish the constraints task", a session had to list every
 * task and scan titles itself — the exact full-board read the queue-first surface
 * exists to avoid, and it burned the context window on rows it threw away.
 *
 * So: search server-side-ish (one list read, no bodies returned) and hand back
 * only the matches. Matching is deliberately dumb and predictable — substring,
 * then all-words-in-title, then all-words-in-title-or-body — because a model that
 * cannot tell why something matched will not trust the answer. `matchedIn` says
 * which rule fired.
 */
const FIND_MATCH_SUBSTRING = 3;
const FIND_MATCH_TITLE_WORDS = 2;
const FIND_MATCH_BODY = 1;

/** Ticket forms a human/model writes: "TDM-21", "tdm-21", "#21", "21". */
function asTicketRef(query: string): string | undefined {
  const m = /^(?:tdm-|#)?(\d{1,9})$/i.exec(query.trim());
  return m ? `TDM-${Number(m[1])}` : undefined;
}

/** Score one task against a query. undefined = not a match. */
function scoreTask(
  task: TaskRow,
  needle: string,
  words: string[]
): { score: number; matchedIn: "title" | "body" } | undefined {
  const title = (task.payload?.title ?? "").toLowerCase();
  const body = (task.payload?.body ?? "").toLowerCase();
  if (title.includes(needle)) return { score: FIND_MATCH_SUBSTRING, matchedIn: "title" };
  if (words.length > 0 && words.every((w) => title.includes(w))) {
    return { score: FIND_MATCH_TITLE_WORDS, matchedIn: "title" };
  }
  if (words.length > 0 && words.every((w) => title.includes(w) || body.includes(w))) {
    return { score: FIND_MATCH_BODY, matchedIn: "body" };
  }
  return undefined;
}

/** A match row: enough to act on (claim it, get it), never a body. */
function findRow(task: TaskRow, matchedIn?: "title" | "body") {
  return {
    ...compactTask(task),
    assignee: task.payload?.assignee ?? "agent",
    ...(task.claimedAt ? { claimedAt: task.claimedAt } : {}),
    ...(matchedIn ? { matchedIn } : {}),
  };
}

// ── Composed writes ──────────────────────────────────────────────────────────

/**
 * Resolve the notes document to write into, CREATING it when the name is new.
 * The raw API rejects an unknown document name (only the unnamed default is
 * created on demand), which makes "leave a note in a doc called X" a 3-call
 * dance. doc_write does that dance here so the agent gets one call.
 */
async function resolveNotesDocument(gateway: Gateway, ref: string): Promise<string> {
  const { documents = [] } = (await gateway.get("/api/canvas/documents")) as {
    documents?: Array<{ id: string; type: string; name: string }>;
  };
  const wanted = ref.trim().toLowerCase();
  const hit = documents.find(
    (d) => d.id.toLowerCase() === wanted || d.name.trim().toLowerCase() === wanted
  );
  if (hit) {
    if (hit.type !== "notes") {
      throw new Error(
        `Document "${ref}" is a ${hit.type} document, not a notes document — doc_write writes ` +
          `markdown notes. Pick a notes document (or a new name to create one).`
      );
    }
    return hit.id;
  }
  const created = (await gateway.post("/api/canvas/documents", {
    type: "notes",
    name: ref.trim(),
    createdBy: "agent",
  })) as { document?: { id: string } };
  if (!created.document?.id) throw new Error(`Could not create notes document "${ref}"`);
  return created.document.id;
}

// ── Composed reads: doc_read (TDM-180) ───────────────────────────────────────
//
// The read side of doc_write. An agent that wrote a tab could not read it back
// on this surface: the only path was GET /api/canvas/state?fields=notes — EVERY
// note on the canvas — matched by hand against a second read of fields=documents.
// On a board whose docs are the strategy writing, that is the whole corpus pulled
// into a context window to answer a question about one tab. TDM-179 put the
// scoped read on the API; this is the tool over it.

/** One note as the document endpoint (TDM-179) returns it. */
type DocumentNoteLine = { id?: string; body?: string; createdBy?: string; updatedAt?: string };

/** GET /api/canvas/documents/{ref}/notes */
type DocumentNotesResponse = {
  document?: { id: string; name: string; type: string };
  notes?: DocumentNoteLine[];
};

// ── The output budget (TDM-181) ──────────────────────────────────────────────
//
// A document tab is unbounded: the strategy docs on this very canvas are tens of
// KB, and nothing stops a tab from being a megabyte. doc_read handing all of it
// back in one answer is how a single tool call eats a context window — and the
// agent cannot even see it coming, because it asked for "one tab" and got a
// corpus. So the answer is capped and PAGED: a fixed byte budget per call, and a
// cursor the caller passes back for the next slice.
//
// The budget is on the MARKDOWN (note bodies), not the JSON envelope: the bodies
// are the part that scales without limit, and measuring what the caller actually
// reads keeps the number meaningful.

/** Per-call ceiling on returned markdown. ~20KB ≈ 5k tokens — a big read, not a ruinous one. */
const DOC_READ_BUDGET_BYTES = 20_000;

/**
 * Don't start a partial slice with less than this left in the budget: a 40-byte
 * sliver of a note costs a whole extra round-trip to say almost nothing. Under
 * it we stop cleanly and point the cursor at where the note resumes.
 */
const DOC_READ_MIN_SLICE_BYTES = 512;

/** Where a truncated read resumes: the note to continue at, and how far into it. */
type DocReadCursor = { noteCursor?: string; offset?: number };

const utf8Len = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * Take at most `maxBytes` of `body` starting at byte `start`, never splitting a
 * UTF-8 codepoint — a slice that ends mid-sequence decodes to U+FFFD and quietly
 * corrupts the markdown the agent is trying to read.
 */
function sliceUtf8(body: string, start: number, maxBytes: number): { text: string; bytes: number } {
  const buf = Buffer.from(body, "utf8");
  if (start >= buf.length || maxBytes <= 0) return { text: "", bytes: 0 };
  let end = Math.min(buf.length, start + maxBytes);
  // Back off any trailing continuation bytes (0b10xxxxxx) so `end` lands on a
  // codepoint boundary. At most 3 steps.
  while (end > start && end < buf.length && (buf[end] & 0b1100_0000) === 0b1000_0000) end--;
  return { text: buf.subarray(start, end).toString("utf8"), bytes: end - start };
}

/**
 * Project a tab into the answer the model reads: one entry per note, each
 * carrying its markdown AND the `noteId` doc_write needs to rewrite it in place
 * (without the id, revising a doc means appending a second copy of it).
 *
 * PURE, and the single shaping point for BOTH read paths below — so the two
 * cannot drift, and the output budget (above) is enforced in exactly one place.
 *
 * Fits in the budget? The answer is what it always was — no cursor, no
 * `truncated`, no paging noise for the small tab that is the common case.
 * Doesn't fit? First slice only, `truncated: true`, and a `nextCursor` that says
 * how much is left and the literal call that fetches it.
 */
function shapeDocRead(
  doc: { id: string; name: string; type?: string },
  notes: DocumentNoteLine[],
  url: string,
  cursor: DocReadCursor = {},
  budget = DOC_READ_BUDGET_BYTES
) {
  const all = notes.map((n) => ({ id: n.id, body: n.body ?? "", createdBy: n.createdBy, updatedAt: n.updatedAt }));
  const totalBytes = all.reduce((sum, n) => sum + utf8Len(n.body), 0);

  // Where this page starts. A cursor that names nothing is not silently ignored:
  // the note was deleted or rewritten under the caller, and continuing from note
  // 0 would hand back a page it already read as if it were the next one.
  let startIndex = 0;
  if (cursor.noteCursor) {
    const at = all.findIndex((n) => n.id === cursor.noteCursor);
    if (at < 0) {
      throw new Error(
        `\`noteCursor\` "${cursor.noteCursor}" is not in "${doc.name}" any more — the note was ` +
          `deleted or replaced since your last page. Re-read the tab from the start: doc_read ` +
          `{ document: "${doc.name}" }.`
      );
    }
    startIndex = at;
  }
  const startOffset = Math.max(0, Math.min(Math.floor(cursor.offset ?? 0), utf8Len(all[startIndex]?.body ?? "")));

  const page: Array<Record<string, unknown>> = [];
  let spent = 0;
  let next: Required<DocReadCursor> | null = null;

  for (let i = startIndex; i < all.length; i++) {
    const n = all[i];
    const from = i === startIndex ? startOffset : 0;
    const bodyBytes = utf8Len(n.body);
    const left = bodyBytes - from;
    const room = budget - spent;

    if (left <= room) {
      page.push({
        noteId: n.id,
        body: from ? sliceUtf8(n.body, from, left).text : n.body,
        ...(from ? { partial: true, resumedAtByte: from } : {}),
        ...(n.createdBy ? { createdBy: n.createdBy } : {}),
        ...(n.updatedAt ? { updatedAt: n.updatedAt } : {}),
      });
      spent += left;
      continue;
    }

    // Doesn't fit. Take a slice if there's enough room to be worth a call;
    // otherwise stop here and resume at this exact byte next time.
    if (room >= DOC_READ_MIN_SLICE_BYTES) {
      const { text, bytes } = sliceUtf8(n.body, from, room);
      page.push({
        noteId: n.id,
        body: text,
        partial: true,
        ...(from ? { resumedAtByte: from } : {}),
        bytesReturned: bytes,
        bytesRemaining: bodyBytes - (from + bytes),
        ...(n.createdBy ? { createdBy: n.createdBy } : {}),
        ...(n.updatedAt ? { updatedAt: n.updatedAt } : {}),
      });
      spent += bytes;
      next = { noteCursor: String(n.id), offset: from + bytes };
    } else {
      next = { noteCursor: String(n.id), offset: from };
    }
    break;
  }

  const consumedBefore = all
    .slice(0, startIndex)
    .reduce((sum, n) => sum + utf8Len(n.body), 0) + startOffset;
  const bytesRemaining = Math.max(0, totalBytes - consumedBefore - spent);
  // The cursor only ever points at a note with bytes still unread (a note that
  // fit entirely was consumed and the loop moved on), so the tail from it is the
  // count — the one it points into included, since it is partly unread.
  const notesRemaining = next ? all.length - all.findIndex((n) => n.id === next!.noteCursor) : 0;

  const base = {
    document: { id: doc.id, name: doc.name, ...(doc.type ? { type: doc.type } : {}) },
    noteCount: page.length,
    notes: page,
    url,
  };

  if (!next) {
    return {
      ...base,
      _next: page.length
        ? "Every note carries its `noteId`: to revise one, doc_write with that noteId — writing " +
          "without it appends a second copy of the same document." +
          (startIndex || startOffset ? " This was the LAST page — the tab is fully read." : "")
        : "The tab exists but is empty — doc_write with this `document` name starts it.",
    };
  }

  const pct = totalBytes ? Math.round(((consumedBefore + spent) / totalBytes) * 100) : 100;
  return {
    ...base,
    truncated: true,
    budgetBytes: budget,
    bytesReturned: spent,
    totalBytes,
    bytesRemaining,
    notesRemaining,
    nextCursor: { document: doc.id, noteCursor: next.noteCursor, offset: next.offset },
    _next:
      `TRUNCATED at the ${Math.round(budget / 1000)}KB per-call budget — you have read ${pct}% of ` +
      `"${doc.name}" (${spent} of ${totalBytes} bytes). ${bytesRemaining} bytes still unread across ` +
      `${notesRemaining} note(s). Fetch the next slice with doc_read { document: "${doc.id}", ` +
      `noteCursor: "${next.noteCursor}", offset: ${next.offset} } and repeat until the answer has no ` +
      `\`truncated\` flag. A note marked \`partial\` is a FRAGMENT: never doc_write it back with its ` +
      `noteId, that would replace the whole note with the piece you happen to be holding.`,
  };
}

/**
 * The tab did not answer. Say WHICH of the two reasons it was, because they need
 * opposite responses from the caller.
 *
 * The scoped endpoint answers "absent" (see Gateway.getIfAvailable) both when the
 * ref names nothing — a 404 — and when the API predates TDM-179, since this API
 * serves the SPA on `/*` and an unrouted /api path comes back as HTML. One list
 * of documents tells them apart: no match means the agent asked for a tab that
 * does not exist (name the ones that do, so it can retry without a second call);
 * a match means the tab is real and the ENDPOINT is what's missing, which is an
 * API version problem the agent cannot fix and should not be punished for — so
 * fall back to the state read there, and only there.
 */
async function docReadFallback(gateway: Gateway, ref: string, cursor: DocReadCursor = {}) {
  const { documents = [] } = (await gateway.get("/api/canvas/documents")) as {
    documents?: Array<{ id: string; type: string; name: string }>;
  };
  const wanted = ref.trim().toLowerCase();
  const hit = documents.find(
    (d) => d.id.toLowerCase() === wanted || d.name.trim().toLowerCase() === wanted
  );

  if (!hit) {
    const names = documents.map((d) => `"${d.name}"`).join(", ");
    throw new Error(
      `No document "${ref}" on this canvas. Tabs that DO exist: ${names || "(none yet)"}. ` +
        `Read one of those, or doc_write with a new \`document\` name to create it.`
    );
  }

  // Legacy path only: an API without the scoped endpoint. Every note on the
  // canvas, filtered to this tab here — the exact read doc_read exists to avoid,
  // kept because answering an old deployment beats failing on one.
  const state = (await gateway.get("/api/canvas/state?fields=notes")) as {
    state?: { notes?: Record<string, DocumentNoteLine & { documentId?: string; sortOrder?: number }> };
  };
  const mine = Object.values(state.state?.notes ?? {})
    .filter((n) => n.documentId === hit.id)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.id).localeCompare(String(b.id)));
  return shapeDocRead(hit, mine, canvasBlock(gateway).url, cursor);
}

// ── Dispatch handoff (TDM-62 / E9.2) ─────────────────────────────────────────

/**
 * THE DELEGATION CONTRACT, made machine-readable.
 *
 * An agent claims only what it will personally do. An orchestrator dispatches:
 * it never claims, never completes on a worker's behalf, and never transports
 * its `session` handle — that handle is ~700 base64 characters of JWT + identity
 * and handing it over makes every worker claim as the planner, collapsing the
 * fleet tree the board draws.
 *
 * So queue_next attaches a `handoff` to every ready task: the 8-char canvas
 * CODE, the task's id/ticket/title, the planner's agentId to parent under, and
 * the literal steps the worker follows. The orchestrator pastes it into a
 * subagent spawn verbatim — nothing to compose, nothing to leak.
 */
type Handoff = {
  canvasCode: string;
  taskId: string;
  ticketId?: string;
  title: string;
  /** The planner's registered id, or null when the caller never registered. */
  parentAgentId: string | null;
  /** The literal instruction sequence, in order. */
  steps: string[];
};

/**
 * What goes where the planner's agentId should be when the caller of queue_next
 * isn't registered. Spelled out rather than omitted, because a handoff missing
 * its parent link silently produces an orphaned worker — the exact failure the
 * fleet tree exists to make visible.
 */
const UNREGISTERED_PARENT =
  '<the planner\'s agentId — you have none yet: reconnect with canvas_connect role "planner" to get one>';

function buildHandoff(
  task: Record<string, unknown>,
  canvasCode: string,
  parentAgentId?: string
): Handoff {
  const taskId = String(task.id ?? "");
  const ticketId = typeof task.ticketId === "string" ? task.ticketId : undefined;
  const title = typeof task.title === "string" ? task.title : "";
  const parent = parentAgentId ?? UNREGISTERED_PARENT;
  const ticketSuffix = ticketId ? ` (${ticketId})` : "";
  return {
    canvasCode,
    taskId,
    ...(ticketId ? { ticketId } : {}),
    title,
    parentAgentId: parentAgentId ?? null,
    steps: [
      `canvas_connect with code "${canvasCode}", role "executor", a name for yourself, and parentAgentId "${parent}" — one call, connects AND registers you under the planner that sent you.`,
      `task_claim id "${taskId}"${ticketSuffix} — "${title}". Claim it yourself; the planner deliberately did not claim it for you.`,
      `If it comes back claimed:false, another session got there first — call queue_next and take a different ready task. Never work a task you did not claim.`,
      `task_get id "${taskId}" for the full brief (linked notes and roadmap items), then do the work.`,
      `task_progress on long work — one line per meaningful step, so the board shows movement instead of silence.`,
      `task_complete with a result summary (what changed, which files) plus \`links\` to any commit or PR.`,
    ],
  };
}

/**
 * Turn raw ready-queue rows into DISPATCH-READY rows: a `handoff` on everything
 * claimable, a tap-out annotation on anything this session already raced for and
 * lost. Shared by queue_next and queue_wait (TDM-149) — a task handed over by the
 * long poll must be the same object, with the same handoff, as one read from the
 * queue, or "wait then dispatch" and "read then dispatch" quietly diverge.
 *
 * ANTI-LOOP, the queue half (TDM-99). A task THIS session was told to let go of
 * must not be offered back to it as fresh work — that round trip (queue → claim →
 * lose → queue) is the loop the tap-out contract exists to break.
 *
 * Annotated rather than hidden: a vanishing task is worse than a marked one — the
 * session (and the human reading its transcript) can still see the work exists and
 * who holds it. What it does NOT get is a `handoff`, because a handoff is a
 * dispatch instruction and dispatching a task you just lost is the loop with extra
 * steps.
 *
 * And this is the SELF-HEALING path: if the server now lists the task as ready
 * with NO holder, the winner's claim is over (release clears claimed_by), so the
 * loss is stale and gets forgotten right here — the task comes back with a
 * handoff, claimable again.
 */
function decorateReadyQueue(
  gateway: Gateway,
  tasks: unknown[],
  limit: number
): { shown: Array<Record<string, unknown>>; lostByYou: Array<Record<string, unknown>> } {
  const session = gateway.getSession();
  const lostByYou: Array<Record<string, unknown>> = [];
  const shown = tasks.slice(0, Math.max(1, limit)).map((t) => {
    const row = (t ?? {}) as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : undefined;
    const ticketId = typeof row.ticketId === "string" ? row.ticketId : undefined;
    const loss = findAnyLoss(gateway, [id, ticketId]);
    if (loss) {
      const holder = typeof row.claimedBy === "string" ? row.claimedBy : undefined;
      if (!holder) {
        // Ready and unheld: proof the claim that beat us is gone.
        forgetLoss(gateway, id, ticketId);
      } else {
        const marked = {
          ...row,
          lostByYou: true,
          ...(loss.holder ? { lostTo: loss.holder } : {}),
          _tapOut:
            `You already lost this task to "${loss.holder ?? holder}" — it is NOT yours to ` +
            `claim or dispatch. No handoff is attached on purpose. Take a different task.`,
        };
        lostByYou.push({ id, ...(ticketId ? { ticketId } : {}) });
        return marked;
      }
    }
    return { ...row, handoff: buildHandoff(row, session.canvasCode, session.agentId) };
  });
  return { shown, lostByYou };
}

/** The `_lostByYou` explanation, when any row came back marked. */
function lostByYouNote(count: number): string {
  return (
    `${count} task(s) in this list are marked lostByYou — you already raced for them and lost, ` +
    `so they carry no handoff and you must not claim them again. If every task is marked, there ` +
    `is nothing here for you: report that instead of re-claiming.`
  );
}

// ── The queue long poll (TDM-149, over the API's TDM-148) ────────────────────

/** The API's one response shape for GET /api/canvas/queue/wait. */
type QueueWaitBody = {
  type?: string;
  /** "ready" | "timeout" — the single field to branch on; both arrive as 200. */
  status?: string;
  /** Byte-identical to GET /api/canvas/actions, so the queue projection applies. */
  actions?: RawTaskAction[];
  count?: number;
  waitedMs?: number;
  timeoutSeconds?: number;
  _hint?: string;
};

/**
 * Wait bounds, mirrored from the API (queue_wait.go) so a bad number is fixed
 * HERE rather than spent on a round trip that comes back 400. The server clamps
 * identically, and its `timeoutSeconds` is what the response reports back.
 */
const WAIT_MIN_SECONDS = 1;
const WAIT_MAX_SECONDS = 60;
const WAIT_DEFAULT_SECONDS = 25;

/**
 * How much longer the CLIENT waits than the server. The server answers at
 * `timeoutSeconds`; this covers the response's own trip back plus any proxy
 * hop, so the server's answer always beats the client's deadline. Getting this
 * backwards is the bug that makes the tool fail exactly when it is working.
 */
const WAIT_CLIENT_SLACK_MS = 20_000;

function clampWaitTimeout(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return WAIT_DEFAULT_SECONDS;
  return Math.min(WAIT_MAX_SECONDS, Math.max(WAIT_MIN_SECONDS, Math.round(n)));
}

/** `Retry-After`-ish hint out of the API's 429 body, when it carried one. */
function readRetryAfter(body: Record<string, unknown>): number | undefined {
  const n = Number(body.retryAfterSeconds);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** What to do the moment approved work comes back — the same on every path. */
const READY_NEXT =
  "Approved work is ready NOW. Working alone: task_get one for the brief, task_claim it, then " +
  "work it. Dispatching: spawn one subagent per task and paste that task's `handoff` in verbatim " +
  "— it is already composed. Do not wait again while work is sitting here unclaimed.";

/** The dispatch-or-claim instruction that rides on any non-empty ready queue. */
function dispatchNote(agentId?: string): string {
  return (
    "If you have subagents, dispatch — do not claim these yourself. Spawn one subagent per task " +
    "and paste that task's `handoff` into it verbatim; each worker registers under you and claims " +
    "its own task. Working alone? Pick ONE, task_get it, task_claim it, then work. Either way " +
    "your `session` handle stays with you — the canvas CODE in the handoff is what travels." +
    (agentId
      ? ""
      : " You are not registered, so the handoffs carry a placeholder parent: reconnect with " +
        'canvas_connect role "planner" and call queue_next again so your workers show up under ' +
        "you on the board.")
  );
}

// ── The approval ask (TDM-186) ───────────────────────────────────────────────
//
// Proposing answered with ids, a url and "now wait for the approval" — and that
// is a deadlock written into the contract. The gate is a HUMAN one, so the plan
// sits on a board nobody was asked to open: the agent parks on queue_wait, the
// human never hears that anything is waiting for them, and both sides are
// patiently blocked on each other. queue_wait is not the first move after
// proposing; ASKING is. You cannot wait for an approval you never requested.
//
// So the answer carries the sentence itself — `tellHuman`, paste-ready, with
// the title, the ticket range and the board URL already in it, so relaying it
// costs the model nothing and cannot come out vague ("I made some tasks") — and
// `_next` leads with "say this NOW", with the queue_wait guidance demoted to
// second, where it belongs.
//
// It stays HONEST about what actually landed: a task born approved (the 'auto'
// policy, or an already-approved epic under the default 'epic' one) is waiting
// on nobody, so it gets no ask. A line that tells the human to go approve what
// the board already approved is how they learn the line is noise.

/** "TDM-4..TDM-9" for a range, "TDM-4" for one, "" when the API assigned none. */
function ticketRange(ticketIds: Array<string | undefined>): string {
  const ids = ticketIds.filter((t): t is string => typeof t === "string" && t.trim() !== "");
  if (ids.length === 0) return "";
  if (ids.length === 1) return ids[0];
  return `${ids[0]}..${ids[ids.length - 1]}`;
}

/** One relayable sentence: what is waiting, which tickets, and where to click. */
function approvalAsk(opts: {
  subject: string;
  detail?: string;
  url: string;
  plural?: boolean;
}): string {
  const detail = opts.detail ? ` (${opts.detail})` : "";
  return (
    `${opts.subject}${detail} ${opts.plural ? "are" : "is"} waiting for YOUR approval ` +
    `on the board: ${opts.url}`
  );
}

/** The first instruction on any answer that carries an ask — relay it, then wait. */
const RELAY_FIRST =
  "RELAY `tellHuman` TO THE HUMAN NOW — say it in your very next message, before you call " +
  "anything else. Nothing here can be worked until they approve it, and they cannot approve " +
  "what nobody told them about. ";

/** Rows as the task POST / batch POST hands them back. */
type ProposedRow = { ticketId?: string; state?: string; payload?: { title?: string } };

/**
 * The `tellHuman` / `url` / `_next` block for a bare task proposal (task_propose).
 * epic_propose composes its own — the thing waiting there is the epic, and one
 * approval on it releases the batch.
 */
function taskProposalAsk(
  gateway: Gateway,
  rows: ProposedRow[]
): { tellHuman?: string; url: string; _next: string } {
  const url = canvasBlock(gateway).url;
  const waiting = rows.filter((r) => (r.state ?? "proposed") === "proposed");
  if (waiting.length === 0) {
    return {
      url,
      _next:
        "These were born APPROVED under this canvas's approval policy — there is no gate here and " +
        "nothing to relay. They are already in the ready queue: call queue_next to pick one up, or " +
        "dispatch one subagent per task with the `handoff` blocks it hands back.",
    };
  }
  const many = waiting.length > 1;
  const title = (waiting[0].payload?.title ?? "").trim();
  return {
    url,
    tellHuman: approvalAsk({
      subject: many ? `${waiting.length} proposed tasks` : `Task ${title ? `"${title}"` : "(untitled)"}`,
      detail: ticketRange(waiting.map((r) => r.ticketId)),
      url,
      plural: many,
    }),
    _next:
      RELAY_FIRST +
      `${many ? "They land" : "It lands"} as 'proposed' and a HUMAN approves ${many ? "them" : "it"} ` +
      "on the board — never approve your own proposal. THEN listen for that approval instead of " +
      "ending your turn: ONE call, not a loop — queue_wait. If it answers status 'timeout', " +
      "nothing was approved yet; that is not an error, so call it again until it answers 'ready'.",
  };
}

// ── The missed-ask backstop (TDM-187) ────────────────────────────────────────
//
// TDM-186 put the ask on the PROPOSE answer, which is where it belongs: the
// moment the gate opens is the moment to say so. But the ask can still be
// skipped — a session that proposed in an earlier turn, one that was handed an
// epicId and told to wait, or one that simply did not relay `tellHuman`. The
// symptom is the same deadlock: the human never hears the board needs them, the
// agent parks on the wait, and a silent parked session is indistinguishable
// from a hung one.
//
// queue_wait is the only call that fires while that deadlock is happening, so
// its 'timeout' answer is the last honest chance to catch it — hence
// `_tell_human` on the FIRST timeout, and only the first. It is a BACKSTOP, not
// a second channel: an agent that already relayed the ask ignores it, and an
// agent that did not gets one unmissable cue rather than a nag on every round.
//
// Once per scope, because the wait is a LOOP. A reminder repeated on every
// timeout is read once and skipped forever after, and it would drown the
// timeout's real message ("this is not an error, call again"). One epicId is one
// batch, so the scope key is the epic — a session waiting on two batches is
// owed two asks, and a session grinding out ten timeouts on one batch is owed
// exactly one.

/** Sessions → the wait scopes they have already been reminded about. */
const TELL_HUMAN_LEDGER = new Map<string, Set<string>>();

/** Bound the ledger so a long-lived stdio process cannot grow forever. */
const MAX_TELL_HUMAN_SCOPES = 100;

/** Test seam: forget who has been reminded. Never called on a production path. */
export function resetTellHumanLedger(): void {
  TELL_HUMAN_LEDGER.clear();
}

/**
 * True the FIRST time this session times out waiting on this scope, false every
 * time after. Recording happens HERE, on the read, so the caller cannot ask
 * twice and get two reminders.
 */
function firstTimeoutOnScope(gateway: Gateway, epicId: string): boolean {
  const key = sessionKey(gateway);
  let scopes = TELL_HUMAN_LEDGER.get(key);
  if (!scopes) {
    scopes = new Set<string>();
    TELL_HUMAN_LEDGER.set(key, scopes);
  }
  // "" is the whole-queue wait — a scope like any other, just an unnamed one.
  const scope = epicId || "*";
  if (scopes.has(scope)) return false;
  if (scopes.size >= MAX_TELL_HUMAN_SCOPES) scopes.clear();
  scopes.add(scope);
  return true;
}

/**
 * The reminder itself: the ask sentence (TDM-186's own composer, so the wording
 * the human hears is identical whichever path produced it) wrapped in "say this
 * now if you have not already, then keep waiting".
 */
function tellHumanReminder(gateway: Gateway, epicId: string): string {
  const ask = approvalAsk({
    subject: epicId ? "A batch you proposed" : "Work you proposed",
    detail: epicId ? `epic ${epicId}` : undefined,
    url: canvasBlock(gateway).url,
  });
  return (
    `IF YOU HAVE NOT YET TOLD THE HUMAN this is waiting on their approval, say so NOW — in ` +
    `your very next message, board URL included — and then call queue_wait again: "${ask}". ` +
    `You are the only thing that knows the gate is open; the board does not tap anyone on the ` +
    `shoulder, and nothing here can be approved by an agent. If you already relayed that ask, ` +
    `ignore this and keep waiting — it is a backstop for a missed ask, not a second ask, and ` +
    `you will not be reminded again on this wait.`
  );
}

/** `## title` + blank line + body, when a title was given. */
function composeMarkdown(title: unknown, body: unknown): string {
  const t = typeof title === "string" ? title.trim() : "";
  const b = typeof body === "string" ? body : "";
  return t ? `## ${t}\n\n${b}` : b;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

const FACADE_NAMES = new Set([
  "canvas_connect",
  "agent_register",
  "context_get",
  "queue_next",
  "queue_wait",
  "task_find",
  "task_get",
  "task_claim",
  "task_progress",
  "task_complete",
  "task_propose",
  "task_amend",
  "task_review",
  "epic_propose",
  "doc_write",
  "doc_read",
  "board_status",
]);

/**
 * Advertised on the facade but IMPLEMENTED on the CRUD surface (tools.ts), so
 * both manifests run one implementation. canvas_connect and agent_register are
 * the identity pair: connect takes the registration fields (TDM-61) and
 * agent_register re-registers afterwards — the same handler serves both
 * surfaces, only the description differs.
 */
const IMPLEMENTED_BY_CRUD = new Set(["canvas_connect", "agent_register"]);

/**
 * Still ROUTED, no longer ADVERTISED (TDM-156). `task_review` replaced
 * `task_approve` rather than joining it — see the tool's own comment for why one
 * verb with two outcomes beats two verbs — but the old name shipped in 2.3.x and
 * is written into docs, skills and running sessions' memory. Keeping the handler
 * reachable costs one Set entry and no context window (an unadvertised tool is
 * not in the manifest the model reads), and it means an agent that learned
 * `task_approve` last week gets its approval instead of "unknown tool".
 *
 * This is the ONLY thing in here that is not on the manifest, and it is a
 * deprecation shim, not a second surface: nothing new should be added to it.
 */
const FACADE_LEGACY_NAMES = new Set(["task_approve"]);

/** Does this tool name route to handleFacadeTool? (Some facade names don't.) */
export function isFacadeTool(name: string): boolean {
  return (
    (FACADE_NAMES.has(name) || FACADE_LEGACY_NAMES.has(name)) && !IMPLEMENTED_BY_CRUD.has(name)
  );
}

/**
 * Reject a missing/empty `id` BEFORE any request (TDM-133). The pass-through
 * delegators (task_get / task_claim / task_complete) used to skip this, so an
 * empty id built a URL with an empty segment — the API mounts the SPA on `/*`, so
 * `/api/canvas/actions/` is answered with index.html (200), which the gateway then
 * JSON-parsed and threw an opaque `SyntaxError: Unexpected token '<'` on. Mirror
 * task_progress's clean validation instead. Returns the trimmed id.
 */
function requireTaskId(args: Args): string {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    throw new Error(
      "`id` (string) is required — pass the task's ticket ref (e.g. \"TDM-21\") or its uuid."
    );
  }
  return id;
}

/**
 * Dispatch one facade tool call. Session-isolated for the same reason the CRUD
 * entrypoint is (TDM-178): one shared Gateway serves every concurrent subagent
 * on stdio, and a call that yields mid-flight must come back to ITS OWN
 * binding — task_claim exports a handle at the end of exactly such a yield.
 */
export async function handleFacadeTool(
  gateway: Gateway,
  toolName: string,
  args: Args
): Promise<unknown> {
  return gateway.runInCallScope(() => runFacadeTool(gateway, toolName, args));
}

async function runFacadeTool(
  gateway: Gateway,
  toolName: string,
  args: Args
): Promise<unknown> {
  // Same model-carried binding contract as the CRUD surface.
  adoptCarriedSession(gateway, toolName, args);

  switch (toolName) {
    case "context_get": {
      // Prefer the server-built briefing when the API has it (TDM-29 / E1.3);
      // fall back to composing one from endpoints that exist today. See
      // Gateway.getIfAvailable for why "absent" is broader than a 404 here.
      const served = await gateway.getIfAvailable<Record<string, unknown>>("/api/canvas/context");
      if (served) return { source: "api", canvas: canvasBlock(gateway), ...served };
      return composeContext(gateway);
    }

    case "queue_next": {
      // Thin intent rename of canvas_task_list pinned to the ready queue, plus
      // the per-task dispatch handoff (TDM-62) — the reason an orchestrator
      // never has to improvise a subagent brief, or reach for its session handle.
      const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 10;
      const listed = (await handleTool(gateway, "canvas_task_list", {
        state: "approved",
        assignee: "agent",
        ...(args.epicId ? { epicId: args.epicId } : {}),
      })) as { tasks?: unknown[]; hint?: string };
      const tasks = listed.tasks ?? [];
      const session = gateway.getSession();

      // Handoffs on the claimable rows, tap-outs on anything already lost.
      // Shared with queue_wait so a waited-for task is the same object as a
      // read-for one — see decorateReadyQueue.
      const { shown, lostByYou } = decorateReadyQueue(gateway, tasks, limit);
      // An EMPTY queue is where the surface says who may open the approval gate,
      // and that answer is per-canvas (TDM-146): on strict|epic|auto it is the
      // human's, full stop; on 'peer' a reviewer agent is also a way through, and
      // telling a reviewer "wait for a human" would park work it was spawned to
      // release. Only asked when the queue came back empty — the branch this
      // sentence is in — so the ready path never pays for it.
      const emptyQueueNext =
        shown.length > 0
          ? ""
          : (await canvasAllowsPeerApproval(gateway))
            ? "Nothing approved. Tasks you propose land as 'proposed' and need approving on the " +
              "board before anyone can claim them. This canvas is on the 'peer' approval policy, " +
              "so a human is not the only way through: a REVIEWER agent may approve a task a " +
              "DIFFERENT agent proposed, with task_review (outcome 'pass' — never its own, and " +
              "epics stay human-only). Read board_status for what is waiting, or ask the human."
            : "Nothing approved. Tasks you propose land as 'proposed' and need a human to " +
              "approve them on the board — check board_status, or ask the human.";

      // canvas_task_list's fan-out `hint` is deliberately NOT passed through:
      // it says the same thing as `_dispatch` below, and the handoffs make it
      // concrete. The hint stays for sessions calling canvas_task_list directly
      // on the CRUD surface, which get no handoffs.
      return {
        tasks: shown,
        ...(tasks.length > limit ? { truncated: tasks.length - limit } : {}),
        ...(lostByYou.length > 0 ? { lostByYou, _lostByYou: lostByYouNote(lostByYou.length) } : {}),
        ...(shown.length > 0
          ? { _dispatch: dispatchNote(session.agentId) }
          : { _next: emptyQueueNext }),
      };
    }

    // ── queue_wait: the call you make INSTEAD of ending your turn (TDM-149) ────
    //
    // THE FAILURE THIS FIXES, precisely. An MCP agent has no sleep and no
    // blocking call. Told to "poll queue_next on a backing-off interval" it does
    // the only thing it can — it ends its turn — and the human has to prompt it a
    // second time to notice an approval that already landed. That happened on
    // this project on 2026-07-31. The waiting therefore lives on the SERVER
    // (TDM-148), and this is the one call that reaches it.
    //
    // So the response TEXT is as load-bearing as the plumbing, and it is written
    // against exactly one decision the model makes: end the turn, or call again?
    //   - "ready"   → the work, dispatch-ready, with handoffs already attached.
    //   - "timeout" → NOT a failure. It says so, in those words, and says call
    //                 again. A timeout that reads like an error trains the model
    //                 out of the only tool that keeps it alive.
    //   - "busy"    → the canvas is at its waiter cap; fall back to the plain read
    //                 (already done here) rather than hammering the wait.
    //   - "unsupported" → the API predates the long poll; degrade to a plain read
    //                 rather than throwing at an agent that only wanted to wait.
    case "queue_wait": {
      const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 10;
      const timeoutSeconds = clampWaitTimeout(args.timeoutSeconds);
      const epicId = typeof args.epicId === "string" ? args.epicId.trim() : "";

      const params = new URLSearchParams({
        timeout: String(timeoutSeconds),
        // Same default as queue_next: an agent waits on the AGENT queue, so a
        // human's todo list never wakes a worker.
        assignee: "agent",
      });
      if (epicId) params.set("epicId", epicId);

      const res = await gateway.getLongPoll<QueueWaitBody, Record<string, unknown>>(
        `/api/canvas/queue/wait?${params.toString()}`,
        // The CLIENT deadline, deliberately above the server's own: the server
        // answers at `timeoutSeconds` (clamped to 60 on its side too), and this
        // has to outlast that answer plus the round trip, or the wait would fail
        // exactly when it was working. See Gateway.getLongPoll.
        timeoutSeconds * 1000 + WAIT_CLIENT_SLACK_MS
      );

      // An API older than this gateway (deployed gateway, un-updated API), or a
      // canvas at its waiter cap. Both degrade the same way — read the queue the
      // way queue_next does — and only the wording differs.
      if (res.unsupported || res.throttled) {
        const fallback = (await handleFacadeTool(gateway, "queue_next", {
          ...(epicId ? { epicId } : {}),
          limit,
        })) as { tasks?: unknown[]; _next?: string; _dispatch?: string };
        const found = fallback.tasks ?? [];
        const retryAfter = res.throttled ? readRetryAfter(res.throttled) : undefined;
        return {
          ...fallback,
          status: found.length > 0 ? "ready" : res.throttled ? "busy" : "unsupported",
          count: found.length,
          waited: false,
          _next:
            found.length > 0
              ? READY_NEXT
              : res.throttled
                ? `This canvas is at its cap for agents waiting on the queue, so this call did ` +
                  `NOT wait — it read the queue instead, and nothing is approved yet. Not an ` +
                  `error. Call queue_wait once more (a waiter slot frees as other agents are ` +
                  `handed work${retryAfter ? `; the server suggests ~${retryAfter}s` : ""}); if ` +
                  `it comes back "busy" again, say so to the human rather than looping.`
                : `This Tandem API predates the queue long poll, so this call could not wait — ` +
                  `it read the queue instead, and nothing is approved yet. Not an error, and ` +
                  `nothing you can fix from here. Tell the human the API needs updating for ` +
                  `waiting to work, and meanwhile treat queue_wait as queue_next. ` +
                  (fallback._next ?? ""),
        };
      }

      const body = res.data ?? ({} as QueueWaitBody);
      const waitedMs = typeof body.waitedMs === "number" ? body.waitedMs : undefined;
      const effectiveTimeout =
        typeof body.timeoutSeconds === "number" ? body.timeoutSeconds : timeoutSeconds;

      // TIMEOUT — the normal, expected, cheap answer. Everything about this
      // branch exists to stop it reading as a failure.
      if (body.status !== "ready") {
        // The missed-ask backstop (TDM-187): on the FIRST timeout for this scope
        // only, in case nobody was ever told the gate is open. Composed after
        // the branch is decided so a 'ready' answer never spends the session's
        // one reminder.
        const remind = firstTimeoutOnScope(gateway, epicId);
        return {
          status: "timeout",
          tasks: [],
          count: 0,
          waited: true,
          waitedMs,
          timeoutSeconds: effectiveTimeout,
          ...(remind ? { _tell_human: tellHumanReminder(gateway, epicId) } : {}),
          _next:
            `Nothing has been approved yet — this is NOT an error and NOT a failure. It is the ` +
            `normal answer to "I waited ${effectiveTimeout}s and the human hasn't approved ` +
            `anything yet". You were parked on the server the whole time, not polling, and it ` +
            `cost one call. DO NOT end your turn and DO NOT report a failure: call queue_wait ` +
            `AGAIN, right now, and keep doing that until it answers status "ready" (or you have ` +
            `waited long enough that telling the human is the honest thing to do). One thing ` +
            `worth checking after several timeouts, ONCE and not every round: a REJECTED ticket ` +
            `never becomes ready, so waiting on one is waiting forever. board_status names the ` +
            `tickets that came back on each epic's \`returned\`, with the reason — and a ` +
            `rejection is usually a correction to the rest of the plan, which is work you can ` +
            `do right now instead of waiting.`,
        };
      }

      // READY — project the actions with the SAME projection queue_next uses, then
      // attach the SAME handoffs, so the next step is dispatch with nothing to
      // compose.
      const rows = await projectTaskRows(gateway, body.actions, epicId || undefined);
      const { shown, lostByYou } = decorateReadyQueue(gateway, rows, limit);
      const session = gateway.getSession();
      // Every row lost by this session is the one way "ready" can still leave the
      // caller with nothing to do — say so instead of handing back an empty-ish list.
      const claimable = shown.filter((t) => t.lostByYou !== true);
      return {
        status: "ready",
        tasks: shown,
        count: shown.length,
        waited: true,
        waitedMs,
        timeoutSeconds: effectiveTimeout,
        ...(rows.length > limit ? { truncated: rows.length - limit } : {}),
        ...(lostByYou.length > 0 ? { lostByYou, _lostByYou: lostByYouNote(lostByYou.length) } : {}),
        ...(claimable.length > 0 ? { _dispatch: dispatchNote(session.agentId) } : {}),
        _next:
          claimable.length > 0
            ? READY_NEXT
            : `The wait returned work, but every task in it is one you already raced for and ` +
              `lost — none of it is yours. Call queue_wait again rather than re-claiming.`,
      };
    }

    case "task_find": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        throw new Error(
          "`query` (string) is required — part of the task's title (e.g. \"constraints\"), or " +
            "its ticket ref (\"TDM-21\")."
        );
      }
      const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Number(args.limit)) : 10;
      const state = typeof args.state === "string" ? args.state.trim() : "";
      const assignee = typeof args.assignee === "string" ? args.assignee.trim() : "any";

      // A ticket ref is not a search — it is an address. Resolve it directly
      // rather than scanning titles for a number that isn't in them. Absent is an
      // ANSWER here (no matches), not an error: the API 404s an unknown ref
      // (TDM-95) and getIfAvailable turns that into null.
      const ticketRef = asTicketRef(query);
      if (ticketRef) {
        const hit = await gateway.getIfAvailable<{ action?: TaskRow }>(
          `/api/canvas/actions/${encodeURIComponent(ticketRef)}`
        );
        const action = hit?.action;
        return {
          query,
          resolvedAs: ticketRef,
          matches: action ? [findRow(action)] : [],
          _next: action
            ? `That ref addresses a task directly — pass "${ticketRef}" to task_get / task_claim / ` +
              `task_complete as \`id\`, no lookup needed.`
            : `No task ${ticketRef} on this canvas. Either the number is wrong or you are on a ` +
              `different canvas than the one it belongs to — check board_status, or search by title.`,
        };
      }

      const params = ["type=task"];
      if (state) params.push(`state=${encodeURIComponent(state)}`);
      if (assignee && assignee !== "any") params.push(`assignee=${encodeURIComponent(assignee)}`);
      const listed = (await gateway.get(`/api/canvas/actions?${params.join("&")}`)) as {
        actions?: TaskRow[];
      };
      const rows = listed.actions ?? [];

      const needle = query.toLowerCase();
      const words = needle.split(/\s+/).filter((w) => w.length > 1);
      const scored = rows
        .map((task) => ({ task, hit: scoreTask(task, needle, words) }))
        .filter((r): r is { task: TaskRow; hit: { score: number; matchedIn: "title" | "body" } } =>
          Boolean(r.hit)
        )
        // Best rule first, then newest — a repeated title is usually the recent one.
        .sort(
          (a, b) =>
            b.hit.score - a.hit.score ||
            Date.parse(b.task.createdAt ?? "") - Date.parse(a.task.createdAt ?? "")
        );

      const matches = scored.slice(0, limit).map((r) => findRow(r.task, r.hit.matchedIn));
      return {
        query,
        matches,
        ...(scored.length > limit ? { truncated: scored.length - limit } : {}),
        searched: rows.length,
        _next:
          matches.length === 0
            ? "Nothing matched. Try fewer words (matching is substring-then-all-words over the " +
              "title, then bodies), drop the `state` filter, or read board_status for what is here."
            : "Take the `id` (or `ticketId`) of the right one straight to task_get for the full " +
              "brief, then task_claim if it is approved and you will do it yourself. Matching is " +
              "textual, so confirm the title is the task you meant before claiming.",
      };
    }

    case "task_get": {
      requireTaskId(args);
      const got = (await handleTool(gateway, "canvas_task_get", args)) as {
        action?: { state?: string; payload?: unknown };
        epic?: { id?: string; hasLinkedContext?: boolean };
        review?: ReviewFeedback;
      };
      // WHY IT CAME BACK, if it did (TDM-161). The API attaches `review` — a
      // human's rejection reason or a reviewer's rework instruction, in one
      // shape — and this turns it into the author's next move. THIS is the read
      // path that carries it: the handoff already sends every worker through
      // task_get before it starts, so the reason reaches the ticket's author and
      // its next worker without queue_next having to become a notifications
      // feed. `_review` rides on every branch below, epic or not.
      const review = reviewNote(got?.review);
      // WHAT THE CONTRACT SEES IN IT (TDM-168). The soft ticket-quality rules,
      // re-derived here from the row's CURRENT text rather than read back from
      // whatever epic_propose once computed — so a ticket filed with
      // task_propose, one proposed before the contract existed, and one a human
      // amended in place all answer, and an amend that fixes a smell makes it
      // go away. Same read path as `review` and for the same reason: the handoff
      // already sends every worker through task_get before it starts, so this
      // reaches both the ticket's author and its next worker without queue_next
      // having to grow an opinion about the work it is handing out.
      const quality = storedTicketWarnings(got?.action, got?.epic?.hasLinkedContext === true);
      const qualityBlock =
        quality.length > 0
          ? {
              quality,
              _quality: storedWarningsNote(
                quality,
                typeof got?.action?.state === "string" ? got.action.state : ""
              ),
            }
          : {};
      // The API hydrates {id, title, state} for the task's epic. Deepen it into
      // the batch's rollup (TDM-93) so the worker learns, BEFORE it starts, how
      // much of the batch is left and whether finishing this task finishes the
      // epic — which is the moment to say what the whole batch achieved. Told
      // only afterwards, the answer arrives when there is no call left to put it
      // on. One extra read, and only for a task that HAS an epic.
      const epicId = typeof got?.epic?.id === "string" ? got.epic.id : "";
      if (!epicId) return { ...got, ...review, ...qualityBlock };
      const rollup = await fetchEpicRollup(gateway, epicId);
      if (!rollup) return { ...got, ...review, ...qualityBlock };
      const open = rollup.tasks.total - terminalCount(rollup);
      return {
        ...got,
        ...review,
        ...qualityBlock,
        epic: { ...got.epic, ...epicSnapshot(rollup), openTasks: open },
        ...(open <= 1
          ? {
              _epic:
                `This is the LAST unfinished task in "${rollup.title}". When you complete it, pass ` +
                `\`epicSummary\` to task_complete — a short account of what the whole BATCH achieved, ` +
                `not just this ticket. Nothing else records that, and after this completion there is ` +
                `no call left to put it on.`,
            }
          : {}),
      };
    }

    case "task_claim":
      requireTaskId(args);
      return handleTool(gateway, "canvas_task_start", args);

    case "task_progress": {
      // Progress is a HEARTBEAT, not just a note (TDM-67). It goes through the
      // inbound status endpoint — POST /api/canvas/{code}/tasks/{id}/status with
      // state "progress" — and NOT the payload-only PATCH this used to do, for
      // two reasons the client-side version could not give us:
      //
      //   1. The lease. A claim expires ~15 min after claimed_at, and the server
      //      only refreshes it (TouchActionClaim, TDM-64) for the holder who
      //      reports through this endpoint. Over the old PATCH a worker doing an
      //      hour of real work heartbeated the whole time and still had its task
      //      reclaimed underneath it.
      //   2. The guard. The PATCH carries no caller identity, so the "is this
      //      yours?" check had to be a client-side read-modify-write that any
      //      other client could simply not do. Now the server enforces it.
      //
      // The append-to-payload.progress[] behaviour is unchanged — the endpoint
      // does the same merge server-side (capped, additive), so progress still
      // travels WITH the task and comes back from task_get.
      const id = String(args.id ?? "");
      const note = typeof args.note === "string" ? args.note.trim() : "";
      if (!id) throw new Error("`id` (string) is required");
      if (!note) throw new Error("`note` (string) is required — say what changed since last time");

      const claimant = (args.agentName as string | undefined) ?? gateway.claimant();
      const percent = typeof args.percent === "number" ? args.percent : undefined;
      // The stored entry is {at, agent, note} — there is no percent field on the
      // wire. Fold it into the line rather than dropping the caller's number.
      const summary = percent === undefined ? note : `${note} (${Math.round(percent)}%)`;
      const code = gateway.getSession().canvasCode;

      const { data, conflict } = await gateway.postWithConflict<
        { action?: { claimedBy?: string; claimedAt?: string; payload?: Record<string, unknown> } },
        ConflictBody
      >(`/api/canvas/${encodeURIComponent(code)}/tasks/${encodeURIComponent(id)}/status`, {
        state: "progress",
        agent: claimant,
        summary,
        // Present the claim's fencing token (TDM-121) so a heartbeat from a lease
        // that has been superseded is refused by generation, not just by name.
        ...(gateway.claimGeneration() ? { claimGeneration: gateway.claimGeneration() } : {}),
      });

      // A rejected heartbeat is an ANSWER, not a crash: the model should route on
      // it (go take a task that is actually yours) rather than see a thrown
      // protocol error mid-work. Same shape the old client-side guard returned.
      //
      // TDM-99: when the rejection is CONTENTION — another agent holds it, our
      // claim was fenced, or the work is already over — it also carries the
      // tap-out block, so a worker heartbeating into a task that moved on beneath
      // it gets the same machine-readable "stop" a lost claim gets, and the loss
      // is remembered so it cannot follow up with a claim attempt.
      //
      // A task that is merely NOT CLAIMED is not a tap-out: nobody beat this
      // caller, and the answer is task_claim, not queue_next. `reason` is a
      // TapOutReason on a tap-out response and the API's own error code otherwise
      // (`apiError` always carries the raw code, whichever branch you are in).
      if (conflict) {
        const c = readConflict(conflict);
        const holder = c.holder;
        const reason = writeReason(c);
        if (reason) {
          const loss = recordLoss(gateway, id, { holder, reason, claimGeneration: c.claimGeneration });
          return {
            recorded: false,
            id,
            by: claimant,
            ...(c.code ? { apiError: c.code } : {}),
            ...(holder ? { claimedBy: holder } : {}),
            ...(c.state ? { state: c.state } : {}),
            ...tapOutBlock(loss),
            message: c.fenced
              ? fenceRejectionMessage(id, holder)
              : reason === "already_finished"
                ? alreadyFinishedMessage(c.state ?? "finished")
                : notYourClaimMessage(holder ?? "another agent", "report on"),
          };
        }
        return {
          recorded: false,
          id,
          by: claimant,
          reason: c.code ?? "rejected",
          ...(c.code ? { apiError: c.code } : {}),
          ...(c.state ? { state: c.state } : {}),
          message: c.state
            ? `This task is "${c.state}", not executing — only the agent currently ` +
              `working a task can report on it. Claim it with task_claim first.`
            : (c.message ?? "The API rejected this progress report."),
        };
      }

      const action = data?.action ?? {};
      const stored = Array.isArray(action.payload?.progress)
        ? (action.payload?.progress as unknown[])
        : [];
      return {
        recorded: true,
        id,
        by: claimant,
        entries: stored.length,
        ...(percent === undefined ? {} : { percent }),
        // The fresh claimed_at IS the lease extension — hand it back so a worker
        // (and the human reading the board) can see the clock reset. The server
        // refreshes it holder-only, and its predicate is exactly "claimed_by =
        // this agent", so mirror that rather than claiming an extension for a
        // report accepted against a non-exclusive holder ("" / "agent").
        ...(action.claimedAt ? { claimedAt: action.claimedAt } : {}),
        leaseExtended: Boolean(action.claimedBy) && action.claimedBy === claimant,
        note:
          "Progress is stored on the task and comes back from task_get. Reporting also " +
          "extends your claim, so keep heartbeating on long work and no one can reclaim it.",
      };
    }

    case "task_complete": {
      requireTaskId(args);
      // `epicSummary` is the EPIC-level write path (TDM-93), and it is an
      // argument here rather than a tool of its own on purpose: the moment an
      // agent knows what a batch achieved is the moment it finishes the last
      // task in it, and a write that costs a second call at that moment is a
      // write that doesn't happen. So the account of the batch rides the same
      // call as the account of the ticket.
      const epicSummary = typeof args.epicSummary === "string" ? args.epicSummary.trim() : "";
      const { epicSummary: _omit, ...forward } = args;
      const done = (await handleTool(gateway, "canvas_task_complete", forward)) as
        | { completed?: boolean; action?: { payload?: { epicId?: string } } }
        | undefined;

      // A refused completion (tap-out: someone else holds it, our lease was
      // fenced, the work is already over) is not ours to summarize. Return it
      // untouched — the model must route on that shape, not read past it.
      if (!done || done.completed === false) return done;

      const epicId =
        typeof done.action?.payload?.epicId === "string" ? done.action.payload.epicId : "";
      if (!epicId) {
        if (epicSummary) {
          // Honesty over silence: the caller wrote a batch summary and there is
          // no batch. Saying nothing would let it believe the write landed.
          return {
            ...done,
            epicSummary: {
              written: false,
              reason: "This task belongs to no epic, so there was no batch to summarize.",
            },
          };
        }
        return done;
      }

      let written: Record<string, unknown> | undefined;
      if (epicSummary) {
        try {
          const epic = await writeEpicSummary(gateway, epicId, epicSummary);
          written = { written: true, epicId, title: epic.title };
        } catch (err) {
          // The TASK is done — that write already landed and must not be
          // reported as failed because the summary didn't. Degrade loudly.
          written = {
            written: false,
            epicId,
            error: err instanceof Error ? err.message : String(err),
            note: "The task completed; only the epic summary failed to save.",
          };
        }
      }

      const rollup = await fetchEpicRollup(gateway, epicId);
      if (!rollup) return { ...done, ...(written ? { epicSummary: written } : {}) };
      const open = rollup.tasks.total - terminalCount(rollup);
      return {
        ...done,
        ...(written ? { epicSummary: written } : {}),
        epic: { ...epicSnapshot(rollup), openTasks: open },
        ...(rollup.summaryNeeded
          ? {
              _epic:
                `"${rollup.title}" has now DRAINED — every task in it is finished — and nothing ` +
                `records what the batch achieved. You still hold the context: if any work in this ` +
                `epic is yours, say so in your report to the human so they can write it on the ` +
                `board, and pass \`epicSummary\` on your next task_complete in this epic if one is ` +
                `left. Reading it back later costs a read of every ticket.`,
            }
          : open > 0
            ? {
                _epic:
                  `${open} task(s) left in "${rollup.title}". Whoever finishes the last one should ` +
                  `pass \`epicSummary\` to task_complete to record what the batch achieved.`,
              }
            : {}),
      };
    }

    case "task_propose": {
      // One tool, both shapes: a single task, or a whole plan in one round trip.
      const many = args.tasks;
      if (Array.isArray(many) && many.length > 0) {
        // Spread the CALL-LEVEL defaults onto every item (TDM-116). The batch
        // branch used to forward only `tasks`, silently dropping a top-level
        // epicId / assignee / requiresApproval — so a whole plan proposed under an
        // epic landed unparented and the response still said "created". The
        // single-task branch below never had this bug (it passes `args` whole), and
        // epic_propose already merges its epic id this way. Item-level fields WIN,
        // so a task may still override a call-level default.
        for (const [i, t] of (many as Args[]).entries()) {
          if (!t || typeof t.title !== "string" || !t.title.trim()) {
            throw new Error(`tasks[${i}] needs a \`title\` — one line saying what to do`);
          }
        }
        const batch = (await handleTool(gateway, "canvas_task_add_batch", {
          tasks: (many as Args[]).map((t) => ({
            ...(args.epicId ? { epicId: args.epicId } : {}),
            ...(args.assignee ? { assignee: args.assignee } : {}),
            ...(args.requiresApproval !== undefined
              ? { requiresApproval: args.requiresApproval }
              : {}),
            ...t,
          })),
        })) as { actions?: ProposedRow[] };
        // The ids stay exactly as they were; what's added is the ask (TDM-186).
        return { ...batch, ...taskProposalAsk(gateway, batch.actions ?? []) };
      }
      if (typeof args.title !== "string" || !args.title.trim()) {
        throw new Error("Pass `title` (one task) or `tasks` (an array of them)");
      }
      const task = (await handleTool(gateway, "canvas_task_add", args)) as ProposedRow;
      return { ...task, ...taskProposalAsk(gateway, [task]) };
    }

    case "task_amend": {
      // Self-correction for a PROPOSAL, deliberately narrow (TDM-117). An agent may
      // amend or withdraw a task IT proposed — but ONLY while it is still `proposed`
      // and unclaimed. Once a human approves it, it is theirs (ask, don't edit);
      // once someone claims it, the claim fence owns it. The three-way guard below
      // is checked against the SERVER's view of the task, never anything
      // self-reported: authoredBy is server-derived provenance (TDM-40). This lets
      // the default surface self-heal a mis-proposed plan without opening a hole to
      // rewrite approved or in-flight work.
      const id = requireTaskId(args);
      const withdraw = args.withdraw === true;
      const amendable = ["title", "body", "epicId", "linkedIds"] as const;
      if (!withdraw && !amendable.some((k) => args[k] !== undefined)) {
        throw new Error(
          "Nothing to amend — pass at least one of title / body / epicId / linkedIds, or " +
            "`withdraw: true` to retract the proposal."
        );
      }

      const { action } = (await gateway.get(
        `/api/canvas/actions/${encodeURIComponent(id)}`
      )) as {
        action?: {
          state?: string;
          claimedBy?: string;
          authoredBy?: string;
          type?: string;
          payload?: Record<string, unknown>;
        };
      };
      if (!action) throw new Error(`No task "${id}" found on this canvas.`);

      // GUARD 1 — still a proposal. Approved / executing / done are off-limits.
      // Who did the approving depends on the canvas (TDM-146): everywhere but a
      // 'peer' canvas it was necessarily a human, and saying so is the clearest
      // way to explain why the task is no longer the proposer's to edit. On 'peer'
      // it may have been a reviewer agent, so the sentence names the approval
      // rather than asserting a human made it.
      if (action.state !== "proposed") {
        const approver = (await canvasAllowsPeerApproval(gateway))
          ? "Once a task is approved — by a human, or by a reviewer agent under this canvas's " +
            "'peer' policy — it is theirs"
          : "Once a human approves a task it is theirs";
        throw new Error(
          `This task is "${action.state}", not "proposed" — you cannot amend it. ${approver}: ` +
            `propose a follow-up, or ask the human to reject this one.`
        );
      }
      // GUARD 2 — unclaimed. A proposed task normally has no holder; refuse if it does.
      const holder = action.claimedBy;
      if (holder && holder !== "agent") {
        throw new Error(
          `This task is held by "${holder}", so it is not yours to amend. Take a different task.`
        );
      }
      // GUARD 3 — you proposed it. authoredBy is server-derived "agent:<identity>";
      // compare to this session's claim identity (the same string X-Tandem-Agent
      // carried when the proposal was created). A task predating provenance has no
      // authoredBy — allow it rather than strand it (best-effort, matches TDM-40).
      const me = `agent:${gateway.claimant()}`;
      if (action.authoredBy && action.authoredBy !== me) {
        throw new Error(
          `You did not propose this task (authored by "${action.authoredBy}"), so it is not yours ` +
            `to amend. Only the agent that proposed a task may correct it.`
        );
      }

      // Withdraw: delete the proposal outright (unclaimed + no holder ⇒ unfenced).
      if (withdraw) {
        await gateway.del(`/api/canvas/actions/${encodeURIComponent(id)}`);
        return { withdrawn: true, id, url: canvasBlock(gateway).url };
      }

      // Amend: merge the changed fields onto the existing payload and PATCH the
      // whole thing. The payload-only PATCH replaces + canonicalizes (title
      // required), so carry the existing values forward for anything not changed.
      const payload: Record<string, unknown> = { ...(action.payload ?? {}) };
      if (typeof args.title === "string" && args.title.trim()) payload.title = args.title.trim();
      if (typeof args.body === "string") payload.body = args.body;
      if (args.epicId !== undefined) payload.epicId = args.epicId;
      if (args.linkedIds !== undefined) payload.linkedIds = args.linkedIds;
      if (typeof payload.title !== "string" || !(payload.title as string).trim()) {
        throw new Error("A task needs a non-empty `title` — pass a new one, or leave the existing.");
      }
      await gateway.patch(`/api/canvas/actions/${encodeURIComponent(id)}`, {
        payload,
        agentName: gateway.claimant(),
      });
      return { amended: true, id, url: canvasBlock(gateway).url };
    }

    // ── task_review: the reviewer's ONE verb, two outcomes (TDM-156) ──────────
    //
    // WHY ONE TOOL RATHER THAN TWO, and why it REPLACED task_approve on the
    // manifest instead of joining it. A reviewer makes a single decision — does
    // this go on, or does it come back — and the two answers happen to land on
    // two different endpoints (approve, and TDM-154's rework) that no reviewer
    // should have to know exist. Advertising them as two tools teaches the wrong
    // thing twice over: a manifest carrying only `task_approve` told reviewers
    // their sole move was YES (the exact gap this epic exists to close), and a
    // manifest carrying both would make "which one applies here?" a question the
    // model answers from a task's state — server knowledge it does not have.
    // One verb, an `outcome` it must state, and the surface stays 16 tools.
    //
    // What this does NOT do is decide anything. `outcome` chooses the endpoint;
    // every rule — the 'peer' policy, reviewer ≠ author, reviewer ≠ same model
    // (TDM-155), the state the task must be in — is the server's, derived from
    // provenance the caller cannot forge (apps/api/internal/api/peer_approval.go).
    // No local pre-flight, no client-supplied identity: the same reasoning as
    // task_approve's, which is one place to get the gate right instead of two
    // that can disagree. The gateway's whole job is to turn the server's answer
    // into the reviewer's next move.
    case "task_review": {
      const id = requireTaskId(args);
      const outcome = typeof args.outcome === "string" ? args.outcome.trim() : "";
      if (outcome !== "pass" && outcome !== "changes_requested") {
        throw new Error(
          "`outcome` must be \"pass\" (approve a PROPOSED task into the ready queue) or " +
            '"changes_requested" (send a DONE task back to the queue with a reason). ' +
            "There is no third answer: an agent cannot reject a proposal or fail a task — " +
            "leaving it alone and saying why is the way to say no to those."
        );
      }
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (outcome === "changes_requested" && !reason) {
        // Argument shape, not policy: the server refuses an empty reason too
        // (rework_reason_required), but a bounce with nothing to act on is worth
        // stopping before it costs a round trip — and the message can say what
        // makes a usable one, which a 400 cannot.
        throw new Error(
          "`reason` (string) is required when outcome is \"changes_requested\" — it is the whole " +
            "content of the bounce and the only thing the author gets. Name what is wrong and " +
            "what 'fixed' looks like (\"the rework handler never checks the claim fence — cover " +
            "that case in the API tests\"), not merely that it is wrong."
        );
      }

      if (outcome === "changes_requested") {
        const { data, refusal } = await gateway.postWithRefusal<
          { action?: TaskRow & { type?: string } },
          unknown
        >(
          `/api/canvas/actions/${encodeURIComponent(id)}/rework`,
          { reason },
          // 400 is an ANSWER here, not a fault: rework_not_finished (asking for
          // changes on work that is not done) is the likeliest reviewer mistake
          // there is, and it deserves prose telling it what to do instead.
          [400]
        );
        if (refusal) {
          const parsed = readApprovalRefusal(refusal);
          return {
            reviewed: false,
            outcome,
            id,
            refusal: parsed.code ?? "rework_refused",
            message: parsed.message,
            ...parsed.extra,
            _next: reworkRefusalNext(parsed),
          };
        }
        const action = data?.action;
        return {
          reviewed: true,
          outcome,
          id,
          ...(action?.ticketId ? { ticketId: action.ticketId } : {}),
          ...(action?.payload?.title ? { title: action.payload.title } : {}),
          state: action?.state ?? "approved",
          reason,
          url: canvasBlock(gateway).url,
          _next:
            "Sent back. The task left 'done', is unclaimed, and is in the ready queue again as " +
            "'approved' — and your reason is DELIVERED, not just filed (TDM-161): task_get on " +
            "this ticket now answers with a `review` block carrying it verbatim, so the author " +
            "and whoever picks it up next read it without asking you. Do NOT claim it and fix it " +
            "yourself: you are the reviewer, and an agent that reviews and then does the work is " +
            "one pair of eyes wearing two hats. Expect it back, and review the second attempt on " +
            "its own merits.",
        };
      }

      // outcome: "pass" — the peer approve path. The body is empty on purpose:
      // `approvedBy` in a request body is the forgery vector TDM-40 / TDM-129
      // closed, and the server ignores it. `reason` (if one was passed) is not
      // sent: approve records WHO, not why, and inventing a field to carry it
      // would be a write the board never shows.
      const { data, refusal, status } = await postApproval(gateway, id, [400]);
      if (refusal) {
        const parsed = readApprovalRefusal(refusal);
        // An uncoded 400 is the state machine, not the gate ("illegal
        // transition: done → approved" — 'pass' on work that is already finished
        // or in flight). Routing it through approvalRefusalNext would answer a
        // state problem with the policy sentence and send the reviewer away.
        const stateRefusal = status === 400 && !parsed.code;
        return {
          reviewed: false,
          outcome,
          id,
          refusal: parsed.code ?? (stateRefusal ? "not_reviewable" : "human_approval_only"),
          message: parsed.message,
          ...parsed.extra,
          _next: stateRefusal
            ? `The server would not make that move: "${parsed.message}". 'pass' approves a task ` +
              `that is still 'proposed' — nothing else is waiting on your yes. If it is already ` +
              `approved or executing, there is nothing to do; if it is 'done' and you want ` +
              `changes, call task_review again with outcome "changes_requested" and a reason.`
            : approvalRefusalNext(parsed),
        };
      }
      const passed = data?.action;
      const passedBy = typeof passed?.approvedBy === "string" ? passed.approvedBy : undefined;
      return {
        reviewed: true,
        outcome,
        id,
        ...(passed?.ticketId ? { ticketId: passed.ticketId } : {}),
        ...(passed?.payload?.title ? { title: passed.payload.title } : {}),
        state: passed?.state ?? "approved",
        ...(passedBy ? { approvedBy: passedBy } : {}),
        url: canvasBlock(gateway).url,
        _next:
          "Passed: the task is in the ready queue and queue_next now returns it to any executor. " +
          "`approvedBy` records WHO let it through — an 'agent:' prefix is a peer review, " +
          "'human' is a human's — so the board can tell the two apart later. You reviewed it, so " +
          "hand it on rather than claiming it yourself: an agent that reviews and then works the " +
          "same task is one pair of eyes wearing two hats.",
      };
    }

    // The name this shipped under in 2.3.x (TDM-146). Unadvertised since TDM-156
    // — task_review is the verb now — but still routed, and deliberately
    // UNCHANGED in behaviour and response shape so a session running on older
    // instructions gets its approval rather than "unknown tool". New work uses
    // task_review; see FACADE_LEGACY_NAMES.
    case "task_approve": {
      const id = requireTaskId(args);
      const { data, refusal } = await postApproval(gateway, id);

      if (refusal) {
        // A refusal is an ANSWER, not a crash — same reasoning as the tap-out
        // contract on a lost claim. `reason` is the server's stable code, or
        // "human_approval_only" for the legacy (non-'peer' canvas) refusal, which
        // carries no code at all.
        const parsed = readApprovalRefusal(refusal);
        return {
          approved: false,
          id,
          reason: parsed.code ?? "human_approval_only",
          message: parsed.message,
          ...parsed.extra,
          _next: approvalRefusalNext(parsed),
        };
      }

      const action = data?.action;
      const approvedBy = typeof action?.approvedBy === "string" ? action.approvedBy : undefined;
      return {
        approved: true,
        id,
        ...(action?.ticketId ? { ticketId: action.ticketId } : {}),
        ...(action?.payload?.title ? { title: action.payload.title } : {}),
        state: action?.state ?? "approved",
        ...(approvedBy ? { approvedBy } : {}),
        url: canvasBlock(gateway).url,
        _next:
          "Approved: the task is in the ready queue and queue_next now returns it to any executor. " +
          "`approvedBy` records WHO let it through — an 'agent:' prefix is a peer approval, " +
          "'human' is a human's — so the board can tell the two apart later. You reviewed it, so " +
          "hand it on rather than claiming it yourself: an agent that reviews and then works the " +
          "same task is one pair of eyes wearing two hats.",
      };
    }

    case "epic_propose": {
      // The container a plan hangs off. Without this on the facade an agent
      // asked to "write an epic" could only propose loose tasks, which land
      // unparented and each need their own approval.
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) throw new Error("`title` (string) is required — name the batch of work");

      // Validate the optional plan BEFORE writing the epic: a batch rejected by
      // the API after the epic landed would leave an empty epic on the board.
      const many = Array.isArray(args.tasks) ? (args.tasks as Args[]) : [];
      for (const [i, t] of many.entries()) {
        if (!t || typeof t.title !== "string" || !t.title.trim()) {
          throw new Error(`tasks[${i}] needs a \`title\` — one line saying what to do`);
        }
      }

      // The ticket-quality contract (TDM-159), split by what a rule can honestly
      // judge. The hard half runs HERE, before any write, so a refused plan
      // leaves nothing behind; it is collected, not thrown per ticket, so a lazy
      // plan is fixed in one pass.
      const tickets = many.map(qualityTicketFromArgs);
      const failures = ticketContractFailures(title, tickets);
      if (failures.length > 0) {
        throw new Error(
          `This plan does not meet the ticket-quality contract, so NOTHING was written — no ` +
            `epic, no tickets. Fix these and call epic_propose again:\n- ${failures.join("\n- ")}`
        );
      }
      // The soft half is computed off the same inputs but never blocks: it rides
      // back on the response below so the proposer sees its own slop first. It
      // is no longer the ONLY place these exist (TDM-168) — the same rules run
      // on the stored row at read time — but hearing it in the call you just
      // made is what lets you amend before anyone else looks.
      const warnings = ticketQualityWarnings(tickets, {
        batchHasLinkedContext: Array.isArray(args.linkedIds) && args.linkedIds.length > 0,
      });

      // Started HERE, not where it is read: the policy decides what the answer
      // promises about approval (below), and it is independent of the writes, so
      // running it alongside them keeps this call the same wall-clock cost it was.
      const peerCanvas = canvasAllowsPeerApproval(gateway);

      const epic = (await handleTool(gateway, "canvas_epic_add", {
        title,
        body: args.body,
        linkedIds: args.linkedIds,
      })) as { id?: string; state?: string };
      if (!epic?.id) throw new Error("The epic was not created — no id came back");

      // Then the plan under it, in one write. The epic's id WINS over any
      // epicId an item carried: this call's whole point is the new container.
      let tasks: Array<Record<string, unknown>> = [];
      if (many.length > 0) {
        const batch = (await handleTool(gateway, "canvas_task_add_batch", {
          tasks: many.map((t) => ({ ...t, epicId: epic.id })),
        })) as { actions?: Array<{ id: string; ticketId?: string; state: string; payload?: { title?: string } }> };
        // Project: ids and titles are what a session needs to refer back to
        // these; the bodies it just wrote are not.
        tasks = (batch.actions ?? []).map((a) => ({
          id: a.id,
          ...(a.ticketId ? { ticketId: a.ticketId } : {}),
          title: a.payload?.title ?? "",
          state: a.state,
        }));
        // The warnings were computed off the REQUEST, so they only know a
        // ticket's position. Now that the batch has landed, point each one at
        // the ticket it is about — without an id there is nothing to amend.
        for (const w of warnings) {
          const row = tasks[w.index] as Record<string, unknown> | undefined;
          if (typeof row?.id === "string") w.taskId = row.id;
          if (typeof row?.ticketId === "string") w.ticketId = row.ticketId;
        }
      }

      // What ONE approval buys is per-canvas (TDM-146). Under the default 'epic'
      // policy approving the epic cascades to every task under it — one click for
      // the batch. Under 'peer' that cascade is deliberately OFF (the API skips it,
      // see policyCascadesToEpicTasks): the per-task gate IS the reviewer's, and a
      // cascade would walk around it. Promising a cascade there would have the
      // proposer poll for a queue that never fills.
      const epicApproval = (await peerCanvas)
        ? "The epic is 'proposed'. A HUMAN approves it on the board — epics stay human-only even " +
          "here, and you must not try to approve it yourself. This canvas is on the 'peer' " +
          "approval policy, so that approval does NOT cascade: each task still needs its own, " +
          "which a REVIEWER agent (any registered agent other than the one that proposed it) can " +
          "give with task_review, outcome 'pass'. "
        : "The epic is 'proposed'. A HUMAN approves it once on the board and that approval " +
          "cascades to every task under it — do not try to approve it yourself. ";

      // The paste-ready approval ask (TDM-186). An agent-proposed epic always
      // lands 'proposed' — only tasks can be born approved — but read the state
      // back rather than asserting it, so an epic that somehow arrives approved
      // does not send the human off to approve it twice.
      const url = canvasBlock(gateway).url;
      const epicState = epic.state ?? "proposed";
      const tellHuman =
        epicState === "proposed"
          ? approvalAsk({
              subject: `Epic "${title}"`,
              detail: [
                many.length > 0 ? `${many.length} task${many.length === 1 ? "" : "s"}` : "",
                ticketRange(tasks.map((t) => t.ticketId as string | undefined)),
              ]
                .filter(Boolean)
                .join(", "),
              url,
            })
          : undefined;

      return {
        created: true,
        epicId: epic.id,
        state: epicState,
        ...(many.length > 0 ? { tasks } : {}),
        ...(warnings.length > 0
          ? { warnings, _warnings: ticketWarningsNote(warnings, many.length) }
          : {}),
        url,
        ...(tellHuman ? { tellHuman } : {}),
        _next:
          // ASK FIRST, then wait: parking on queue_wait without ever telling the
          // human the gate is open is how a plan sits unread while both sides
          // think it is the other's move.
          (tellHuman ? RELAY_FIRST : "") +
          epicApproval +
          "THEN LISTEN FOR THAT APPROVAL instead of ending your turn — and you do that with ONE " +
          "call, not a loop: queue_wait with this `epicId`. It parks on the server and returns " +
          "the moment the tasks are approved. If it answers status 'timeout', nothing was " +
          "approved yet — that is not an error, so call queue_wait again, and keep doing that " +
          "until it answers 'ready'. Then work them — with subagents, dispatch one per task " +
          "using the `handoff` blocks it hands back. The human approving on the board IS the go " +
          "signal; they should not have to prompt you again. Add more tasks to the batch later " +
          "with task_propose and this `epicId`.",
      };
    }

    case "doc_write": {
      const body = typeof args.body === "string" ? args.body : "";
      if (!body.trim() && !args.title) throw new Error("`body` (string) is required");
      const markdown = composeMarkdown(args.title, body);

      // Update in place when an id was given — same note, new content.
      if (typeof args.noteId === "string" && args.noteId.trim()) {
        const noteId = args.noteId.trim();
        // The note PATCH 200s for ANY id: the API does not existence-check it and
        // returns no documentId to confirm a write landed (TDM-137). Relaying that
        // as updated:true tells an agent rewriting a stale/wrong noteId that its
        // content was saved when it was silently dropped. So confirm the note
        // exists FIRST (a cheap notes-only state read, which also gives us the
        // documentId to echo back); only then is updated:true honest.
        const resp = (await gateway.get(`/api/canvas/state?fields=notes`)) as {
          state?: { notes?: Record<string, { id?: string; documentId?: string }> };
        };
        const note = resp.state?.notes?.[noteId];
        if (!note) {
          throw new Error(
            `No note with id "${noteId}" exists on this canvas, so there was nothing to update — ` +
              `your content was NOT saved. Re-check the noteId, or omit it to create a new note ` +
              `(optionally with a \`document\` name to place it).`
          );
        }
        // Project the response: echoing the note body back would just spend the
        // model's context on text it wrote a moment ago.
        await gateway.patch(`/api/canvas/notes/${noteId}`, { body: markdown });
        return {
          updated: true,
          noteId,
          ...(note.documentId ? { documentId: note.documentId } : {}),
          url: canvasBlock(gateway).url,
        };
      }

      // Otherwise create. A named document is created on demand (see
      // resolveNotesDocument); an unnamed one lands in the canvas default.
      const ref = typeof args.document === "string" ? args.document.trim() : "";
      const documentId = ref ? await resolveNotesDocument(gateway, ref) : undefined;
      const created = (await gateway.post("/api/canvas/notes", {
        body: markdown,
        imageRefs: [],
        ...(documentId ? { document: documentId } : {}),
        createdBy: "agent",
      })) as { id?: string; documentId?: string };
      return {
        created: true,
        noteId: created.id,
        documentId: created.documentId ?? documentId,
        url: canvasBlock(gateway).url,
      };
    }

    case "doc_read": {
      const ref = typeof args.document === "string" ? args.document.trim() : "";
      if (!ref) {
        throw new Error(
          "`document` (string) is required — the tab's NAME (the one you gave doc_write) or its " +
            "id. context_get lists the tabs on this canvas."
        );
      }
      // Paging (TDM-181). Both come straight back from a truncated answer's
      // `nextCursor`, so the caller never composes them by hand.
      const rawOffset = args.offset;
      if (rawOffset !== undefined && (typeof rawOffset !== "number" || !Number.isFinite(rawOffset) || rawOffset < 0)) {
        throw new Error(
          "`offset` must be a non-negative byte offset into the note named by `noteCursor` — pass " +
            "the `nextCursor` from a truncated doc_read back verbatim rather than computing one."
        );
      }
      const cursor: DocReadCursor = {
        ...(typeof args.noteCursor === "string" && args.noteCursor.trim()
          ? { noteCursor: args.noteCursor.trim() }
          : {}),
        ...(typeof rawOffset === "number" ? { offset: rawOffset } : {}),
      };

      // ONE scoped call on the happy path (TDM-179): this tab's notes, in the
      // order the tab shows them, and nothing from any other document.
      const served = await gateway.getIfAvailable<DocumentNotesResponse>(
        `/api/canvas/documents/${encodeURIComponent(ref)}/notes`
      );
      if (served?.document) {
        return shapeDocRead(served.document, served.notes ?? [], canvasBlock(gateway).url, cursor);
      }
      return docReadFallback(gateway, ref, cursor);
    }

    case "board_status": {
      // Deliberately NOT canvas_state_read: the whole point is a board-shaped
      // answer (states, epics, who holds what) without pulling the canvas.
      //
      // The epic half comes from the server's ROLLUP endpoint (TDM-93) when the
      // API has it: each batch's persisted `summary` — what it ACHIEVED — plus
      // counts and, on request, one line per finished ticket. That is the answer
      // this tool could not give before: counting task states says how MUCH
      // happened in an epic and nothing about what, so "what did E5 deliver?"
      // meant opening all six of its tickets.
      //
      // Those per-ticket lines are now EXPANDED, not free (TDM-184). Every read
      // used to carry the whole archive, so the report grew with the project's
      // history and the live rows were buried in finished ones. The default is
      // one bounded row per batch; `epic:` quotes exactly one batch in full,
      // which is the question that actually wanted the lines.
      const expandRef = typeof args.epic === "string" ? args.epic.trim() : "";
      const [tasks, rollups, epicsRes] = await Promise.all([
        listAgentTasks(gateway),
        // ONE rollup call either way. Expanding asks for the full shape and
        // compacts the other batches here, rather than paying for a second read.
        fetchEpicRollups(gateway, expandRef ? { full: true } : {}),
        // The fallback list, for an API deployed before /api/canvas/epics
        // existed. Read in the same wave so the fallback costs no extra round
        // trip when the rollup turns out to be absent.
        gateway.get("/api/canvas/actions?type=epic") as Promise<{
          actions?: Array<{ id: string; state: string; payload?: { title?: string } }>;
        }>,
      ]);

      // Which batch (if any) the caller asked to see whole. A ref that names
      // nothing, or names several, expands nothing and says so — the board read
      // itself still answers.
      const expansion: { epic?: EpicRollup; problem?: string } = !expandRef
        ? {}
        : rollups
          ? matchBoardEpic(rollups, expandRef)
          : {
              problem:
                `This API has no epic rollup endpoint, so \`epic: "${expandRef}"\` could not be ` +
                `expanded — the epics below are composed from task counts alone. Read the ` +
                `batch's tickets with task_find / task_get instead.`,
            };
      const expandedId = expansion.epic?.id;

      const epics =
        rollups?.map((e) =>
          e.id === expandedId
            ? // The whole batch, exactly as the rollup gives it: per-ticket
              // lines, the summary in full, the activity window.
              { ...e, expanded: true }
            : boardEpicRow(e)
        ) ??
        (epicsRes.actions ?? []).map((e) => {
          const mine = tasks.filter((t) => t.payload?.epicId === e.id);
          return {
            id: e.id,
            title: e.payload?.title ?? "",
            state: e.state,
            tasks: countByState(mine),
          };
        });

      // How much finished history this read is NOT carrying. Reported rather
      // than silent: an agent that cannot see the lines should at least know
      // they exist and cost one argument.
      const omittedLines = (rollups ?? []).reduce(
        (n, e) => n + (e.id === expandedId ? 0 : (e.doneOmitted ?? e.done?.length ?? 0)),
        0
      );

      // Batches that drained with nobody recording what they delivered. Named
      // rather than left for the reader to notice: an unwritten summary only
      // ever gets written while somebody still remembers the work.
      // Listed at briefing length, not exhaustively: on a long-running board this
      // is a backlog of two dozen finished batches, and re-quoting every id and
      // title here doubles them — each row above already carries
      // `summaryNeeded: true`, and the note says how many there are in total.
      const unsummarizedAll = (rollups ?? [])
        .filter((e) => e.summaryNeeded)
        .map((e) => ({ id: e.id, title: e.title, doneTasks: e.tasks.byState.done ?? 0 }));
      const unsummarized = unsummarizedAll.slice(0, UNSUMMARIZED_LISTED);

      // Each in-flight row is a REPORT line, not just a name (TDM-95): ticket,
      // holder, how long they have held it, whether the claim outlived its lease,
      // and their last progress note. An orchestrator asked "where does the fleet
      // stand?" used to have to task_get every executing task to say anything
      // concrete; now the one board read answers it.
      const inFlight = tasks.filter((t) => t.state === "executing").map(inFlightRow);
      const stale = inFlight.filter((t) => "staleClaim" in t);

      // Tickets that came BACK (TDM-161) — already inline on each epic's
      // `returned`. Counted here only to say so, because a board read that
      // quietly carries four rejection reasons is a board read whose most
      // actionable content goes unread.
      const returnedCount = (rollups ?? []).reduce((n, e) => n + (e.returned?.length ?? 0), 0);

      return {
        canvas: canvasBlock(gateway),
        tasks: { total: tasks.length, byState: countByState(tasks) },
        inFlight,
        epics,
        unassignedTasks: tasks.filter((t) => !t.payload?.epicId).length,
        ...(expansion.epic ? { expandedEpic: expansion.epic.id } : {}),
        ...(unsummarized.length > 0 ? { unsummarizedEpics: unsummarized } : {}),
        ...(expansion.problem ? { _epicNotExpanded: expansion.problem } : {}),
        ...(stale.length > 0
          ? {
              _staleClaims:
                `${stale.length} in-flight task(s) are marked staleClaim: nothing has been ` +
                `reported on them for over ${DEFAULT_CLAIM_LEASE_MINUTES} minutes, so their ` +
                `holder has probably gone dark and the task is reclaimable. Report them as at ` +
                `risk — do NOT complete them on the holder's behalf.`,
            }
          : {}),
        ...(unsummarizedAll.length > 0
          ? {
              _unsummarizedEpics:
                `${unsummarizedAll.length} epic(s) have DRAINED with nothing recording what the ` +
                `batch achieved` +
                (unsummarizedAll.length > unsummarized.length
                  ? ` (\`unsummarizedEpics\` lists ${unsummarized.length}; the rest are the epic ` +
                    `rows marked \`summaryNeeded\`)`
                  : "") +
                `. Report them: the account only gets written while someone still remembers ` +
                `the work. An agent finishing remaining work in one passes \`epicSummary\` to ` +
                `task_complete; otherwise the human writes it on the board.`,
            }
          : {}),
        ...(returnedCount > 0
          ? {
              _returned:
                `${returnedCount} ticket(s) came BACK — see \`returned\` on the epics above: each ` +
                `carries the reason it was rejected at the gate or bounced for rework, and who ` +
                `said so. Read them before dispatching anything else in those batches. A ` +
                `rejection is a correction to the PLAN, so it usually applies to tickets still ` +
                `standing; amend those rather than watching them come back one at a time. ` +
                `Reasons are excerpted here — task_get on the ticket has the whole thing.`,
            }
          : {}),
        ...(omittedLines > 0
          ? {
              _epics:
                `Epics are listed COMPACT: counts, state, and the first line of each batch's ` +
                `summary. ${omittedLines} finished-ticket line(s) are not shown — call ` +
                `board_status again with \`epic: "<id or title>"\` to expand exactly ONE batch ` +
                `into its per-ticket account (that batch full, every other one still compact), ` +
                `which is the read for "what did that epic actually deliver?". Each row's ` +
                `\`doneOmitted\` says how many lines it is holding back.`,
            }
          : {}),
        _next:
          "Ready work is the 'approved' count — call queue_next to see it. Tasks stuck at " +
          "'proposed' are waiting on a human (and tasks under a 'proposed' epic wait on that " +
          "epic). Looking for one specific task by name? task_find. Want one batch's " +
          "per-ticket history? board_status with `epic:` — it is one argument, not a second tool.",
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ── Manifest ─────────────────────────────────────────────────────────────────

export const FACADE_RAW_TOOLS: RawTool[] = [
  {
    name: "canvas_connect",
    description:
      "STEP 1 of every session: bind this session to a canvas by its code (e.g. 'TEGLQFXR'), " +
      "given to you by the human. Nothing else works until you do. Returns the shareable web " +
      "`url` — give it to the user IMMEDIATELY, before you start work, so they can watch your " +
      "changes land live — and a `session` handle. Pass that handle as `session` on EVERY later " +
      "call. ALSO REGISTER HERE: pass `role` ('planner' if you'll dispatch work to subagents, " +
      "'executor' if you'll claim and do tasks yourself), a `name`, and — if an orchestrator " +
      "spawned you — the `parentAgentId` it gave you. That registers you in the SAME call and " +
      "returns `agentId` plus a `session` handle already carrying it, so your claims show as you " +
      "on the fleet view instead of an anonymous session. If a `parentAgentId` is rejected you " +
      "still connect: the result carries `agent.problem` saying so. " +
      "Next: context_get to learn the canvas, or queue_next to go straight to the work.",
    inputSchema: schemaOf("canvas_connect"),
  },
  {
    name: "agent_register",
    description: descriptionOf("agent_register") + " " + SESSION_CONVENTION,
    inputSchema: schemaOf("agent_register"),
  },
  {
    name: "context_get",
    description:
      "The canvas briefing: what this canvas IS and what's on it — identity, mode, the document " +
      "tabs, per-kind counts and names, and the state of the task queue — in ONE cheap call that " +
      "never pulls the full board. Call it once after canvas_connect to orient yourself, or when " +
      "you're picking up a canvas you haven't touched this session. If you already know the " +
      "canvas and just want work, skip it and call queue_next. " +
      SESSION_CONVENTION,
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "queue_next",
    description:
      SESSION_CONVENTION +
      " " +
      "THE ENTRY POINT FOR WORK: the approved tasks ready to be picked up right now, compact " +
      "({id, ticketId, title, state, epicId}) — no bodies. Start here rather than reading the " +
      "canvas. IF YOU HAVE SUBAGENTS, DISPATCH — do NOT claim these yourself: spawn one subagent " +
      "per ready task and paste that task's `handoff` block into it VERBATIM. The handoff carries " +
      "the 8-char canvas CODE, the task's id/ticket/title, and the steps its worker follows " +
      "(connect+register as an executor under you → claim ITS task → work → task_complete), so " +
      "there is nothing for you to compose. An orchestrator never claims, never completes on a " +
      "worker's behalf, and never passes on its `session` handle — the handle stays with you, the " +
      "CODE is what travels. WORKING ALONE: pick ONE, task_get it for the full brief, task_claim " +
      "it, then work. Empty means nothing is approved: tasks you propose sit at 'proposed' until " +
      "they are approved on the board. A task marked `lostByYou: true` carries NO handoff: you " +
      "raced for it and lost, so it is neither yours to claim nor yours to dispatch — take another.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max tasks to return. Default 10." },
        epicId: { type: "string", description: "Only ready tasks under this epic." },
      },
    },
  },
  {
    name: "queue_wait",
    description:
      SESSION_CONVENTION +
      " " +
      "WAIT HERE INSTEAD OF ENDING YOUR TURN. One call that RETURNS THE MOMENT approved work " +
      "exists — you are parked on the server, not polling, and you are woken the instant a human " +
      "(or a peer reviewer) approves something. This is the tool for every 'now we wait for " +
      "approval' moment: you proposed an epic, you finished a task and there may be more coming, " +
      "the queue is empty but work is expected. Do NOT stop and ask the human to prompt you " +
      "again — the approval on the board IS the go signal, and this call is how you hear it. " +
      "TELL THE HUMAN BEFORE YOU WAIT: waiting is the SECOND beat, never the first. If you (or " +
      "whoever briefed you) just proposed this work, relay the `tellHuman` line from the " +
      "epic_propose / task_propose answer in chat FIRST — nobody can approve a gate they were " +
      "never told is open, and a session parked here in silence looks exactly like one that " +
      "hung. Skipped it? The FIRST 'timeout' answer hands back a `_tell_human` reminder for " +
      "precisely that miss: say it then and keep waiting. It is a backstop, not a substitute, " +
      "and it comes once per batch — not on every round. " +
      "ANSWERS, always one of these, always on `status`: " +
      "'ready' — approved tasks, each already carrying the same paste-ready `handoff` queue_next " +
      "gives you, so the next step is claim (working alone) or dispatch (with subagents), with " +
      "nothing to compose. " +
      "'timeout' — nothing was approved inside the window. THIS IS NOT AN ERROR AND NOT A " +
      "FAILURE: it means 'nothing yet', it cost one call, and the correct response is to call " +
      "queue_wait AGAIN immediately. Keep going until you get 'ready', or until enough time has " +
      "passed that telling the human is honest. " +
      "'busy' / 'unsupported' — this canvas is at its waiter cap, or the API is too old to wait; " +
      "the call read the queue for you instead, so treat it like queue_next and try again. " +
      "Default wait is 25s, up to 60 (`timeoutSeconds`). Narrow to one batch with `epicId` — " +
      "e.g. the id epic_propose just returned. To read the queue right now WITHOUT waiting, use " +
      "queue_next.",
    inputSchema: {
      type: "object" as const,
      properties: {
        timeoutSeconds: {
          type: "number",
          description:
            "How long to wait for work, in seconds. Default 25, clamped to 1–60. Longer is " +
            "fine — a long wait costs nothing while it is parked, and a 'timeout' answer just " +
            "means call again.",
        },
        epicId: {
          type: "string",
          description:
            "Only wake for ready tasks under this epic — e.g. the `epicId` epic_propose returned, " +
            "when you are waiting on approval of a batch you just proposed.",
        },
        limit: { type: "number", description: "Max tasks to return. Default 10." },
      },
    },
  },
  {
    name: "task_find",
    description:
      "FIND a task by NAME when you don't have its id — \"the constraints task\", \"dark mode " +
      "rollout\". Returns only the matches ({id, ticketId, title, state, claimedBy, epicId}), so " +
      "you never have to read the whole board to turn a description into an id. Matching is " +
      "textual and predictable: the query as a substring of the title, then all its words in the " +
      "title, then all its words in title-or-body — `matchedIn` says which fired, so CHECK the " +
      "title is the task you meant before acting on it. Filter with `state` (e.g. 'approved' for " +
      "ready work, 'executing' for in flight). A ticket ref ('TDM-21', '#21') is resolved directly " +
      "instead of searched — though you can also just pass a ref straight to task_get / task_claim " +
      "as `id`, with no lookup at all. Then: task_get for the brief, task_claim to take it. " +
      SESSION_CONVENTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "What you know: part of the title (\"constraints\"), or a ticket ref (\"TDM-21\").",
        },
        state: {
          type: "string",
          description:
            "Only tasks in this state — 'proposed' | 'approved' | 'executing' | 'done' | " +
            "'failed'. Omit to search every state.",
        },
        assignee: {
          type: "string",
          description:
            "'agent' for agent work, 'human' for the human's own todos, 'any' (default) for both.",
        },
        limit: { type: "number", description: "Max matches to return. Default 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "task_get",
    description:
      "Read ONE task with its context hydrated: { action, linked, epic? } — `linked` carries the " +
      "referenced roadmap items and notes (title, body, status), which is where the real brief " +
      "lives, and `epic` says which batch it belongs to. Call this on the task you chose from " +
      "queue_next; it is all the context you need to start, so you never have to read the whole " +
      "canvas. Progress reported via task_progress comes back here too. THIS IS ALSO WHERE WORK " +
      "THAT CAME BACK EXPLAINS ITSELF: a ticket a human rejected, or finished work a reviewer " +
      "sent back for rework, answers with a `review` block — { outcome, reason, by, at } — " +
      "carrying the decider's reason VERBATIM, plus a `_review` line saying what to do about it. " +
      "One channel for both, so if you proposed something and the count dropped, task_get the " +
      "ticket rather than guessing why. A ticket still open (proposed / approved / executing) may " +
      "also answer with `quality`: the ticket-quality contract's non-blocking warnings — names no " +
      "surface, states no done condition, reads like more than one sitting — re-derived from the " +
      "text the ticket has right now, whether or not it was ever proposed through epic_propose. " +
      "They block nothing: settle them (amend it, or say what the surface and done condition are) " +
      "before you write code, rather than guessing quietly. " +
      SESSION_CONVENTION,
    inputSchema: schemaOf("canvas_task_get"),
  },
  {
    name: "task_claim",
    description:
      SESSION_CONVENTION +
      " " +
      "Claim a task you are about to do YOURSELF (approved → executing), so parallel sessions " +
      "skip it. Claim only what you will personally work: if you are dispatching subagents, do " +
      "NOT claim here — hand each worker the task's `handoff` from queue_next and let it claim " +
      "its own. A task claimed by an orchestrator that never touches it reads on the board as " +
      "in-flight work nobody is doing. The claim is ATOMIC and losing is NORMAL: " +
      "{ claimed: false, claimedBy } means another session got there first — do NOT work on it, " +
      "go back to queue_next and take the next one. Every losing answer also carries " +
      "`tapOut: true` with a `reason` and `next: \"queue_next\"` — that flag is the one thing to " +
      "branch on, and it means STOP TOUCHING THIS TASK, not try again. Asking a second time for a " +
      "task you already lost is refused without even reaching the server. On success you get the task's `ticketId` " +
      "(e.g. 'TDM-142'); put it in your commit messages so the work traces back.",
    inputSchema: schemaOf("canvas_task_start"),
  },
  {
    name: "task_progress",
    description:
      "Report progress on a task you claimed, mid-flight. Use it on long work so the human (and " +
      "other sessions) can see movement instead of silence — after a meaningful step, or when you " +
      "hit a blocker and change approach. One short line per call: what changed since last time. " +
      "The entry is stored ON the task and comes back from task_get. It is also a HEARTBEAT: each " +
      "report extends your claim, so on work longer than ~15 minutes report as you go or the task " +
      "becomes reclaimable and another session can take it out from under you. This is NOT the " +
      "finish line — call task_complete for that. " +
      SESSION_CONVENTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "The task you claimed." },
        note: {
          type: "string",
          description: "One line: what you just did, found, or got blocked on.",
        },
        percent: { type: "number", description: "Optional rough completion, 0-100." },
        agentName: {
          type: "string",
          description: "Identity to report as — the same one you claimed with. Defaults to this session's.",
        },
      },
      required: ["id", "note"],
    },
  },
  {
    name: "task_complete",
    description:
      SESSION_CONVENTION +
      " " +
      "FINISH a task with a result summary — the last step of every task you claim; leaving one " +
      "'executing' blocks the queue. `result` is a short human-readable account of what was done " +
      "and where: files, commit hashes, PR. It shows on the board, so it is the human's whole view " +
      "of your work. Back it with `links`: the GitHub URLs the work produced (commit / pull " +
      "request / branch). The board resolves those live — merged, open, checks failing — so the " +
      "human reads what HAPPENED, not just what you said. " +
      "Failed? pass status:'failed' with `error` rather than leaving it hanging. " +
      "Complete under the SAME identity you claimed with. " +
      "FINISHING A BATCH: if this is the last unfinished task in its epic (task_get says so, and " +
      "the answer here reports what is left), also pass `epicSummary` — what the whole BATCH " +
      "achieved. A task's `result` is per-ticket; without an epic summary the only way to learn " +
      "what an epic delivered is to open every ticket in it.",
    inputSchema: withEpicSummaryArg(schemaOf("canvas_task_complete")),
  },
  {
    name: "task_propose",
    description:
      SESSION_CONVENTION +
      " " +
      "Propose work for LATER sessions — one task, or a whole plan at once via `tasks` (strongly " +
      "preferred over calling this repeatedly). Proposals land as 'proposed' and a human approves " +
      "them on the board before any session can claim them, so this is how you hand off work " +
      "instead of doing it. Keep `body` a tight brief (what to do, acceptance criteria) and put " +
      "the heavy context in notes/roadmap items referenced by `linkedIds` — task_get hydrates " +
      "those for whoever picks it up. For a whole plan, prefer epic_propose: it creates the epic " +
      "AND its tasks in one call, so the human approves once instead of task by task. " +
      "The answer hands back `tellHuman` — a paste-ready line naming what is waiting, its ticket " +
      "range and the board URL. RELAY IT in your very next message before you wait on anything: " +
      "a gate nobody was told about is just a stall. " +
      PEER_APPROVAL_CLAUSE,
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short imperative title, e.g. 'Add CSV export to sheets'." },
        body: { type: "string", description: "Concise brief: what to do, acceptance criteria." },
        linkedIds: {
          type: "array",
          items: { type: "string" },
          description: "Ids of notes / roadmap items carrying the detailed context.",
        },
        epicId: {
          type: "string",
          description:
            "Epic this task belongs to (from epic_propose, task_get or board_status). Under the " +
            "default approval policy, a task added to an already-approved epic is born approved " +
            "instead of waiting for its own approval; under a still-proposed epic it waits for " +
            "that epic's single approval. Without one the task is unparented and needs its own. " +
            "When you pass `tasks`, a call-level epicId here applies to EVERY item (an item's own " +
            "epicId still wins), so you can parent a whole plan in one call.",
        },
        assignee: {
          type: "string",
          enum: ["agent", "human"],
          description: "'agent' (default) = for an agent session; 'human' = the human's own todo.",
        },
        requiresApproval: {
          type: "boolean",
          description:
            "Force the human gate even under an auto-approving policy. Set it when the task " +
            "deviates from what was agreed.",
        },
        tasks: {
          type: "array",
          description:
            "Propose MANY at once — each item takes the same fields as above. Use this for a " +
            "whole plan; it is one write instead of N.",
          items: {
            type: "object" as const,
            properties: {
              title: { type: "string" },
              body: { type: "string" },
              linkedIds: { type: "array", items: { type: "string" } },
              epicId: {
                type: "string",
                description:
                  "Epic this task belongs to — set it per item, or use epic_propose to create " +
                  "the epic and its tasks together.",
              },
              assignee: { type: "string", enum: ["agent", "human"] },
              requiresApproval: { type: "boolean" },
            },
            required: ["title"],
          },
        },
      },
    },
  },
  {
    name: "task_amend",
    description:
      "Correct or retract a task YOU proposed — the self-heal for a mis-proposed plan (wrong " +
      "epic, typo'd title, a duplicate). Deliberately narrow: it works ONLY while the task is " +
      "still 'proposed' AND unclaimed AND was authored by you. Pass the fields to change " +
      "(title / body / epicId / linkedIds) to edit it, or `withdraw: true` to delete it. Once a " +
      "task has been approved it is THEIRS — this tool refuses, and the move is to propose a " +
      "follow-up or ask the human to reject it; once another agent has claimed it, its claim " +
      "owns it. Use this to re-parent tasks that landed unparented, not to rewrite work already " +
      "approved or in flight. " +
      SESSION_CONVENTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The task to amend — its ticket ref (e.g. 'TDM-21') or uuid.",
        },
        title: { type: "string", description: "New title. Omit to keep the current one." },
        body: { type: "string", description: "New brief. Omit to keep the current one." },
        epicId: {
          type: "string",
          description:
            "Re-parent the task to this epic (from epic_propose / board_status). Omit to leave " +
            "its parent unchanged.",
        },
        linkedIds: {
          type: "array",
          items: { type: "string" },
          description: "Replace the linked context ids. Omit to leave them unchanged.",
        },
        withdraw: {
          type: "boolean",
          description:
            "Set true to RETRACT (delete) the proposal instead of editing it — for a task " +
            "proposed by mistake or a duplicate. Ignores the edit fields.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "task_review",
    description:
      SESSION_CONVENTION +
      " " +
      "THE REVIEWER'S ONE TOOL — the whole review loop, in two outcomes. Only usable on a canvas " +
      "whose owner turned on the 'peer' approval policy (off by default — everywhere else review " +
      "is the human's and this answers reviewed:false). There, a REGISTERED agent reviews work " +
      "another agent did: " +
      "`outcome: \"pass\"` approves a task that is still 'proposed', releasing it into the ready " +
      "queue; `outcome: \"changes_requested\"` sends a task that is 'done' back — it leaves 'done', " +
      "loses its claim, and returns to the ready queue as 'approved' with your `reason` on its " +
      "audit trail, so the next executor reads why. Those are the only two moves, and each one " +
      "applies to exactly one state: 'pass' is for a PLAN you are letting through, " +
      "'changes_requested' is for FINISHED work you are sending back. " +
      "There is no third answer, deliberately: an agent cannot reject a proposal or kill a task. " +
      "The bounce is reversible, so an agent gets it; destroying work is not, so it stays the " +
      "human's. Leaving a task alone and saying why IS how you say no to a proposal. " +
      "The server enforces the rest from provenance it derived itself — you cannot review your " +
      "own proposal or your own completion, you cannot review an epic (that cascade stays " +
      "human-only), and you cannot review as anyone but the identity you registered under. On a " +
      "canvas whose owner also turned on cross-model review you cannot review an agent running " +
      "the same MODEL as you either (peer_same_model / rework_same_model), which is why " +
      "canvas_connect's `model` is worth passing. " +
      "BEING A REVIEWER MEANS READING THE WORK: task_get the task (and its result, and the " +
      "commit it links), judge whether it is right, correctly scoped and actually finished, and " +
      "only then answer. A reviewer that passes everything is indistinguishable from the 'auto' " +
      "policy, which already exists and is simpler. " +
      "Refusals come back as DATA, not errors: `reviewed:false` with a stable `refusal` code " +
      "(rework_not_finished, rework_self_review, peer_self_approval, peer_epic_human_only, " +
      "peer_agent_unregistered, rework_policy_required, human_approval_only when the canvas is " +
      "not on 'peer', …) plus the server's `message` and a `_next` saying what to do about it. " +
      "Read `_next` — it is written for the case you actually hit, including codes newer than " +
      "this tool.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description:
            "The task you reviewed — its ticket ref (e.g. 'TDM-21', '#21', '21') or uuid. One " +
            "task per call: there is no bulk review for agents, on purpose.",
        },
        outcome: {
          type: "string",
          enum: ["pass", "changes_requested"],
          description:
            "'pass' — approve a PROPOSED task into the ready queue. 'changes_requested' — send a " +
            "DONE task back for another go, with a reason. Nothing else is a review outcome.",
        },
        reason: {
          type: "string",
          description:
            "REQUIRED on 'changes_requested', and the only thing the author gets: name what is " +
            "wrong and what 'fixed' would look like ('the rework handler never checks the claim " +
            "fence — cover that case in the API tests'), not merely that it is wrong. Kept " +
            "verbatim on the task's audit trail. Ignored on 'pass', which records who approved, " +
            "not why.",
        },
      },
      required: ["id", "outcome"],
    },
  },
  {
    name: "epic_propose",
    description:
      SESSION_CONVENTION +
      " " +
      "Propose an EPIC — the named container a plan hangs off — and, in the SAME call, the tasks " +
      "under it via `tasks` (same item shape as task_propose). Use this whenever you're asked to " +
      "'write an epic' or plan a feature: tasks proposed without one are unparented and each need " +
      "their own approval. " +
      "WHEN TO REACH FOR IT WITHOUT BEING ASKED — and when NOT to, which matters just as much. " +
      "The test: could you write the ticket — name the surface it touches, state a done condition " +
      "someone else could check, one sitting of work — out of what the user ACTUALLY SAID? " +
      "If NO for any part of the ask, call this FIRST, before you write a line of code: " +
      "'fix auth, the email service, and messaging' names three AREAS and zero surfaces, so " +
      "starting means inventing the surfaces, the scope and the done conditions yourself — and " +
      "those invented calls are exactly what the human is meant to see before the code exists. " +
      "Same for one vague area ('make onboarding not suck') or one ask plainly bigger than a " +
      "sitting. If YES for every part, do NOT wrap it in an epic — just do the work. " +
      "'Fix the bell overlapping the code chip' already names its surface and its done condition; " +
      "an epic there charges the human an approval for a decision they made when they asked, and " +
      "a gate that fires on everything gets switched off. It turns on how SPECIFIED the ask is, " +
      "not how many parts it has: three specified one-sitting changes are three tasks, not an " +
      "epic. Propose the WHOLE batch here rather than starting on the easy one while the rest " +
      "waits. " +
      "THAT SAME TEST IS THE BAR FOR THE TICKETS YOU WRITE, and ticket quality is the point " +
      "here, not a nicety: the PLAN is what the human reviews, so " +
      "eleven mushy tickets waste the whole gate. Every ticket you write must (1) NAME THE " +
      "SURFACE it touches — a file, a package, an endpoint, a component, never 'improve auth'; " +
      "(2) carry a DONE CONDITION someone else could check without asking you — a test, a build, " +
      "an observable behaviour; (3) be ONE SITTING of work — if it needs three, it is its own " +
      "epic, so split it; (4) LINK heavy context with `linkedIds` instead of pasting the same " +
      "background into every body (task_get hydrates links for whoever picks the ticket up). " +
      "The cheap, objective half of that is ENFORCED: a ticket with no real body, a ticket whose " +
      "title just restates the epic's, or an epic with exactly one ticket is REFUSED and nothing " +
      "is written — fix them all and call again. The rest comes back as non-blocking `warnings` " +
      "on the response, each naming a ticket and what it is missing: read them and amend with " +
      "task_amend while the tickets are still 'proposed'. Warnings never block approval. " +
      "The epic lands as 'proposed'; a HUMAN approves it ONCE on the board " +
      "and that single approval cascades to every task under it. You must NOT try to approve " +
      "it yourself — that gate is the human's on every canvas, epics included, and the server " +
      "refuses agent approval of an epic even where it allows peer review of a task (there the " +
      "cascade is off and each task is approved on its own; see task_review). " +
      "After proposing, TELL THE HUMAN FIRST, then listen: the answer hands you `tellHuman`, a " +
      "paste-ready line naming the epic, its ticket range and the board URL — relay it in your " +
      "very next message, because a gate nobody was told about is just a stall. THEN, without " +
      "ending your turn, LISTEN for the approval with queue_wait and the " +
      "returned `epicId` — one call that returns when the work is approved — so the human's " +
      "approval on the board, not another prompt, is what starts the work. " +
      "Returns `epicId`: pass it as `epicId` on later task_propose calls to add work to the same " +
      "batch (once the epic is approved, those tasks are born approved).",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short name for the batch, e.g. 'Dark mode rollout'." },
        body: { type: "string", description: "What this batch achieves; scope and intent." },
        linkedIds: {
          type: "array",
          items: { type: "string" },
          description: "Ids of notes / roadmap items carrying the detailed context.",
        },
        tasks: {
          type: "array",
          description:
            "The plan, created under the new epic in one write — each item takes the same fields " +
            "as task_propose. Any `epicId` on an item is overridden with the new epic's id. " +
            "Two or more: an epic with a single ticket is refused, because that is a task " +
            "(use task_propose). Each one is a slice of the batch, not a restatement of it.",
          items: {
            type: "object" as const,
            properties: {
              title: {
                type: "string",
                description:
                  "One line naming this ticket's own slice of the work — not the epic's title again.",
              },
              body: {
                type: "string",
                description:
                  "What changes, on WHICH surface (file / package / endpoint / component), and " +
                  "the DONE CONDITION someone else could check without asking you. Required in " +
                  "substance: a near-empty body is refused. One sitting of work per ticket.",
              },
              linkedIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "Ids of the notes / roadmap items carrying the heavy context — link it here " +
                  "rather than pasting the same background into every ticket body.",
              },
              assignee: { type: "string", enum: ["agent", "human"] },
              requiresApproval: { type: "boolean" },
            },
            required: ["title"],
          },
        },
      },
      required: ["title"],
    },
  },
  {
    name: "doc_write",
    description:
      "LEAVE CONTEXT BEHIND: write a markdown note onto the canvas — findings, a decision and why, " +
      "a design sketch, anything the next session (or the human) needs and would otherwise have to " +
      "rediscover. This is the main write path; use it as you go, not only at the end. `document` " +
      "names the tab to write into and IS CREATED if it doesn't exist yet, so you can organise as " +
      "you write; omit it to use the canvas's default notes tab. Pass `noteId` to rewrite an " +
      "existing note instead of adding another. Returns `noteId` — keep it if you'll update this " +
      "note again. For task outcomes use task_complete's `result`, not this. " +
      SESSION_CONVENTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        body: { type: "string", description: "The note content, markdown." },
        title: {
          type: "string",
          description: "Optional heading, prepended to the body as '## title'.",
        },
        document: {
          type: "string",
          description:
            "Notes tab to write into — an existing document's name or id, or a NEW name to " +
            "create that tab. Omit for the canvas's default notes tab.",
        },
        noteId: {
          type: "string",
          description: "Rewrite this existing note (from an earlier doc_write) instead of creating one.",
        },
      },
      required: ["body"],
    },
  },
  {
    name: "doc_read",
    description:
      "READ ONE DOCUMENT TAB BACK — the read side of doc_write. Use it for the strategy and " +
      "context writing that lives on the canvas rather than in the repo: the thesis, a plan, the " +
      "decisions a past session left behind. `document` is the tab's NAME (the one you passed to " +
      "doc_write) or its id; context_get lists the tabs if you don't know it. Returns that tab's " +
      "notes in the order it shows them, each with its markdown and its `noteId` — keep the id if " +
      "you'll revise that note, because doc_write WITHOUT it appends a second copy instead of " +
      "updating. Scoped server-side: reading one tab never pulls the rest of the canvas. An " +
      "unknown name comes back naming the tabs that do exist. BUDGETED: at most ~20KB of markdown " +
      "per call, so a huge tab can never blow your context in one answer. A tab that fits comes " +
      "back whole with no paging fields at all; one that doesn't answers `truncated: true` plus a " +
      "`nextCursor` ({ document, noteCursor, offset }) — pass those two values straight back to " +
      "read the next slice, and repeat until the answer has no `truncated` flag. A note marked " +
      "`partial` is a FRAGMENT of that note: never doc_write it back under its noteId. " +
      SESSION_CONVENTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        document: {
          type: "string",
          description:
            "The tab to read — an existing document's name (case-insensitive) or its id. " +
            "Unlike doc_write, this never creates one.",
        },
        noteCursor: {
          type: "string",
          description:
            "Continue a truncated read: the `nextCursor.noteCursor` from the previous page (the " +
            "noteId to resume at). Omit for the first page.",
        },
        offset: {
          type: "number",
          description:
            "Byte offset into the note named by `noteCursor` — the `nextCursor.offset` from the " +
            "previous page. Omit for the first page; don't compute one by hand.",
        },
      },
      required: ["document"],
    },
  },
  {
    name: "board_status",
    description:
      "A compact read of the BOARD, not the canvas: task counts by state, epics with their approval " +
      "state, per-epic task counts and the first line of each epic's `summary` of what it ACHIEVED. " +
      "An epic marked `summaryNeeded` has drained with nobody recording that. And every in-flight " +
      "task as a report line — ticketId, holder, how many minutes they have held the claim, their " +
      "last progress note, and `staleClaim: true` once nothing has been reported for longer than " +
      "the claim lease (~15 min), meaning the holder has probably gone dark. THIS IS THE " +
      "ORCHESTRATOR'S REPORT: it is enough to say where every worker stands without reading a " +
      "single task. Also how you check whether your proposals got approved. ONE BATCH IN FULL: the " +
      "per-ticket account — one line per finished ticket, with what it delivered — is one argument " +
      "away, not something every read pays for. Pass `epic` (its id, or enough of its title to name " +
      "it) and THAT batch comes back whole while every other one stays compact, which is the read " +
      "for 'what did E5 actually deliver?'. Each compact row's `doneOmitted` says how many lines it " +
      "is holding back. Cheap by default and it never dumps canvas contents. For the work you can " +
      "actually start, use queue_next; to find one task by name, task_find. " +
      SESSION_CONVENTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        epic: {
          type: "string",
          description:
            "Optional: expand exactly ONE batch into its per-ticket account — its id, or enough " +
            "of its title to name it alone ('E15', 'token diet'). Everything else on the board " +
            "stays compact. A ref that matches nothing, or several batches, expands nothing and " +
            "says so in `_epicNotExpanded` — the rest of the board read still answers.",
        },
      },
    },
  },
];
