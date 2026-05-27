import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CanvasState, Note } from "../types";
import { imageUrl } from "../lib/api";
import { sendOp } from "../lib/ws";
import EmptyState from "../components/EmptyState";

interface Props {
  canvasId: string;
  state: CanvasState;
}

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
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto w-full px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-semibold text-gray-900">Docs</h1>
          <button
            onClick={handleAddNote}
            className="text-sm px-3 py-1.5 rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700 transition-colors"
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
  const [editing, setEditing] = useState(note.body === "");
  const [draft, setDraft] = useState(note.body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep the draft in sync when the server pushes a new body (e.g. Claude
  // updated this note). Last-write-wins: any in-progress local edits get
  // overwritten, which matches the user's explicit current-behavior preference.
  useEffect(() => {
    setDraft(note.body);
  }, [note.body]);

  // Autosize the textarea to its content so editing feels like a doc rather
  // than a chat input.
  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);

  const parent =
    note.parentId
      ? state.pins[note.parentId] ?? state.events[note.parentId]
      : null;

  function commit() {
    if (draft !== note.body) {
      sendOp({ op: "note.update", id: note.id, partial: { body: draft } });
    }
    setEditing(false);
  }

  function cancel() {
    setDraft(note.body);
    setEditing(false);
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  }

  function handleDelete() {
    if (!confirm("Delete this note?")) return;
    sendOp({ op: "note.delete", id: note.id });
  }

  return (
    <div className="group bg-white rounded-lg border border-gray-200 hover:border-gray-300 transition-colors">
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
        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Edit
            </button>
          )}
          <button
            onClick={handleDelete}
            className="text-xs text-gray-400 hover:text-red-600"
            title="Delete note"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="px-4 pb-4 pt-2">
        {editing ? (
          <div className="space-y-2">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={handleKey}
              autoFocus
              placeholder="Start typing… Markdown supported (tables too)."
              className="w-full min-h-[120px] text-sm text-gray-800 font-mono leading-relaxed bg-transparent resize-none focus:outline-none"
            />
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>Markdown · ⌘⏎ save · Esc cancel</span>
              <div className="flex gap-2">
                <button onClick={cancel} className="hover:text-gray-600">Cancel</button>
                <button
                  onClick={commit}
                  className="text-blue-600 hover:text-blue-700 font-medium"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div
            onClick={() => setEditing(true)}
            className="cursor-text min-h-[1.5rem]"
          >
            {note.body.trim() ? (
              <div className="prose prose-sm max-w-none text-gray-800">
                <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>
                  {note.body}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-gray-400 italic">
                Empty note — click to start writing.
              </p>
            )}
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
