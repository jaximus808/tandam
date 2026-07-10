import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import remarkGfm from "remark-gfm";
import type { CanvasState, Note } from "../types";
import { imageUrl } from "../lib/api";
import { sendOp } from "../lib/ws";
import { htmlToMarkdown } from "../lib/paste";
import EmptyState from "../components/EmptyState";
import { modeTheme } from "../lib/modeTheme";

interface Props {
  canvasId: string;
  state: CanvasState;
}

const ACCENT = modeTheme("docs");

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

export default function DocsMode({ canvasId, state }: Props) {
  const notes = Object.values(state.notes).sort((a, b) => a.updatedAt - b.updatedAt);

  function handleAddNote() {
    sendOp({
      op: "note.add",
      data: { body: "", imageRefs: [] },
    });
  }

  return (
    <div className="tandem-scroll flex-1 overflow-y-auto bg-paper">
      <div className="max-w-3xl mx-auto w-full px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="font-display text-xl font-medium tracking-tight text-gray-900">Docs</h1>
          <button
            onClick={handleAddNote}
            className="text-sm px-3.5 py-1.5 rounded-lg text-white font-medium shadow-sm transition-opacity hover:opacity-90"
            style={{ backgroundColor: ACCENT.solid }}
          >
            + New note
          </button>
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
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NoteCard({
  note,
  canvasId,
  state,
}: {
  note: Note;
  canvasId: string;
  state: CanvasState;
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

  return (
    <div
      data-agent-target={note.id}
      className="group bg-white rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
    >
      <div className="flex items-center justify-between px-4 pt-3">
        {parent ? (
          <span className="text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">
            {parent.kind === "pin"
              ? `Pin · ${parent.label ?? "Unnamed"}`
              : `Event · ${"title" in parent ? parent.title : ""}`}
          </span>
        ) : (
          <span />
        )}
        <button
          onClick={handleDelete}
          className="text-xs text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Delete note"
        >
          ✕
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
                className="rounded max-h-48 object-cover border border-gray-100"
              />
            ))}
          </div>
        )}

        {saveState !== "idle" && (
          <div className="mt-2 text-[11px] text-gray-400 select-none">
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
        className="rich-editor cursor-text min-h-[1.5rem] prose prose-sm max-w-none text-gray-800 focus:outline-none"
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
      className="px-2 py-1 rounded text-xs text-gray-600 hover:bg-gray-100 transition-colors"
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
      <span className="w-px h-4 bg-gray-200 mx-1" />
      {item(<span className="font-bold">B</span>, "bold", undefined, "Bold")}
      {item(<span className="italic">I</span>, "italic", undefined, "Italic")}
      <span className="w-px h-4 bg-gray-200 mx-1" />
      {item("• List", "insertUnorderedList", undefined, "Bulleted list")}
      {item("1. List", "insertOrderedList", undefined, "Numbered list")}
    </div>
  );
}
