import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  Bot,
  Check,
  Compass,
  GitCommitHorizontal,
  Layers,
  Link2,
  MapPin,
  Milestone,
  Play,
  RotateCcw,
  SearchX,
  Shield,
  StickyNote,
  User,
  Users,
} from "lucide-react";
import type {
  Action,
  CanvasState,
  ContentAuditEntry,
  ContentionEvent,
  TaskPayload,
  TaskProgressEntry,
} from "../types";
import { CHIP_BASE, STATE_CHIP } from "../lib/stateChips";
import {
  auditActorLabel,
  auditChangeLabel,
  isStateMove,
  lastReapprovalEdit,
  moveVerbLabel,
  stateMoveNote,
} from "../lib/taskAudit";
import { deriveLease, leaseAge } from "../lib/lease";
import { eventLabel, eventSentence, repeatsOf, tallyContention } from "../lib/contention";
import { humanMovesFor, type HumanMove } from "../lib/taskMoves";
import { moveTask } from "../lib/api";
import posthog from "../lib/posthog";
import TaskLinks from "./TaskLinks";
import TandemLogo from "./TandemLogo";
import { useFreshnessNow } from "./Freshness";
import {
  ageOf,
  ApprovalLine,
  ClaimantChip,
  extractCommits,
  fullDate,
  ContentionMark,
  LeaseChip,
  LeaseNotice,
  ProvenanceChip,
  StateChip,
} from "./TaskBoard";
import { parseApproval } from "../lib/provenance";

/* ─────────────────────────────────────────────────────────────────────────────
   TicketView — the whole ticket, at its own URL: /c/CODE/ticket/TDM-n.

   The Board answers "what is the fleet doing"; a card there is a summary, and
   the detail slide-over is a step-in panel you open ON TOP of the board. This
   is the third thing, and the one a shareable link needs: a PAGE for one piece
   of work — the full brief rendered as markdown, its epic, the context it was
   handed, every progress report, the result and its receipts, and the record of
   who changed what after it was approved.

   It resolves the ticket string from the URL against the canvas state the WS
   connection already delivered — no fetch, no second source of truth, and it
   stays live: a claim or a completion landing over the socket re-renders this
   page in place, exactly like the board.

   Layout follows the reading order of a review: identity and title first, then
   the brief, then everything the work produced. The record facts (who, when,
   which epic) file into a right-hand rail on lg+ and fall in under the content
   on narrower screens — they qualify the ticket, they aren't the ticket.

   Design: Precision Canon (/DESIGN.md). Inter for everything human; JetBrains
   Mono strictly for machine text — the ticket id, commit hashes, timestamps,
   the canvas code, the audit trail's old→new quotations. Colour comes only from
   the closed six-hue state set (lib/stateChips), the single accent, and amber
   for the one thing that must interrupt you (re-approval). Every ground and
   hairline is a paper/surface/ink token, so dark mode needs no second pass.
   ──────────────────────────────────────────────────────────────────────────── */

const MARKDOWN_PLUGINS = [remarkGfm];

const EYEBROW = "text-[10px] font-medium uppercase tracking-wide text-ink/50";

function taskPayload(a: Action): TaskPayload {
  return (a.payload ?? {}) as TaskPayload;
}

/** Match the URL's ticket string to a task on this canvas. */
function findTicket(state: CanvasState | null, ref: string): Action | undefined {
  if (!state) return undefined;
  const want = ref.trim().toUpperCase();
  if (!want) return undefined;
  const actions = Object.values(state.actions ?? {}).filter((a) => a.type === "task");
  const byId = actions.find((a) => (a.ticketId ?? "").toUpperCase() === want);
  if (byId) return byId;
  // A bare number (or a prefix this deployment doesn't use) still resolves —
  // the sequential number is the identity, "TDM-" is only its display form.
  const digits = want.match(/(\d+)\s*$/)?.[1];
  if (!digits) return undefined;
  const n = Number(digits);
  return Number.isFinite(n) ? actions.find((a) => a.ticket === n) : undefined;
}

/** One label/value row in the record rail. */
function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <span className={EYEBROW}>{label}</span>
      <div className="min-w-0 text-[12.5px] leading-relaxed text-ink/75">{children}</div>
    </div>
  );
}

/** A titled block in the main column. */
function Section({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`mt-7 ${className}`}>
      <h2 className={`mb-2 ${EYEBROW}`}>{label}</h2>
      {children}
    </section>
  );
}

// A timestamp reads twice: the exact moment in the code face for the record,
// and "how long ago" for the human sense of it.
function Stamp({ at, className = "" }: { at: string; className?: string }) {
  return (
    <span className={`font-code text-[11px] text-ink/55 ${className}`} title={fullDate(at)}>
      {ageOf(at)} ago
    </span>
  );
}

// ── Progress log ─────────────────────────────────────────────────────────────
// The mid-flight reports whoever holds the task filed (MCP task_progress / the
// inbound status API). A vertical rail with a node per entry: this is the only
// place on the product where you can read a task's execution as a narrative,
// so it's typeset as one — oldest first, top to bottom.
function ProgressLog({ entries }: { entries: TaskProgressEntry[] }) {
  return (
    <ol className="relative flex flex-col gap-3 border-l border-ink/10 pl-4">
      {entries.map((e, i) => (
        <li key={`${e.at}-${i}`} className="relative">
          <span
            className="absolute -left-[21px] top-[5px] h-[7px] w-[7px] rounded-full bg-ink/25"
            aria-hidden="true"
          />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {(e.agent || e.by) && (
              <span className="text-[12px] font-medium text-ink/70">{e.agent || e.by}</span>
            )}
            <Stamp at={e.at} />
            {/* A percent report is the working state talking, so it wears the
                working hue from the closed state set — never a hue of its own. */}
            {typeof e.percent === "number" && (
              <span className={`${CHIP_BASE} ${STATE_CHIP.executing.chip}`}>
                {Math.round(e.percent)}%
              </span>
            )}
          </div>
          <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink/70">
            {e.note}
          </p>
        </li>
      ))}
    </ol>
  );
}

// ── History ──────────────────────────────────────────────────────────────────
// The server-owned audit trail, which holds TWO kinds of entry and is typeset to
// say which is which (TDM-97).
//
//   a content EDIT — someone rewrote the title or body. The ones that COST an
//     approval (reverted) carry the board's one attention hue; an ordinary
//     pre-approval fix is a record fact at the weight of a timestamp. The old→new
//     hint is a quotation, so it stays in the code face with its arrow intact.
//   a state MOVE — someone walked the card along by hand: Start, Mark done,
//     Release, Re-queue, Reopen, Reconsider. Never amber: a move costs no
//     approval, and borrowing the attention hue for a routine "I started this"
//     would teach people to ignore it where it matters.
//
// Both were always in the log; only the edits were ever drawn. The move entries
// are the more interesting half in practice — an agent's transitions leave no
// audit entry at all, so everything here is a PERSON's hand on the work.
function MoveEntry({ entry }: { entry: ContentAuditEntry }) {
  const note = stateMoveNote(entry);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-ink/70">
          <ArrowRight size={11} className="shrink-0 text-ink/35" aria-hidden="true" />
          <span className="min-w-0">
            <span className="font-medium text-ink/80">{auditActorLabel(entry.actor)}</span>{" "}
            {moveVerbLabel(entry)}
          </span>
        </span>
        <span className="font-code text-[10.5px] text-ink/45">
          {entry.fromState} → {entry.toState}
        </span>
        <Stamp at={entry.at} className="ml-auto" />
      </div>
      {/* The mover's own words, so they read as prose rather than as the
          machine summary the from→to above already renders. */}
      {note && (
        <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink/70">
          {note}
        </p>
      )}
    </>
  );
}

function EditEntry({ entry }: { entry: ContentAuditEntry }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {entry.reverted && (
          <span
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-400"
            title="This edit withdrew the approval: the task went back to proposed and its claim was released."
          >
            <RotateCcw size={11} className="shrink-0" aria-hidden="true" />
            sent back for approval
          </span>
        )}
        <span className="text-[12px] text-ink/70">
          {auditActorLabel(entry.actor)} changed the {auditChangeLabel(entry.change)}
        </span>
        <span className="font-code text-[10.5px] text-ink/45">
          {entry.fromState} → {entry.toState}
        </span>
        <Stamp at={entry.at} className="ml-auto" />
      </div>
      {entry.summary && (
        <p className="mt-1.5 overflow-x-auto whitespace-pre font-code text-[10.5px] leading-relaxed text-ink/55">
          {entry.summary}
        </p>
      )}
    </>
  );
}

function AuditHistory({ trail }: { trail: ContentAuditEntry[] }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {[...trail].reverse().map((e, i) => {
        const move = isStateMove(e);
        return (
          <li
            key={`${e.at}-${i}`}
            className={`rounded-md border px-2.5 py-2 ${
              e.reverted && !move
                ? "border-amber-500/25 bg-amber-500/[0.07]"
                : "border-ink/10 bg-ink/[0.02]"
            }`}
          >
            {move ? <MoveEntry entry={e} /> : <EditEntry entry={e} />}
          </li>
        );
      })}
    </ol>
  );
}

// ── Contention history ───────────────────────────────────────────────────────
// Every collision this task saw: who went for it and yielded, and who wrote to it
// after losing the claim. This is the page's answer to a question the board can
// only hint at with a chip — and it is the page where the answer belongs, because
// reading a ticket is the retrospective act, not the deciding one.
//
// Typeset as a record list rather than a narrative rail (which is what
// ProgressLog is): these are not steps in the work, they are things that happened
// AROUND it. Newest first, like the edit history it sits beside — a person opening
// a raced ticket wants the most recent race.
//
// No hue, following ContentionMark: a collision can be recorded on a task in any
// state, so amber (which already means "needs approval" and "lease lapsed"
// elsewhere) is not available. The FENCED entries — the near misses, where a
// worker came back after its lease had gone — get firmer ink and a filled ground;
// the routine yields read at record weight.
function ContentionHistory({ trail }: { trail: ContentionEvent[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {[...trail].reverse().map((e, i) => {
        const fenced = e.kind === "fenced_write";
        return (
          <li
            key={`${e.at}-${i}`}
            className={`rounded-md border px-2.5 py-2 ${
              fenced ? "border-ink/15 bg-ink/[0.04]" : "border-ink/10 bg-ink/[0.02]"
            }`}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={`inline-flex shrink-0 items-center gap-1 text-[11px] ${
                  fenced ? "font-semibold text-ink/75" : "font-medium text-ink/55"
                }`}
              >
                {fenced ? (
                  <Shield size={11} className="shrink-0" aria-hidden="true" />
                ) : (
                  <Users size={11} className="shrink-0" aria-hidden="true" />
                )}
                {eventLabel(e)}
              </span>
              <span className="font-code text-[11.5px] font-medium text-ink/70">{e.agent}</span>
              {e.holder && e.holder !== "nobody" && (
                <span className="font-code text-[10.5px] text-ink/45">
                  {/* The arrow is the whole shape of the fact: loser → holder. */}
                  → {e.holder}
                </span>
              )}
              {repeatsOf(e) > 1 && (
                <span className="font-code text-[10.5px] text-ink/45">×{repeatsOf(e)}</span>
              )}
              <Stamp at={e.at} className="ml-auto" />
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-ink/60">{eventSentence(e)}</p>
          </li>
        );
      })}
    </ol>
  );
}

// ── Linked context ───────────────────────────────────────────────────────────
// What the author handed the executor: roadmap goals, notes, pins. Resolved
// against the same canvas state everything else renders from, and clickable
// where the thing still lives in a document — the point of linking context is
// being able to go read it.
type Resolved = {
  id: string;
  kind: string;
  label: string;
  docId: string | null;
  Glyph: typeof Link2;
};

function resolveLink(state: CanvasState, id: string): Resolved | null {
  const goal = (state.roadmapItems ?? {})[id];
  if (goal) {
    return {
      id,
      kind: "goal",
      label: goal.title || "Untitled goal",
      docId: goal.documentId ?? null,
      Glyph: Milestone,
    };
  }
  const note = (state.notes ?? {})[id];
  if (note) {
    const first = (note.body ?? "").split("\n")[0].replace(/^#+\s*/, "").slice(0, 80);
    return {
      id,
      kind: "note",
      label: first || "Untitled note",
      docId: note.documentId ?? null,
      Glyph: StickyNote,
    };
  }
  const pin = (state.pins ?? {})[id];
  if (pin) {
    return {
      id,
      kind: "pin",
      label: pin.label || pin.body?.split("\n")[0] || "Untitled pin",
      docId: pin.documentId ?? null,
      Glyph: MapPin,
    };
  }
  return null;
}

function LinkedContext({
  state,
  ids,
  onOpenDocument,
}: {
  state: CanvasState;
  ids: string[];
  onOpenDocument?: (docId: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {ids.map((id) => {
        const r = resolveLink(state, id);
        if (!r) {
          return (
            <li
              key={id}
              title="Linked item is not on this canvas any more (deleted, or from another surface)"
              className="flex items-center gap-1.5 rounded-md border border-dashed border-ink/15 px-2 py-1.5 font-code text-[10.5px] text-ink/45"
            >
              <Link2 size={11} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{id}</span>
            </li>
          );
        }
        const doc = r.docId ? (state.documents ?? {})[r.docId] : undefined;
        const body = (
          <>
            <r.Glyph size={12} className="shrink-0 text-ink/40" aria-hidden="true" />
            <span className={`shrink-0 ${EYEBROW}`}>{r.kind}</span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink/75">{r.label}</span>
            {doc && (
              <span className="shrink-0 text-[11px] text-ink/45">{doc.name || "Untitled"}</span>
            )}
          </>
        );
        return (
          <li key={id}>
            {doc && onOpenDocument ? (
              <button
                onClick={() => onOpenDocument(doc.id)}
                title={`Open "${doc.name || "Untitled"}" to read this in place`}
                className="tandem-tap flex w-full items-center gap-1.5 rounded-md border border-ink/10 bg-surface px-2 py-1.5 text-left transition-colors hover:border-ink/25 hover:bg-ink/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {body}
              </button>
            ) : (
              <div className="flex items-center gap-1.5 rounded-md border border-ink/10 bg-surface px-2 py-1.5">
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── Human state moves (TDM-104) ──────────────────────────────────────────────
// The page used to be read-only: you could follow a link to a ticket, read the
// whole record of it, and then had to go BACK to the board to say "I started
// this". A page that is the shareable address of one piece of work has to be the
// place you can act on that piece of work, or the link is a dead end.
//
// Same matrix, same verbs, same server call as the board's detail panel
// (TaskBoard's renderMoves): lib/taskMoves is the client mirror of
// apps/api/internal/api/task_move.go, and the API re-validates every move, so
// this strip cannot offer one the server will refuse. 'proposed' renders NOTHING
// — the approval gate is the only way out of triage and no move control may
// route around it, here any more than there.
//
// It is deliberately NOT a copy of the panel's whole footer: no approve/reject
// (this page is not the triage surface) and no delete (deleting the thing you
// are looking at leaves you on the address of something that no longer exists).
function moveIcon(move: HumanMove) {
  if (move.kind === "rewind") return <RotateCcw size={12} />;
  if (move.to === "executing") return <Play size={12} />;
  if (move.to === "failed") return <Ban size={12} />;
  return <Check size={12} />;
}

const MOVE_PRIMARY =
  "tandem-tap flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 sm:flex-none";
const MOVE_QUIET =
  "tandem-tap flex flex-1 items-center justify-center gap-1 rounded-md border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/60 transition-colors hover:border-ink/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 sm:flex-none";

function MoveControls({
  code,
  task,
  assignee,
  className = "",
}: {
  code: string;
  task: Action;
  assignee: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The armed move, waiting on its confirm (and optionally a note).
  const [pending, setPending] = useState<HumanMove | null>(null);
  const [note, setNote] = useState("");

  const moves = humanMovesFor(task.state);
  // The task moved underneath us — a socket push landed a state whose armed move
  // is no longer legal — so drop the armed strip rather than fire a stale move.
  useEffect(() => {
    setPending(null);
    setNote("");
    setError(null);
  }, [task.state]);

  if (moves.length === 0) return null;

  async function go(move: HumanMove) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const from = task.state;
      await moveTask(code, task.id, move.to, note.trim() || undefined);
      posthog.capture("task_moved", {
        canvas_code: code,
        from,
        to: move.to,
        assignee,
        noted: note.trim().length > 0,
        // The board's two move surfaces already report themselves; this is the
        // third, and the point of the property is telling them apart.
        surface: "ticket_page",
      });
      if (from === "failed" && move.to === "approved") {
        posthog.capture("agent_task_requeued", { canvas_code: code });
      }
      setPending(null);
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move this task");
    } finally {
      setBusy(false);
    }
  }

  // Plain and forward (Start) fires straight away. Anything worth annotating,
  // and every rewind — which discards the last attempt's result — arms first.
  function arm(move: HumanMove) {
    if (move.notePrompt || move.kind === "rewind") {
      setNote("");
      setError(null);
      setPending(move);
      return;
    }
    void go(move);
  }

  return (
    <div className={className}>
      {error && (
        <div className="mb-2 rounded-md border border-rose-500/20 bg-rose-500/10 px-2.5 py-1.5 text-[12px] text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}
      {pending ? (
        <div className="flex flex-col gap-2">
          <p className="text-[12px] leading-snug text-ink/60">{pending.hint}.</p>
          {pending.notePrompt && (
            <input
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void go(pending);
                if (e.key === "Escape") setPending(null);
              }}
              placeholder={pending.notePrompt}
              className="tandem-tap w-full rounded-md border border-ink/15 bg-surface px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink/30 focus:border-accent/50 focus:ring-2 focus:ring-accent/40"
            />
          )}
          <div className="flex gap-1.5">
            <button onClick={() => void go(pending)} disabled={busy} className={MOVE_PRIMARY}>
              {busy ? "Working…" : pending.label}
            </button>
            <button onClick={() => setPending(null)} className={MOVE_QUIET}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {moves.map((m, i) => (
            <button
              key={`${m.to}-${m.label}`}
              onClick={() => arm(m)}
              disabled={busy}
              title={m.hint}
              className={i === 0 && m.kind === "forward" ? MOVE_PRIMARY : MOVE_QUIET}
            >
              {moveIcon(m)} {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function TicketView({
  code,
  canvasName,
  state,
  ticketRef,
  readOnly = false,
  onOpenBoard,
  onOpenEpic,
  onOpenDocument,
  onHome,
}: {
  /** Canvas code from the URL — known before the first snapshot lands. */
  code: string;
  /** Canvas name, once meta has arrived. */
  canvasName?: string | null;
  /** Live canvas state, or null while the socket is still joining. */
  state: CanvasState | null;
  /** The ticket string as it appeared in the URL, e.g. "TDM-7". */
  ticketRef: string;
  /** Viewer holds the read role: the page renders the record, not the moves. */
  readOnly?: boolean;
  /** Leave the ticket page for the Board surface. */
  onOpenBoard: () => void;
  /** Board, scoped to this task's epic. */
  onOpenEpic?: (epicId: string) => void;
  /** Open the document a linked goal / note / pin lives in. */
  onOpenDocument?: (docId: string) => void;
  onHome?: () => void;
}) {
  const task = useMemo(() => findTicket(state, ticketRef), [state, ticketRef]);
  const p = task ? taskPayload(task) : undefined;
  const epic =
    state && p?.epicId ? (state.actions ?? {})[p.epicId] : undefined;
  const epicTitle =
    epic && epic.type === "epic"
      ? ((epic.payload ?? {}) as { title?: string }).title || "Untitled epic"
      : undefined;
  const commits = extractCommits(task?.result);
  const reapproval = lastReapprovalEdit(p);
  // Which gate this task passed — human, peer agent, or a policy that let it
  // through without anyone looking (TDM-147).
  const approval = parseApproval(task?.approvedBy);
  const progress = useMemo(
    () =>
      [...(p?.progress ?? [])].sort(
        (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
      ),
    [p?.progress],
  );
  const linkedIds = useMemo(
    () => [...(p?.linkedIds ?? []), ...(task?.linkedPinIds ?? [])],
    [p?.linkedIds, task?.linkedPinIds],
  );
  // Collisions (TDM-100). Stored on the task's payload, so it arrives with the
  // same canvas-state push everything else on this page reads from — a race
  // recorded while the page is open appears without a refetch.
  const contentionEvents = p?.contention ?? [];
  const contention = tallyContention(contentionEvents);

  // Claim lease (TDM-101). This page is where someone lands from a pasted link
  // to find out what is happening with one piece of work — and "the agent
  // holding it went quiet eleven minutes ago" is the single most useful thing
  // this page can say that the brief cannot. The clock has to tick on its own:
  // a stalled worker sends no state, so a lease age derived from the last push
  // would sit frozen at whatever it read when the page loaded.
  const now = useFreshnessNow();
  const lease = deriveLease(task, now);

  // The tab is part of the deliverable for a link you paste to someone.
  const heading = task ? p?.title || "Untitled task" : ticketRef;
  useEffect(() => {
    const prev = document.title;
    const id = task?.ticketId || ticketRef;
    document.title = `${id} · ${heading} — Tandem`;
    return () => {
      document.title = prev;
    };
  }, [task?.ticketId, ticketRef, heading]);

  const loading = state === null;

  return (
    <div className="flex h-app flex-col overflow-hidden bg-paper text-ink">
      {/* Breadcrumb chrome. Deliberately thinner than the canvas header: this
          page has one subject, and everything up here is a way back to it. */}
      <header className="relative z-10 flex shrink-0 items-center gap-1.5 border-b border-ink/10 bg-paper px-3 py-2.5 sm:gap-2 sm:px-4">
        <button
          onClick={onHome}
          disabled={!onHome}
          className="group flex shrink-0 items-center gap-1.5 rounded-md text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:cursor-default"
          title="Back to home"
        >
          <TandemLogo size={26} animate={false} />
          <span className="hidden font-semibold tracking-tight text-ink transition-colors group-hover:text-accent sm:inline">
            Tandem
          </span>
        </button>
        <span className="hidden shrink-0 text-ink/20 sm:inline">/</span>
        <button
          onClick={onOpenBoard}
          className="hidden min-w-0 max-w-[14rem] truncate rounded-md text-sm font-medium text-ink/70 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:inline"
          title="Back to this canvas"
        >
          {canvasName || code}
        </button>
        {/* The "Board" crumb is desktop-only: below sm the pill on the right is
            already labelled "Board", and two identical controls in one 390px bar
            is a bar that reads as broken. On a phone the crumb trail is just the
            ticket id — which is the one thing that says where you are. */}
        <span className="hidden shrink-0 text-ink/20 sm:inline">/</span>
        <button
          onClick={onOpenBoard}
          className="hidden shrink-0 rounded-md text-sm font-medium text-ink/70 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:block"
          title="Back to the board"
        >
          Board
        </button>
        <span className="hidden shrink-0 text-ink/20 sm:inline">/</span>
        <span className="shrink-0 font-code text-[12px] font-medium tracking-tight text-ink/60">
          {task?.ticketId || ticketRef}
        </span>
        <button
          onClick={onOpenBoard}
          className="ml-auto inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-ink/15 bg-surface px-2.5 text-[13px] font-medium text-ink/75 transition-colors hover:border-ink/25 hover:bg-ink/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
        >
          <ArrowLeft size={14} />
          <span className="hidden sm:inline">Back to board</span>
          <span className="sm:hidden">Board</span>
        </button>
      </header>

      <div className="tandem-scroll min-h-0 flex-1 overflow-y-auto">
        {/* The safe-area strip is ADDED to this page's own bottom padding
            (--tandem-pb-base = the py-6 below), so the last line of the history
            doesn't finish under the iOS home indicator. */}
        <div className="tandem-safe-pb-plus mx-auto w-full max-w-5xl px-4 pt-6 [--tandem-pb-base:1.5rem] sm:px-6 sm:pt-8 sm:[--tandem-pb-base:2rem]">
          {loading ? (
            <TicketSkeleton ticketRef={ticketRef} code={code} />
          ) : !task || !p ? (
            <NotFound ticketRef={ticketRef} code={code} onOpenBoard={onOpenBoard} />
          ) : (
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-10">
              {/* ── Main column ───────────────────────────────────────────── */}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-code text-[12px] font-medium tracking-tight text-ink/55">
                    {task.ticketId || ticketRef}
                  </span>
                  <StateChip state={task.state} />
                  {p.requiresApproval && task.state === "proposed" && (
                    <span
                      className={`${CHIP_BASE} bg-amber-500/10 text-amber-600 dark:text-amber-400`}
                      title="The agent flagged this task as needing explicit approval"
                    >
                      needs approval
                    </span>
                  )}
                  {p.assignee === "human" ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink/55">
                      <User size={11} className="shrink-0" /> your todo
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink/55">
                      <Bot size={11} className="shrink-0" /> for an agent
                    </span>
                  )}
                  {task.state === "executing" && task.claimedBy && (
                    <>
                      <ClaimantChip name={task.claimedBy} />
                      <LeaseChip lease={lease} />
                    </>
                  )}
                  {/* The marker rides the identity row rather than waiting for the
                      history section: "other agents went for this" belongs with
                      "this agent has it", and the section below is the detail. */}
                  <ContentionMark tally={contention} events={contentionEvents} />
                </div>

                <h1 className="mt-2 text-[24px] font-semibold leading-tight tracking-tight text-ink sm:text-[28px]">
                  {p.title || "Untitled task"}
                </h1>

                {/* ── Claim summary, narrow screens only (TDM-104) ─────────
                    The record rail is a RAIL only from lg up; below that the
                    grid collapses and it stacks under the ENTIRE main column —
                    past the brief, the progress log, the result and both
                    histories. On a phone that put "who is holding this" a dozen
                    screens from the title, which is the one question a pasted
                    ticket link is usually opened to answer.

                    So the rail's headline facts come up here instead, and only
                    where they'd otherwise be unreachable (lg:hidden — the
                    breakpoint the grid actually changes at, not md, or the
                    tablet gets the same long scroll). State is NOT repeated:
                    the identity row two lines above already carries the state
                    chip and the lease, and a second copy inside 100px reads as
                    a rendering bug. The full rail stays exactly where it was.

                    Nothing to hoist, nothing drawn: an unclaimed task with no
                    epic has only its assignee to report, and the identity row
                    already said "for an agent" one line up. */}
                {(task.claimedBy || (epicTitle && p.epicId)) && (
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-ink/10 bg-surface px-3 py-2 lg:hidden">
                    <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-ink/70">
                      <span className={EYEBROW}>Holder</span>
                      {task.claimedBy ? (
                        <ClaimantChip name={task.claimedBy} />
                      ) : p.assignee === "human" ? (
                        <span className="inline-flex items-center gap-1">
                          <User size={11} className="shrink-0 text-ink/45" /> You
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-ink/55">
                          <Bot size={11} className="shrink-0 text-ink/45" /> Unclaimed
                        </span>
                      )}
                    </span>
                    {/* When it was taken — but only once the stamp MEANS that. On
                        an executing task claimedAt is the lease heartbeat, so the
                        chip in the identity row is the honest reading and this
                        stays quiet rather than claiming "claimed 40s ago" on work
                        that has been running for an hour. */}
                    {task.claimedAt && task.state !== "executing" && <Stamp at={task.claimedAt} />}
                    {epicTitle && p.epicId && (
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <span className={EYEBROW}>Epic</span>
                        {onOpenEpic ? (
                          <button
                            onClick={() => onOpenEpic(p.epicId as string)}
                            title={`Open the board scoped to "${epicTitle}"`}
                            className="tandem-tap inline-flex min-w-0 items-center gap-1 rounded-md text-[12px] text-ink/70 underline decoration-ink/20 underline-offset-2 transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            <Layers size={11} className="shrink-0 text-ink/45" />
                            <span className="min-w-0 truncate">{epicTitle}</span>
                          </button>
                        ) : (
                          <span className="inline-flex min-w-0 items-center gap-1 text-[12px] text-ink/70">
                            <Layers size={11} className="shrink-0 text-ink/45" />
                            <span className="min-w-0 truncate">{epicTitle}</span>
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                )}

                {/* A lapsed lease outranks the brief, for the same reason the
                    re-approval notice does: it changes what you are reading the
                    ticket FOR. Release is now one of the moves directly below
                    (TDM-104), so the notice can offer it here rather than
                    sending the reader back to the board — except for a viewer
                    with the read role, for whom the moves don't render at all. */}
                <LeaseNotice lease={lease} canRelease={!readOnly} className="mt-4" />

                {/* The moves, high: this page's whole job is "one piece of
                    work", and the act it exists to support is walking that work
                    along. Under the title (and under the lapsed-lease notice,
                    because Release is one of these buttons) means a phone can
                    Start / Mark done without scrolling past the brief. Renders
                    nothing at all on a proposed task — approval is the board's,
                    deliberately. */}
                {!readOnly && (
                  <MoveControls
                    code={code}
                    task={task}
                    assignee={p.assignee ?? "agent"}
                    className="mt-4"
                  />
                )}

                {/* Why this is back in triage — above the brief, because it
                    changes how you read every word of it. */}
                {task.state === "proposed" && reapproval && (
                  <div className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-amber-700 dark:text-amber-400">
                      <RotateCcw size={13} className="shrink-0" aria-hidden="true" />
                      Edited after approval — needs re-approval
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-ink/65">
                      {auditActorLabel(reapproval.actor)} changed the{" "}
                      {auditChangeLabel(reapproval.change)} <Stamp at={reapproval.at} />, so the
                      task went back to proposed and its claim was released. Read it again before
                      approving.
                    </p>
                  </div>
                )}

                <Section label="Description">
                  {p.body ? (
                    <div className="prose prose-sm max-w-none">
                      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{p.body}</ReactMarkdown>
                    </div>
                  ) : (
                    <p className="text-[12.5px] italic leading-relaxed text-ink/45">
                      No description — the title is the whole brief.
                    </p>
                  )}
                </Section>

                {linkedIds.length > 0 && state && (
                  <Section label="Linked context">
                    <LinkedContext
                      state={state}
                      ids={linkedIds}
                      onOpenDocument={onOpenDocument}
                    />
                  </Section>
                )}

                {progress.length > 0 && (
                  <Section label={`Progress · ${progress.length}`}>
                    <ProgressLog entries={progress} />
                  </Section>
                )}

                {task.result && (
                  <Section label="Result">
                    <p className="whitespace-pre-wrap rounded-lg bg-emerald-500/10 px-3 py-2.5 text-[13px] leading-relaxed text-emerald-700 dark:text-emerald-300">
                      {task.result}
                    </p>
                    {commits.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
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
                  </Section>
                )}

                {(task.state === "failed" || task.state === "rejected") && task.error && (
                  <Section label={task.state === "failed" ? "Error" : "Rejection reason"}>
                    <p className="whitespace-pre-wrap rounded-lg bg-rose-500/10 px-3 py-2.5 text-[13px] leading-relaxed text-rose-700 dark:text-rose-300">
                      {task.error}
                    </p>
                  </Section>
                )}

                {(p.links ?? []).length > 0 && (
                  <Section label="Evidence">
                    {/* Always live here: you opened the ticket to find out. */}
                    <TaskLinks code={code} links={p.links} live boxed />
                  </Section>
                )}

                {/* Above the edit history, because it is about the WORK's
                    coordination rather than about the row's text — and because on
                    a task that was raced for, it is the more interesting of the
                    two histories. */}
                {contentionEvents.length > 0 && (
                  <Section label={`Contention · ${contention.total}`}>
                    <ContentionHistory trail={contentionEvents} />
                  </Section>
                )}

                {/* One trail, both kinds — the section is "History" rather than
                    "Edit history" because half of what the server records here
                    is someone moving the card, not rewriting it. */}
                {(p.audit ?? []).length > 0 && (
                  <Section label={`History · ${(p.audit ?? []).length}`}>
                    <AuditHistory trail={p.audit ?? []} />
                  </Section>
                )}
              </div>

              {/* ── Record rail ───────────────────────────────────────────── */}
              <aside className="min-w-0 lg:sticky lg:top-0 lg:self-start">
                <div className="flex flex-col gap-4 rounded-lg border border-ink/10 bg-surface p-3.5">
                  <Field label="State">
                    <StateChip state={task.state} />
                  </Field>

                  <Field label="Assignee">
                    {p.assignee === "human" ? (
                      <span className="inline-flex items-center gap-1.5">
                        <User size={12} className="shrink-0 text-ink/45" /> You
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <Bot size={12} className="shrink-0 text-ink/45" />
                        {task.claimedBy || "Any agent"}
                      </span>
                    )}
                  </Field>

                  <Field label="Epic">
                    {epicTitle && p.epicId ? (
                      onOpenEpic ? (
                        <button
                          onClick={() => onOpenEpic(p.epicId as string)}
                          title={`Open the board scoped to "${epicTitle}"`}
                          className="tandem-tap flex w-full items-center gap-1.5 rounded-md border border-ink/10 bg-ink/[0.02] px-2 py-1.5 text-left transition-colors hover:border-ink/25 hover:bg-ink/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        >
                          <Layers size={12} className="shrink-0 text-ink/45" />
                          <span className="min-w-0 flex-1 truncate">{epicTitle}</span>
                          {epic && <StateChip state={epic.state} />}
                        </button>
                      ) : (
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          <Layers size={12} className="shrink-0 text-ink/45" />
                          <span className="truncate">{epicTitle}</span>
                        </span>
                      )
                    ) : (
                      <span className="text-ink/45">No epic</span>
                    )}
                  </Field>

                  <div className="h-px bg-ink/10" />

                  <Field label="Proposed by">
                    <span className="break-words">{task.proposedBy || "unknown"}</span>
                    {/* What the caller CALLED itself, above; what the server
                        concluded, below. Sitting them together is the point. */}
                    <div className="mt-0.5">
                      <ProvenanceChip authoredBy={task.authoredBy} verbose />
                    </div>
                  </Field>

                  {/* WHICH GATE it passed (TDM-147). Since peer approval landed,
                      "approved" has more than one meaning, and this page is
                      where someone lands from a pasted link to find out what
                      happened to one piece of work — so the surprising cases (a
                      peer agent, or a policy that let it through unlooked-at)
                      are spelt out in words rather than left to a tooltip. A
                      person approving their own board's task is the expected
                      case and stays one quiet line. */}
                  {approval && (
                    <Field label="Approved by">
                      <ApprovalLine approvedBy={task.approvedBy} prefix={false} />
                      {!approval.byHuman && (
                        <p className="mt-1 text-[11px] leading-snug text-ink/45">
                          {approval.title}
                        </p>
                      )}
                      {/* The stamp itself, like Proposed by pairs the caller's
                          label with what the server concluded. */}
                      <div className="mt-1 font-code text-[10.5px] text-ink/35">
                        {task.approvedBy}
                      </div>
                    </Field>
                  )}

                  {task.claimedBy && (
                    <Field label="Claimed by">
                      <ClaimantChip name={task.claimedBy} />
                      {/* While it is EXECUTING, claimedAt is the lease stamp, not
                          the moment work began — every heartbeat pushes it
                          forward — so reading it as "claimed 2m ago" would be
                          plainly wrong on a task that has been running an hour.
                          The lease reading is the honest one. Once the task has
                          left executing the stamp stops moving and does mean
                          when it was taken, so that case keeps the plain age. */}
                      {task.state === "executing" && lease.health !== "none" ? (
                        <div className="mt-1 flex flex-col gap-1">
                          <LeaseChip lease={lease} className="self-start" />
                          <span className="text-[11px] leading-snug text-ink/45">
                            {lease.reclaimable
                              ? `claim lease lapsed ${leaseAge(lease.overdueMs)} ago — reclaimable by any agent`
                              : `claim lease good for another ${leaseAge(lease.remainingMs)}`}
                          </span>
                        </div>
                      ) : (
                        task.claimedAt && (
                          <div className="mt-0.5">
                            <Stamp at={task.claimedAt} />
                          </div>
                        )
                      )}
                    </Field>
                  )}

                  <div className="h-px bg-ink/10" />

                  <Field label="Created">
                    <Stamp at={task.createdAt} />
                  </Field>
                  <Field label="Updated">
                    <Stamp at={task.updatedAt} />
                  </Field>

                  <Field label="Canvas">
                    <span className="inline-flex items-center gap-1.5">
                      <Compass size={12} className="shrink-0 text-ink/45" />
                      <span className="font-code text-[11px] tracking-[0.12em] text-ink/55">
                        {code}
                      </span>
                    </span>
                  </Field>
                </div>
              </aside>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// While the socket is still joining. Shapes match the real page so the content
// lands in place rather than jumping.
function TicketSkeleton({ ticketRef, code }: { ticketRef: string; code: string }) {
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-10">
      <div className="min-w-0 animate-pulse">
        <div className="flex items-center gap-2">
          <span className="font-code text-[12px] font-medium tracking-tight text-ink/40">
            {ticketRef}
          </span>
          <span className="h-4 w-16 rounded-[4px] bg-ink/[0.08]" />
        </div>
        <div className="mt-3 h-7 w-3/4 rounded bg-ink/[0.08]" />
        <div className="mt-7 h-2.5 w-20 rounded bg-ink/[0.06]" />
        <div className="mt-3 flex flex-col gap-2">
          <div className="h-3 w-full rounded bg-ink/[0.06]" />
          <div className="h-3 w-11/12 rounded bg-ink/[0.06]" />
          <div className="h-3 w-4/5 rounded bg-ink/[0.06]" />
        </div>
        <p className="mt-8 font-code text-[11px] text-ink/40">
          joining {code} — the ticket resolves as soon as the canvas lands
        </p>
      </div>
      <aside className="hidden animate-pulse lg:block">
        <div className="flex flex-col gap-4 rounded-lg border border-ink/10 bg-surface p-3.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="h-2 w-14 rounded bg-ink/[0.06]" />
              <div className="h-3.5 w-24 rounded bg-ink/[0.08]" />
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

// State arrived and this ticket isn't on the canvas: it was deleted, the number
// belongs to another canvas, or the link was mistyped. Say which canvas we
// actually looked in — that's the mistake this link makes most often.
function NotFound({
  ticketRef,
  code,
  onOpenBoard,
}: {
  ticketRef: string;
  code: string;
  onOpenBoard: () => void;
}) {
  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-ink/10 bg-surface">
        <SearchX size={20} className="text-ink/45" />
      </span>
      <h1 className="mt-4 text-xl font-semibold tracking-tight text-ink">
        No ticket <span className="font-code text-[18px]">{ticketRef}</span> here
      </h1>
      <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-ink/55">
        Canvas <span className="font-code text-[12px] tracking-[0.12em]">{code}</span> has no task
        with that number — it may have been deleted, or the ticket belongs to a different canvas.
      </p>
      <button
        onClick={onOpenBoard}
        className="tandem-tap mt-6 inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
      >
        <ArrowLeft size={15} /> Back to the board
      </button>
    </div>
  );
}
