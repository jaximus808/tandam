import { useRef } from "react";
import ReactMarkdown from "react-markdown";
import type { CanvasState, PendingEdit } from "../types";
import ScopedEdit from "../components/ScopedEdit";
import { uploadImage, imageUrl } from "../lib/api";
import { sendOp } from "../lib/ws";

interface Props {
  canvasId: string;
  state: CanvasState;
  pendingEdits: PendingEdit[];
}

export default function DocsMode({ canvasId, state, pendingEdits }: Props) {
  const notes = Object.values(state.notes).sort((a, b) => a.updatedAt - b.updatedAt);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadTarget, setUploadTarget] = [
    useRef<string | null>(null),
    (id: string | null) => {
      uploadTarget.current = id;
    },
  ];

  async function handleFileDrop(noteId: string, files: FileList | null) {
    if (!files?.length) return;
    const note = state.notes[noteId];
    if (!note) return;
    try {
      const uploads = await Promise.all(Array.from(files).map(uploadImage));
      sendOp({
        op: "note.update",
        id: noteId,
        partial: { imageRefs: [...note.imageRefs, ...uploads] },
      });
    } catch (err) {
      alert(`Upload failed: ${err}`);
    }
  }

  if (notes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        No notes yet — ask Claude to add some.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 max-w-2xl mx-auto w-full space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (uploadTarget.current) handleFileDrop(uploadTarget.current, e.target.files);
          e.target.value = "";
        }}
      />

      {notes.map((note) => {
        const parent =
          note.parentId
            ? state.pins[note.parentId] ?? state.events[note.parentId]
            : null;

        return (
          <div
            key={note.id}
            className="bg-white rounded-lg border border-gray-200 p-4"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFileDrop(note.id, e.dataTransfer.files);
            }}
          >
            {parent && (
              <span className="inline-block mb-2 text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">
                {parent.kind === "pin"
                  ? `📍 ${parent.label ?? "Pin"}`
                  : `🗓 ${"title" in parent ? parent.title : ""}`}
              </span>
            )}

            <ScopedEdit entityId={note.id} pendingEdits={pendingEdits}>
              <div className="prose prose-sm max-w-none text-gray-700">
                <ReactMarkdown>{note.body}</ReactMarkdown>
              </div>
            </ScopedEdit>

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

            <button
              onClick={() => {
                setUploadTarget(note.id);
                fileInputRef.current?.click();
              }}
              className="mt-3 text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              + attach image
            </button>
          </div>
        );
      })}
    </div>
  );
}
