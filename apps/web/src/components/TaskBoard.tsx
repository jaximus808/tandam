import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowRight,
  BadgeCheck,
  Ban,
  Bot,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  GitCommitHorizontal,
  Layers,
  Link2,
  ListChecks,
  Maximize2,
  Milestone,
  Pencil,
  PenLine,
  Play,
  Plus,
  RotateCcw,
  Search,
  Shield,
  SlidersHorizontal,
  Square,
  SquareKanban,
  Timer,
  Trash2,
  User,
  Users,
  X,
  Zap,
} from "lucide-react";
import type {
  Action,
  ActionState,
  CanvasState,
  ContentAuditEntry,
  EpicPayload,
  TaskPayload,
} from "../types";
import {
  approveAction,
  approveBatch,
  createTask,
  deleteTask,
  moveTask,
  rejectAction,
  updateTask,
} from "../lib/api";
import { humanMovesFor, primaryMoveFor, type HumanMove } from "../lib/taskMoves";
import {
  deriveLease,
  leaseAge,
  leaseLabel,
  leaseSentence,
  type Lease,
} from "../lib/lease";
import {
  contentionLabel,
  contentionSentence,
  tallyContention,
  type ContentionTally,
} from "../lib/contention";
import { useFreshnessNow } from "./Freshness";
import posthog from "../lib/posthog";
import TaskComposer, { linkTargets } from "./TaskComposer";
import { epicLifecycle, TERMINAL_STATES } from "../lib/epicLifecycle";
import { CHIP_BASE, STATE_CHIP } from "../lib/stateChips";
import {
  parseApproval,
  parseAuthoredBy,
  provenanceTitle,
  type Approval,
} from "../lib/provenance";
import {
  auditActorLabel,
  auditChangeLabel,
  lastReapprovalEdit,
  lastStateMove,
  moveVerbLabel,
  moveVerbShort,
  stateMoveNote,
} from "../lib/taskAudit";
import TaskLinks from "./TaskLinks";
import { useCardFlight } from "../lib/useCardFlight";
import { spaLink } from "../lib/spaNav";

/* ─────────────────────────────────────────────────────────────────────────────
   TaskBoard — the Board surface: the one home for tasks on a canvas. Humans
   author tasks here (the toolbar's "New task" composer), triage agent-proposed
   work, and watch cards move as agent sessions claim and finish them.

   Epics are the NAVIGATION LENS, not items on the board. A left sidebar lists
   the epic timeline in creation order (oldest first — it reads as the
   project's sequence): state chip, n/m-done mini progress bar, an elapsed
   "drained in Xm" annotation once an approved epic's tasks all reach a
   terminal state, and inline Approve / Reject on proposed epics — the sidebar
   doubles as the approval inbox. Two sticky pseudo-entries sit on top:
   "All tasks" and "No epic" (no or dangling epicId). The selection persists
   in localStorage and falls back to All tasks if the stored epic vanished.

   Age-out (TDM-9): epics whose lifecycle (lib/epicLifecycle) is finished
   (approved + all tasks terminal) or archived (rejected) leave the timeline
   for a collapsed "Done · N" bucket at the bottom — dimmed entries, still
   selectable, so history stays browsable. The one exception is the epic you
   are currently viewing: it holds its timeline slot if it finishes under you.

   The main area is ONE kanban (Proposed / Ready / Working / Done /
   Failed+Rejected), always scoped to the sidebar selection. Scoped to an
   epic, a compact header shows the epic's title / clamped body / progress /
   Approve-Reject, and cards drop the (now redundant) epic chip; in All-tasks
   scope the chip stays and clicking it jumps the sidebar to that epic.

   A compact filter bar (search + state / claimant / assignee / commit chips,
   AND-composed) applies within the selected scope, so the Done/Failed history
   is genuinely browsable. "/" focuses search; Escape closes the detail panel,
   then clears filters. Filters are not persisted; the scope is.

   Search reaches PAST the scope (TDM-144). The chip filters narrow what is on
   screen; search is how you FIND something, and the two are not the same verb.
   So a query also resolves ticket refs ("TDM-104" / "#104" / "104") straight to
   their card, matches EPICS as their own result group (an epic hit scopes the
   board to it), and reports the matches the current scope cannot show instead
   of silently omitting them — see the search ladder below and renderSearchHits.

   Everything renders from the same version-gated canvas-state props as every
   other view, so claims/completions move cards live over WS — no polling, no
   local task cache. Mutations are the existing REST calls; fresh state comes
   back over the broadcast like everywhere else.

   Card click opens the full TaskDetail side panel (wave 2): complete body,
   linked context, result with commit chips, provenance, and the step-in
   controls per state. Destructive actions confirm inline (two-step).

   HUMANS MOVE CARDS TOO (E10). Everything except approve/reject used to be an
   agent transition, which made your own `assignee:"human"` todo in Ready a card
   you could only look at. Now: a card carries the one forward move for a human
   todo (Start / Mark done — one click, no confirm), and the detail panel
   carries the whole legal set for ANY task from lib/taskMoves — start, mark
   done, mark failed, release a claim, re-queue a failure, reopen a done task,
   reconsider a rejected one, each with an optional note. Explicit controls, no
   drag-and-drop: a state change is a decision, not a gesture, and it has to be
   as available to a keyboard as to a mouse.

   What no control here can do is APPROVE. A proposed task has no moves at all
   — Approve / Reject are its only exits, on the server as much as in this file.

   TRIAGE IS A BATCH VERB (TDM-164). The Proposed lane takes a selection —
   click, shift-click for a range, cmd/ctrl-click to toggle, arrows and
   shift-arrows from the keyboard, and a tap-to-select mode for touch — and
   approve / reject act on the whole of it, with one shared reason asked once.
   The selection is a set of task IDS held apart from the canvas state, because
   this board re-renders under live websocket pushes and a selection keyed by
   position would drift onto tickets nobody looked at; see the note on
   `selected` for the two rules that keep it honest against a moving lane.
   ──────────────────────────────────────────────────────────────────────────── */

// Kanban columns. `dot` is the header hue (from the shared six-hue state set);
// Failed + Rejected share the terminal "closed" column so dead work doesn't
// take two lanes. `short` is the mobile column-switcher label — the strip has
// five segments to fit on a 390px screen, so "Failed / Rejected" spends width
// the switcher does not have (the lane header still says it in full).
const COLUMNS: {
  key: string;
  label: string;
  short: string;
  states: ActionState[];
  dot: string;
}[] = [
  { key: "proposed", label: "Proposed", short: "Proposed", states: ["proposed"], dot: STATE_CHIP.proposed.dot },
  { key: "ready",    label: "Ready",    short: "Ready",    states: ["approved"], dot: STATE_CHIP.approved.dot },
  { key: "working",  label: "Working",  short: "Working",  states: ["executing"], dot: STATE_CHIP.executing.dot },
  { key: "done",     label: "Done",     short: "Done",     states: ["done"], dot: STATE_CHIP.done.dot },
  { key: "closed",   label: "Failed / Rejected", short: "Closed", states: ["failed", "rejected"], dot: STATE_CHIP.failed.dot },
];

// Which lane a task in this state lives in — so a focus/follow handoff can bring
// the right lane forward on mobile, where only one is on screen at a time.
function colKeyForState(s: string): string {
  return COLUMNS.find((c) => c.states.includes(s as ActionState))?.key ?? COLUMNS[0].key;
}

// How many cards may resolve their evidence links against GitHub on a board
// load (TDM-45). The rest render their chips without a dot until you open them.
// See liveLinkTaskIds for why this is a small number.
const LIVE_LINK_CARDS = 6;

// Whether a keystroke landed in something the person is TYPING into — the guard
// every bare-letter shortcut on this surface needs, or "a" in the search box
// approves the selection. Factored out because "/" and the TDM-164 triage keys
// must agree on what counts as typing.
function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  return (
    node.tagName === "INPUT" ||
    node.tagName === "TEXTAREA" ||
    node.tagName === "SELECT" ||
    node.isContentEditable
  );
}

/* Fan a per-id write across a bounded number of lanes, and report which ids
   landed (TDM-164). Bulk REJECT has no batch endpoint — reject is one request
   per ticket by design (each carries its own reason into the action's error
   column) — so rejecting eleven tickets serially would spend eleven
   round-trips end to end and make the bulk path feel slower than clicking. Four
   at a time is the same shape the API's own batch paths settled on: enough
   overlap to hide the latency, few enough not to open a connection per ticket.

   Failures are SWALLOWED here and inferred from the returned list: one ticket
   that has already moved on must not abort the other ten, and the caller has to
   know exactly which ids to offer an undo for anyway. */
const BULK_LANES = 4;
async function runBatch(ids: string[], fn: (id: string) => Promise<void>): Promise<string[]> {
  const queue = [...ids];
  const landed: string[] = [];
  await Promise.all(
    Array.from({ length: Math.min(BULK_LANES, queue.length) }, async () => {
      for (;;) {
        const id = queue.shift();
        if (id === undefined) return;
        try {
          await fn(id);
          landed.push(id);
        } catch {
          /* counted by the caller as "not in the landed list" */
        }
      }
    }),
  );
  return landed;
}

/* ── Mobile type scale (TDM-85) ───────────────────────────────────────────────
   The board's desktop scale is deliberately DENSE: five lanes side by side, so
   a card title is 13px and its record metadata 10px. On a phone none of those
   reasons hold — one lane is on screen at a time (TDM-86), the card is
   full-width, and the reading distance is shorter. Rendering the desktop sizes
   unchanged is how a dense-by-design board turns into a cramped one.

   So the scale is MOBILE-FIRST here: the bare size is the PHONE size and `sm:`
   restores the desktop density verbatim — ≥640px is unchanged, pixel for pixel.
   Written as constants because the same few rungs recur across cards, sidebar
   rows and column headers, and a scale is only a scale if it is applied once.

   This pairs with the text-size-adjust fix in index.css: until iOS stopped
   font-boosting the wide kanban, tuning these numbers was pointless because the
   browser was overriding them anyway. */

/** Card titles. */
const T_TITLE = "text-[14px] sm:text-[13px]";
/** Sidebar epic + pseudo-entry titles (one rung below a card title). */
const T_ROW = "text-[13.5px] sm:text-[12.5px]";
/** Record metadata: ticket chips, ages, counts — the smallest readable rung. */
const T_META = "text-[11px] sm:text-[10px]";
/** Column headers and the uppercase group labels. */
const T_HEAD = "text-[11.5px] sm:text-[11px]";
/** In-card and in-row action buttons (approve / reject / state moves). */
const T_BTN = "text-[12px] sm:text-[11px]";
/** Comfortable touch height for a real control, collapsing to dense on sm+.
    The rule itself lives in index.css as `.tandem-tap` so the composer, the
    sheets and the dialogs share ONE definition of the floor rather than each
    re-deriving it. */
const TAP = "tandem-tap";

// Sidebar scope — which lens the kanban shows: "all" | "none" | an epic id.
// Persisted so the board reopens where you left it.
const SCOPE_KEY = "tandem.board.epic";
// Whether the sidebar's Done bucket (finished + rejected epics) is expanded.
const DONE_OPEN_KEY = "tandem.board.epicsDoneOpen";

function taskPayload(a: Action): TaskPayload {
  return (a.payload ?? {}) as TaskPayload;
}

function epicPayload(a: Action): EpicPayload {
  return (a.payload ?? {}) as EpicPayload;
}

/* ── Search (TDM-144) ─────────────────────────────────────────────────────────
   Board search used to be ONE substring test over the tasks in the current
   scope, which made three ordinary things impossible: finding an epic by name,
   jumping to a ticket by its ref, and finding anything whatsoever while scoped
   to an epic that does not contain it.

   The matching ladder here is deliberately the same one the MCP's `task_find`
   uses (apps/mcp-gateway/src/facade.ts, TDM-95): the query as a substring of
   the title, then all its words in the title, then all its words across
   title-or-body. Same rules on both surfaces means "does this match?" has one
   answer whether a human typed it or an agent asked — and, as there, the ladder
   is dumb and predictable on purpose, because a result you cannot explain is a
   result you will not trust.

   Above the ladder sits the ticket ref, which is not a fuzzy query at all:
   "TDM-104", "tdm-104", "#104" and "104" are an ADDRESS. An address outranks
   every guess, so it wins outright and gets the Enter key. */

/** Match strength, best first. */
const M_TICKET = 4;
const M_TITLE_SUB = 3;
const M_TITLE_WORDS = 2;
const M_BODY = 1;

/** How many epic / out-of-scope hits the results strip lists before it counts. */
const SEARCH_HITS = 6;

type SearchQuery = { needle: string; words: string[]; ticket: string | null };

/** Parse the (already trimmed + lowercased) search text once per keystroke:
 *  the needle, its words, and the ticket ref it spells if it spells one. */
function parseSearch(raw: string): SearchQuery | null {
  const needle = raw.trim().toLowerCase();
  if (!needle) return null;
  const m = /^(?:tdm-|#)?(\d{1,9})$/.exec(needle);
  return {
    needle,
    // One-character words match nearly everything — they would turn the
    // ladder's lower rungs into noise.
    words: needle.split(/\s+/).filter((w) => w.length > 1),
    ticket: m ? `TDM-${Number(m[1])}` : null,
  };
}

/** The ladder over one title/body pair (both already lowercased). 0 = no match. */
function scoreText(q: SearchQuery, title: string, body: string): number {
  if (title.includes(q.needle)) return M_TITLE_SUB;
  if (q.words.length === 0) return 0;
  if (q.words.every((w) => title.includes(w))) return M_TITLE_WORDS;
  if (q.words.every((w) => title.includes(w) || body.includes(w))) return M_BODY;
  return 0;
}

/** Score a task: its own ticket ref wins outright, else the ladder. The result
 *  text and ticket id fold into the body rung so the Done history stays
 *  findable by what an agent actually wrote there (a commit hash, a file). */
function scoreTask(q: SearchQuery, t: Action): number {
  if (q.ticket && t.ticketId?.toUpperCase() === q.ticket) return M_TICKET;
  const p = taskPayload(t);
  return scoreText(
    q,
    (p.title ?? "").toLowerCase(),
    `${p.body ?? ""}\n${t.result ?? ""}\n${t.ticketId ?? ""}`.toLowerCase(),
  );
}

/** Score an epic — the same ladder, minus the ticket rung (epics carry none). */
function scoreEpic(q: SearchQuery, e: Action): number {
  const p = epicPayload(e);
  return scoreText(q, (p.title ?? "").toLowerCase(), (p.body ?? "").toLowerCase());
}

// ── Commit-hash detection ─────────────────────────────────────────────────────
// A "commit" is a 7-40 char hex word in the result text that contains at least
// one digit AND one a-f letter — the heuristic keeps plain numbers (ports,
// timestamps) and ordinary words out while catching every realistic git SHA.
const COMMIT_RE = /\b[0-9a-fA-F]{7,40}\b/g;

export function extractCommits(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.match(COMMIT_RE) ?? []) {
    if (/[0-9]/.test(m) && /[a-fA-F]/.test(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

// Compact relative age ("now", "5m", "2h", "3d", "2w", "4mo"). Renders from
// props only — it refreshes on state pushes, which is exactly as live as the
// rest of the board (no timers, no polling).
export function ageOf(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.floor(d / 7)}w`;
  return `${Math.floor(d / 30)}mo`;
}

export function fullDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// Human duration for the epic elapsed annotation ("22m", "1h 4m", "3d 2h").
function elapsedLabel(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

// "drained in 22m" — how long an epic took to empty once approved. Epics only
// move proposed → approved and are never claimed or executed, so an approved
// epic's updatedAt IS its approval timestamp; the end is the newest updatedAt
// among its tasks (the moment each hit its terminal state). Only shown when
// every task is terminal and the span is trustworthy (positive, parseable).
function epicDrain(epic: Action, epicTasks: Action[]): string | null {
  if (epic.state !== "approved" || epicTasks.length === 0) return null;
  if (!epicTasks.every((t) => TERMINAL_STATES.includes(t.state))) return null;
  const start = new Date(epic.updatedAt).getTime();
  const end = Math.max(...epicTasks.map((t) => new Date(t.updatedAt).getTime()));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return `drained in ${elapsedLabel(end - start)}`;
}

// Segmented progress: done in emerald, in-flight in pulsing violet, on an ink
// track — the at-a-glance "is this moving?" signal, shared by the sidebar
// entries and the scoped-epic header.
function ProgressBar({
  done,
  working,
  total,
  className = "",
}: {
  done: number;
  working: number;
  total: number;
  className?: string;
}) {
  return (
    <div className={`flex overflow-hidden rounded-full bg-ink/[0.08] ${className}`}>
      {total > 0 && done > 0 && (
        <div className={`h-full ${STATE_CHIP.done.dot}`} style={{ width: `${(done / total) * 100}%` }} />
      )}
      {total > 0 && working > 0 && (
        <div
          className={`h-full animate-pulse opacity-80 ${STATE_CHIP.executing.dot}`}
          style={{ width: `${(working / total) * 100}%` }}
        />
      )}
    </div>
  );
}

export function StateChip({ state, className = "" }: { state: string; className?: string }) {
  const chip = STATE_CHIP[state] ?? STATE_CHIP.proposed;
  return (
    <span className={`${CHIP_BASE} ${chip.chip} ${className}`}>
      {chip.label}
    </span>
  );
}

// The one claimant treatment everywhere: who's executing, in working-violet.
export function ClaimantChip({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 text-[11px] font-medium ${STATE_CHIP.executing.text} ${className}`}
      title={`Being worked on by ${name}`}
    >
      <Zap size={11} className="shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

// ── Claim leases (TDM-101) ───────────────────────────────────────────────────
// The claimant chip above says WHO holds a task. It cannot say whether they are
// still alive — and because claim expiry is lazy on the server (no sweeper), a
// worker that died ten minutes ago renders exactly like one mid-sentence. These
// two say the rest: how long since we heard from the holder, and whether the
// lease has lapsed so that any other agent may take the task over.
//
// Hue: the closed six-hue state set owns STATE, and a lapsed lease is not a new
// state — the task is still Working. So live rides the working violet the
// claimant chip already wears, and the two states that want a human's attention
// borrow the board's one attention hue (amber), the same hue "needs approval"
// and "edited after approval" use. Those live only on PROPOSED cards and this
// lives only on EXECUTING ones, so amber never means two things on one card.
//
// Shape carries the same information as hue, per the Freshness rule: a pulsing
// solid dot for live, a hollow ring for slipping, a solid dot in a filled well
// for lapsed — so the three survive a colourblind reader, and the whole sentence
// rides along as `title` and as screen-reader text.

const LEASE_TONE: Record<"live" | "slipping" | "stale", { well: string; dot: string; text: string }> = {
  live: { well: "", dot: "bg-violet-500 animate-pulse", text: "text-ink/50" },
  slipping: {
    well: "",
    dot: "border border-amber-500 bg-transparent",
    text: "text-amber-600 dark:text-amber-400",
  },
  stale: {
    well: "bg-amber-500/10",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
};

/** Heartbeat freshness for a claim: silent-for age, plus a word once the lease
 *  is in trouble. Renders nothing when there is no lease to report. */
export function LeaseChip({ lease, className = "" }: { lease: Lease; className?: string }) {
  if (lease.health === "none") return null;
  const tone = LEASE_TONE[lease.health];
  const label = leaseLabel(lease.health);
  const sentence = leaseSentence(lease);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-[4px] px-1 py-px ${tone.well} ${className}`}
      title={sentence}
    >
      <span aria-hidden="true" className={`h-[6px] w-[6px] shrink-0 rounded-full ${tone.dot}`} />
      <span className={`font-code ${T_META} ${tone.text}`}>{leaseAge(lease.silentMs)}</span>
      {label && (
        <span
          className={`shrink-0 text-[10px] font-semibold uppercase tracking-[0.06em] ${tone.text}`}
        >
          {label}
        </span>
      )}
      <span className="sr-only">{sentence}</span>
    </span>
  );
}

/** The lapsed-lease explainer, for the step-in surfaces — it sits next to the
 *  Release control, because "another agent will take this over" and "you can put
 *  it back in the queue yourself right now" are one decision.
 *
 *  Only for a LAPSED lease. A slipping one is carried by the chip alone: nothing
 *  has happened yet, and a panel that grows a paragraph halfway through every
 *  ordinary long task teaches people to skip paragraphs. */
export function LeaseNotice({
  lease,
  canRelease = false,
  className = "",
}: {
  lease: Lease;
  /** Whether a Release control is adjacent — changes what the last line says. */
  canRelease?: boolean;
  className?: string;
}) {
  if (lease.health !== "stale") return null;
  return (
    <div
      className={`rounded-md border border-amber-500/25 bg-amber-500/[0.07] px-2.5 py-2 ${className}`}
    >
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-700 dark:text-amber-400">
        <Timer size={12} className="shrink-0" aria-hidden="true" />
        Claim lease lapsed — reclaimable
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink/65">
        {lease.holder ?? "The holder"} has not reported for{" "}
        <span className="font-code">{leaseAge(lease.silentMs)}</span>, so the next agent that asks
        for this task takes it over.{" "}
        {canRelease
          ? "Release puts it back in the queue now, under nobody's name."
          : "A human can release it from the board to put it back in the queue now."}
      </p>
      {lease.unextendable && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink/55">
          It is still filing reports, but the lease is not moving with them — usually a claim taken
          under the shared <span className="font-code">agent</span> identity, which the server will
          not extend.
        </p>
      )}
    </div>
  );
}

// ── Contention (TDM-100) ─────────────────────────────────────────────────────
// Somebody else went for this task. The claimant chip says who is on it and the
// lease chip says whether they're alive; this says whether anyone else TRIED —
// which is the one thing on a card that shows the coordination protocol doing its
// job rather than just its result.
//
// Hue: NONE. This is the strictest case the closed six-hue rule has produced so
// far. A collision can be recorded on a task in ANY state — a done task that was
// raced for while it ran keeps its trail — so the card's attention hue (amber) is
// unavailable: amber already means "needs approval" on proposed cards and "lease
// lapsed" on executing ones, and a third meaning that can appear on either would
// make it mean nothing. So the marker is a RECORD fact in dim ink, exactly like
// ProvenanceChip, and does its shouting through the glyph and the count.
//
// The two kinds are told apart by weight rather than colour, because they are not
// equally interesting. A lost claim is routine — an agent asked, was told no, went
// elsewhere; it reads at record weight. A fenced write is a near miss — a worker
// came back after its lease lapsed and tried to finish work that had moved on —
// and it gets a filled well and firmer ink, the same "this one is different"
// treatment the lease chip gives a lapsed lease without borrowing a hue for it.
export function ContentionMark({
  tally,
  events,
  className = "",
}: {
  tally: ContentionTally;
  /** The trail itself — only for the sentence, which names who collided. */
  events: Parameters<typeof contentionSentence>[0];
  className?: string;
}) {
  const label = contentionLabel(tally);
  if (!label) return null;
  const fenced = tally.fenced > 0;
  const sentence = contentionSentence(events);
  const Glyph = fenced ? Shield : Users;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-[4px] ${
        fenced ? "bg-ink/[0.06] px-1 py-px text-ink/70" : "text-ink/45"
      } ${T_META} ${className}`}
      title={sentence}
    >
      <Glyph size={10} className="shrink-0" aria-hidden="true" />
      <span className={fenced ? "font-medium" : undefined}>{label}</span>
      <span className="sr-only">{sentence}</span>
    </span>
  );
}

/** The card-level form: reads the trail off the action itself, so a caller that
 *  has an Action in hand needs one line and cannot get the tally out of step with
 *  the sentence. */
export function TaskContentionMark({
  action,
  className = "",
}: {
  action: Action;
  className?: string;
}) {
  const events = (action.payload as TaskPayload | undefined)?.contention ?? [];
  return <ContentionMark tally={tallyContention(events)} events={events} className={className} />;
}

// Provenance (TDM-40): who the SERVER concluded wrote this, next to `proposedBy`
// — which is only what the caller called itself.
//
// This is the quietest mark on a card, on purpose. The six semantic hues belong
// to STATE; authorship is a record fact, so it sits in dim ink alongside the age
// readout with no fill and no border. The agent case is the only one that spends
// width on a label, because it's the only one carrying something the glyph can't
// say: WHICH agent. human and anonymous are one bit each — glyph plus a title,
// with the bit preserved for screen readers via aria-label.
//
// No provenance at all renders NOTHING. A row that predates migration 0039 is
// genuinely unknown, and an "unknown" chip on every old task would be noise
// standing in for information.
export function ProvenanceChip({
  authoredBy,
  verbose = false,
  className = "",
}: {
  authoredBy?: string;
  /** Detail-panel mode: spell the authorship out instead of leaning on a glyph. */
  verbose?: boolean;
  className?: string;
}) {
  const p = parseAuthoredBy(authoredBy);
  if (!p) return null;

  // Verbose lives in the detail footer, a strip of plain-text facts ("proposed
  // by …", "created 2h ago") that already opens with a Bot glyph. A second glyph
  // there is an accessory, not information — the words do the work instead.
  if (verbose) {
    return (
      <span className={`text-[11px] text-ink/50 ${className}`} title={provenanceTitle(p)}>
        authored by {p.label}
      </span>
    );
  }

  const Glyph = p.kind === "agent" ? Bot : p.kind === "human" ? PenLine : CircleDashed;
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 text-ink/45 ${T_META} ${className}`}
      title={provenanceTitle(p)}
      aria-label={`Authored by ${p.label}`}
    >
      <Glyph size={10} className="shrink-0" aria-hidden="true" />
      {/* Only the agent case spends width on a label — it's the only one whose
          glyph leaves a real question ("which agent?") unanswered. */}
      {p.kind === "agent" && <span className="max-w-[7rem] truncate">{p.label}</span>}
    </span>
  );
}

// Approval provenance (TDM-147): WHICH GATE this task passed.
//
// Since TDM-145 "approved" is no longer one thing — under the canvas 'peer'
// policy a registered agent can approve a task another agent proposed, and two
// more rows never passed a gate at all (born approved by policy). Rendering all
// of those identically would quietly devalue the one approval that cost a
// person's attention, so each kind gets its own glyph and its own weight.
//
// Hue: NONE, same rule as ProvenanceChip and ContentionMark. The six semantic
// hues belong to STATE and amber is spoken for by re-approval; an approval stamp
// is a record fact, so the distinction is carried by GLYPH and WEIGHT:
//
//   human     Check, firmer ink, NO label — an unqualified approval is a
//             person's, and it is the only kind that needs no qualifier. That
//             absence is what makes it read as the strongest claim.
//   agent     BadgeCheck + the agent's own name. Dim, like every other record
//             fact: on a peer canvas this is the NORMAL path and a card that
//             shouted would be shouting all day. The name is the information —
//             "approved" you already knew from the column.
//   auto      Zap + "auto" — born approved, nobody looked.
//   legacy    the raw stamp, verbatim, because we can't say what it meant.
//
// The 'epic' policy stamp renders NOTHING here. It is the canvas DEFAULT, its
// card already carries the epic chip that explains it, and a badge on every card
// on every default board would be noise standing in for information. It is spelt
// out in full in the detail panel and on the ticket page, where there is room.
export function ApprovalMark({
  approvedBy,
  className = "",
}: {
  approvedBy?: string;
  className?: string;
}) {
  const a = parseApproval(approvedBy);
  if (!a || a.kind === "epic") return null;

  const Glyph = approvalGlyph(a);
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 ${
        a.byHuman ? "font-medium text-ink/60" : "text-ink/45"
      } ${T_META} ${className}`}
      title={a.title}
      aria-label={`Approved by ${a.phrase}`}
    >
      <Glyph size={10} className="shrink-0" aria-hidden="true" />
      {/* Tighter than ProvenanceChip's 7rem on purpose: on a peer canvas a card
          can carry BOTH names (agent wrote it, agent passed it) and the record
          group does not shrink — the second name is the one that yields. The
          full identity is in the title and on the ticket page. */}
      {a.label && <span className="max-w-[5rem] truncate">{a.label}</span>}
    </span>
  );
}

function approvalGlyph(a: Approval) {
  switch (a.kind) {
    case "human":
      return Check;
    case "agent":
      return BadgeCheck;
    case "auto":
      return Zap;
    case "epic":
      return Layers;
    default:
      return CircleDashed;
  }
}

/** Sentence form for the detail panel and the ticket page: the same four facts,
 *  spelt out, where there is room to say them. */
export function ApprovalLine({
  approvedBy,
  /** False under a field already labelled "Approved by", where the prefix would
   *  say it twice. */
  prefix = true,
  className = "",
}: {
  approvedBy?: string;
  prefix?: boolean;
  className?: string;
}) {
  const a = parseApproval(approvedBy);
  if (!a) return null;
  const Glyph = approvalGlyph(a);
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 ${
        a.byHuman ? "text-ink/65" : "text-ink/50"
      } ${className}`}
      title={a.title}
    >
      <Glyph size={11} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        {prefix ? "approved by " : ""}
        {a.phrase}
      </span>
    </span>
  );
}

// Re-approval surfacing (TDM-41): this proposed task is NOT new — it was
// approved once, its title or body was rewritten, and the approval was
// withdrawn. The state chip already moved the card; what it can't say is that
// you have read this task before and it has since changed.
//
// Amber, and amber only here. The board's six semantic hues belong to STATE,
// and provenance sits in dim ink as a record fact — this is neither. It is the
// one thing on a Proposed card that should pull the eye first, so it gets the
// board's only unclaimed attention hue and nothing else does.

// Card form: one line, glyph plus three words, above the record-metadata row so
// it doesn't compete with the epic chip and the provenance group.
function ReapprovalMark({ edit }: { edit: ContentAuditEntry }) {
  return (
    <div
      className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-amber-600 dark:text-amber-400 sm:text-[10.5px]"
      title={`${auditActorLabel(edit.actor)} changed the ${auditChangeLabel(edit.change)} after this was approved, so it went back for approval. ${edit.summary}`}
    >
      <RotateCcw size={10} className="shrink-0" aria-hidden="true" />
      edited after approval
    </div>
  );
}

// Detail form: the facts, then the diff hint the server recorded. The hint is
// the reason this exists — at the moment of deciding whether to approve again,
// seeing exactly what moved beats any amount of prose about it. Rendered in the
// code face with the arrow intact, because it is a quotation, not a sentence.
function ReapprovalNotice({ edit }: { edit: ContentAuditEntry }) {
  return (
    <div className="mt-3 rounded-md border border-amber-500/25 bg-amber-500/[0.07] px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-700 dark:text-amber-400">
        <RotateCcw size={12} className="shrink-0" aria-hidden="true" />
        Edited after approval — needs re-approval
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink/65">
        {auditActorLabel(edit.actor)} changed the {auditChangeLabel(edit.change)}{" "}
        <span title={fullDate(edit.at)}>{ageOf(edit.at)} ago</span>, so the task went back to
        proposed and its claim was released. Read it again before approving.
      </p>
      {edit.summary && (
        <p className="mt-1.5 overflow-x-auto whitespace-pre font-code text-[10.5px] leading-relaxed text-ink/55">
          {edit.summary}
        </p>
      )}
    </div>
  );
}

// Hand-moves (TDM-97). The server records every move a PERSON makes on the
// board — Start, Mark done, Release, Re-queue, Reopen, Reconsider — and an
// agent's own transitions record nothing, so this mark appearing at all is
// exactly the fact "a human put this card where it is". On a Done card that is
// the difference between work an agent finished and work someone ticked off,
// which nothing else on the card can say once the claimant chip has gone.
//
// Record weight in dim ink, never the attention hue: a move costs no approval,
// and the column the card is sitting in already says where the work ended up.
// The tooltip carries the rest — the exact from→to, when, and any note typed at
// the moment of the move; the full trail is on the ticket page.
function MoveMark({ move }: { move: ContentAuditEntry }) {
  const note = stateMoveNote(move);
  const who = auditActorLabel(move.actor);
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 text-ink/45 ${T_META}`}
      title={`${who} ${moveVerbLabel(move)} ${ageOf(move.at)} ago (${move.fromState} → ${move.toState})${note ? ` — ${note}` : ""}`}
    >
      <ArrowRight size={9} className="shrink-0" aria-hidden="true" />
      <span className="truncate">
        {moveVerbShort(move)} by {who}
      </span>
    </span>
  );
}

/* ── The triage controls (TDM-160) ───────────────────────────────────────────
   The three verbs a person needs at the plan gate, on ONE row of a proposed
   card: approve it, reject it, or amend it. All three are inline — leaving the
   list to make a decision is what turns an eleven-ticket epic into a desktop
   chore, and the gate has to survive being worked one-handed on a phone.

   REJECT COSTS EXACTLY WHAT APPROVE COSTS. It used to be two taps (Reject →
   Confirm reject) against approve's one, which is not a neutral gate: the
   cheaper button wins, and a board where every ticket gets approved is a board
   with no gate on it. So on a TASK reject fires on the first tap and the board
   arms an Undo strip (rejected → proposed is a legal move — lib/taskMoves'
   RECONSIDER), which is the same safety at equal cost. Same geometry, same tap
   count, and reject carries its own rose so it reads as a real decision rather
   than as the Cancel of the pair.

   EPICS KEEP THE CONFIRM (`confirmReject`). Rejecting an epic archives a whole
   batch, and the undo for that is not one move — the asymmetry there is
   earned. Neither path takes a reason; the detail panel keeps the long form.

   stopPropagation so the card's click-through to the detail panel doesn't fire
   underneath the buttons. */
function TriageControls({
  busy,
  rejecting,
  approveLabel = "Approve",
  confirmReject = false,
  onApprove,
  onReject,
  onAmend,
  setRejecting,
}: {
  busy: boolean;
  rejecting: boolean;
  approveLabel?: string;
  /** Two-step reject (epics). Tasks reject on the first tap and offer Undo. */
  confirmReject?: boolean;
  onApprove: () => void;
  onReject: () => void;
  /** Opens the in-place editor. Omitted where amending makes no sense (epics). */
  onAmend?: () => void;
  setRejecting: (v: boolean) => void;
}) {
  return (
    <div className="mt-2 flex gap-1.5" onClick={(e) => e.stopPropagation()}>
      {rejecting ? (
        <>
          <button
            onClick={onReject}
            disabled={busy}
            className={`flex-1 rounded-md bg-rose-600 px-2 py-1 font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-40 ${T_BTN} ${TAP}`}
          >
            Confirm reject
          </button>
          <button
            onClick={() => setRejecting(false)}
            className={`rounded-md border border-ink/15 px-2 py-1 font-medium text-ink/60 transition-colors hover:border-ink/30 ${T_BTN} ${TAP}`}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            onClick={onApprove}
            disabled={busy}
            className={`flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2 py-1 font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${T_BTN} ${TAP}`}
          >
            <Check size={12} /> {approveLabel}
          </button>
          <button
            onClick={() => (confirmReject ? setRejecting(true) : onReject())}
            disabled={busy}
            title={confirmReject ? undefined : "Reject this ticket — you can undo it"}
            className={`flex flex-1 items-center justify-center gap-1 rounded-md border border-rose-500/30 px-2 py-1 font-medium text-rose-600 transition-colors hover:border-rose-500/60 hover:bg-rose-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 disabled:opacity-40 dark:text-rose-400 ${T_BTN} ${TAP}`}
          >
            <X size={12} /> Reject
          </button>
          {onAmend && (
            <button
              onClick={onAmend}
              disabled={busy}
              title="Amend this ticket — fix the title or body without leaving the list"
              aria-label="Amend this ticket"
              className={`flex shrink-0 items-center justify-center rounded-md border border-ink/15 px-2 py-1 text-ink/55 transition-colors hover:border-ink/30 hover:text-ink/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${T_BTN} ${TAP}`}
            >
              <Pencil size={12} />
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* Amend a proposed ticket IN PLACE (TDM-160) — the third triage verb, and the
   one the gate was missing. "Right idea, wrong scope" is the commonest verdict
   on a generated plan, and until now the only ways to act on it were approve
   (let a too-broad ticket run) or reject (throw away a good idea). Sending the
   person through the detail slide-over for a one-line fix is what made
   widening ticket 7 cost more than approving all eleven.

   Title and body only: everything else on a proposed ticket is the proposer's
   to state. The payload ROUND-TRIPS WHOLE — a PATCH replaces the payload, so
   spreading the stored one is what keeps epicId, linkedIds and requiresApproval
   from silently vanishing (same rule as TaskDetail's draftFrom).

   Drafts live here rather than on the board so they die with the editor; the
   caller keys this on the action id, so opening a different ticket remounts it
   with that ticket's text instead of the previous one's. */
function InlineAmend({
  action,
  busy,
  onSave,
  onCancel,
}: {
  action: Action;
  busy: boolean;
  onSave: (title: string, body: string) => void;
  onCancel: () => void;
}) {
  const p = taskPayload(action);
  const [title, setTitle] = useState(p.title ?? "");
  const [body, setBody] = useState(p.body ?? "");
  const changed = title.trim() !== (p.title ?? "").trim() || body.trim() !== (p.body ?? "").trim();
  const canSave = !busy && title.trim().length > 0 && changed;
  const field =
    "w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5 text-ink placeholder:text-ink/35 focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/20";
  // Cmd/Ctrl+Enter saves and Escape backs out, so amending never needs a second
  // hand on a phone keyboard — and Enter inside the body stays a newline.
  function keys(e: ReactKeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSave) {
      e.preventDefault();
      onSave(title, body);
    }
  }
  return (
    <div
      className="mt-2 flex flex-col gap-1.5"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={keys}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Ticket title"
        aria-label="Ticket title"
        className={`${field} font-semibold ${T_TITLE}`}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="What this ticket covers (optional)"
        aria-label="Ticket body"
        className={`${field} resize-y leading-relaxed ${T_BTN}`}
      />
      <div className="flex gap-1.5">
        <button
          onClick={() => onSave(title, body)}
          disabled={!canSave}
          className={`flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2 py-1 font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${T_BTN} ${TAP}`}
        >
          <Check size={12} /> Save
        </button>
        <button
          onClick={onCancel}
          className={`flex-1 rounded-md border border-ink/15 px-2 py-1 font-medium text-ink/60 transition-colors hover:border-ink/30 ${T_BTN} ${TAP}`}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Human state moves (E10) ──────────────────────────────────────────────────
// The board used to be a VIEWER for agent work: cards moved when a session
// claimed one and again when it reported back, and a person's own todo sitting
// in Ready had no control on it at all. These render the moves in
// lib/taskMoves — one glyph per destination, so a move reads the same on a card
// as it does in the detail panel.

function moveIcon(move: HumanMove) {
  if (move.kind === "rewind") return <RotateCcw size={12} />;
  if (move.to === "executing") return <Play size={12} />;
  if (move.to === "failed") return <Ban size={12} />;
  return <Check size={12} />;
}

// Card form: the ONE forward move, quiet, full width. stopPropagation so the
// card's click-through to the detail panel doesn't fire underneath it.
function PrimaryMoveControl({
  move,
  busy,
  onGo,
}: {
  move: HumanMove;
  busy: boolean;
  onGo: () => void;
}) {
  return (
    <div className="mt-2" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={onGo}
        disabled={busy}
        title={move.hint}
        className={`flex w-full items-center justify-center gap-1 rounded-md border border-ink/15 px-2 py-1 font-medium text-ink/70 transition-colors hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${T_BTN} ${TAP}`}
      >
        {moveIcon(move)} {move.label}
      </button>
    </div>
  );
}

// ── Filters ──────────────────────────────────────────────────────────────────

type Filters = {
  state: "all" | ActionState;
  claimant: "all" | string;
  assignee: "all" | "agent" | "human";
  hasCommit: boolean;
};

const NO_FILTERS: Filters = {
  state: "all",
  claimant: "all",
  assignee: "all",
  hasCommit: false,
};

const FILTER_SELECT_CLS =
  "h-9 max-w-[10rem] shrink-0 rounded-md border border-ink/15 bg-surface px-1.5 text-[12px] font-medium text-ink/70 outline-none transition-colors focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-7 sm:text-[11px]";

// The same selects inside the mobile filter sheet: full width, one per row, at a
// real touch height. (index.css forces every select to 16px on coarse-pointer
// phones so focusing one can't auto-zoom the app — hence the generous height.)
const SHEET_SELECT_CLS =
  "h-11 w-full rounded-md border border-ink/15 bg-surface px-2 text-[13px] font-medium text-ink outline-none transition-colors focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40";

// One search hit in the results strip (TDM-144) — an epic to scope to, or a
// task the current scope is hiding. Same quiet chip vocabulary as the epic's
// plan chip in the scope header: these are navigation, not another filter row.
const SEARCH_CHIP =
  "inline-flex min-w-0 shrink items-center gap-1 rounded-[4px] border border-ink/10 bg-ink/[0.03] px-1.5 py-1 text-[11px] text-ink/60 transition-colors hover:border-ink/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:py-px sm:text-[10px]";

export default function TaskBoard({
  code,
  state,
  readOnly,
  focusTaskId,
  onFocusHandled,
  focusEpicId,
  onScopeHandled,
  onOpenConnect,
  onOpenDocuments,
  onOpenRoadmapDoc,
  onOpenTicket,
  spotlightTaskId,
  spotlightNonce,
  active = true,
  onOverlayOpenChange,
}: {
  code: string;
  state: CanvasState;
  readOnly: boolean;
  /** First-run empty state: open the agent connect dialog. */
  onOpenConnect?: () => void;
  /** First-run empty state: switch to the Documents surface. */
  onOpenDocuments?: () => void;
  /** Scoped-epic header's plan chip: open the roadmap document an epic's
      linked goal lives in (switches to the Documents surface). */
  onOpenRoadmapDoc?: (docId: string) => void;
  /** A card's ticket-id chip: open the ticket's own page
      (/c/CODE/ticket/TDM-n). The card body still opens the detail slide-over —
      the chip is the route to the full, linkable view. */
  onOpenTicket?: (ticketId: string) => void;
  // TDM-14 one-shot focus handoff (from the header agent presence): when a
  // task id arrives, scope to its epic, scroll its card into view, open its
  // detail — then hand the token back via onFocusHandled.
  focusTaskId?: string | null;
  onFocusHandled?: () => void;
  // One-shot EPIC-scope handoff (roadmap chip → "open the Board scoped to this
  // epic"): same pattern as focusTaskId, needed because the board stays
  // mounted after first visit so a localStorage write alone never re-scopes.
  focusEpicId?: string | null;
  onScopeHandled?: () => void;
  // FOLLOW handoff (App's useFollowMoves): an agent just moved this task between
  // columns and the viewer is following. Unlike focusTaskId this does NOT open
  // the detail panel — following is watching, not stepping in — it only makes
  // sure the card is on screen while useCardFlight flies it to its new lane.
  // `spotlightNonce` re-fires the effect for repeat moves of the same task.
  spotlightTaskId?: string | null;
  spotlightNonce?: number;
  /** Whether the Board surface is the one showing. The board stays MOUNTED and
   *  hidden with CSS (keep-alive), and a hidden element measures as a zero rect
   *  — so the flight animation has to re-measure the moment it comes back. */
  active?: boolean;
  /** TDM-135: reports whether a mobile sheet/modal (filter sheet, epic sheet,
   *  detail slide-over) is open over the board. App hides the nav FAB while it
   *  is — the FAB is a fixed z-30 sibling of the board's `relative isolate`
   *  container, so the isolate cages these overlays BELOW it and it steals taps
   *  from their bottom-right CTAs. */
  onOverlayOpenChange?: (open: boolean) => void;
}) {
  // Sidebar scope — raw as stored; validated against the live epic set below.
  const [scope, setScope] = useState<string>(() => {
    try {
      return localStorage.getItem(SCOPE_KEY) ?? "all";
    } catch {
      return "all";
    }
  });
  // Mobile only — on md+ the sidebar is always visible.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // ── Mobile lane selection (TDM-86) ────────────────────────────────────────
  // Below md the kanban shows ONE lane at a time, full width, with a switcher
  // above it. Five 17rem columns in a horizontal scroller meant a 390px phone
  // saw one and a half of them, every card clipped at the right edge — and a
  // scroll container wider than the viewport is also what triggered iOS font
  // boosting (TDM-85). md+ still renders all five side by side, unchanged.
  //
  // null = "nobody has chosen yet", which resolves to the first lane that has
  // cards (see activeCol) so an unopened board never lands on an empty lane. An
  // explicit tap pins the choice: silently moving someone off the lane they
  // picked because its last card completed is worse than an empty lane with a
  // switcher one tap away.
  const [mobileCol, setMobileCol] = useState<string | null>(null);
  // Done-bucket expansion (finished + rejected epics) — persisted preference.
  const [doneOpen, setDoneOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DONE_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  // The card the follow camera just brought us to (see the spotlight effect).
  const [spotlightGlow, setSpotlightGlow] = useState<{ id: string; nonce: number } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  // The proposed ticket being amended in place (TDM-160) — at most one at a
  // time, so a half-finished edit can never be left behind on a card scrolled
  // off screen.
  const [amendingId, setAmendingId] = useState<string | null>(null);
  // The last rejection, offering Undo (TDM-160, widened to a LIST by TDM-164).
  // Rejecting is a single tap precisely BECAUSE this exists; if you remove the
  // strip, put the confirm back or the gate stops being reversible. A bulk
  // reject arms the same strip with every id it rejected, so "reject three,
  // change your mind" is one Undo rather than three.
  const [undoReject, setUndoReject] = useState<{ ids: string[]; label: string } | null>(null);

  /* ── Multi-select triage (TDM-164) ─────────────────────────────────────────
     Approving eleven tickets except three used to cost eleven decisions' worth
     of clicking, which is how a gate becomes a rubber stamp: the value is
     decided per PLAN but the cost is paid per TICKET. So the Proposed lane
     takes a selection, and approve / reject act on all of it at once.

     THE SELECTION IS A SET OF IDS, AND NOTHING ELSE. This board takes live
     websocket pushes — cards arrive, get claimed, and leave the lane while you
     are still deciding — so any selection keyed by index, by position, or
     rebuilt from the incoming payload would silently shift onto the wrong
     tickets on the next broadcast. That failure is worse than having no
     multi-select at all (you would approve something you never looked at), so
     this state is deliberately NOT derived from `state.actions`: a push
     re-renders the lanes and leaves the set untouched.

     Two rules keep the set honest against that live board, both below:
       · `selectedIds` is the set INTERSECTED with the proposed lane as
         currently rendered — the writes only ever touch tickets that are on
         screen and still awaiting a decision.
       · a prune effect drops ids that stopped being proposed tasks at all
         (someone else approved them, an agent's epic got rejected, the ticket
         was deleted), so a selection cannot accumulate ghosts.

     A scope change clears the selection: navigating to another epic is a
     deliberate change of subject, and carrying a selection you can no longer
     see into it is how you approve the wrong batch. A websocket push is not. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // Tap-to-select mode. Shift-click has no touch equivalent, so a phone gets an
  // explicit mode (the Proposed lane header's "Select"): while it is on, a tap
  // on a proposed card selects instead of opening the detail slide-over. It is
  // also what keeps the bulk bar up after you deselect the last ticket, so
  // "clear and start again" doesn't drop you out of triage.
  const [selectMode, setSelectMode] = useState(false);
  // Where a range gesture measures FROM, plus the selection as it stood when
  // that anchor was set. Range gestures recompute `base ∪ range(anchor→here)`
  // rather than accumulating, which is what lets shift-arrow SHRINK a range
  // back down instead of only ever growing it.
  const [anchor, setAnchor] = useState<{ id: string; base: string[] } | null>(null);
  // The shared reason for a bulk reject: null = the panel is closed, "" = open
  // and empty. Asked ONCE for the whole selection — a reason per ticket is the
  // per-ticket cost this whole feature exists to remove, and the tickets in one
  // selection are almost always being turned down for one reason.
  const [bulkReason, setBulkReason] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  // Whether the scoped epic's finished-ticket rollup is expanded (TDM-93).
  // Collapsed by default: the summary above it is the answer, and the receipts
  // are for when you want to check it.
  const [achievedOpen, setAchievedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The "New task" composer (toolbar button / empty-state CTA) — humans author
  // tasks HERE; the Board is the one home for task work.
  const [composing, setComposing] = useState(false);
  // One in-flight "Approve all" batch (the Proposed column header button).
  const [batchBusy, setBatchBusy] = useState(false);

  // Filter state — deliberately not persisted; every visit starts unfiltered.
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState(""); // debounced, lowercased
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const searchRef = useRef<HTMLInputElement>(null);
  // The lease clock (TDM-101). Claim leases are derived from `now`, and the whole
  // point is the case where NOTHING arrives over the socket — a worker that went
  // dark pushes no state, so without a moving clock its heartbeat age would
  // freeze at whatever it read when the last push landed, which is precisely the
  // stall we are trying to show. One re-render a minute (the finest granularity
  // any age here prints), shared with the rest of the app's relative-time
  // treatment via useFreshnessNow.
  const now = useFreshnessNow();
  // Mobile filter sheet (TDM-88). Search stays inline at every width — it is the
  // filter people reach for — but the four chip filters were a horizontally
  // scrolling row that simply ran off a 390px screen ("Any claimant" clipped
  // mid-word), i.e. controls that existed but could not be seen. Below md they
  // live behind ONE affordance carrying the active count; md+ keeps the inline
  // row exactly as it was.
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(searchInput.trim().toLowerCase()), 150);
    return () => clearTimeout(t);
  }, [searchInput]);

  const filtering =
    query !== "" ||
    filters.state !== "all" ||
    filters.claimant !== "all" ||
    filters.assignee !== "all" ||
    filters.hasCommit;

  // How many of the COLLAPSED filters are on — the badge on the mobile
  // affordance. Search is deliberately excluded: it stays inline, so its state
  // is already visible and counting it would double-report.
  const activeFilterCount =
    (filters.state !== "all" ? 1 : 0) +
    (filters.claimant !== "all" ? 1 : 0) +
    (filters.assignee !== "all" ? 1 : 0) +
    (filters.hasCommit ? 1 : 0);

  function clearFilters() {
    clearSearch();
    setFilters(NO_FILTERS);
  }

  // Just the query — used when a search result has been ACTED on (jumped to an
  // epic), where the text has done its job but the chips on screen have not.
  function clearSearch() {
    setSearchInput("");
    setQuery("");
  }

  // Each filter's options, shared by the md+ inline row and the mobile sheet, so
  // the two presentations cannot drift into offering different choices.
  const stateOptions = (
    <>
      <option value="all">All states</option>
      {Object.entries(STATE_CHIP).map(([k, v]) => (
        <option key={k} value={k}>
          {v.label}
        </option>
      ))}
    </>
  );
  const assigneeOptions = (
    <>
      <option value="all">Anyone's</option>
      <option value="agent">Agent tasks</option>
      <option value="human">Your todos</option>
    </>
  );

  function toggleDoneOpen() {
    setDoneOpen((v) => {
      try {
        localStorage.setItem(DONE_OPEN_KEY, v ? "0" : "1");
      } catch {
        /* preference only */
      }
      return !v;
    });
  }

  function selectScope(s: string) {
    setScope(s);
    setSidebarOpen(false); // mobile: picking a scope dismisses the drawer
    // Scoping to an AGED epic (finished/rejected — filed in the Done bucket)
    // must reveal its sidebar entry: without this the selection highlights
    // nothing and the board looks scoped to a ghost (QA wave-3 finding 5).
    if (s !== "all" && s !== "none") {
      const epic = (state.actions ?? {})[s];
      if (epic && epic.type === "epic") {
        const own = Object.values(state.actions ?? {}).filter(
          (a) => a.type === "task" && taskPayload(a).epicId === s,
        );
        if (epicLifecycle(epic, own) !== "active") {
          setDoneOpen(true);
          try {
            localStorage.setItem(DONE_OPEN_KEY, "1");
          } catch {
            /* preference only */
          }
        }
      }
    }
    try {
      localStorage.setItem(SCOPE_KEY, s);
    } catch {
      /* preference only */
    }
  }

  const tasks = useMemo(
    () =>
      Object.values(state.actions ?? {})
        .filter((a) => a.type === "task")
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [state.actions],
  );
  // Creation order, OLDEST first — the sidebar timeline reads as the
  // project's sequence, top to bottom.
  const epics = useMemo(
    () =>
      Object.values(state.actions ?? {})
        .filter((a) => a.type === "epic")
        .sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1)),
    [state.actions],
  );
  const epicIds = useMemo(() => new Set(epics.map((e) => e.id)), [epics]);
  const epicTitleById = useMemo(
    () => new Map(epics.map((e) => [e.id, epicPayload(e).title || "Untitled epic"])),
    [epics],
  );
  // Epics are the bridge between the plans and the queue: an epic that links a
  // roadmap goal (payload.linkedIds, TDM-10) belongs to that goal's roadmap
  // DOCUMENT — one plan per stream, one Board running them all. Attribution is
  // best-effort: the first linked id that still resolves to a roadmap item
  // whose document still exists wins; dangling ids (deleted goals, deleted
  // docs) are skipped, and an epic with nothing resolvable stays unlinked.
  const epicPlan = useMemo(() => {
    const m = new Map<string, { goalTitle: string; docId: string; docName: string }>();
    for (const e of epics) {
      for (const id of epicPayload(e).linkedIds ?? []) {
        const item = (state.roadmapItems ?? {})[id];
        if (!item) continue;
        const doc = (state.documents ?? {})[item.documentId ?? ""];
        if (!doc) continue;
        m.set(e.id, {
          goalTitle: item.title || "Untitled goal",
          docId: doc.id,
          docName: doc.name || "Roadmap",
        });
        break;
      }
    }
    return m;
  }, [epics, state.roadmapItems, state.documents]);
  // Everyone who has ever held a claim — done/failed rows keep claimed_by, so
  // this doubles as the "browse one agent's history" axis.
  const claimants = useMemo(() => {
    const s = new Set<string>();
    for (const t of tasks) if (t.claimedBy) s.add(t.claimedBy);
    return [...s].sort();
  }, [tasks]);
  // Shared by the inline row and the mobile filter sheet (see stateOptions).
  const claimantOptions = (
    <>
      <option value="all">Any claimant</option>
      {claimants.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </>
  );

  // Every task grouped under its (valid) epic — unfiltered, feeds the sidebar
  // progress bars and the scoped kanban alike.
  const tasksByEpic = useMemo(() => {
    const m = new Map<string, Action[]>();
    for (const t of tasks) {
      const eid = taskPayload(t).epicId;
      if (eid && epicIds.has(eid)) m.set(eid, [...(m.get(eid) ?? []), t]);
    }
    return m;
  }, [tasks, epicIds]);
  // No epic, or a dangling epicId — the "No epic" scope.
  const epiclessAll = useMemo(
    () =>
      tasks.filter((t) => {
        const eid = taskPayload(t).epicId;
        return !eid || !epicIds.has(eid);
      }),
    [tasks, epicIds],
  );

  // The stored scope may point at an epic that no longer exists — fall back to
  // All tasks. Derived (not an effect) so a state push that still holds the
  // epic recovers the selection instead of clobbering it.
  const effectiveScope =
    scope === "all" || scope === "none" || epicIds.has(scope) ? scope : "all";
  const scopedEpic =
    effectiveScope !== "all" && effectiveScope !== "none"
      ? epics.find((e) => e.id === effectiveScope)
      : undefined;
  // What the mobile epic affordance says. Unscoped it names the CONTROL
  // ("Epics") rather than the scope, because an unscoped board is the first-run
  // state and a first-time user needs to be told the control exists before they
  // need to be told what it is set to. Once scoped it names the scope.
  const scopeLabel = scopedEpic
    ? epicPayload(scopedEpic).title || "Untitled epic"
    : effectiveScope === "none"
      ? "No epic"
      : "Epics";

  const scopedTasks = useMemo(() => {
    if (effectiveScope === "none") return epiclessAll;
    if (scopedEpic) return tasksByEpic.get(scopedEpic.id) ?? [];
    return tasks;
  }, [effectiveScope, scopedEpic, tasks, epiclessAll, tasksByEpic]);

  // ── Epic age-out (TDM-9) ────────────────────────────────────────────────────
  // Finished (approved + ≥1 task, all terminal) and rejected epics leave the
  // timeline and file into a collapsed "Done" bucket at the bottom. No
  // rug-pull: an epic that finishes WHILE it is the selected scope stays
  // pinned in its timeline slot for the rest of the session — it files under
  // Done on the next visit. Pure derived state; pin held via functional update.
  const [pinnedActiveId, setPinnedActiveId] = useState<string | null>(null);
  useEffect(() => {
    const lc = scopedEpic
      ? epicLifecycle(scopedEpic, tasksByEpic.get(scopedEpic.id) ?? [])
      : null;
    setPinnedActiveId((prev) => {
      if (scopedEpic && lc === "active") return scopedEpic.id; // viewing an active epic — pin it
      if (scopedEpic && prev === scopedEpic.id) return prev; // it finished under us — hold
      return null; // navigated away (or no epic scope) — release
    });
  }, [scopedEpic, tasksByEpic]);

  const { activeEpics, agedEpics } = useMemo(() => {
    const act: Action[] = [];
    const aged: Action[] = [];
    for (const e of epics) {
      const lc = epicLifecycle(e, tasksByEpic.get(e.id) ?? []);
      if (lc === "active" || e.id === pinnedActiveId) act.push(e);
      else aged.push(e);
    }
    return { activeEpics: act, agedEpics: aged };
  }, [epics, tasksByEpic, pinnedActiveId]);

  // Sidebar grouping: the ACTIVE timeline splits into one group per roadmap
  // document with linked epics (plans, in the docs' sortOrder) plus the
  // unlinked rest. Age-out wins — a finished epic files under the Done bucket,
  // never under its plan. A canvas with no plan-linked epics gets zero groups
  // and renders the flat timeline exactly as before.
  const planGroups = useMemo(() => {
    const byDoc = new Map<string, Action[]>();
    const unlinked: Action[] = [];
    for (const e of activeEpics) {
      const plan = epicPlan.get(e.id);
      if (plan) byDoc.set(plan.docId, [...(byDoc.get(plan.docId) ?? []), e]);
      else unlinked.push(e);
    }
    const groups = [...byDoc.entries()]
      .map(([docId, list]) => {
        const doc = (state.documents ?? {})[docId];
        return { docId, name: doc?.name || "Roadmap", sortOrder: doc?.sortOrder ?? 0, list };
      })
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return { groups, unlinked };
  }, [activeEpics, epicPlan, state.documents]);

  // The typed query, parsed once (null when the box is empty). Declared here
  // rather than with the hit memos below because taskMatches reads it.
  const searchQuery = useMemo(() => parseSearch(query), [query]);

  // One predicate, AND-composed — applied WITHIN the selected scope.
  function taskMatches(t: Action): boolean {
    const p = taskPayload(t);
    if (searchQuery && scoreTask(searchQuery, t) === 0) return false;
    if (filters.state !== "all" && t.state !== filters.state) return false;
    if (filters.claimant !== "all" && t.claimedBy !== filters.claimant) return false;
    if (filters.assignee !== "all" && (p.assignee ?? "agent") !== filters.assignee) return false;
    if (filters.hasCommit && extractCommits(t.result).length === 0) return false;
    return true;
  }

  const visibleTasks = useMemo(
    () => (filtering ? scopedTasks.filter(taskMatches) : scopedTasks),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopedTasks, filtering, query, filters],
  );

  // ── What search found that the kanban is not showing (TDM-144) ─────────────
  // The lanes below render the in-scope task hits, as they always did. These
  // three are everything else the query resolved: the ticket it addresses, the
  // epics it names, and the tasks the current scope is hiding.

  // The task the query ADDRESSES. Not a ranked hit — an exact one, canvas-wide,
  // which is why it ignores the scope AND the chip filters: you did not type a
  // ticket number to be told a state filter disagrees with it.
  const ticketHit = useMemo(() => {
    const ref = searchQuery?.ticket;
    if (!ref) return null;
    return tasks.find((t) => t.ticketId?.toUpperCase() === ref) ?? null;
  }, [tasks, searchQuery]);

  // Epics matching the query, best rule first. Their own result group because an
  // epic is a DESTINATION (it scopes the board), not a card in a lane.
  const epicHits = useMemo(() => {
    if (!searchQuery) return [];
    return epics
      .map((e) => ({ e, score: scoreEpic(searchQuery, e) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.e);
  }, [epics, searchQuery]);

  // Matches the current scope CANNOT show. Without these, searching inside one
  // epic can never find anything outside it — and fails silently, which reads
  // as "no such task" rather than "not here". Same AND-composed predicate as
  // the lanes, so a chip filter still means what it says.
  const outOfScopeHits = useMemo(() => {
    if (!searchQuery || effectiveScope === "all") return [];
    const inScope = new Set(scopedTasks.map((t) => t.id));
    return tasks
      .filter((t) => !inScope.has(t.id) && t.id !== ticketHit?.id && taskMatches(t))
      .sort((a, b) => scoreTask(searchQuery, b) - scoreTask(searchQuery, a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, scopedTasks, effectiveScope, searchQuery, filters, ticketHit]);

  // One bucket per lane, computed once: the mobile switcher needs every lane's
  // counts before any lane renders, and the lanes themselves need the same
  // lists. `all` is the lane within the scope; `shown` is what survives the
  // filters (identical when nothing is filtered).
  const columnBuckets = useMemo(
    () =>
      COLUMNS.map((col) => {
        const all = scopedTasks.filter((t) => col.states.includes(t.state));
        return {
          col,
          all,
          shown: filtering ? visibleTasks.filter((t) => col.states.includes(t.state)) : all,
        };
      }),
    [scopedTasks, visibleTasks, filtering],
  );

  // ── The selection, reconciled against the live lane (TDM-164) ─────────────
  // The proposed lane in DISPLAY ORDER: the axis every range gesture runs along
  // (shift-click, shift-arrow) and the universe "select all" selects. It is the
  // filtered list, so a selection can never reach a card the person cannot see
  // — narrowing the filters visibly narrows what Approve/Reject will touch,
  // rather than acting on hidden tickets.
  const proposedOrder = useMemo(
    () => (columnBuckets.find((b) => b.col.key === "proposed")?.shown ?? []).map((t) => t.id),
    [columnBuckets],
  );
  // What the bulk buttons actually write to, in lane order. Intersecting here
  // (rather than mutating the set on every push) is what makes the selection
  // survive live updates: a ticket that leaves the lane under you stops being
  // acted on immediately, while the rest of your selection is undisturbed.
  const selectedIds = useMemo(
    () => proposedOrder.filter((id) => selected.has(id)),
    [proposedOrder, selected],
  );
  // Whether the board is IN triage: the bulk bar is up and a plain click on a
  // proposed card selects rather than opening it.
  const selecting = !readOnly && (selectMode || selected.size > 0);

  // Drop ids that stopped being proposed tasks — approved by someone else,
  // rejected, claimed, deleted. Keyed off the canvas state so it runs on every
  // push, and returns the SAME set when nothing changed so it can't loop.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        const a = (state.actions ?? {})[id];
        if (a && a.type === "task" && a.state === "proposed") next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [state.actions]);

  // Changing the lens is a change of subject — see the note on the state above.
  // Guarded so the mount pass (and any re-run with nothing selected) is a true
  // no-op rather than a fresh empty Set that re-renders the whole board.
  useEffect(() => {
    setSelected((prev) => (prev.size === 0 ? prev : new Set()));
    setSelectMode(false);
    setAnchor(null);
    setBulkReason(null);
  }, [effectiveScope]);

  // How many visible cards are held by a LAPSED lease (TDM-101). The Working
  // lane header wears this, so "something is stuck" is answerable from the lane
  // label without reading a single card — the per-card chips are the detail
  // behind a number you can see from across the room. Recomputed on the lease
  // clock, which is what makes it move on its own while nothing arrives.
  const stalledCount = useMemo(
    () => visibleTasks.filter((t) => deriveLease(t, now).health === "stale").length,
    [visibleTasks, now],
  );

  // The lane showing on mobile: the explicit choice if there is one, else the
  // first lane with cards, else Proposed (COLUMNS[0]) on a genuinely empty scope.
  const activeCol =
    (mobileCol && COLUMNS.some((c) => c.key === mobileCol) ? mobileCol : null) ??
    columnBuckets.find((b) => b.shown.length > 0)?.col.key ??
    COLUMNS[0].key;

  // Which cards get a LIVE GitHub status (TDM-45).
  //
  // Every card with evidence renders its link chips; only these ask the server
  // what GitHub says about them. The endpoint behind that spends a
  // 60-requests-per-hour budget shared by everyone looking at the deployment,
  // so "resolve all of them" is not an option on a board with a year of done
  // work. The most recently touched few are also the only ones anyone is
  // deciding anything about — older evidence is history, and history is one
  // click away in the detail panel, where the lookup always runs.
  const liveLinkTaskIds = useMemo(() => {
    const withLinks = visibleTasks
      .filter((t) => (taskPayload(t).links ?? []).length > 0)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, LIVE_LINK_CARDS);
    return new Set(withLinks.map((t) => t.id));
  }, [visibleTasks]);

  // Link targets for the composer (roadmap items + notes on this canvas).
  const targets = useMemo(() => linkTargets(state), [state]);

  // Cards that change lane FLY there (lib/useCardFlight): a ghost clone crosses
  // the gap while the real card waits, then wears an arrival ring for a beat.
  // Not gated on following — a board you're looking at should show its own
  // movement whether or not the camera brought you here.
  const kanbanRef = useRef<HTMLDivElement>(null);
  const landed = useCardFlight(kanbanRef, [visibleTasks, effectiveScope, active]);

  // The mobile lane switcher is a scroll strip, so its five pills don't all fit
  // on a 390px screen — and `activeCol` changes on its own when a follow handoff
  // brings an agent's lane forward. Keep the selected pill on screen, or the one
  // control telling you which lane you're looking at is the one scrolled out of
  // sight. Horizontal only: `nearest` in the block axis so this never nudges the
  // page itself.
  const switcherRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    switcherRef.current
      ?.querySelector(`[data-col-key="${activeCol}"]`)
      ?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  }, [activeCol]);

  // Returns whether the write landed, so a caller that only wants to follow up
  // on SUCCESS (arming the reject Undo) doesn't act on a failed one.
  async function run(id: string, fn: () => Promise<void>): Promise<boolean> {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      return false;
    } finally {
      setBusyId(null);
    }
  }

  // ONE approve-batch call for every proposed task in the current scope (the
  // Proposed column header's "Approve all"). No optimistic overlay — the WS
  // broadcast moves the cards, and batchBusy labels the in-flight window.
  async function approveAllProposed(ids: string[]) {
    if (ids.length === 0 || batchBusy || readOnly) return;
    setBatchBusy(true);
    setError(null);
    try {
      const { approved } = await approveBatch(code, ids);
      posthog.capture("agent_tasks_batch_approved", {
        canvas_code: code,
        requested: ids.length,
        approved: approved.length,
        surface: "board",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve tasks");
    } finally {
      setBatchBusy(false);
    }
  }

  /* ── Per-ticket triage (TDM-160) ───────────────────────────────────────────
     The three decisions a person makes at the plan gate, one ticket at a time:
     approve, reject (+ undo), amend. Everything the board renders on a proposed
     card routes through exactly these four functions.

     TDM-164 built the multi-select layer on top of them rather than beside
     them: a selection approves through the existing approveBatch (one request
     for N ids, the same call "Approve all" makes) and rejects through the same
     per-id reject route, fanned out by runBatch — no second write path, and no
     second definition of what rejecting means. The undo strip grew with it,
     from one id to a list, so a bulk reject is undone by the one control that
     made a single reject safe in the first place.

     Note on the epic cascade: approving the epic AFTER partial triage cannot
     resurrect anything decided here. Both server paths (ApproveEpicTasks and
     approve-batch, store/supabase.go) filter on state='proposed', so a rejected
     ticket simply stops matching. There is deliberately no client-side guard —
     duplicating that rule here would just be a second place for it to drift. */

  function approve(a: Action) {
    void run(a.id, async () => {
      await approveAction(code, a.id);
      posthog.capture(a.type === "epic" ? "epic_approved" : "agent_task_approved", {
        canvas_code: code,
        surface: "board",
      });
    });
  }

  // The write itself, id-only: the one place the board rejects anything.
  function rejectOne(id: string) {
    return run(id, async () => {
      await rejectAction(code, id);
      setRejectingId(null);
      posthog.capture("agent_task_rejected", { canvas_code: code, surface: "board" });
    });
  }

  // One tap on a TASK — no confirm, but the strip that arms Undo. The label is
  // captured before the write because the card leaves the Proposed lane the
  // moment the broadcast lands, and "Rejected TDM-163" has to survive that.
  function reject(a: Action) {
    if (a.type === "epic") {
      void run(a.id, async () => {
        await rejectAction(code, a.id);
        setRejectingId(null);
      });
      return;
    }
    const label = a.ticketId || taskPayload(a).title || "that ticket";
    if (amendingId === a.id) setAmendingId(null);
    void rejectOne(a.id).then((ok) => {
      if (ok) setUndoReject({ ids: [a.id], label });
    });
  }

  // rejected → proposed (lib/taskMoves' RECONSIDER), for the one ticket or for
  // the whole batch. Puts the tickets back in triage exactly as they were, NOT
  // back in the queue — undoing a rejection returns a decision to you, it does
  // not make it for you. (The rewind also clears the reason the bulk reject
  // wrote, which is right: a ticket back in triage must not still advertise the
  // verdict that was just taken back.)
  function undoLastReject() {
    const target = undoReject;
    if (!target || batchBusy) return;
    setBatchBusy(true);
    setError(null);
    void runBatch(target.ids, (id) => moveTask(code, id, "proposed").then(() => undefined)).then(
      (back) => {
        setBatchBusy(false);
        setUndoReject(null);
        if (back.length < target.ids.length) {
          setError(`Put ${back.length} of ${target.ids.length} back — the rest could not be undone.`);
        }
        posthog.capture("agent_task_reject_undone", {
          canvas_code: code,
          count: back.length,
          surface: "board",
        });
      },
    );
  }

  // Amend in place. The payload PATCH replaces what's stored, so the whole
  // stored payload rides along and only title/body change.
  function amend(a: Action, title: string, body: string) {
    const next: TaskPayload = {
      ...taskPayload(a),
      title: title.trim(),
      body: body.trim() || undefined,
    };
    void run(a.id, async () => {
      await updateTask(code, a.id, next);
      setAmendingId(null);
      posthog.capture("agent_task_amended", { canvas_code: code, surface: "board" });
    });
  }

  // The Undo offer is a moment, not a state: it expires on its own so it can't
  // sit on the board offering to undo something you decided a while ago. A
  // BATCH gets longer — eleven tickets took longer to decide on than one, and
  // re-reading what you just turned down is the point of the offer.
  useEffect(() => {
    if (!undoReject) return;
    const t = setTimeout(() => setUndoReject(null), undoReject.ids.length > 1 ? 20_000 : 12_000);
    return () => clearTimeout(t);
  }, [undoReject]);

  /* ── Selection gestures (TDM-164) ──────────────────────────────────────────
     The muscle memory people already have from every file manager and mail
     client: click one, shift-click to extend a range, cmd/ctrl-click to toggle
     one, shift-arrow to grow or shrink it from the keyboard. Nothing here
     writes anything — they only move ids in and out of `selected`. */

  function clearSelection() {
    setSelected(new Set());
    setSelectMode(false);
    setAnchor(null);
    setBulkReason(null);
  }

  // Toggle one, and re-anchor: the ticket you last touched by hand is where the
  // next range measures from, whether you were adding or removing.
  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    setAnchor({ id, base: [...next] });
  }

  // Add one and anchor there. What a range gesture DEGRADES to when it has
  // nowhere to measure from — including the live-board case where the anchor
  // card was approved or claimed out from under the selection between the two
  // clicks. Additive rather than a toggle: "extend to here" must never come out
  // as "deselect here".
  function selectOne(id: string) {
    const next = new Set(selected);
    next.add(id);
    setSelected(next);
    setAnchor({ id, base: [...next] });
  }

  // base ∪ range(anchor → id), recomputed from scratch every time so pulling
  // the range back deselects what it passed over instead of leaving it behind.
  function rangeTo(from: { id: string; base: string[] }, id: string) {
    const i = proposedOrder.indexOf(from.id);
    const j = proposedOrder.indexOf(id);
    if (i < 0 || j < 0) {
      selectOne(id);
      return;
    }
    const [lo, hi] = i <= j ? [i, j] : [j, i];
    const next = new Set(from.base);
    for (let k = lo; k <= hi; k++) next.add(proposedOrder[k]);
    setSelected(next);
  }

  // Shift-click. With no anchor yet it is just a click — extending from nowhere
  // has no meaning, and guessing (the top of the lane?) would select tickets
  // the person never pointed at.
  function extendTo(id: string) {
    if (!anchor) {
      selectOne(id);
      return;
    }
    rangeTo(anchor, id);
  }

  // The inverse of "approve everything except these three": take the lot, then
  // deselect the three. Scoped to an epic, the lane IS that epic's proposed
  // tickets, so this is also the epic-wide select-all.
  function selectAllProposed() {
    setSelected(new Set(proposedOrder));
    setSelectMode(true);
    setAnchor(proposedOrder.length > 0 ? { id: proposedOrder[0], base: proposedOrder } : null);
  }

  // Arrow / shift-arrow from the focused card. Focus IS the cursor — the card
  // the event came from — so repeated shift-arrows measure from the anchor and
  // the range grows and shrinks the way it does in a spreadsheet. Shift-arrow
  // with nothing anchored takes the card you are on with you, which is what
  // "start selecting from here" means.
  function stepSelection(fromId: string, dir: 1 | -1, extend: boolean) {
    const i = proposedOrder.indexOf(fromId);
    if (i < 0) return;
    const j = Math.min(proposedOrder.length - 1, Math.max(0, i + dir));
    const target = proposedOrder[j];
    if (extend) {
      const from = anchor ?? { id: fromId, base: [...new Set([...selected, fromId])] };
      if (!anchor) setAnchor(from);
      rangeTo(from, target);
    } else {
      setAnchor({ id: target, base: [...selected] });
    }
    const el = document.querySelector(`[data-task-id="${CSS.escape(target)}"]`);
    if (el instanceof HTMLElement) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  }

  /* ── Bulk triage writes (TDM-164) ──────────────────────────────────────────
     Both verbs act on `selectedIds` — the selection intersected with the lane
     as rendered — so neither can touch a ticket that moved on while the bar was
     up. Approve is the EXISTING approve-batch endpoint (one request for N ids,
     the same one "Approve all" uses); reject is per-id by necessity, fanned out
     through runBatch, because rejection carries a reason and has no batch
     route. Neither is optimistic: the websocket broadcast moves the cards,
     which is also the confirmation that the writes landed. */

  async function approveSelection() {
    const ids = selectedIds;
    if (ids.length === 0 || batchBusy || readOnly) return;
    setBatchBusy(true);
    setError(null);
    try {
      const { approved } = await approveBatch(code, ids);
      posthog.capture("agent_tasks_batch_approved", {
        canvas_code: code,
        requested: ids.length,
        approved: approved.length,
        surface: "board",
        via: "selection",
      });
      clearSelection();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve tasks");
    } finally {
      setBatchBusy(false);
    }
  }

  async function rejectSelection(reason: string) {
    const ids = selectedIds;
    if (ids.length === 0 || batchBusy || readOnly) return;
    // Read the label BEFORE the writes: the cards leave the Proposed lane as
    // the broadcasts land, and the Undo strip still has to name what it undoes.
    const first = (state.actions ?? {})[ids[0]];
    const oneLabel = first
      ? first.ticketId || taskPayload(first).title || "that ticket"
      : "that ticket";
    const shared = reason.trim();
    setBatchBusy(true);
    setError(null);
    const rejected = await runBatch(ids, (id) => rejectAction(code, id, shared || undefined));
    setBatchBusy(false);
    clearSelection();
    if (rejected.length > 0) {
      setUndoReject({
        ids: rejected,
        label: rejected.length === 1 ? oneLabel : `${rejected.length} tickets`,
      });
      posthog.capture("agent_tasks_batch_rejected", {
        canvas_code: code,
        requested: ids.length,
        rejected: rejected.length,
        with_reason: shared.length > 0,
        surface: "board",
      });
    }
    if (rejected.length < ids.length) {
      setError(
        `Rejected ${rejected.length} of ${ids.length} — the rest had already moved on.`,
      );
    }
  }

  // A human state move from a CARD: no note, no confirm — the whole point is
  // that marking your own todo started or done is one click. The card doesn't
  // move optimistically; the WS broadcast flies it to its new lane, which is
  // also the confirmation that the write landed.
  function moveCard(t: Action, move: HumanMove) {
    void run(t.id, async () => {
      const from = t.state;
      await moveTask(code, t.id, move.to);
      posthog.capture("task_moved", {
        canvas_code: code,
        from,
        to: move.to,
        assignee: taskPayload(t).assignee ?? "agent",
        surface: "board",
      });
    });
  }

  // The detail panel reads the LIVE action from state (not a snapshot), so a
  // claim or completion landing over WS updates it in place; a deleted task
  // closes it. It is independent of the filters — a card filtered out of the
  // board keeps its open panel alive.
  const detail = detailId ? (state.actions ?? {})[detailId] : undefined;
  useEffect(() => {
    if (detailId && !detail) setDetailId(null);
  }, [detailId, detail]);

  // TDM-135: tell App when a mobile overlay (filter sheet, epic sheet, detail
  // slide-over) is up so it can hide the nav FAB — the FAB paints over these,
  // caged as they are by the board's `isolate`, and steals taps from their CTAs.
  // Gated on `active`: when the board isn't the shown surface a leftover-open
  // sheet must not keep the FAB hidden on Documents. Report false on unmount /
  // deactivation so the FAB can never get stuck hidden.
  const overlayOpen = active && (filterSheetOpen || sidebarOpen || detailId !== null);
  useEffect(() => {
    onOverlayOpenChange?.(overlayOpen);
    return () => onOverlayOpenChange?.(false);
  }, [overlayOpen, onOverlayOpenChange]);

  // Go to ONE task: scope the board to its epic (or "No epic" for epicless
  // tasks, unless the All-tasks lens already shows it), open its detail
  // slide-over, and scroll its card into view. Shared by the TDM-14 focus
  // handoff and the search results strip (TDM-144) — "take me to that card" is
  // one behaviour, and the two callers must not drift apart.
  function revealTask(t: Action) {
    // An unconditional jump: stale filters (a state or claimant filter from
    // earlier browsing — or the very search that found it) would hide the card
    // we are about to scroll to (QA wave-3 finding 6).
    clearFilters();
    const eid = taskPayload(t).epicId;
    if (eid && epicIds.has(eid)) selectScope(eid);
    else if (effectiveScope !== "all") selectScope("none");
    // Mobile shows one lane at a time (TDM-86), so scoping is not enough —
    // bring the lane this task actually sits in forward, or the card we are
    // about to scroll to is in a `hidden` column.
    setMobileCol(colKeyForState(t.state));
    setDetailId(t.id);
    // The card renders into the (possibly new) scope on the next paint —
    // scroll once the DOM has settled. Deliberately not cleaned up: the focus
    // handoff's reset re-runs its effect immediately, and a cleanup would
    // cancel the scroll before it fires.
    setTimeout(() => {
      document
        .querySelector(`[data-task-id="${CSS.escape(t.id)}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
  }

  // TDM-14: consume the one-shot focus handoff from the header agent presence,
  // then hand the token back so normal browsing resumes. If the task left
  // `executing` meanwhile, this still opens it wherever it now sits; a task
  // that vanished entirely just clears the handoff.
  useEffect(() => {
    if (!focusTaskId) return;
    const t = (state.actions ?? {})[focusTaskId];
    if (t) revealTask(t);
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTaskId]);

  // FOLLOW spotlight: an agent moved this card and we're watching. Get it on
  // screen and stay out of the way — no detail panel, no scope change unless
  // the current lens would hide it outright.
  //
  // Two scrolls, deliberately. The lifecycle ping and the state broadcast are
  // separate WS messages with no guaranteed order, so the first pass may find
  // the card still sitting in its OLD column — which is the better opening shot
  // anyway (you watch it leave). The second pass re-centres once it has landed.
  useEffect(() => {
    if (!spotlightTaskId) return;
    // A stale filter or a narrow epic scope would hide the very card we're
    // about to point at (the same trap the TDM-14 handoff hit).
    if (filtering) clearFilters();
    // The ping can beat the state broadcast, in which case we don't know the
    // task's epic yet — skip the re-scope and let the scrolls below find the
    // card wherever it renders. Its next move will scope correctly.
    const t = (state.actions ?? {})[spotlightTaskId];
    if (t && effectiveScope !== "all") {
      const eid = taskPayload(t).epicId;
      if (eid && epicIds.has(eid)) {
        if (effectiveScope !== eid) selectScope(eid);
      } else if (eid || effectiveScope !== "none") {
        selectScope(eid ? "all" : "none");
      }
    }
    // Same reason as the focus handoff: on mobile the card's lane may be the
    // hidden one. Following an agent means the lane it moved the card INTO comes
    // forward — which is the whole point of watching.
    if (t) setMobileCol(colKeyForState(t.state));
    const center = () =>
      document
        .querySelector(`[data-task-id="${CSS.escape(spotlightTaskId)}"]`)
        ?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    // Ring the card even when the flight didn't run — being pulled here from
    // another surface means the board was hidden (zero rects) when it moved, so
    // the glow is the only tell that THIS is the card you were brought to see.
    setSpotlightGlow({ id: spotlightTaskId, nonce: spotlightNonce ?? 0 });
    const first = setTimeout(center, 90);
    const second = setTimeout(center, 820);
    const fade = setTimeout(() => setSpotlightGlow(null), 2600);
    return () => {
      clearTimeout(first);
      clearTimeout(second);
      clearTimeout(fade);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotlightNonce, spotlightTaskId]);

  // Epic-scope handoff: a roadmap chip asked for this epic. One-shot, mirrors
  // the task-focus effect above (the board stays mounted, so props are the
  // only reliable channel — a bare localStorage write never re-scopes).
  useEffect(() => {
    if (!focusEpicId) return;
    if (epicIds.has(focusEpicId)) selectScope(focusEpicId);
    onScopeHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEpicId]);

  // Keyboard: "/" focuses search; Escape closes the detail panel first, then
  // clears the filters. Bound per-render so the closures stay fresh.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (detailId) {
          setDetailId(null);
        } else if (filterSheetOpen) {
          // Dismiss the sheet before clearing what it configures — Escape on an
          // open sheet means "put this away", not "throw away my filters".
          setFilterSheetOpen(false);
        } else if (sidebarOpen) {
          // Below md the epic list is a modal sheet over the board, so Escape
          // dismisses it before it reaches for the filters. On md+ the rail
          // renders whatever this flag says, so clearing it is a no-op there.
          setSidebarOpen(false);
        } else if (bulkReason !== null) {
          // Back out of the reason, keeping the selection: Escape on an open
          // form means "put this away", not "throw away my triage" (TDM-164).
          setBulkReason(null);
        } else if (selecting) {
          clearSelection();
        } else if (filtering || searchInput) {
          clearFilters();
          searchRef.current?.blur();
        }
        return;
      }
      if (e.key === "/") {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        searchRef.current?.focus();
      }
      /* The keyboard end of bulk triage (TDM-164): with a selection up, A
         approves it and R opens the shared reason. Bare letters, so they are
         guarded three ways — not while typing, not while a modifier is held
         (cmd+R is reload), and not while the detail slide-over is reading a
         ticket, where "a" belongs to whatever is open rather than to a
         selection behind it. The whole triage is then doable without a mouse:
         arrow to a card, shift-arrow to extend, A or R. */
      if (
        selectedIds.length > 0 &&
        bulkReason === null &&
        !detailId &&
        !readOnly &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isTypingTarget(e.target)
      ) {
        if (e.key === "a" || e.key === "A") {
          e.preventDefault();
          void approveSelection();
        } else if (e.key === "r" || e.key === "R") {
          e.preventDefault();
          setBulkReason("");
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const empty = tasks.length === 0 && epics.length === 0;
  // Whether the canvas has any real documents (folders only nest them) — the
  // teaching empty state only points at Documents when there's something there.
  const hasDocs = Object.values(state.documents ?? {}).some((d) => d.type !== "folder");

  // The inline move on a card, and the rule for WHICH cards get one: your own
  // todos. An agent task's card stays clean — a human hijacking a queued agent
  // task is a real move, but it is a considered one, so it lives in the detail
  // panel with the rest of the matrix rather than one stray click from every
  // card on the board. (Terminal states have only rewinds, and primaryMoveFor
  // returns none, so a done card grows no button either.)
  function renderPrimaryMove(t: Action) {
    if (readOnly || (taskPayload(t).assignee ?? "agent") !== "human") return null;
    const move = primaryMoveFor(t.state);
    if (!move) return null;
    return <PrimaryMoveControl move={move} busy={busyId === t.id} onGo={() => moveCard(t, move)} />;
  }

  // The triage row on a proposed card or epic header — swapped for the in-place
  // editor while that ticket is being amended, so the decision and the edit
  // occupy the same slot instead of stacking two rows of controls on a card.
  function renderApproveReject(a: Action, approveLabel?: string) {
    if (readOnly || a.state !== "proposed") return null;
    const isEpic = a.type === "epic";
    // In multi-select triage the per-card row stands down (TDM-164). Two sets
    // of Approve/Reject on screen at once — one meaning "this ticket", one
    // meaning "the eight I picked" — is a misfire waiting to happen, and
    // dropping the row also fits more cards on screen for the decision you are
    // actually making. It returns the moment the selection is cleared.
    if (!isEpic && selecting) return null;
    if (!isEpic && amendingId === a.id) {
      return (
        <InlineAmend
          key={a.id}
          action={a}
          busy={busyId === a.id}
          onSave={(title, body) => amend(a, title, body)}
          onCancel={() => setAmendingId(null)}
        />
      );
    }
    return (
      <TriageControls
        busy={busyId === a.id}
        rejecting={rejectingId === a.id}
        approveLabel={approveLabel}
        confirmReject={isEpic}
        onApprove={() => approve(a)}
        onReject={() => reject(a)}
        onAmend={isEpic ? undefined : () => setAmendingId(a.id)}
        setRejecting={(v) => setRejectingId(v ? a.id : null)}
      />
    );
  }

  // ── Kanban card ─────────────────────────────────────────────────────────────
  // withEpicChip: only the All-tasks scope shows the epic chip (clicking it
  // jumps the sidebar to that epic); inside an epic scope it's redundant.
  function renderCard(t: Action, showState: boolean, withEpicChip: boolean, colKey: string) {
    const p = taskPayload(t);
    const terminal = t.state === "done" || t.state === "failed" || t.state === "rejected";
    const reapproval = lastReapprovalEdit(p);
    // The last time a PERSON moved this card (TDM-97) — null for a task only
    // agents have ever transitioned, which is most of them.
    const handMove = lastStateMove(p);
    const epicId = p.epicId;
    const epicTitle = withEpicChip && epicId ? epicTitleById.get(epicId) : undefined;
    // Just flew in from another lane (or the camera brought us here for it) —
    // hold the agent ring while it settles.
    const justLanded = landed[t.id] !== undefined || spotlightGlow?.id === t.id;
    // Lease health (TDM-101) — "none" for anything not executing, so every other
    // lane's cards are untouched. A lapsed lease is the one thing about a Working
    // card worth borrowing the card's own border for: it is a fact about the
    // CARD (nobody is driving this), not about a field inside it.
    const lease = deriveLease(t, now);
    // Multi-select triage (TDM-164) lives on the proposed lane and nowhere else:
    // a selection is a thing you do at the GATE, and there is no bulk verb for
    // a card that has already been decided on.
    const selectable = !readOnly && t.state === "proposed";
    const isSelected = selectable && selected.has(t.id);
    const cardLabel = t.ticketId || p.title || "this ticket";
    return (
      <div
        key={t.id}
        data-task-id={t.id}
        // The lane this card is in, so useCardFlight can tell a MOVE from a
        // re-render, and the anchor the agent cursor's halo wraps when the
        // follow camera brings the viewer here.
        data-task-col={colKey}
        data-agent-target={t.id}
        role="button"
        tabIndex={0}
        // Shift-click selects a RANGE, and the browser's own shift-click is
        // "extend the text selection" — which would paint the lane blue under
        // the cards. Suppressed at mousedown, where that behaviour starts.
        onMouseDown={(ev) => {
          if (selectable && ev.shiftKey) ev.preventDefault();
        }}
        onClick={(ev) => {
          if (selectable) {
            // cmd/ctrl-click toggles one, shift-click extends the range, and
            // once a selection is up (or tap-to-select is on) a plain click
            // selects too — the same escalation a file manager makes. With no
            // selection and no modifier, a click still opens the ticket, which
            // is what a click on this card has always meant.
            if (ev.metaKey || ev.ctrlKey) {
              toggleSelect(t.id);
              return;
            }
            if (ev.shiftKey) {
              extendTo(t.id);
              return;
            }
            if (selecting) {
              toggleSelect(t.id);
              return;
            }
          }
          setDetailId(t.id);
        }}
        onKeyDown={(ev: ReactKeyboardEvent) => {
          // Only when the card itself is focused — keys on inner controls
          // (approve/reject, epic chip) keep their own behaviour.
          if (ev.target !== ev.currentTarget) return;
          // Keyboard parity with the sidebar rows: Enter opens the detail
          // slide-over, and so does Space on a card with no selection to make.
          if (ev.key === "Enter") {
            ev.preventDefault();
            setDetailId(t.id);
            return;
          }
          if (!selectable) {
            if (ev.key === " ") {
              ev.preventDefault();
              setDetailId(t.id);
            }
            return;
          }
          // On a SELECTABLE card Space is the checkbox key (the platform
          // convention), x its Gmail-shaped alias, and the arrows walk the lane
          // — with shift, they drag the selection along (TDM-164).
          if (ev.key === " " || ev.key === "x" || ev.key === "X") {
            ev.preventDefault();
            toggleSelect(t.id);
            return;
          }
          if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
            ev.preventDefault();
            stepSelection(t.id, ev.key === "ArrowDown" ? 1 : -1, ev.shiftKey);
            return;
          }
          if ((ev.key === "a" || ev.key === "A") && (ev.metaKey || ev.ctrlKey)) {
            // Select-all, scoped to the lane the focus is in rather than to the
            // document — which is the only reading of cmd+A that makes sense
            // with a card focused, and why it is bound here and not on window.
            ev.preventDefault();
            selectAllProposed();
          }
        }}
        /* Selection is carried by a ring and the border, NOT by a fill: the
           card's `bg-surface` is one deliberate step above the board's paper in
           dark mode, and swapping it for a translucent accent would make the
           selected cards read as sunk BELOW the ones you didn't pick. */
        className={`group cursor-pointer rounded-lg border bg-surface p-2.5 transition-[border-color,box-shadow] hover:border-ink/25 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
          isSelected ? "ring-2 ring-inset ring-accent/50" : ""
        } ${
          justLanded
            ? "tandem-card-land border-agent/40"
            : lease.health === "stale"
              ? "border-amber-500/40"
              : isSelected
                ? "border-accent/45"
                : "border-ink/10"
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          {/* The selection box. Hidden until it is wanted — on a pointer device
              it appears on hover or keyboard focus, and on touch (no hover at
              all) the lane header's "Select" is the way in, which is why that
              control exists. Never a tab stop: the card is the one tab stop and
              Space toggles it, so tabbing a triage lane doesn't cost two stops
              per ticket. */}
          {selectable && (
            <button
              role="checkbox"
              aria-checked={isSelected}
              aria-label={isSelected ? `Deselect ${cardLabel}` : `Select ${cardLabel}`}
              tabIndex={-1}
              onClick={(ev) => {
                ev.stopPropagation();
                if (ev.shiftKey) extendTo(t.id);
                else toggleSelect(t.id);
              }}
              className={`mt-px shrink-0 rounded-[4px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                isSelected ? "text-accent" : "text-ink/35 hover:text-ink/70"
              } ${selecting ? "flex" : "hidden group-hover:flex group-focus-within:flex"}`}
            >
              {isSelected ? <CheckSquare size={14} /> : <Square size={14} />}
            </button>
          )}
          <span
            className={`min-w-0 flex-1 font-semibold leading-snug ${T_TITLE} ${terminal ? "text-ink/55" : "text-ink"}`}
          >
            {t.ticketId &&
              (onOpenTicket ? (
                /* A real <a>, so cmd/middle-click opens the ticket in a new tab
                   (spaLink lets modified clicks through). stopPropagation keeps
                   the card's own click — the detail slide-over — out of it. */
                <a
                  href={`/c/${code}/ticket/${t.ticketId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    spaLink(() => onOpenTicket(t.ticketId as string))(e);
                  }}
                  title={`Open ${t.ticketId} — the full ticket page`}
                  className={`mr-1.5 rounded-[3px] font-code font-medium tracking-tight text-ink/50 transition-colors hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${T_META}`}
                >
                  {t.ticketId}
                </a>
              ) : (
                <span className={`mr-1.5 font-code font-medium tracking-tight text-ink/50 ${T_META}`}>
                  {t.ticketId}
                </span>
              ))}
            {p.title || "Untitled task"}
          </span>
          {/* State is the column in this view — chip only where the column is
              ambiguous (the merged Failed / Rejected lane). */}
          {showState && <StateChip state={t.state} />}
        </div>
        {/* Who is on it, and whether they are still breathing. One row: the pair
            is a single fact ("this agent, this recently"), and splitting them
            would put a name on one line and its own vital sign on another. */}
        {t.state === "executing" && t.claimedBy && (
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            <ClaimantChip name={t.claimedBy} className="min-w-0" />
            <LeaseChip lease={lease} className="ml-auto" />
          </div>
        )}
        {/* Only while it's waiting on a human. Once re-approved the mark has
            done its job, and a permanent "was edited once" badge on a running
            task is history, not a decision aid. */}
        {t.state === "proposed" && reapproval && <ReapprovalMark edit={reapproval} />}
        {/* Evidence: what the completion says it produced, and what GitHub says
            about it. Above the record-metadata row because it's about the WORK,
            not about the row. Two chips max — the card is a summary; the rest
            are in the detail panel. */}
        <TaskLinks
          code={code}
          links={p.links}
          live={liveLinkTaskIds.has(t.id)}
          max={2}
          className="mt-1.5"
        />
        <div className="mt-1.5 flex items-center gap-1.5">
          {epicTitle && epicId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                selectScope(epicId);
              }}
              title={`Scope the board to "${epicTitle}"`}
              className={`inline-flex min-w-0 items-center gap-1 rounded-[4px] border border-ink/10 bg-ink/[0.03] px-1.5 py-0.5 text-ink/50 transition-colors hover:border-ink/30 hover:text-ink/75 sm:py-px ${T_META}`}
            >
              <Layers size={9} className="shrink-0" />
              <span className="max-w-[9rem] truncate">{epicTitle}</span>
            </button>
          )}
          {p.assignee === "human" && (
            <User size={11} className="shrink-0 text-ink/40" aria-label="Your own todo" />
          )}
          {/* Who last moved this by hand. Left of the record group because it is
              a fact about the WORK (someone walked it here) rather than about
              the row, and it yields its width to the epic chip beside it. */}
          {handMove && <MoveMark move={handMove} />}
          {/* Record metadata, right-aligned as one group: who else went for it,
              who wrote it, which gate let it through, when. All four are facts
              about the row rather than its status, so they read at the same dim
              weight — and the collision marker leads the group because it is the
              only one that is ever news. Authorship then approval, in that
              order: it is a chain, and reading "planner-1 wrote it → reviewer-b
              passed it" backwards would make the pair harder, not easier. */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <TaskContentionMark action={t} />
            <ProvenanceChip authoredBy={t.authoredBy} />
            <ApprovalMark approvedBy={t.approvedBy} />
            <span className={`font-code text-ink/50 ${T_META}`} title={fullDate(t.createdAt)}>
              {ageOf(t.createdAt)}
            </span>
          </div>
        </div>
        {renderApproveReject(t)}
        {renderPrimaryMove(t)}
      </div>
    );
  }

  // ── Sidebar: epic timeline entries ──────────────────────────────────────────
  // Deliberately a different shape from task cards — full-width rows with a
  // left selection accent, a Layers icon, and no ticket badge. Epics are the
  // lens, not the work.

  function epicStats(e: Action) {
    const list = tasksByEpic.get(e.id) ?? [];
    return {
      list,
      total: list.length,
      done: list.filter((t) => t.state === "done").length,
      working: list.filter((t) => t.state === "executing").length,
      drain: epicDrain(e, list),
    };
  }

  const entryCls = (selected: boolean) =>
    [
      "cursor-pointer border-l-2 px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 sm:py-2",
      selected ? "border-accent bg-accent/[0.08]" : "border-transparent hover:bg-ink/[0.03]",
    ].join(" ");

  function entryKeyDown(s: string) {
    return (ev: ReactKeyboardEvent) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        selectScope(s);
      }
    };
  }

  function renderPseudoEntry(key: "all" | "none", label: string, count: number) {
    const selected = effectiveScope === key;
    return (
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => selectScope(key)}
        onKeyDown={entryKeyDown(key)}
        className={`flex items-center gap-1.5 ${entryCls(selected)}`}
      >
        <span
          className={`min-w-0 flex-1 truncate font-semibold ${T_ROW} ${selected ? "text-accent" : "text-ink/70"}`}
        >
          {label}
        </span>
        <span className={`shrink-0 font-code text-ink/50 ${T_META}`}>{count}</span>
      </div>
    );
  }

  // aged: rendered inside the Done bucket — dimmed, lifecycle chip (Done for
  // finished, Rejected for archived), drained-in annotation where it applies.
  function renderEpicEntry(e: Action, aged = false) {
    const p = epicPayload(e);
    const { list, total, done, working, drain } = epicStats(e);
    const lifecycle = epicLifecycle(e, list);
    const selected = effectiveScope === e.id;
    const plan = epicPlan.get(e.id);
    return (
      <div
        key={e.id}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => selectScope(e.id)}
        onKeyDown={entryKeyDown(e.id)}
        className={`${entryCls(selected)}${aged ? " opacity-60 hover:opacity-90" : ""}`}
      >
        <div className="flex items-center gap-1.5">
          <Layers size={12} className="shrink-0 text-ink/45" />
          <span
            className={`min-w-0 flex-1 truncate font-semibold ${T_ROW} ${selected ? "text-accent" : "text-ink/80"}`}
            title={p.title || "Untitled epic"}
          >
            {p.title || "Untitled epic"}
          </span>
          <StateChip state={lifecycle === "finished" ? "done" : e.state} />
        </div>
        {/* The goal this epic delivers — quiet provenance, not a control (the
            plan chip in the scoped header is the interactive route). */}
        {plan && (
          <div
            className={`mt-0.5 truncate pl-[18px] text-ink/45 ${T_HEAD}`}
            title={plan.goalTitle}
          >
            {plan.goalTitle}
          </div>
        )}
        {/* What it achieved, clamped to two lines (TDM-93). The sidebar is a
            timeline of batches, and for a finished one the interesting fact is
            the outcome, not the ticket count — this is where you notice it
            without selecting the epic. The full text is in the scoped header. */}
        {(p.summary ?? "").trim() && (
          <div
            className={`mt-1 line-clamp-2 pl-[18px] leading-snug text-ink/55 ${T_HEAD}`}
            title={p.summary}
          >
            {p.summary}
          </div>
        )}
        <ProgressBar done={done} working={working} total={total} className="mt-1.5 h-1.5" />
        <div className={`mt-1 flex items-center justify-between font-code text-ink/50 ${T_META}`}>
          <span>
            {done}/{total} done
          </span>
          {drain && <span className="text-emerald-600 dark:text-emerald-400">{drain}</span>}
        </div>
        {/* The sidebar doubles as the approval inbox. */}
        {renderApproveReject(e, "Approve epic")}
      </div>
    );
  }

  /* ── "What this batch achieved" (TDM-93) ───────────────────────────────────
     A task says what it did in its `result`; an epic said nothing at all, so
     the batch-level answer only existed as six ticket results nobody had read
     together. This is that answer, above the tickets rather than inside them:
     the epic's own summary first, then the ticket-by-ticket rollup COLLAPSED
     underneath — the prose is what you want on arrival, the receipts are what
     you open when you don't believe it.

     The rollup is derived here from the board's own state (the same tasks the
     kanban is drawing), so it stays live with the socket and costs no fetch.
     The API's /api/canvas/epics computes the same shape for agents. */
  function renderAchieved(e: Action) {
    const p = epicPayload(e);
    const { list } = epicStats(e);
    // done AND failed: "we tried and it broke" is part of what a batch
    // achieved, and hiding it would make this panel flattering rather than
    // honest. Rejected tasks are excluded — nobody worked them.
    const finished = list
      .filter((t) => t.state === "done" || t.state === "failed")
      .sort((a, b) => (a.ticket ?? 0) - (b.ticket ?? 0));
    const summary = (p.summary ?? "").trim();
    // Nothing has finished and nobody has written anything: an empty
    // "achieved" panel on a batch that hasn't started is pure chrome.
    if (!summary && finished.length === 0) return null;

    return (
      <div className="mt-2 rounded-md border border-ink/10 bg-ink/[0.02] px-2.5 py-2">
        {summary ? (
          <>
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink/45">
              What this batch achieved
            </div>
            <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink/75">
              {summary}
            </p>
            {(p.summaryBy || p.summaryAt) && (
              <div className="mt-1 font-code text-[10.5px] text-ink/40">
                {p.summaryBy ?? "unknown"}
                {p.summaryAt && (
                  <span title={fullDate(p.summaryAt)}> · {ageOf(p.summaryAt)} ago</span>
                )}
              </div>
            )}
          </>
        ) : (
          // The prompt IS the write path's discoverability: a summary nobody is
          // asked for stays unwritten, and this is the moment it's cheapest to
          // write (the work just landed and is still on screen).
          <button
            onClick={() => setDetailId(e.id)}
            className="text-left text-[12px] text-ink/50 transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {finished.length} ticket{finished.length === 1 ? "" : "s"} finished and nothing says
            what the batch achieved — write it
          </button>
        )}

        {finished.length > 0 && (
          <>
            <button
              onClick={() => setAchievedOpen((v) => !v)}
              aria-expanded={achievedOpen}
              className={`mt-1.5 inline-flex items-center gap-1 rounded-[3px] font-code text-ink/45 transition-colors hover:text-ink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${T_META}`}
            >
              <ChevronDown
                size={11}
                className={`shrink-0 transition-transform ${achievedOpen ? "" : "-rotate-90"}`}
              />
              {finished.length} finished ticket{finished.length === 1 ? "" : "s"}
            </button>
            {achievedOpen && (
              <ul className="mt-1 flex flex-col gap-1 border-l border-ink/10 pl-2">
                {finished.map((t) => {
                  // One line each — the headline of the result, not the essay.
                  // The whole result is one click away in the ticket itself.
                  const first = (t.result ?? "").trim().split("\n")[0].trim();
                  return (
                    <li key={t.id} className="min-w-0 text-[12px] leading-snug">
                      <button
                        onClick={() =>
                          t.ticketId && onOpenTicket ? onOpenTicket(t.ticketId) : setDetailId(t.id)
                        }
                        className="min-w-0 max-w-full text-left transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        title={t.result || undefined}
                      >
                        {t.ticketId && (
                          <span className="font-code text-[11px] text-ink/45">{t.ticketId} </span>
                        )}
                        <span className={t.state === "failed" ? "text-ink/55 line-through" : "text-ink/70"}>
                          {taskPayload(t).title || "Untitled task"}
                        </span>
                        {first && <span className="text-ink/45"> — {first}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    );
  }

  // ── Scoped-epic header above the kanban ─────────────────────────────────────
  function renderScopeHeader(e: Action) {
    const p = epicPayload(e);
    const { list, total, done, working, drain } = epicStats(e);
    // Finished epics read as history: Done chip, full emerald bar, prominent
    // drained-in — no approve-era chrome.
    const finished = epicLifecycle(e, list) === "finished";
    const plan = epicPlan.get(e.id);
    return (
      <div className="shrink-0 border-b border-ink/10 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Layers size={14} className="shrink-0 text-ink/45" />
          <button
            onClick={() => setDetailId(e.id)}
            title="Open epic details"
            className="min-w-0 truncate text-left text-[15px] font-semibold text-ink hover:underline sm:text-[14px]"
          >
            {p.title || "Untitled epic"}
          </button>
          <StateChip state={finished ? "done" : e.state} />
          {/* The plan this epic delivers: goal + roadmap doc. Clicking jumps to
              the roadmap on the Documents surface — the reverse of the roadmap's
              epic chips pointing here. */}
          {plan && onOpenRoadmapDoc && (
            <button
              onClick={() => onOpenRoadmapDoc(plan.docId)}
              title="Open the roadmap this epic belongs to"
              aria-label="Open the roadmap this epic belongs to"
              className={`inline-flex min-w-0 shrink items-center gap-1 rounded-[4px] border border-ink/10 bg-ink/[0.03] px-1.5 py-0.5 text-ink/50 transition-colors hover:border-ink/30 hover:text-ink/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:py-px ${T_META}`}
            >
              <Milestone size={9} className="shrink-0" />
              <span className="truncate">
                {plan.goalTitle} · {plan.docName}
              </span>
            </button>
          )}
          {finished && drain && (
            <span className="shrink-0 text-[12px] font-semibold text-emerald-600 dark:text-emerald-400">
              {drain}
            </span>
          )}
          <span className="ml-auto shrink-0 font-code text-[11px] text-ink/50">
            {done}/{total} done
          </span>
        </div>
        {p.body && (
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink/60 sm:text-[12px]">
            {p.body}
          </p>
        )}
        {/* What the batch ACHIEVED, above its tickets — the answer you came for,
            with the receipts collapsed under it. */}
        {renderAchieved(e)}
        {finished ? (
          <div className="mt-2 h-1.5 rounded-full bg-emerald-500" />
        ) : (
          <>
            <ProgressBar done={done} working={working} total={total} className="mt-2 h-1.5" />
            {/* What partial triage already decided (TDM-160). Approving the epic
                cascades to its tickets, and the honest question at that moment
                is "what does this actually let through?" — the cascade only
                touches tickets still in 'proposed' (both server paths filter on
                it), so anything rejected one card up stays rejected. Saying so
                is the difference between trusting the cascade and re-checking
                every card before pressing the button. Shown only once a
                decision has been made, so an untouched epic is unchanged. */}
            {e.state === "proposed" &&
              (() => {
                const waiting = list.filter((t) => t.state === "proposed").length;
                const turnedDown = list.filter((t) => t.state === "rejected").length;
                if (turnedDown === 0) return null;
                return (
                  <p className={`mt-1.5 text-ink/55 ${T_META}`}>
                    {turnedDown} rejected — approving the epic releases the {waiting} still
                    waiting and leaves {turnedDown === 1 ? "it" : "them"} rejected.
                  </p>
                );
              })()}
            <div className="max-w-xs">{renderApproveReject(e, "Approve epic")}</div>
          </>
        )}
      </div>
    );
  }

  /* What the query found that the LANES cannot show (TDM-144). The kanban below
     still renders the in-scope task hits exactly as before; this strip is the
     rest of the answer — the ticket the query addresses, the epics it names,
     and the matches the current scope is hiding. It renders only when it has
     something to say, so an ordinary search over an unscoped board is visually
     unchanged. */
  function renderSearchHits() {
    if (!searchQuery) return null;
    // A ref that resolves to nothing is worth SAYING: on a scoped, filtered
    // board an empty result reads as "no such ticket" when the truth may be
    // "not here". Only shown when the ref itself found nothing at all.
    const missingRef = searchQuery.ticket && !ticketHit ? searchQuery.ticket : null;
    if (!ticketHit && !missingRef && epicHits.length === 0 && outOfScopeHits.length === 0) {
      return null;
    }
    const shownEpics = epicHits.slice(0, SEARCH_HITS);
    const shownOut = outOfScopeHits.slice(0, SEARCH_HITS);
    return (
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-ink/10 bg-accent/[0.03] px-4 py-2">
        {/* The ticket ref: ONE exact card, canvas-wide, ahead of every fuzzy
            hit — and it takes the Enter key straight from the search box. */}
        {ticketHit && (
          <button
            onClick={() => revealTask(ticketHit)}
            title={`Open ${ticketHit.ticketId}`}
            className={`flex w-full min-w-0 items-center gap-2 rounded-md border border-accent/40 bg-accent/[0.08] px-2 py-1.5 text-left transition-colors hover:bg-accent/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${TAP}`}
          >
            <ArrowRight size={12} className="shrink-0 text-accent" />
            <span className={`shrink-0 font-code font-semibold text-accent ${T_META}`}>
              {ticketHit.ticketId}
            </span>
            <span className={`min-w-0 flex-1 truncate font-medium text-ink ${T_BTN}`}>
              {taskPayload(ticketHit).title || "Untitled task"}
            </span>
            <StateChip state={ticketHit.state} />
            <span className={`hidden shrink-0 font-code text-ink/40 sm:inline ${T_META}`}>
              Enter
            </span>
          </button>
        )}
        {missingRef && (
          <p className={`text-ink/50 ${T_META}`}>No {missingRef} on this canvas.</p>
        )}
        {/* Epics as their own group: an epic is a destination, not a card, so
            its hit does the one thing an epic does — scope the board. */}
        {shownEpics.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span
              className={`shrink-0 font-medium uppercase tracking-wide text-ink/50 ${T_META}`}
            >
              Epics
            </span>
            {shownEpics.map((e) => (
              <button
                key={e.id}
                onClick={() => {
                  selectScope(e.id);
                  clearSearch();
                }}
                title="Scope the board to this epic"
                className={SEARCH_CHIP}
              >
                <Layers size={10} className="shrink-0" />
                <span className="max-w-[13rem] truncate">
                  {epicPayload(e).title || "Untitled epic"}
                </span>
                <span className="shrink-0 font-code opacity-70">
                  {(tasksByEpic.get(e.id) ?? []).length}
                </span>
              </button>
            ))}
            {epicHits.length > shownEpics.length && (
              <span className={`text-ink/45 ${T_META}`}>
                +{epicHits.length - shownEpics.length} more
              </span>
            )}
          </div>
        )}
        {/* Reach past the scope. Searching inside one epic used to be unable to
            find anything outside it — and said nothing about it, which reads as
            "no such task" rather than "not in this lens". */}
        {outOfScopeHits.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className={`shrink-0 text-ink/50 ${T_META}`}>
              {outOfScopeHits.length} match{outOfScopeHits.length === 1 ? "" : "es"} outside “
              {scopeLabel}”
            </span>
            {shownOut.map((t) => (
              <button
                key={t.id}
                onClick={() => revealTask(t)}
                title={`Open ${t.ticketId ?? "this task"} (${
                  epicTitleById.get(taskPayload(t).epicId ?? "") ?? "No epic"
                })`}
                className={SEARCH_CHIP}
              >
                {t.ticketId && <span className="shrink-0 font-code">{t.ticketId}</span>}
                <span className="max-w-[11rem] truncate">
                  {taskPayload(t).title || "Untitled task"}
                </span>
              </button>
            ))}
            <button
              onClick={() => selectScope("all")}
              title="Widen the board to every task and keep searching"
              className={`shrink-0 rounded-[4px] px-1.5 py-1 font-semibold text-accent transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:py-px ${T_META}`}
            >
              Search all tasks
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* Toolbar: the mobile epic-scope affordance + a quiet census of the
          current scope. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-ink/10 px-4 py-2">
        <span className="shrink-0 text-sm font-semibold text-ink">Board</span>
        {/* Epic navigation on mobile (TDM-87). This used to be a bare PanelLeft
            glyph with nothing but an aria-label on it — on a phone, where the
            sidebar is the ONLY route to an epic and the only place epics get
            approved, "an unlabeled icon" and "undiscoverable" are the same
            thing. So it is a labeled control, and it doubles as the scope
            READOUT: unscoped it reads "Epics" (which is what makes it findable
            in the first place); scoped it reads the epic's own name, which is
            the only place a phone says what lens the board is under.
            The chevron is the promise that tapping opens something. */}
        {!empty && (
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label={
              scopedEpic
                ? `Epics — the board is scoped to ${epicPayload(scopedEpic).title || "Untitled epic"}`
                : "Epics — choose which epic scopes the board"
            }
            aria-expanded={sidebarOpen}
            title="Choose which epic scopes the board"
            className={[
              "flex h-9 min-w-0 shrink items-center gap-1.5 rounded-md border px-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 md:hidden",
              T_BTN,
              sidebarOpen
                ? "border-accent/40 bg-accent/[0.08] text-accent"
                : "border-ink/15 text-ink/70",
            ].join(" ")}
          >
            <Layers size={13} className="shrink-0" />
            <span className="min-w-0 truncate">{scopeLabel}</span>
            <ChevronDown size={12} className="shrink-0 opacity-60" />
          </button>
        )}
        {!empty && (
          <span className="hidden font-code text-[11px] text-ink/50 sm:inline">
            {filtering
              ? `${visibleTasks.length}/${scopedTasks.length} tasks`
              : `${scopedTasks.length} task${scopedTasks.length === 1 ? "" : "s"}`}
            {effectiveScope !== "all" && " in scope"}
            {epics.length > 0 && ` · ${epics.length} epic${epics.length === 1 ? "" : "s"}`}
          </span>
        )}
        {!readOnly && !empty && (
          <button
            onClick={() => setComposing((v) => !v)}
            aria-expanded={composing}
            className="ml-auto flex h-9 shrink-0 items-center gap-1 rounded-md bg-accent pl-2.5 pr-3 text-[13px] font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-7 sm:pl-2 sm:pr-2.5 sm:text-xs"
          >
            <Plus size={13} /> New task
          </button>
        )}
      </div>

      {/* The composer — task authoring lives on the Board. Human-authored tasks
          are born approved; agent sessions pull "For the agent" ones from the
          queue. A new task files under the scoped epic, if one is selected. */}
      {composing && !readOnly && (
        <div className="shrink-0 border-b border-ink/10 px-4 py-3">
          <div className="max-w-xl">
            <TaskComposer
              targets={targets}
              onCancel={() => setComposing(false)}
              onSubmit={async (draft) => {
                await createTask(code, scopedEpic ? { ...draft, epicId: scopedEpic.id } : draft);
                posthog.capture("agent_task_created", { canvas_code: code, surface: "board" });
                setComposing(false);
              }}
            />
          </div>
        </div>
      )}

      {/* Filter bar, AND-composed. Search is inline at EVERY width — it is the
          filter people actually reach for, and it takes the whole row on a phone
          because nothing else is competing for it. The state / claimant /
          assignee / commit chips are inline on md+ (unchanged, horizontally
          scrolling rather than wrapping into the board) and collapse below md
          into the one "Filters" button beside it (TDM-88). */}
      {!empty && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-ink/10 px-4 py-1.5 md:overflow-x-auto">
          <div className="relative min-w-0 flex-1 md:flex-none md:shrink-0">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink/30" />
            <input
              ref={searchRef}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              // Enter on a ticket ref goes STRAIGHT to the card. Typing an
              // address and then having to aim at a result is a step the
              // address already paid for. (Escape stays on the window handler.)
              onKeyDown={(e) => {
                if (e.key === "Enter" && ticketHit) {
                  e.preventDefault();
                  revealTask(ticketHit);
                }
              }}
              placeholder='Search tasks, epics, TDM-104  ·  "/"'
              title="Search task and epic titles, bodies and results. A ticket ref (TDM-104, #104, 104) jumps straight to that ticket — press Enter."
              className="h-9 w-full rounded-md border border-ink/15 bg-surface pl-[26px] pr-2 text-[12px] text-ink outline-none placeholder:text-ink/30 focus:border-accent/50 focus:ring-2 focus:ring-accent/40 md:h-7 md:w-64"
            />
          </div>

          {/* Below md: the one affordance for everything else. The badge is the
              whole point — a collapsed filter you have forgotten about is a
              board silently hiding cards, so the count has to be on the closed
              control, not only inside the sheet. */}
          <button
            onClick={() => setFilterSheetOpen(true)}
            aria-expanded={filterSheetOpen}
            aria-label={
              activeFilterCount > 0
                ? `Filters — ${activeFilterCount} active`
                : "Filters"
            }
            className={[
              "flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 md:hidden",
              T_BTN,
              activeFilterCount > 0
                ? "border-accent/40 bg-accent/[0.08] text-accent"
                : "border-ink/15 text-ink/70",
            ].join(" ")}
          >
            <SlidersHorizontal size={13} className="shrink-0" />
            Filters
            {activeFilterCount > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 font-code text-[10px] font-semibold leading-none text-white">
                {activeFilterCount}
              </span>
            )}
          </button>

          {/* md+ inline chip row — the original controls, untouched. */}
          <div className="hidden shrink-0 items-center gap-1.5 md:flex">
            <select
              value={filters.state}
              onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value as Filters["state"] }))}
              aria-label="Filter by state"
              className={FILTER_SELECT_CLS}
            >
              {stateOptions}
            </select>
            {claimants.length > 0 && (
              <select
                value={filters.claimant}
                onChange={(e) => setFilters((f) => ({ ...f, claimant: e.target.value }))}
                aria-label="Filter by claimant"
                className={FILTER_SELECT_CLS}
              >
                {claimantOptions}
              </select>
            )}
            <select
              value={filters.assignee}
              onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value as Filters["assignee"] }))}
              aria-label="Filter by assignee"
              className={FILTER_SELECT_CLS}
            >
              {assigneeOptions}
            </select>
            <button
              onClick={() => setFilters((f) => ({ ...f, hasCommit: !f.hasCommit }))}
              aria-pressed={filters.hasCommit}
              title="Only tasks whose result mentions a commit hash"
              className={[
                "flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                filters.hasCommit
                  ? "border-accent/40 bg-accent/[0.08] text-accent"
                  : "border-ink/15 text-ink/60 hover:border-ink/30",
              ].join(" ")}
            >
              <GitCommitHorizontal size={12} /> Has commit
            </button>
            {filtering && (
              <button
                onClick={clearFilters}
                title="Clear search and filters (Esc)"
                className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink/75"
              >
                <X size={12} /> Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* The mobile filter sheet. Fixed to the viewport floor (not the board's,
          unlike the epic sheet) because it is a full modal over the app, and
          `tandem-safe-pb` keeps its footer off the home indicator. Filters apply
          LIVE as you change them — there is no Apply step to forget — so the
          footer button is a readout of what you have done ("Show N tasks") that
          happens to close the sheet. */}
      {filterSheetOpen && (
        <div className="fixed inset-0 z-[2000] flex flex-col justify-end md:hidden">
          <div
            className="absolute inset-0 bg-ink/25"
            onClick={() => setFilterSheetOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Filter tasks"
            className="tandem-safe-pb tandem-sheet-in relative flex max-h-[85%] flex-col rounded-t-[10px] border-t border-ink/10 bg-surface shadow-lg"
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-ink/10 px-4 py-2.5">
              <SlidersHorizontal size={14} className="shrink-0 text-ink/45" />
              <span className={`min-w-0 flex-1 font-semibold text-ink ${T_ROW}`}>Filters</span>
              <button
                onClick={() => setFilterSheetOpen(false)}
                aria-label="Close the filters"
                className="-mr-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <X size={16} />
              </button>
            </div>
            <div className="tandem-scroll flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3">
              <label className="flex flex-col gap-1">
                <span className={`font-medium uppercase tracking-wide text-ink/50 ${T_META}`}>
                  State
                </span>
                <select
                  value={filters.state}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, state: e.target.value as Filters["state"] }))
                  }
                  className={SHEET_SELECT_CLS}
                >
                  {stateOptions}
                </select>
              </label>
              {claimants.length > 0 && (
                <label className="flex flex-col gap-1">
                  <span className={`font-medium uppercase tracking-wide text-ink/50 ${T_META}`}>
                    Claimant
                  </span>
                  <select
                    value={filters.claimant}
                    onChange={(e) => setFilters((f) => ({ ...f, claimant: e.target.value }))}
                    className={SHEET_SELECT_CLS}
                  >
                    {claimantOptions}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1">
                <span className={`font-medium uppercase tracking-wide text-ink/50 ${T_META}`}>
                  Assignee
                </span>
                <select
                  value={filters.assignee}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, assignee: e.target.value as Filters["assignee"] }))
                  }
                  className={SHEET_SELECT_CLS}
                >
                  {assigneeOptions}
                </select>
              </label>
              <button
                onClick={() => setFilters((f) => ({ ...f, hasCommit: !f.hasCommit }))}
                aria-pressed={filters.hasCommit}
                className={[
                  "flex h-11 w-full items-center gap-2 rounded-md border px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                  filters.hasCommit
                    ? "border-accent/40 bg-accent/[0.08] text-accent"
                    : "border-ink/15 text-ink/70",
                ].join(" ")}
              >
                <GitCommitHorizontal size={14} className="shrink-0" />
                <span className="min-w-0 flex-1 text-left">Has commit</span>
                {filters.hasCommit && <Check size={14} className="shrink-0" />}
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-2 border-t border-ink/10 px-4 py-3">
              {filtering && (
                <button
                  onClick={clearFilters}
                  className="flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-ink/15 px-3 text-[13px] font-medium text-ink/60 transition-colors hover:border-ink/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <X size={14} /> Clear all
                </button>
              )}
              <button
                onClick={() => setFilterSheetOpen(false)}
                className="flex h-11 min-w-0 flex-1 items-center justify-center rounded-md bg-accent px-3 text-[13px] font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {filtering
                  ? `Show ${visibleTasks.length} of ${scopedTasks.length}`
                  : `Show all ${scopedTasks.length}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── The bulk triage bar (TDM-164) ──────────────────────────────────
          What a selection is FOR. Same column flow as the undo strip below and
          for the same reason: on a phone the Proposed lane is the whole screen,
          and a floating bar would cover the cards you are deciding about.

          Approve and Reject sit side by side at equal weight — the entire point
          of this ticket is that turning eleven tickets down costs what letting
          them through costs. Reject opens the shared-reason panel rather than
          firing, because a batch is the one case where a reason is worth typing
          once, and because a mis-aimed bulk reject is the expensive mistake on
          this surface (the Undo strip catches it either way).

          It stays up while the selection is EMPTY but tap-to-select is on: that
          is the state you are in right after pressing "Select", and it is where
          "All 11" lives. */}
      {selecting && (
        <div className="mx-4 mt-2 shrink-0 rounded-md border border-accent/30 bg-accent/[0.06] px-2.5 py-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className={`shrink-0 font-medium text-ink/80 ${T_BTN}`}>
              {selectedIds.length} selected
            </span>
            {selectedIds.length < proposedOrder.length && proposedOrder.length > 0 && (
              <button
                onClick={selectAllProposed}
                className={`shrink-0 rounded-[4px] px-1.5 py-1 font-semibold text-accent transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:py-px ${T_META}`}
              >
                All {proposedOrder.length}
              </button>
            )}
            {selectedIds.length > 0 && (
              <button
                onClick={clearSelection}
                className={`shrink-0 rounded-[4px] px-1.5 py-1 font-medium text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:py-px ${T_META}`}
              >
                Clear
              </button>
            )}
            {/* The keyboard path, stated where it is used — the whole triage is
                doable without the mouse and nobody would guess that. */}
            <span className={`hidden shrink-0 font-code text-ink/40 lg:inline ${T_META}`}>
              ↑↓ move · ⇧↑↓ extend · space pick · A approve · R reject
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                onClick={() => void approveSelection()}
                disabled={batchBusy || selectedIds.length === 0}
                className={`flex items-center justify-center gap-1 rounded-md bg-accent px-2.5 py-1 font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${T_BTN} ${TAP}`}
              >
                <Check size={12} /> {batchBusy ? "Working…" : `Approve ${selectedIds.length}`}
              </button>
              <button
                onClick={() => setBulkReason(bulkReason === null ? "" : null)}
                disabled={batchBusy || selectedIds.length === 0}
                aria-expanded={bulkReason !== null}
                className={`flex items-center justify-center gap-1 rounded-md border border-rose-500/30 px-2.5 py-1 font-medium text-rose-600 transition-colors hover:border-rose-500/60 hover:bg-rose-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 disabled:opacity-40 dark:text-rose-400 ${T_BTN} ${TAP}`}
              >
                <X size={12} /> Reject {selectedIds.length}
              </button>
            </div>
          </div>
          {/* ONE reason for the batch. Optional — a reason you are made to type
              is a reason nobody reads — but it is offered first, because the
              rejection rate only means something if the record says why. It
              lands in each ticket's error column, and an Undo clears it. */}
          {bulkReason !== null && selectedIds.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-1.5">
              <textarea
                autoFocus
                value={bulkReason}
                onChange={(e) => setBulkReason(e.target.value)}
                onKeyDown={(e: ReactKeyboardEvent) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void rejectSelection(bulkReason);
                  }
                }}
                rows={2}
                placeholder={`Why these ${selectedIds.length} are being turned down (optional) — recorded on every one of them`}
                aria-label="Shared reason for rejecting the selected tickets"
                className={`w-full resize-y rounded-md border border-ink/15 bg-paper px-2 py-1.5 leading-relaxed text-ink placeholder:text-ink/35 focus:border-rose-500/50 focus:outline-none focus:ring-2 focus:ring-rose-500/20 ${T_BTN}`}
              />
              <div className="flex gap-1.5">
                <button
                  onClick={() => void rejectSelection(bulkReason)}
                  disabled={batchBusy}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-md bg-rose-600 px-2 py-1 font-medium text-white transition-colors hover:bg-rose-600/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 disabled:opacity-40 ${T_BTN} ${TAP}`}
                >
                  <Ban size={12} />
                  {batchBusy ? "Rejecting…" : `Reject ${selectedIds.length}`}
                </button>
                <button
                  onClick={() => setBulkReason(null)}
                  className={`flex-1 rounded-md border border-ink/15 px-2 py-1 font-medium text-ink/60 transition-colors hover:border-ink/30 ${T_BTN} ${TAP}`}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* What makes one-tap reject safe (TDM-160). It sits in the board's own
          column flow rather than floating over the lanes: on a phone the
          Proposed lane IS the screen, and a toast pinned over it would cover
          the next card you were about to decide on. */}
      {undoReject && (
        <div
          role="status"
          className="mx-4 mt-2 flex shrink-0 items-center gap-2 rounded-md border border-ink/10 bg-surface px-2.5 py-1.5 text-[12px] text-ink/70"
        >
          <Ban size={12} className="shrink-0 text-rose-500" aria-hidden="true" />
          <span className="min-w-0 truncate">
            Rejected{" "}
            <span
              className={`font-medium text-ink/85 ${undoReject.ids.length === 1 ? "font-code" : ""}`}
            >
              {undoReject.label}
            </span>
          </span>
          <button
            onClick={undoLastReject}
            disabled={batchBusy}
            className={`ml-auto shrink-0 rounded-md border border-ink/15 px-2 py-1 font-medium text-ink/75 transition-colors hover:border-ink/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 sm:py-0.5 ${T_BTN} ${TAP}`}
          >
            Undo
          </button>
          <button
            onClick={() => setUndoReject(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-1 text-ink/40 transition-colors hover:text-ink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {error && (
        <div className="mx-4 mt-2 shrink-0 rounded-md border border-rose-500/20 bg-rose-500/10 px-2.5 py-1.5 text-[12px] text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {empty && !composing ? (
        /* First-run teaching state: the loop this product is built around —
           write a task, an agent claims it, you review. ONE primary action. */
        <div className="tandem-scroll flex flex-1 items-center justify-center overflow-y-auto p-8">
          <div className="w-full max-w-md text-center">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-ink/10 bg-surface">
              <SquareKanban size={20} className="text-ink/45" />
            </span>
            <h2 className="mt-4 text-xl font-semibold tracking-tight text-ink">
              This is where the work happens
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-ink/55">
              Tasks move across this board as agent sessions pick them up and finish them —
              with you approving what runs.
            </p>
            <ol className="mx-auto mt-5 flex max-w-xs flex-col gap-2.5 text-left">
              {[
                "Write a task — or ask a connected agent to propose a plan.",
                "Approve it so an agent session can claim it from the queue.",
                "Review the result when the card lands in Done.",
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-ink/60">
                  <span className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border border-ink/15 bg-surface font-code text-[10px] font-medium text-ink/55">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
            {readOnly ? (
              <p className="mt-6 font-code text-[11px] text-ink/40">
                view only — tasks will appear here as they're written
              </p>
            ) : (
              <>
                <button
                  onClick={() => setComposing(true)}
                  className="mt-6 inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
                >
                  <Plus size={15} /> Write the first task
                </button>
                {(onOpenConnect || (onOpenDocuments && hasDocs)) && (
                  <p className="mt-4 font-code text-[11px] text-ink/40">
                    {onOpenConnect && (
                      <button onClick={onOpenConnect} className="font-medium text-accent hover:underline">
                        open the connect dialog
                      </button>
                    )}
                    {onOpenConnect && onOpenDocuments && hasDocs && <span aria-hidden> · </span>}
                    {onOpenDocuments && hasDocs && (
                      <button onClick={onOpenDocuments} className="font-medium text-accent hover:underline">
                        browse the documents
                      </button>
                    )}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {/* Epic navigator. On md+ it is the static left timeline rail, exactly
              as before. Below md it is a BOTTOM SHEET (TDM-87), opened by the
              labeled "Epics" control in the toolbar and dismissed by the scrim,
              by Escape, or by picking a scope (see selectScope).
              A sheet rather than the old left drawer for two reasons: it is the
              idiom this app already uses on phones (MobileNavDrawer), and epic
              rows are the tallest tap targets on the board — they belong under
              the thumb, not against the far edge of the screen. Everything
              inside is the SAME markup as desktop, so epic Approve / Reject and
              the Done bucket work in the sheet by construction. */}
          {sidebarOpen && (
            <div
              className="absolute inset-0 z-20 bg-ink/25 md:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-hidden="true"
            />
          )}
          <aside
            aria-label="Epics"
            className={[
              sidebarOpen ? "flex" : "hidden",
              // Mobile: a sheet on the board's floor, capped so the kanban
              // behind it stays visible as context. No safe-area padding of its
              // own — App already shortens the whole board surface by
              // `tandem-fab-reserve`, which includes the home-indicator strip,
              // so this floor is already clear of it.
              "tandem-sheet-in absolute inset-x-0 bottom-0 z-30 max-h-[78%] flex-col rounded-t-[10px] border-t border-ink/10 bg-paper shadow-lg",
              // md+: the original 16rem rail, unchanged.
              "md:static md:inset-auto md:z-auto md:flex md:max-h-none md:w-64 md:shrink-0 md:animate-none md:rounded-none md:border-r md:border-t-0 md:shadow-none",
            ].join(" ")}
          >
            {/* Sheet handle + title + explicit close. Mobile only: on desktop
                the rail is permanent chrome and needs no dismiss. */}
            <div className="flex shrink-0 items-center gap-2 border-b border-ink/10 px-3 py-2 md:hidden">
              <Layers size={13} className="shrink-0 text-ink/45" />
              <span className={`min-w-0 flex-1 font-semibold text-ink ${T_ROW}`}>Epics</span>
              <button
                onClick={() => setSidebarOpen(false)}
                aria-label="Close the epic list"
                className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-2">
              <div className="sticky top-0 z-10 border-b border-ink/10 bg-paper py-1">
                {renderPseudoEntry("all", "All tasks", tasks.length)}
                {renderPseudoEntry("none", "No epic", epiclessAll.length)}
              </div>
              {/* Roadmaps are the plans, one per stream; the Board is the single
                  execution queue; epics are the bridge. Plan-linked epics group
                  under their roadmap doc's name; the rest keep the plain
                  timeline (which is ALL of them on a canvas with no links —
                  zero visual change there). */}
              {planGroups.groups.map((g) => (
                <div key={g.docId}>
                  <div
                    className={`px-3 pb-0.5 pt-2.5 font-medium uppercase tracking-wide text-ink/50 ${T_META}`}
                  >
                    {g.name}
                  </div>
                  {g.list.map((e) => renderEpicEntry(e))}
                </div>
              ))}
              {(planGroups.groups.length === 0 || planGroups.unlinked.length > 0) && (
                <div
                  className={`px-3 pb-0.5 pt-2.5 font-medium uppercase tracking-wide text-ink/50 ${T_META}`}
                >
                  Epic timeline
                </div>
              )}
              {planGroups.unlinked.map((e) => renderEpicEntry(e))}
              {epics.length === 0 && (
                <p className="px-3 py-1.5 text-[11px] leading-relaxed text-ink/50">
                  No epics yet — agents propose them as named batches of tasks.
                </p>
              )}
              {/* Done bucket: finished + rejected epics, collapsed by default.
                  History stays browsable — entries still scope the kanban. */}
              {agedEpics.length > 0 && (
                <div className="mt-2 border-t border-ink/10">
                  <button
                    onClick={toggleDoneOpen}
                    aria-expanded={doneOpen}
                    className={`flex w-full items-center gap-1 px-3 pb-2 pt-3 font-medium uppercase tracking-wide text-ink/50 transition-colors hover:text-ink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 sm:pb-1 sm:pt-2.5 ${T_META}`}
                  >
                    <ChevronRight
                      size={10}
                      className={`shrink-0 transition-transform ${doneOpen ? "rotate-90" : ""}`}
                    />
                    Done · {agedEpics.length}
                  </button>
                  {doneOpen && agedEpics.map((e) => renderEpicEntry(e, true))}
                </div>
              )}
            </div>
          </aside>

          {/* Main area: ONE kanban, always scoped to the sidebar selection. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {scopedEpic && renderScopeHeader(scopedEpic)}
            {renderSearchHits()}
            {/* Mobile lane switcher (TDM-86) — the navigation the single-column
                board needs. Below md exactly one lane is on screen, so the strip
                is also the only place every lane's count is visible; it doubles
                as the board's census. A scroll strip rather than five rigid
                thirds: "Proposed 12" must not truncate to make room. */}
            <div
              ref={switcherRef}
              className="tandem-scroll flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-ink/10 px-4 py-2 md:hidden"
              aria-label="Board columns"
            >
              {columnBuckets.map(({ col, all, shown }) => {
                const selected = col.key === activeCol;
                return (
                  <button
                    key={col.key}
                    data-col-key={col.key}
                    onClick={() => setMobileCol(col.key)}
                    aria-pressed={selected}
                    className={[
                      "flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                      T_BTN,
                      TAP,
                      selected
                        ? "border-accent/40 bg-accent/[0.08] text-accent"
                        : "border-ink/15 text-ink/60",
                    ].join(" ")}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: col.dot, opacity: shown.length === 0 ? 0.35 : 1 }}
                    />
                    {col.short}
                    <span className={`font-code ${selected ? "text-accent/70" : "text-ink/45"}`}>
                      {filtering ? `${shown.length}/${all.length}` : shown.length}
                    </span>
                    {/* A phone shows ONE lane, so the switcher is where a stalled
                        worker has to be visible from whichever lane you're on —
                        otherwise the signal is hidden behind a tap. */}
                    {col.key === "working" && stalledCount > 0 && (
                      <span
                        className="inline-flex shrink-0 items-center gap-0.5 font-code text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                        aria-label={`${stalledCount} with a lapsed claim lease`}
                      >
                        <Timer size={10} className="shrink-0" aria-hidden="true" />
                        {stalledCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {/* Kanban: on md+ the whole strip scrolls horizontally and each
                column scrolls its own cards; empty columns collapse to a slim
                rail. Below md the strip does NOT scroll sideways at all — the
                switcher above picks the one lane, which fills the width. Under a
                filter, cards simply vanish and the header shows shown/total
                (within the scope). */}
            <div ref={kanbanRef} className="min-h-0 flex-1 overflow-x-hidden md:overflow-x-auto">
              <div className="flex h-full gap-3 py-3 pl-4 pr-4">
                {columnBuckets.map(({ col, all: colAll, shown: colTasks }) => {
                  const slim = colTasks.length === 0;
                  const showState = col.states.length > 1;
                  return (
                    <div
                      key={col.key}
                      className={[
                        "min-h-0 w-full min-w-0 flex-col md:flex md:shrink-0",
                        // Below md: only the switcher's lane is mounted visible.
                        col.key === activeCol ? "flex" : "hidden",
                        slim ? "md:w-44" : "md:w-[17rem]",
                      ].join(" ")}
                    >
                      <div className="mb-2 flex shrink-0 items-center gap-1.5 px-1">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: col.dot, opacity: slim ? 0.35 : 1 }}
                        />
                        <span
                          className={`truncate font-medium uppercase tracking-wide ${T_HEAD} ${slim ? "text-ink/50" : "text-ink/60"}`}
                        >
                          {col.label}
                        </span>
                        <span className={`shrink-0 font-code text-ink/50 ${T_META}`}>
                          {filtering ? `${colTasks.length}/${colAll.length}` : colTasks.length}
                        </span>
                        {/* "N stalled" (TDM-101) — how many of this lane's claims
                            have run past their lease. The lane label is the
                            cheapest place on the board to read it: five lanes
                            side by side and one of them says a number in amber. */}
                        {col.key === "working" && stalledCount > 0 && (
                          <span
                            title={`${stalledCount} claim${stalledCount === 1 ? "" : "s"} here have run past the 15-minute lease with no report — any agent asking for the task takes it over`}
                            className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-[4px] bg-amber-500/10 px-1.5 py-px font-semibold text-amber-600 dark:text-amber-400 ${T_META}`}
                          >
                            <Timer size={10} className="shrink-0" aria-hidden="true" />
                            {stalledCount} stalled
                          </span>
                        )}
                        {/* Bulk triage on the lane header. "Approve all" is the
                            whole column in one approve-batch call; "Select" is
                            the way INTO a partial one — and on touch it is the
                            only way in, since shift-click has no finger
                            equivalent (TDM-164). While a selection is up the
                            pair collapses to "Done": the bulk bar below carries
                            the verbs, and offering "Approve all" beside
                            "Approve 8" is two buttons a keystroke apart that do
                            different things to different tickets. */}
                        {col.key === "proposed" && !readOnly && colAll.length > 1 && (
                          <div className="ml-auto flex shrink-0 items-center gap-0.5">
                            {selecting ? (
                              <button
                                onClick={clearSelection}
                                className={`rounded-md px-1.5 py-1 font-semibold text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:py-0.5 ${T_META}`}
                              >
                                Done
                              </button>
                            ) : (
                              <>
                                <button
                                  onClick={() => setSelectMode(true)}
                                  title="Pick tickets to approve or reject together"
                                  className={`flex items-center gap-1 rounded-md px-1.5 py-1 font-semibold text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:py-0.5 ${T_META}`}
                                >
                                  <ListChecks size={11} className="shrink-0" />
                                  Select
                                </button>
                                <button
                                  onClick={() => approveAllProposed(colAll.map((t) => t.id))}
                                  disabled={batchBusy}
                                  title="Approve every proposed task in this scope in one batch"
                                  className={`rounded-md px-1.5 py-1 font-semibold text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 sm:py-0.5 ${T_META}`}
                                >
                                  {batchBusy ? "Approving…" : `Approve all ${colAll.length}`}
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      {slim ? (
                        /* On md+ this is a slim rail among four populated lanes —
                           the emptiness is self-evident from the neighbours, so
                           it stays wordless. On mobile it is the ENTIRE screen,
                           and a bare dashed rectangle reads as a failure to
                           load, so the one lane on show says what it is. */
                        <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-ink/10 p-6">
                          <p className={`text-center text-ink/40 md:hidden ${T_HEAD}`}>
                            {filtering
                              ? `Nothing in ${col.label} matches the filters`
                              : `Nothing in ${col.label}`}
                          </p>
                        </div>
                      ) : (
                        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2 pr-0.5">
                          {colTasks.map((t) =>
                            renderCard(t, showState, effectiveScope === "all", col.key),
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <TaskDetail
          key={detail.id}
          code={code}
          action={detail}
          state={state}
          epicTitleById={epicTitleById}
          readOnly={readOnly}
          onOpenTicket={onOpenTicket}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   TaskDetail — the wave-2 detail / step-in side panel. Renders the LIVE action
   (props come from canvas state, so WS pushes update it in place) and offers
   exactly the state's legal human moves:
     · proposed  — edit title/body, toggle requiresApproval, approve / reject
     · executing — release the stuck claim
     · failed    — error shown + re-queue (failed → approved, error cleared)
     · done / rejected — read-only history
   Destructive moves (reject / release / re-queue) confirm inline, two-step.
   ──────────────────────────────────────────────────────────────────────────── */

// The two-step confirms that are NOT state moves: rejecting (the gate) and
// deleting (gone for everyone). State moves have their own strip — see
// TaskDetail's renderMoves, which carries the optional note as well as the
// confirm, since "are you sure" and "say why" are the same beat.
type DetailConfirm = "reject" | "delete" | null;

// Resolve a linked entity id to a human label using the same canvas state the
// board already receives — roadmap items by title, notes by first line.
function linkLabel(state: CanvasState, id: string): { kind: string; label: string } | null {
  const r = (state.roadmapItems ?? {})[id];
  if (r) return { kind: "goal", label: r.title || "Untitled goal" };
  const n = (state.notes ?? {})[id];
  if (n) {
    const first = (n.body ?? "").split("\n")[0].replace(/^#+\s*/, "").slice(0, 60);
    return { kind: "note", label: first || "Untitled note" };
  }
  return null;
}

function TaskDetail({
  code,
  action,
  state,
  epicTitleById,
  readOnly,
  onOpenTicket,
  onClose,
}: {
  code: string;
  action: Action;
  state: CanvasState;
  epicTitleById: Map<string, string>;
  readOnly: boolean;
  /** Leave the slide-over for the ticket's own page (/c/CODE/ticket/TDM-n). */
  onOpenTicket?: (ticketId: string) => void;
  onClose: () => void;
}) {
  const isTask = action.type === "task";
  const p = taskPayload(action); // epics read title/body through the same shape
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DetailConfirm>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(p.title ?? "");
  const [editBody, setEditBody] = useState(p.body ?? "");
  // The epic summary editor (TDM-93) — separate from the title/body editor
  // above on purpose. Title and body are CONTENT: editing them on an approved
  // epic revokes the approval its tasks inherit. `summary` is not, so it is the
  // one field a human can write on a finished batch without disturbing it, and
  // bundling the two into one Save would have made the safe edit dangerous.
  const epicSummary = ((action.payload ?? {}) as EpicPayload).summary ?? "";
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState(epicSummary);
  // The state move waiting on its confirm (and its note), or null.
  const [pendingMove, setPendingMove] = useState<HumanMove | null>(null);
  const [moveNote, setMoveNote] = useState("");

  const commits = extractCommits(action.result);
  // The panel's own lease clock (TDM-101). It can sit open for a whole lease
  // window, and a heartbeat age frozen at the instant the panel opened is worse
  // than no age at all — this is the one surface where a person decides whether
  // to release a claim.
  const now = useFreshnessNow();
  const lease = deriveLease(action, now);
  const epicTitle = isTask && p.epicId ? epicTitleById.get(p.epicId) : undefined;
  // The last edit that cost an approval, if any — epics are gated the same way,
  // so this reads through the shared payload shape too.
  const reapproval = lastReapprovalEdit(p);
  // Collisions on this task (TDM-100). Read off the payload the panel already
  // holds, so it stays live with the socket like everything else here.
  const contentionEvents = isTask ? ((p as TaskPayload).contention ?? []) : [];
  const contention = tallyContention(contentionEvents);

  // aria-modal contract: move focus INTO the dialog on open, keep Tab cycling
  // inside it, and hand focus back to the opener on close. The component
  // remounts per action (key={detail.id} upstream), so mount/unmount is
  // exactly open/close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // The panel reads the LIVE action, so the task can move under an open move
  // strip — an agent completes it, or another tab releases it. Disarm when that
  // happens: a "Mark done" confirm still sitting on a task that is already done
  // would send a move the API now (correctly) refuses.
  useEffect(() => {
    setPendingMove(null);
    setMoveNote("");
  }, [action.state]);

  function trapTab(e: ReactKeyboardEvent) {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const current = document.activeElement;
    if (e.shiftKey) {
      if (current === first || current === root) {
        e.preventDefault();
        last.focus();
      }
    } else if (current === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  // Content edits REPLACE the payload server-side, so every field the editor
  // doesn't touch must round-trip or it silently disappears.
  // A payload PATCH REPLACES the payload, so an edit must round-trip everything
  // it isn't changing. Spreading the whole stored payload (rather than naming
  // fields) is what keeps that true as the payload grows: a task that has been
  // executing carries CI progress and evidence links, and a reverted task
  // reaches this editor still holding both. Listing fields by hand meant every
  // human edit quietly deleted the ones nobody remembered to add.
  //
  // `audit` rides along too and is harmless — the server ignores whatever a
  // caller sends under it and re-attaches its own copy (TDM-41).
  function draftFrom(overrides: Partial<TaskPayload>): TaskPayload {
    return { ...p, title: p.title ?? "", ...overrides };
  }

  function saveEdit() {
    const title = editTitle.trim();
    if (!title) return;
    void run(async () => {
      await updateTask(code, action.id, draftFrom({ title, body: editBody.trim() || undefined }));
      setEditing(false);
    });
  }

  // Writes ONLY `summary`, carrying the rest of the payload through draftFrom.
  // Because title/body are untouched, the server's content gate reads this as a
  // bookkeeping write: no re-approval, no released claim (see content_gate.go).
  function saveSummary() {
    const next = summaryDraft.trim();
    void run(async () => {
      await updateTask(code, action.id, draftFrom({ summary: next || undefined } as Partial<TaskPayload>));
      setSummaryEditing(false);
    });
  }

  function toggleRequiresApproval() {
    void run(async () => {
      await updateTask(code, action.id, draftFrom({ requiresApproval: !p.requiresApproval || undefined }));
    });
  }

  function approve() {
    void run(async () => {
      await approveAction(code, action.id);
      posthog.capture(isTask ? "agent_task_approved" : "epic_approved", {
        canvas_code: code,
        surface: "board_detail",
      });
    });
  }

  function reject() {
    void run(async () => {
      await rejectAction(code, action.id);
      setConfirm(null);
    });
  }

  // ── Human state moves (E10) ───────────────────────────────────────────────
  // One call for every move — start, complete, mark failed, release, re-queue,
  // reopen, reconsider. The legal set comes from lib/taskMoves (the client's
  // mirror of the API matrix) and the API re-validates it, so this panel cannot
  // offer a move the server will refuse.

  function goMove(move: HumanMove) {
    void run(async () => {
      const from = action.state;
      await moveTask(code, action.id, move.to, moveNote.trim() || undefined);
      posthog.capture("task_moved", {
        canvas_code: code,
        from,
        to: move.to,
        assignee: p.assignee ?? "agent",
        noted: moveNote.trim().length > 0,
        surface: "board_detail",
      });
      // The requeue funnel predates this control; keep feeding it so the
      // existing analytics don't silently go to zero.
      if (from === "failed" && move.to === "approved") {
        posthog.capture("agent_task_requeued", { canvas_code: code });
      }
      setPendingMove(null);
      setMoveNote("");
    });
  }

  // A move fires immediately when it is plain and forward (Start). Anything
  // that takes a note, and every rewind — which discards the last attempt's
  // result — gets the strip first.
  function startMove(move: HumanMove) {
    setConfirm(null);
    if (move.notePrompt || move.kind === "rewind") {
      setMoveNote("");
      setPendingMove(move);
      return;
    }
    goMove(move);
  }

  function cancelMove() {
    setPendingMove(null);
    setMoveNote("");
  }

  function doDelete() {
    void run(async () => {
      await deleteTask(code, action.id);
      posthog.capture("agent_task_deleted", { canvas_code: code });
      onClose();
    });
  }

  // Two-step confirm strip for a destructive move (mirrors the board's reject).
  function confirmStrip(kind: Exclude<DetailConfirm, null>, message: string, label: string, onGo: () => void) {
    if (confirm !== kind) return null;
    // Below sm the question takes its own line: a destructive confirm must be
    // readable before it is tappable, and squeezing prose + two buttons into a
    // 390px row leaves the prose one word wide.
    return (
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink/60">{message}</span>
        <div className="flex shrink-0 gap-1.5">
          <button
            onClick={onGo}
            disabled={busy}
            className={`flex flex-1 items-center justify-center rounded-md bg-rose-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-40 sm:flex-none ${TAP}`}
          >
            {label}
          </button>
          <button
            onClick={() => setConfirm(null)}
            className={`flex flex-1 items-center justify-center rounded-md border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/60 hover:border-ink/30 sm:flex-none ${TAP}`}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // The step-in controls. `TAP` matters most HERE: this footer is where a
  // person moves a task by hand, and on a phone the row is three ~30px buttons
  // side by side unless the floor is applied. `flex-1` on the quiet buttons too
  // below sm — three equal thirds beat one wide button and two slivers.
  const primaryBtn = `flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${TAP}`;
  const quietBtn = `flex flex-1 items-center justify-center gap-1 rounded-md border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/60 transition-colors hover:border-ink/30 disabled:opacity-40 sm:flex-none ${TAP}`;

  // The state's legal human moves — or, once one is armed, its confirm strip
  // with the optional note. Reads entirely off the shared matrix: a move added
  // in lib/taskMoves (and the API's) appears here with no change below.
  function renderMoves() {
    if (!isTask) return null;
    const moves = humanMovesFor(action.state);
    if (moves.length === 0) return null; // 'proposed' — the gate is above
    if (pendingMove) {
      return (
        <div className="flex flex-col gap-2">
          <p className="text-[12px] leading-snug text-ink/60">{pendingMove.hint}.</p>
          {pendingMove.notePrompt && (
            <input
              autoFocus
              value={moveNote}
              onChange={(e) => setMoveNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") goMove(pendingMove);
                if (e.key === "Escape") cancelMove();
              }}
              placeholder={pendingMove.notePrompt}
              className={`w-full rounded-md border border-ink/15 bg-surface px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink/30 focus:border-accent/50 focus:ring-2 focus:ring-accent/40 ${TAP}`}
            />
          )}
          <div className="flex gap-1.5">
            <button onClick={() => goMove(pendingMove)} disabled={busy} className={primaryBtn}>
              {busy ? "Working…" : pendingMove.label}
            </button>
            <button onClick={cancelMove} className={quietBtn}>
              Cancel
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap gap-1.5">
        {moves.map((m, i) => (
          <button
            key={`${m.to}-${m.label}`}
            onClick={() => startMove(m)}
            disabled={busy}
            title={m.hint}
            className={i === 0 && m.kind === "forward" ? primaryBtn : quietBtn}
          >
            {moveIcon(m)} {m.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[2000] flex justify-end bg-ink/25"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${action.ticketId ? `${action.ticketId} — ` : ""}${p.title || "Task detail"}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
        className="flex h-full w-full max-w-xl flex-col border-l border-ink/10 bg-surface shadow-lg focus-visible:outline-none"
      >
        {/* Header: ticket + state + close. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-ink/10 px-4 py-3">
          {action.ticketId &&
            (onOpenTicket ? (
              /* The slide-over is a step-in panel over the board; this is the
                 way out to the ticket's own page — the linkable, full record. */
              <a
                href={`/c/${code}/ticket/${action.ticketId}`}
                onClick={spaLink(() => onOpenTicket(action.ticketId as string))}
                title={`Open ${action.ticketId} as its own page`}
                className="shrink-0 rounded-[3px] font-code text-[12px] font-medium tracking-tight text-ink/50 transition-colors hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {action.ticketId}
              </a>
            ) : (
              <span className="shrink-0 font-code text-[12px] font-medium tracking-tight text-ink/50">
                {action.ticketId}
              </span>
            ))}
          {!isTask && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-ink/10 bg-ink/[0.03] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em] text-ink/50">
              <Layers size={10} /> Epic
            </span>
          )}
          <StateChip state={action.state} />
          {isTask && p.requiresApproval && action.state === "proposed" && (
            <span
              className={`${CHIP_BASE} bg-amber-500/10 text-amber-600 dark:text-amber-400`}
              title="The agent flagged this task as needing explicit approval"
            >
              needs approval
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {/* The ref above is the address, but it reads as a label — a
                monospace chip nobody thinks to click. This is the same
                destination said out loud, so the way OUT of the step-in panel
                to the ticket's own page is visible without a hover. Unticketed
                actions have no page to open, so they get no control at all
                rather than a dead one. */}
            {action.ticketId && onOpenTicket && (
              <a
                href={`/c/${code}/ticket/${action.ticketId}`}
                onClick={spaLink(() => onOpenTicket(action.ticketId as string))}
                title={`Open ${action.ticketId} as its own page`}
                aria-label={`Open ${action.ticketId} as its own page`}
                className="flex h-11 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-ink/45 transition-colors hover:bg-ink/5 hover:text-ink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-7"
              >
                <Maximize2 size={13} />
                <span className="hidden sm:inline">Full page</span>
              </a>
            )}
            {/* On a phone this slide-over is the whole screen, so its close
                button is the only way out — it gets the touch floor, not the
                dense desktop 28px. */}
            <button
              onClick={onClose}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink/70 sm:h-7 sm:w-7"
              aria-label="Close"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* --tandem-pb-base = the py-3 this surface would have had; the safe-area
            strip is added on top so the provenance footer clears the iOS home
            indicator when there are no step-in controls under it. */}
        <div className="tandem-safe-pb-plus min-h-0 flex-1 overflow-y-auto px-4 pt-3 [--tandem-pb-base:0.75rem]">
          {/* Title + body — inline edit while proposed. */}
          {editing ? (
            <div className="flex flex-col gap-2">
              <input
                autoFocus
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                placeholder="Task title"
                className="w-full rounded-md border border-ink/15 bg-surface px-2.5 py-1.5 text-sm font-semibold text-ink outline-none placeholder:text-ink/30 focus:border-accent/50 focus:ring-2 focus:ring-accent/40"
              />
              <textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                placeholder="Brief: what, why, acceptance criteria (optional)"
                rows={10}
                className="w-full resize-y rounded-md border border-ink/15 bg-surface px-2.5 py-1.5 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink/30 focus:border-accent/50 focus:ring-2 focus:ring-accent/40"
              />
              <div className="flex gap-1.5">
                <button onClick={saveEdit} disabled={!editTitle.trim() || busy} className={primaryBtn}>
                  {busy ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setEditTitle(p.title ?? "");
                    setEditBody(p.body ?? "");
                  }}
                  className={quietBtn}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* The title is the thing a reader actually aims at, so it is the
                  link out to the ticket's own page — not just the monospace ref
                  in the header, which reads as a label. Unticketed actions have
                  no page to open, so they stay plain text rather than a dead
                  link. A real <a>, so cmd/middle-click opens a new tab. */}
              <h2 className="text-[16px] font-semibold leading-snug text-ink">
                {action.ticketId && onOpenTicket ? (
                  <a
                    href={`/c/${code}/ticket/${action.ticketId}`}
                    onClick={spaLink(() => onOpenTicket(action.ticketId as string))}
                    title={`Open ${action.ticketId} as its own page`}
                    className="rounded-[3px] decoration-ink/25 underline-offset-[3px] transition-colors hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    {p.title || "Untitled"}
                  </a>
                ) : (
                  p.title || "Untitled"
                )}
              </h2>
              {p.body && (
                <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-ink/70">
                  {p.body}
                </p>
              )}
            </>
          )}

          {/* Why this is back in triage. Sits directly under the content it is
              about — it changes how you read the title above it, so it must not
              be further down the panel than the thing it qualifies. */}
          {!editing && action.state === "proposed" && reapproval && (
            <ReapprovalNotice edit={reapproval} />
          )}

          {/* What this BATCH achieved (TDM-93) — epics only, and the one place a
              human writes it. Read by the board header above its tickets, by
              board_status, and by the connect briefing, so this field is how the
              batch-level answer gets to every reader at once. */}
          {!isTask && !editing && (
            <div className="mt-3 rounded-md border border-ink/10 bg-ink/[0.02] px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink/45">
                  What this batch achieved
                </span>
                {!readOnly && !summaryEditing && (
                  <button
                    onClick={() => {
                      setSummaryDraft(epicSummary);
                      setSummaryEditing(true);
                    }}
                    className="ml-auto shrink-0 text-[11px] font-medium text-ink/50 transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    {epicSummary ? "Edit" : "Write it"}
                  </button>
                )}
              </div>
              {summaryEditing ? (
                <div className="mt-1.5 flex flex-col gap-2">
                  <textarea
                    autoFocus
                    value={summaryDraft}
                    onChange={(ev) => setSummaryDraft(ev.target.value)}
                    placeholder="What did this batch deliver? What shipped, what changed, what was decided — a paragraph a reader can trust instead of opening every ticket."
                    rows={6}
                    className="w-full resize-y rounded-md border border-ink/15 bg-surface px-2.5 py-1.5 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink/30 focus:border-accent/50 focus:ring-2 focus:ring-accent/40"
                  />
                  <div className="flex items-center gap-1.5">
                    <button onClick={saveSummary} disabled={busy} className={primaryBtn}>
                      {busy ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={() => {
                        setSummaryEditing(false);
                        setSummaryDraft(epicSummary);
                      }}
                      className={quietBtn}
                    >
                      Cancel
                    </button>
                    {/* The reassurance that makes this editable at all: unlike
                        the title/body above, saving here costs nothing. */}
                    <span className="ml-1 text-[11px] text-ink/40">
                      Doesn't affect approval
                    </span>
                  </div>
                </div>
              ) : epicSummary ? (
                <>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink/75">
                    {epicSummary}
                  </p>
                  {(() => {
                    const ep = (action.payload ?? {}) as EpicPayload;
                    if (!ep.summaryBy && !ep.summaryAt) return null;
                    return (
                      <div className="mt-1.5 font-code text-[10.5px] text-ink/40">
                        {ep.summaryBy ?? "unknown"}
                        {ep.summaryAt && (
                          <span title={fullDate(ep.summaryAt)}> · {ageOf(ep.summaryAt)} ago</span>
                        )}
                      </div>
                    );
                  })()}
                </>
              ) : (
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink/45">
                  Nothing recorded yet. An agent can write this when it finishes the last task in
                  the batch (task_complete's <code className="font-code">epicSummary</code>) — or
                  write it here.
                </p>
              )}
            </div>
          )}

          {/* Epic membership. */}
          {epicTitle && (
            <div className="mt-3 flex items-center gap-1.5 text-[12px] text-ink/55">
              <Layers size={12} className="shrink-0" />
              <span className="truncate">{epicTitle}</span>
            </div>
          )}

          {/* Linked context — resolved against the same canvas state the board
              renders from; ids that aren't on this canvas render raw with a
              tooltip so provenance is never silently dropped. */}
          {(p.linkedIds ?? []).length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink/50">
                Linked context
              </div>
              <div className="flex flex-wrap gap-1">
                {(p.linkedIds ?? []).map((id) => {
                  const link = linkLabel(state, id);
                  return link ? (
                    <span
                      key={id}
                      className="inline-flex max-w-full items-center gap-1 rounded-[4px] border border-ink/10 bg-ink/[0.03] px-1.5 py-0.5 text-[11px] text-ink/60"
                    >
                      <Link2 size={10} className="shrink-0" />
                      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-ink/50">
                        {link.kind}
                      </span>
                      <span className="truncate">{link.label}</span>
                    </span>
                  ) : (
                    <span
                      key={id}
                      title="Linked item is not on this canvas (deleted, or from another surface)"
                      className="inline-flex max-w-full items-center gap-1 rounded-[4px] border border-dashed border-ink/15 px-1.5 py-0.5 font-code text-[10px] text-ink/50"
                    >
                      <Link2 size={10} className="shrink-0" />
                      <span className="truncate">{id}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Claim: who holds it, how recently they said anything, and how much
              lease they have left.

              NOTE on the wording. `claimedAt` is not "when they started" for a
              task in flight — every heartbeat pushes it forward (it IS the lease
              stamp), so the honest reading of its age is "silent for", which is
              what the lease chip says. Only a task that has LEFT executing has a
              claimedAt that still means the moment it was taken, so that's the
              only case that keeps the plain "claimed Xm ago". */}
          {action.claimedBy && (action.state === "executing" || action.claimedAt) && (
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
              <ClaimantChip name={action.claimedBy} />
              {action.state === "executing" ? (
                <>
                  <LeaseChip lease={lease} />
                  {lease.health !== "none" && (
                    <span className="text-[11px] text-ink/45">
                      {lease.reclaimable
                        ? `lease lapsed ${leaseAge(lease.overdueMs)} ago`
                        : `lease good for ${leaseAge(lease.remainingMs)}`}
                    </span>
                  )}
                </>
              ) : (
                action.claimedAt && (
                  <span className="text-[11px] text-ink/50" title={fullDate(action.claimedAt)}>
                    claimed {ageOf(action.claimedAt)} ago
                  </span>
                )
              )}
            </div>
          )}

          {/* Who ELSE went for it (TDM-100). Directly under the claim, because
              "worker-a holds this" and "worker-b tried and yielded" are one story
              read in order. The panel gets the marker plus a plain-language line;
              the full event list lives on the ticket page, which is where someone
              goes to read a task's history rather than to act on it. */}
          {contention.total > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <ContentionMark tally={contention} events={contentionEvents} />
              <span className="min-w-0 text-[11px] leading-relaxed text-ink/50">
                {contention.fenced > 0
                  ? `${contention.fenced} write${contention.fenced === 1 ? "" : "s"} refused — an agent came back after its lease had gone`
                  : `${contention.raced} agent${contention.raced === 1 ? "" : "s"} asked for this and yielded`}
              </span>
            </div>
          )}

          {/* Result — commit hashes surfaced as monospace chips. */}
          {action.result && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink/50">
                Result
              </div>
              <p className="whitespace-pre-wrap rounded-md bg-emerald-500/10 px-2.5 py-2 text-[12.5px] leading-relaxed text-emerald-700 dark:text-emerald-300">
                {action.result}
              </p>
              {commits.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {commits.map((c) => (
                    <span
                      key={c}
                      title="Commit referenced in the result"
                      className="inline-flex items-center gap-1 rounded-[4px] border border-emerald-600/20 bg-emerald-500/10 px-1.5 py-0.5 font-code text-[10.5px] text-emerald-600 dark:text-emerald-400"
                    >
                      <GitCommitHorizontal size={10} className="shrink-0" />
                      {c.length > 12 ? c.slice(0, 12) : c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Failure / rejection detail. */}
          {(action.state === "failed" || action.state === "rejected") && action.error && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink/50">
                {action.state === "failed" ? "Error" : "Rejection reason"}
              </div>
              <p className="whitespace-pre-wrap rounded-md bg-rose-500/10 px-2.5 py-2 text-[12.5px] leading-relaxed text-rose-700 dark:text-rose-300">
                {action.error}
              </p>
            </div>
          )}

          {/* Evidence (TDM-45) — the links the completion carried, each resolved
              against GitHub. Below the result and the error because it backs
              BOTH: a failed task's CI run link belongs here too. Always live:
              you opened this panel to find out. */}
          {(p.links ?? []).length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink/50">
                Evidence
              </div>
              <TaskLinks code={code} links={p.links} live boxed />
            </div>
          )}

          {/* Provenance + timestamps. */}
          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-ink/10 pt-3 text-[11px] text-ink/50">
            <span className="inline-flex items-center gap-1">
              {isTask && p.assignee === "human" ? (
                <>
                  <User size={11} /> your todo
                </>
              ) : (
                <>
                  <Bot size={11} /> proposed by {action.proposedBy}
                </>
              )}
            </span>
            {/* Which gate it passed (TDM-147). The raw stamp used to be printed
                here verbatim, which said "approved by policy:epic" to a person
                who wanted to know whether anyone had actually looked. */}
            <ApprovalLine approvedBy={action.approvedBy} />
            {/* The claimed label above is whatever the caller sent; this is what
                the server derived from how the request authenticated. Sitting
                them side by side is the point. */}
            <ProvenanceChip authoredBy={action.authoredBy} verbose />
            <span className="ml-auto" title={fullDate(action.createdAt)}>
              created {ageOf(action.createdAt)} ago
            </span>
          </div>
        </div>

        {/* Step-in controls: exactly the current state's legal human moves. */}
        {!readOnly && !editing && (
          <div className="tandem-safe-pb-plus shrink-0 border-t border-ink/10 px-4 pt-3 [--tandem-pb-base:0.75rem]">
            {error && (
              <div className="mb-2 rounded-md border border-rose-500/20 bg-rose-500/10 px-2.5 py-1.5 text-[12px] text-rose-600 dark:text-rose-400">
                {error}
              </div>
            )}
            {action.state === "proposed" &&
              (confirm === "reject" ? (
                confirmStrip("reject", `Reject this ${isTask ? "task" : "epic"}?`, "Reject", reject)
              ) : (
                <div className="flex flex-col gap-2">
                  {/* One control, not a 14px box with a label loosely wired to
                      it: the whole row is the switch, so the tap area is the
                      full width at the touch floor instead of a checkbox you
                      have to hit dead centre. */}
                  {isTask && (
                    <button
                      onClick={toggleRequiresApproval}
                      disabled={busy}
                      role="switch"
                      aria-checked={!!p.requiresApproval}
                      className={`flex w-full items-center gap-2 rounded-md text-left text-[12px] text-ink/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${TAP}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
                          p.requiresApproval
                            ? "border-accent bg-accent"
                            : "border-ink/25 bg-transparent"
                        }`}
                      >
                        {p.requiresApproval && <Check size={10} className="text-white" />}
                      </span>
                      <span className="min-w-0">
                        Requires explicit approval (won't auto-flow with its epic)
                      </span>
                    </button>
                  )}
                  <div className="flex gap-1.5">
                    <button onClick={approve} disabled={busy} className={primaryBtn}>
                      <Check size={13} /> {isTask ? "Approve" : "Approve epic"}
                    </button>
                    {isTask && (
                      <button onClick={() => setEditing(true)} disabled={busy} className={quietBtn}>
                        <Pencil size={12} /> Edit
                      </button>
                    )}
                    <button onClick={() => setConfirm("reject")} disabled={busy} className={quietBtn}>
                      <X size={13} /> Reject
                    </button>
                  </div>
                </div>
              ))}
            {/* The lapsed-lease explainer, immediately above the moves — and
                Release is one of them. "Another agent is about to take this
                over" and "you can put it back in the queue yourself" are one
                decision, so they are one block on the screen. Suppressed while a
                move is armed: the confirm strip replaces the buttons, and a
                paragraph above a live confirm is competition, not context. */}
            {!pendingMove && <LeaseNotice lease={lease} canRelease className="mb-2" />}
            {/* Every legal human move out of this state, from one matrix —
                start / mark done / mark failed on a task in flight, release a
                claim, re-queue a failure, reopen a done task, reconsider a
                rejected one. 'proposed' renders nothing here: the approval
                controls above are its only exit. */}
            {renderMoves()}
            {/* Delete — available in every state. Quiet by default, two-step
                like the other destructive moves. */}
            {isTask &&
              (confirm === "delete" ? (
                <div className="mt-2">
                  {confirmStrip("delete", "Delete this task for everyone?", "Delete", doDelete)}
                </div>
              ) : (
                <button
                  onClick={() => setConfirm("delete")}
                  disabled={busy}
                  className={`mt-2 flex w-full items-center justify-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-ink/40 transition-colors hover:bg-rose-500/10 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 dark:hover:text-rose-400 ${TAP}`}
                >
                  <Trash2 size={12} /> Delete task
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
