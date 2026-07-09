import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest draft, so a debounced/blur flush always saves what's on screen even
  // if state has moved on.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Keep the draft in sync when the server pushes a new body (e.g. Claude edited
  // this note) — but only while we're NOT typing, so an agent edit never yanks
  // text out from under the caret. On blur our copy saves (last-write-wins).
  useEffect(() => {
    if (!focused) setDraft(note.body);
  }, [note.body, focused]);

  // Autosize the textarea to its content so it reads like a page, not an input.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, focused]);

  const parent =
    note.parentId
      ? state.pins[note.parentId] ?? state.events[note.parentId]
      : null;

  // Persist the current draft if it changed. Called by the autosave debounce and
  // on blur — there is no explicit save action.
  function flush() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (draftRef.current !== note.body) {
      sendOp({ op: "note.update", id: note.id, partial: { body: draftRef.current } });
    }
  }

  function onChange(next: string) {
    setDraft(next);
    // Autosave: coalesce keystrokes, then push. Feels continuously saved.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      if (draftRef.current !== note.body) {
        sendOp({ op: "note.update", id: note.id, partial: { body: draftRef.current } });
      }
    }, 500);
  }

  // Flush any pending autosave if the card unmounts (tab switch, deletion).
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Rich-text paste: if the clipboard carries HTML (a webpage or Google-Docs
  // selection), convert it to Markdown and splice it in at the cursor. Notes
  // render Markdown, so this preserves headings/links/lists/tables instead of
  // flattening them. Plain-text paste falls through to the default (item 13).
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const html = e.clipboardData.getData("text/html");
    if (!html.trim()) return;
    const md = htmlToMarkdown(html);
    if (!md) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + md + draft.slice(end);
    onChange(next);
    const caret = start + md.length;
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.selectionStart = ta.selectionEnd = caret;
        ta.focus();
      }
    });
  }

  function handleDelete() {
    if (!confirm("Delete this note?")) return;
    sendOp({ op: "note.delete", id: note.id });
  }

  // Clicking the rendered view swaps to the source textarea and focuses it.
  function enterEditing() {
    setFocused(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  const showSource = focused || !note.body.trim();

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
        {showSource ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              flush();
              setFocused(false);
            }}
            onPaste={handlePaste}
            autoFocus={note.body === ""}
            placeholder="Start typing… Markdown supported (tables too)."
            className="w-full min-h-[1.5rem] text-sm text-gray-800 font-mono leading-relaxed bg-transparent resize-none focus:outline-none"
          />
        ) : (
          <div
            onClick={enterEditing}
            className="cursor-text min-h-[1.5rem] prose prose-sm max-w-none text-gray-800"
          >
            <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>
              {note.body}
            </ReactMarkdown>
          </div>
        )}

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

      </div>
    </div>
  );
}
