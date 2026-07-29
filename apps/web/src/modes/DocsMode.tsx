import { BookMarked, FileDown, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
} from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import remarkGfm from "remark-gfm";
import type { CanvasState, Document, FreshnessPatchFields, Note } from "../types";
import { imageUrl, setBriefing } from "../lib/api";
import { sendOp } from "../lib/ws";
import { htmlToMarkdown } from "../lib/paste";
import EmptyState from "../components/EmptyState";
import ImportBriefingModal from "../components/ImportBriefingModal";
import { FreshnessChip, VerifyControl, useFreshnessNow } from "../components/Freshness";
import { deriveFreshness, needsReview } from "../lib/freshness";
import { noteTitle, sortNotes } from "../lib/docOutline";

interface Props {
  canvasId: string;
  canvasCode: string;
  state: CanvasState;
  readOnly: boolean;
  /** The notes document on screen — this view is one document's slice of the
   *  canvas, and freshness / briefing designation are properties OF that
   *  document, not of the mode. Absent on an empty canvas. */
  doc?: Document;
  /** The document this canvas hands every agent on connect, if any. */
  briefingDocId?: string | null;
  /** Opens (and focuses) a document tab — used after a briefing import. */
  onOpenDoc: (docId: string) => void;
}

// Below this the outline is noise — a rail listing one or two notes tells you
// nothing you can't see by looking at the page.
const MIN_NOTES_FOR_OUTLINE = 2;

// How long a jumped-to note stays ringed. Long enough to catch the eye after the
// smooth scroll settles, short enough not to linger as decoration.
const HIGHLIGHT_MS = 1400;

const MARKDOWN_PLUGINS = [remarkGfm];

// Per-doc save lifecycle for the footer indicator. "idle" = nothing to show yet
// (freshly loaded, untouched); "saving" = an edit is pending/in flight; "saved"
// = persisted, show the timestamp.
type SaveState = "idle" | "saving" | "saved";

function formatSavedAt(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Render Markdown to an HTML string with the SAME renderer as the read view, so
// what you edit in the WYSIWYG surface matches how the note renders everywhere
// else. This seeds the contentEditable; htmlToMarkdown (lib/paste) is the exact
// inverse — together they are the markdown<->HTML bridge that lets storage stay
// Markdown while editing feels rich.
function markdownToHtml(md: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{md}</ReactMarkdown>,
  );
}

export default function DocsMode({
  canvasId,
  canvasCode,
  state,
  readOnly,
  doc,
  briefingDocId,
  onOpenDoc,
}: Props) {
  const allNotes = useMemo(() => sortNotes(Object.values(state.notes)), [state.notes]);
  const [importOpen, setImportOpen] = useState(false);
  const now = useFreshnessNow();

  // The review pass: how many notes on this page have aged out of their
  // declared shelf life (or are on their way). Counted over the whole document
  // so the number doesn't change when the filter narrows the page.
  const [reviewOnly, setReviewOnly] = useState(false);
  const reviewCount = useMemo(
    () => allNotes.filter((n) => needsReview(deriveFreshness(n, now))).length,
    [allNotes, now],
  );
  const notes = useMemo(
    () => (reviewOnly ? allNotes.filter((n) => needsReview(deriveFreshness(n, now))) : allNotes),
    [allNotes, reviewOnly, now],
  );

  // Leave the filter the moment there's nothing left to review — a filter that
  // survives its own emptiness reads as a broken page.
  useEffect(() => {
    if (reviewOnly && reviewCount === 0) setReviewOnly(false);
  }, [reviewOnly, reviewCount]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Live map of note id → card element, populated by each card's ref callback.
  // Drives both the jump-to scroll and the IntersectionObserver.
  const cardsRef = useRef(new Map<string, HTMLElement>());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const showOutline = notes.length >= MIN_NOTES_FOR_OUTLINE;

  // Track which note is currently in view so the outline row for it lights up as
  // you scroll. The observer reports enter/exit per card, so we keep the visible
  // set and pick whichever comes first in document order — that's the one the
  // reader is at, and it stays stable when two cards are on screen at once.
  const visibleRef = useRef(new Set<string>());
  useEffect(() => {
    if (!showOutline) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = e.target.getAttribute("data-agent-target");
          if (!id) continue;
          if (e.isIntersecting) visibleRef.current.add(id);
          else visibleRef.current.delete(id);
        }
        const first = notes.find((n) => visibleRef.current.has(n.id));
        if (first) setActiveId(first.id);
      },
      // Ignore the bottom 55%: without it the last cards on a short page all
      // count as "in view" and the active row sticks to the wrong note.
      { root: scrollRef.current, rootMargin: "0px 0px -55% 0px", threshold: 0 },
    );
    for (const el of cardsRef.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [showOutline, notes]);

  useEffect(() => {
    if (!highlightId) return;
    const t = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlightId]);

  function handleAddNote() {
    sendOp({
      op: "note.add",
      data: { body: "", imageRefs: [] },
    });
  }

  function handleJump(id: string) {
    cardsRef.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(id);
    setHighlightId(id);
  }

  // Write a whole new order out as note.update ops — the same op any other edit
  // uses, so a reorder broadcasts over WS to other clients and to agents for
  // free. Renumber densely (0..n-1) and only send the rows that actually moved.
  function applyOrder(ordered: Note[]) {
    ordered.forEach((note, i) => {
      if (note.sortOrder !== i) {
        sendOp({ op: "note.update", id: note.id, partial: { sortOrder: i } });
      }
    });
  }

  function handleMove(from: number, to: number) {
    if (to < 0 || to >= notes.length || from === to) return;
    applyOrder(arrayMove(notes, from, to));
  }

  return (
    <div ref={scrollRef} className="tandem-scroll flex-1 overflow-y-auto bg-paper">
      {/* Wide enough to seat the rail beside a full-width prose column rather
          than stealing from it; the rail itself is lg-only (see Outline). */}
      <div className="mx-auto flex w-full max-w-[64rem] gap-6 px-4 py-6 sm:px-6">
        {showOutline && (
          <Outline
            notes={notes}
            activeId={activeId}
            // Reordering a FILTERED list would renumber sortOrder across the
            // notes on screen and silently reshuffle the ones hidden behind the
            // review filter. Navigation stays; the drag handles step aside.
            readOnly={readOnly || reviewOnly}
            onJump={handleJump}
            onMove={handleMove}
          />
        )}

        <div className="mx-auto w-full min-w-0 max-w-3xl">
          <div className="mb-4">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-xl font-semibold tracking-tight text-ink">Docs</h1>
              <div className="flex shrink-0 items-center gap-2">
                {/* Import sits beside "New note" as its quieter sibling: same row,
                    outline instead of filled. Writing a note is the everyday act;
                    designating the canvas's briefing is a once-a-project one. */}
                {!readOnly && (
                  <button
                    onClick={() => setImportOpen(true)}
                    title="Import a repo's AGENTS.md or CLAUDE.md as this canvas's briefing"
                    className="inline-flex items-center gap-1.5 rounded-md border border-ink/15 bg-surface px-3 py-1.5 text-sm font-medium text-ink/70 transition-colors hover:border-ink/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <FileDown size={14} strokeWidth={1.75} />
                    Import AGENTS.md
                  </button>
                )}
                <button
                  onClick={handleAddNote}
                  className="rounded-md bg-accent px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  + New note
                </button>
              </div>
            </div>

            {doc && (
              <DocumentTrustRow
                doc={doc}
                code={canvasCode}
                isBriefing={briefingDocId === doc.id}
                readOnly={readOnly}
                now={now}
                reviewCount={reviewCount}
                reviewOnly={reviewOnly}
                onToggleReview={() => setReviewOnly((v) => !v)}
              />
            )}
          </div>

          {notes.length === 0 ? (
            <EmptyState
              title="No notes yet"
              hint="Click + New note to start writing, or ask Claude to draft something."
            />
          ) : (
            <div className="space-y-4">
              {notes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  canvasId={canvasId}
                  state={state}
                  readOnly={readOnly}
                  now={now}
                  highlighted={highlightId === note.id}
                  cardRef={(el) => {
                    if (el) cardsRef.current.set(note.id, el);
                    else cardsRef.current.delete(note.id);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {importOpen && (
        <ImportBriefingModal
          code={canvasCode}
          onClose={() => setImportOpen(false)}
          // The import lands as its own document; open its tab so the user sees
          // what they just brought in instead of being left on this one.
          onImported={onOpenDoc}
        />
      )}
    </div>
  );
}

/* One quiet line under the page title answering the only two questions a reader
   has about the DOCUMENT (rather than about any one note): is this the briefing
   every agent reads, and can what's on this page still be trusted?

   It sits below the title rather than in the tab strip because it's about
   standing, not navigation — and because the answers change as you work, which
   is not something a tab should be doing. Hairline top border, 11px, no fills:
   at rest it should read as a caption. */
function DocumentTrustRow({
  doc,
  code,
  isBriefing,
  readOnly,
  now,
  reviewCount,
  reviewOnly,
  onToggleReview,
}: {
  doc: Document;
  code: string;
  isBriefing: boolean;
  readOnly: boolean;
  now: number;
  reviewCount: number;
  reviewOnly: boolean;
  onToggleReview: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function designate(next: string | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // No optimistic write: the server broadcasts fresh canvas state, and the
      // briefing lives on the canvas (one per canvas, by construction), so the
      // marker here and in the tab strip both follow that one push.
      await setBriefing(code, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the briefing");
    } finally {
      setBusy(false);
    }
  }

  function patchDoc(patch: FreshnessPatchFields) {
    sendOp({ op: "document.update", id: doc.id, partial: patch });
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-ink/10 pt-2 text-[11px]">
      {isBriefing ? (
        <span
          className="inline-flex items-center gap-1 rounded-[4px] bg-accent/[0.08] py-0.5 pl-1.5 pr-1 font-medium text-accent"
          title="Every agent reads this document the moment it connects"
        >
          <BookMarked size={11} strokeWidth={2} />
          Briefing
          {!readOnly && (
            <button
              type="button"
              onClick={() => void designate(null)}
              disabled={busy}
              title="Stop handing this document to agents on connect"
              aria-label="Clear the briefing designation"
              className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded text-accent/60 hover:bg-accent/15 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
            >
              <X size={10} strokeWidth={2.5} />
            </button>
          )}
        </span>
      ) : (
        !readOnly &&
        doc.type === "notes" && (
          <button
            type="button"
            onClick={() => void designate(doc.id)}
            disabled={busy}
            title="Hand this document to every agent that connects to this canvas"
            className="rounded font-medium text-ink/45 underline decoration-ink/20 underline-offset-2 transition-colors hover:text-ink hover:decoration-ink/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          >
            Set as briefing
          </button>
        )
      )}

      <span className="inline-flex items-center gap-1.5">
        <FreshnessChip item={doc} now={now} />
        {!readOnly && <VerifyControl item={doc} onPatch={patchDoc} alwaysVisible />}
      </span>

      {error && <span className="text-rose-600 dark:text-rose-400">{error}</span>}

      {reviewCount > 0 && (
        <button
          type="button"
          onClick={onToggleReview}
          aria-pressed={reviewOnly}
          title={
            reviewOnly
              ? "Show every note in this document again"
              : "Show only the notes that have aged past their shelf life"
          }
          className={[
            "ml-auto inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-medium transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
            reviewOnly
              ? "bg-accent/[0.08] text-accent"
              : "text-ink/45 hover:bg-ink/5 hover:text-ink/70",
          ].join(" ")}
        >
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          {reviewOnly ? `Showing ${reviewCount} to review` : `${reviewCount} to review`}
        </button>
      )}
    </div>
  );
}

// The jump-to rail: every note in the doc by derived title, in document order.
// This is navigation, not a viewer — the notes stay one continuous scroll and
// clicking a row just takes you there. Doubles as the reorder surface: drag a
// row by its handle, or nudge it with the arrows (dragging is fiddly when all
// you want is to swap two neighbours).
//
// Same dnd-kit sortable-list idiom as Sheets rows and the Roadmap board, so the
// three reorderable lists in the app behave identically (including keyboard
// reordering). Dragging lives on a handle rather than the row because the row
// itself is a click target — jumping and dragging can't share one gesture.
function Outline({
  notes,
  activeId,
  readOnly,
  onJump,
  onMove,
}: {
  notes: Note[];
  activeId: string | null;
  readOnly: boolean;
  onJump: (id: string) => void;
  onMove: (from: number, to: number) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = useMemo(() => notes.map((n) => n.id), [notes]);

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = notes.findIndex((n) => n.id === active.id);
    const to = notes.findIndex((n) => n.id === over.id);
    if (from < 0 || to < 0) return;
    onMove(from, to);
  }

  return (
    <aside className="hidden w-52 shrink-0 lg:block">
      <div className="sticky top-6">
        <div className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-ink/50">
          Outline · {notes.length}
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-0.5">
              {notes.map((note, i) => (
                <OutlineRow
                  key={note.id}
                  note={note}
                  index={i}
                  total={notes.length}
                  isActive={note.id === activeId}
                  readOnly={readOnly}
                  onJump={onJump}
                  onMove={onMove}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </aside>
  );
}

function OutlineRow({
  note,
  index,
  total,
  isActive,
  readOnly,
  onJump,
  onMove,
}: {
  note: Note;
  index: number;
  total: number;
  isActive: boolean;
  readOnly: boolean;
  onJump: (id: string) => void;
  onMove: (from: number, to: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: note.id,
  });
  const title = noteTitle(note.body);

  return (
    <div
      ref={setNodeRef}
      onClick={() => onJump(note.id)}
      title={title}
      className={[
        "group/row flex cursor-pointer items-center gap-1 rounded-md py-1.5 pl-1 pr-1 text-[13px] transition-colors",
        isActive ? "bg-accent/10 font-medium text-ink" : "text-ink/60 hover:bg-ink/[0.04]",
      ].join(" ")}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
    >
      {!readOnly && <OutlineDragHandle attributes={attributes} listeners={listeners} />}
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${
          isActive ? "bg-accent" : "bg-transparent"
        }`}
      />
      <span className="min-w-0 flex-1 truncate">{title}</span>

      {!readOnly && (
        <span
          className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <MoveButton label="Move up" disabled={index === 0} onClick={() => onMove(index, index - 1)}>
            ↑
          </MoveButton>
          <MoveButton
            label="Move down"
            disabled={index === total - 1}
            onClick={() => onMove(index, index + 1)}
          >
            ↓
          </MoveButton>
        </span>
      )}
    </div>
  );
}

function OutlineDragHandle({
  attributes,
  listeners,
}: {
  attributes: DraggableAttributes;
  listeners: SyntheticListenerMap | undefined;
}) {
  return (
    <button
      {...attributes}
      {...listeners}
      onClick={(e) => e.stopPropagation()}
      className="shrink-0 cursor-grab touch-none px-0.5 text-ink/20 hover:text-ink/55 active:cursor-grabbing"
      aria-label="Drag to reorder note"
      title="Drag to reorder"
    >
      <svg width="10" height="14" viewBox="0 0 10 14">
        <circle cx="3" cy="3" r="1" fill="currentColor" />
        <circle cx="7" cy="3" r="1" fill="currentColor" />
        <circle cx="3" cy="7" r="1" fill="currentColor" />
        <circle cx="7" cy="7" r="1" fill="currentColor" />
        <circle cx="3" cy="11" r="1" fill="currentColor" />
        <circle cx="7" cy="11" r="1" fill="currentColor" />
      </svg>
    </button>
  );
}

function MoveButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded px-1 text-[11px] leading-4 text-ink/40 hover:bg-ink/10 hover:text-ink/70 disabled:pointer-events-none disabled:opacity-20"
    >
      {children}
    </button>
  );
}

function NoteCard({
  note,
  canvasId,
  state,
  readOnly,
  now,
  highlighted,
  cardRef,
}: {
  note: Note;
  canvasId: string;
  state: CanvasState;
  readOnly: boolean;
  now: number;
  highlighted: boolean;
  cardRef: (el: HTMLElement | null) => void;
}) {
  // No edit/read mode gate: the note is a live surface. When it isn't focused we
  // render the Markdown; the moment you click in, the same box becomes the
  // editable source at that caret. Nothing to "open", nothing to "save".
  const [focused, setFocused] = useState(note.body === "");
  const [draft, setDraft] = useState(note.body);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest draft, so a debounced/blur flush always saves what's on screen even
  // if state has moved on.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Optimistically flip the footer to "saved" the moment we hand an op off,
  // rather than waiting on the server round-trip / version bump — the save
  // feels instant. Timestamp is the client clock at send time.
  function markSaved() {
    setSaveState("saved");
    setSavedAt(Date.now());
  }

  // Keep the draft in sync when the server pushes a new body (e.g. Claude or
  // another client edited this note) — but only while we're NOT typing, so a
  // remote edit never yanks text out from under the caret. On blur our copy
  // saves (last-write-wins). When an authoritative body actually diverges from
  // what we're showing, adopt it AND move the saved-at footer to now, so the
  // indicator follows the backend rather than a stale optimistic edit. (Our own
  // just-flushed edit echoes back equal to the draft, so it no-ops here.)
  useEffect(() => {
    if (focused) return;
    if (note.body !== draftRef.current) {
      setDraft(note.body);
      markSaved();
    }
  }, [note.body, focused]);

  const parent =
    note.parentId
      ? state.pins[note.parentId] ?? state.events[note.parentId]
      : null;

  // Send the current draft if it changed. Returns whether an op was actually
  // pushed, so callers only touch the saved-at indicator on a real save.
  function persist(): boolean {
    if (draftRef.current === note.body) return false;
    sendOp({ op: "note.update", id: note.id, partial: { body: draftRef.current } });
    return true;
  }

  // Persist the current draft if it changed. Called by the autosave debounce and
  // on blur — there is no explicit save action.
  function flush() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (persist()) markSaved();
  }

  function onChange(next: string) {
    setDraft(next);
    setSaveState("saving");
    // Autosave: coalesce keystrokes, then push. Feels continuously saved.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      if (persist()) markSaved();
    }, 500);
  }

  // Flush any pending autosave if the card unmounts (tab switch, deletion).
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      persist();
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  function handleDelete() {
    if (!confirm("Delete this note?")) return;
    sendOp({ op: "note.delete", id: note.id });
  }

  // Vouching is its own op, never bundled with the body: a note.update carrying
  // only the freshness pair is exactly the claim "I read this and it still
  // holds", with no edit attached.
  function handleVerify(patch: FreshnessPatchFields) {
    sendOp({ op: "note.update", id: note.id, partial: patch });
  }

  // The verify control hides until you reach for it — except on a note that has
  // aged out, where the whole point is to be asking.
  const stale = needsReview(deriveFreshness(note, now));

  return (
    <div
      ref={cardRef}
      data-agent-target={note.id}
      className={[
        "group bg-surface rounded-lg border transition-all",
        highlighted
          ? "border-transparent ring-2 ring-accent"
          : "border-ink/10 hover:border-ink/20",
      ].join(" ")}
    >
      {/* Card header: where the note CAME FROM on the left, what can be done to
          it on the right. Freshness joins the left — it's a fact about the
          note, not an action. */}
      <div className="flex items-center gap-2 px-4 pt-3">
        {parent && (
          <span className="text-xs bg-ink/10 text-ink/60 rounded-full px-2 py-0.5">
            {parent.kind === "pin"
              ? `Pin · ${parent.label ?? "Unnamed"}`
              : `Event · ${"title" in parent ? parent.title : ""}`}
          </span>
        )}
        <FreshnessChip item={note} now={now} />
        <span className="flex-1" />
        {!readOnly && <VerifyControl item={note} onPatch={handleVerify} alwaysVisible={stale} />}
        <button
          onClick={handleDelete}
          className="rounded p-0.5 text-ink/40 hover:text-rose-600 dark:hover:text-rose-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 transition-opacity"
          title="Delete note"
        >
          <X size={13} />
        </button>
      </div>

      <div className="px-4 pb-4 pt-2">
        <RichTextEditor
          markdown={note.body}
          focused={focused}
          autoFocus={note.body === ""}
          onChangeMarkdown={onChange}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            flush();
            setFocused(false);
          }}
        />

        {note.imageRefs.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {note.imageRefs.map((ref) => (
              <img
                key={ref}
                src={imageUrl(canvasId, ref)}
                alt=""
                className="rounded max-h-48 object-cover border border-ink/10"
              />
            ))}
          </div>
        )}

        {saveState !== "idle" && (
          <div className="mt-2 text-[11px] text-ink/40 select-none">
            {saveState === "saving" || savedAt === null
              ? "Saving…"
              : `Saved at ${formatSavedAt(savedAt)}`}
          </div>
        )}
      </div>
    </div>
  );
}

// A lightweight WYSIWYG surface: a contentEditable div rendered with the same
// prose styles as the read view, so headings/bold/lists look styled as you
// type — no visible Markdown syntax. Storage stays Markdown: we seed the DOM
// from Markdown (markdownToHtml) and serialize it back on every edit
// (htmlToMarkdown). No editor dependency — just the browser's editing model.
function RichTextEditor({
  markdown,
  focused,
  autoFocus,
  onChangeMarkdown,
  onFocus,
  onBlur,
}: {
  markdown: string;
  focused: boolean;
  autoFocus: boolean;
  onChangeMarkdown: (md: string) => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);

  // Seed the surface from Markdown on mount, and re-seed when an authoritative
  // body arrives while we're NOT focused (a remote / agent edit). We never write
  // innerHTML while focused — mid-edit the DOM is the source of truth, so the
  // caret is never yanked out from under the user.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!seeded.current) {
      el.innerHTML = markdownToHtml(markdown);
      seeded.current = true;
      if (autoFocus) el.focus();
      return;
    }
    if (!focused) {
      const html = markdownToHtml(markdown);
      if (el.innerHTML !== html) el.innerHTML = html;
    }
  }, [markdown, focused, autoFocus]);

  // Read the live DOM back to Markdown and hand it up. Runs on every keystroke
  // and after a toolbar command; the parent debounces the actual save.
  function emit() {
    const el = ref.current;
    if (el) onChangeMarkdown(htmlToMarkdown(el.innerHTML));
  }

  // execCommand is deprecated but universally supported and exactly the
  // "lightweight, no heavy editor dep" path this v1 calls for. The bracketed
  // tag form for formatBlock ("<h1>") is the one every browser accepts.
  function cmd(command: string, value?: string) {
    document.execCommand(command, false, value);
    emit();
  }

  // Rich-text paste: normalise clipboard HTML (a webpage or Google-Docs
  // selection) through the Markdown bridge so only supported formatting
  // survives and the surface stays clean. Plain text falls through to the
  // browser's default paste, then emit() picks it up on the following input.
  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const html = e.clipboardData.getData("text/html");
    if (!html.trim()) return;
    e.preventDefault();
    document.execCommand("insertHTML", false, markdownToHtml(htmlToMarkdown(html)));
    emit();
  }

  return (
    <div>
      {focused && <Toolbar onCommand={cmd} />}
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        onInput={emit}
        onFocus={onFocus}
        onBlur={onBlur}
        onPaste={handlePaste}
        data-placeholder="Start typing…"
        className="rich-editor cursor-text min-h-[1.5rem] prose prose-sm max-w-none text-ink/80 focus:outline-none"
      />
    </div>
  );
}

// The formatting toolbar: block styles (Normal / H1–H3) and inline marks
// (bold / italic / bullet / numbered). onMouseDown-preventDefault keeps focus
// and the current selection inside the editor when a button is pressed.
function Toolbar({
  onCommand,
}: {
  onCommand: (command: string, value?: string) => void;
}) {
  const item = (
    label: React.ReactNode,
    command: string,
    value: string | undefined,
    title: string,
  ) => (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onCommand(command, value)}
      className="px-2 py-1 rounded text-xs text-ink/60 hover:bg-ink/10 transition-colors"
    >
      {label}
    </button>
  );

  return (
    <div className="flex items-center gap-0.5 mb-2 -ml-1 flex-wrap select-none">
      {item("Normal", "formatBlock", "<p>", "Normal text")}
      {item("H1", "formatBlock", "<h1>", "Heading 1")}
      {item("H2", "formatBlock", "<h2>", "Heading 2")}
      {item("H3", "formatBlock", "<h3>", "Heading 3")}
      <span className="w-px h-4 bg-ink/10 mx-1" />
      {item(<span className="font-bold">B</span>, "bold", undefined, "Bold")}
      {item(<span className="italic">I</span>, "italic", undefined, "Italic")}
      <span className="w-px h-4 bg-ink/10 mx-1" />
      {item("• List", "insertUnorderedList", undefined, "Bulleted list")}
      {item("1. List", "insertOrderedList", undefined, "Numbered list")}
    </div>
  );
}
