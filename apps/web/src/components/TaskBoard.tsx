import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  GitCommitHorizontal,
  Layers,
  Link2,
  Milestone,
  Pencil,
  PenLine,
  Play,
  Plus,
  RotateCcw,
  Search,
  Shield,
  SlidersHorizontal,
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
import { parseAuthoredBy, provenanceTitle } from "../lib/provenance";
import { auditActorLabel, auditChangeLabel, lastReapprovalEdit } from "../lib/taskAudit";
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

// Approve / Reject pair for a proposed task or epic. Reject is two-step (the
// confirm replaces the pair) — no reason field here; the sidebar keeps the
// full reject-with-reason form. stopPropagation so the card click-through to
// the detail panel doesn't fire.
function ApproveRejectControls({
  busy,
  rejecting,
  approveLabel = "Approve",
  onApprove,
  onReject,
  setRejecting,
}: {
  busy: boolean;
  rejecting: boolean;
  approveLabel?: string;
  onApprove: () => void;
  onReject: () => void;
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
            onClick={() => setRejecting(true)}
            disabled={busy}
            className={`flex flex-1 items-center justify-center gap-1 rounded-md border border-ink/15 px-2 py-1 font-medium text-ink/60 transition-colors hover:border-ink/30 disabled:opacity-40 ${T_BTN} ${TAP}`}
          >
            <X size={12} /> Reject
          </button>
        </>
      )}
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
  const [detailId, setDetailId] = useState<string | null>(null);
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
    setSearchInput("");
    setQuery("");
    setFilters(NO_FILTERS);
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

  // One predicate, AND-composed — applied WITHIN the selected scope.
  function taskMatches(t: Action): boolean {
    const p = taskPayload(t);
    if (query) {
      const hay = `${p.title ?? ""}\n${p.body ?? ""}\n${t.result ?? ""}\n${t.ticketId ?? ""}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
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

  async function run(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
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

  function approve(a: Action) {
    void run(a.id, async () => {
      await approveAction(code, a.id);
      posthog.capture(a.type === "epic" ? "epic_approved" : "agent_task_approved", {
        canvas_code: code,
        surface: "board",
      });
    });
  }

  function reject(a: Action) {
    void run(a.id, async () => {
      await rejectAction(code, a.id);
      setRejectingId(null);
    });
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

  // TDM-14: consume the one-shot focus handoff from the header agent presence.
  // Scope the board to the task's epic (or "No epic" for epicless tasks, unless
  // the All-tasks lens already shows it), open its detail slide-over, and scroll
  // its card into view — then hand the token back so normal browsing resumes.
  // If the task left `executing` meanwhile, this still opens it wherever it now
  // sits; a task that vanished entirely just clears the handoff.
  useEffect(() => {
    if (!focusTaskId) return;
    const t = (state.actions ?? {})[focusTaskId];
    if (t) {
      // "Follow this agent" is an unconditional jump: stale filters (a state
      // or claimant filter from earlier browsing) would hide the very card we
      // are about to scroll to (QA wave-3 finding 6).
      clearFilters();
      const eid = taskPayload(t).epicId;
      if (eid && epicIds.has(eid)) selectScope(eid);
      else if (effectiveScope !== "all") selectScope("none");
      // Mobile shows one lane at a time (TDM-86), so scoping is not enough —
      // bring the lane this task actually sits in forward, or the card we are
      // about to scroll to is in a `hidden` column.
      setMobileCol(colKeyForState(t.state));
      setDetailId(focusTaskId);
      // The card renders into the (possibly new) scope on the next paint —
      // scroll once the DOM has settled. Deliberately not cleaned up: the
      // handoff reset below re-runs this effect immediately, and a cleanup
      // would cancel the scroll before it fires.
      setTimeout(() => {
        document
          .querySelector(`[data-task-id="${CSS.escape(focusTaskId)}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 80);
    }
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
        } else if (filtering || searchInput) {
          clearFilters();
          searchRef.current?.blur();
        }
        return;
      }
      if (e.key === "/") {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
        e.preventDefault();
        searchRef.current?.focus();
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

  function renderApproveReject(a: Action, approveLabel?: string) {
    if (readOnly || a.state !== "proposed") return null;
    return (
      <ApproveRejectControls
        busy={busyId === a.id}
        rejecting={rejectingId === a.id}
        approveLabel={approveLabel}
        onApprove={() => approve(a)}
        onReject={() => reject(a)}
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
        onClick={() => setDetailId(t.id)}
        onKeyDown={(ev: ReactKeyboardEvent) => {
          // Keyboard parity with the sidebar rows: Enter/Space opens the detail
          // slide-over. Only when the card itself is focused — keys on inner
          // controls (approve/reject, epic chip) keep their own behaviour.
          if ((ev.key === "Enter" || ev.key === " ") && ev.target === ev.currentTarget) {
            ev.preventDefault();
            setDetailId(t.id);
          }
        }}
        className={`cursor-pointer rounded-lg border bg-surface p-2.5 transition-[border-color,box-shadow] hover:border-ink/25 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
          justLanded
            ? "tandem-card-land border-agent/40"
            : lease.health === "stale"
              ? "border-amber-500/40"
              : "border-ink/10"
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <span
            className={`min-w-0 font-semibold leading-snug ${T_TITLE} ${terminal ? "text-ink/55" : "text-ink"}`}
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
          {/* Record metadata, right-aligned as one group: who else went for it,
              who wrote it, when. All three are facts about the row rather than
              its status, so they read at the same dim weight — and the collision
              marker leads the group because it is the only one of the three that
              is ever news. */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <TaskContentionMark action={t} />
            <ProvenanceChip authoredBy={t.authoredBy} />
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
        {finished ? (
          <div className="mt-2 h-1.5 rounded-full bg-emerald-500" />
        ) : (
          <>
            <ProgressBar done={done} working={working} total={total} className="mt-2 h-1.5" />
            <div className="max-w-xs">{renderApproveReject(e, "Approve epic")}</div>
          </>
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
              placeholder='Search tasks  ·  "/"'
              className="h-9 w-full rounded-md border border-ink/15 bg-surface pl-[26px] pr-2 text-[12px] text-ink outline-none placeholder:text-ink/30 focus:border-accent/50 focus:ring-2 focus:ring-accent/40 md:h-7 md:w-52"
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
                        {/* Bulk triage: one approve-batch call for the whole
                            proposed column (within the current scope). */}
                        {col.key === "proposed" && !readOnly && colAll.length > 1 && (
                          <button
                            onClick={() => approveAllProposed(colAll.map((t) => t.id))}
                            disabled={batchBusy}
                            title="Approve every proposed task in this scope in one batch"
                            className={`ml-auto shrink-0 rounded-md px-1.5 py-1 font-semibold text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 sm:py-0.5 ${T_META}`}
                          >
                            {batchBusy ? "Approving…" : `Approve all ${colAll.length}`}
                          </button>
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
          {/* On a phone this slide-over is the whole screen, so its close button
              is the only way out — it gets the touch floor, not the dense
              desktop 28px. */}
          <button
            onClick={onClose}
            className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink/70 sm:h-7 sm:w-7"
            aria-label="Close"
          >
            <X size={15} />
          </button>
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
              <h2 className="text-[16px] font-semibold leading-snug text-ink">
                {p.title || "Untitled"}
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
            {action.approvedBy && <span>→ approved by {action.approvedBy}</span>}
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
