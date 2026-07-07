import { useRef, useState } from "react";
import { X, Plus } from "lucide-react";
import type { Document, DocumentType } from "../types";
import { sendOp } from "../lib/ws";
import { modeTheme } from "../lib/modeTheme";
import { DOC_TYPE_TO_MODE, DOC_TYPE_LABEL, CREATABLE_DOC_TYPES } from "../lib/docTypes";

interface Props {
  /** Open documents, in display (sortOrder) order. */
  docs: Document[];
  activeDocId: string | null;
  onSelect: (id: string) => void;
  /** Close = hide this tab locally (non-destructive; the document still exists). */
  onClose: (id: string) => void;
  /** Create a new document of this type and open it. */
  onCreate: (type: DocumentType) => void;
  readOnly: boolean;
}

/* The canvas tab strip — one tab per OPEN document (migration 0024). Double-click
   to rename, drag to reorder, ✕ to close, + to create any doc type. Rename and
   reorder are shared mutations (document.update / document.reorder); open/close/
   active-tab are local to this viewer (like switching tabs in a Google Doc). */
export default function DocumentTabs({
  docs,
  activeDocId,
  onSelect,
  onClose,
  onCreate,
  readOnly,
}: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const dragId = useRef<string | null>(null);

  function startRename(doc: Document) {
    if (readOnly) return;
    setRenamingId(doc.id);
    setDraft(doc.name);
  }

  function commitRename(id: string) {
    const name = draft.trim();
    const current = docs.find((d) => d.id === id);
    setRenamingId(null);
    if (name && current && name !== current.name) {
      sendOp({ op: "document.update", id, partial: { name } });
    }
  }

  function onDrop(targetId: string) {
    const from = dragId.current;
    dragId.current = null;
    if (readOnly || !from || from === targetId) return;
    const ids = docs.map((d) => d.id);
    const fromIdx = ids.indexOf(from);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0]);
    // Reorder within the tab strip only — keep each document's folder membership.
    const parentOf = new Map(docs.map((d) => [d.id, d.parentId ?? null]));
    sendOp({
      op: "document.reorder",
      updates: ids.map((id, i) => ({ id, parentId: parentOf.get(id) ?? null, sortOrder: i })),
    });
  }

  return (
    <div className="flex items-center gap-0.5 min-w-0">
      {/* Only the tab list scrolls. The "+" and its menu live OUTSIDE this
          overflow container — a dropdown rendered inside an `overflow-x-auto`
          box gets clipped vertically (overflow-y computes to auto too), which
          is why the menu never appeared. */}
      <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto no-scrollbar">
      {docs.map((doc) => {
        const t = modeTheme(DOC_TYPE_TO_MODE[doc.type]);
        const active = doc.id === activeDocId;
        const renaming = renamingId === doc.id;
        return (
          <div
            key={doc.id}
            draggable={!readOnly && !renaming}
            onDragStart={() => (dragId.current = doc.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(doc.id)}
            onClick={() => onSelect(doc.id)}
            className={[
              "group flex items-center gap-1.5 rounded-lg pl-2.5 pr-1.5 py-1 text-sm font-medium shrink-0 cursor-pointer transition-colors",
              active ? "" : "text-gray-500 hover:bg-gray-900/5 hover:text-gray-800",
            ].join(" ")}
            style={active ? { backgroundColor: t.soft, color: t.solid } : undefined}
            title={DOC_TYPE_LABEL[doc.type]}
          >
            <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: t.solid }} />
            {renaming ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commitRename(doc.id)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(doc.id);
                  if (e.key === "Escape") setRenamingId(null);
                }}
                className="w-24 bg-white/80 rounded px-1 py-0 text-sm text-gray-900 outline-none ring-1 ring-gray-900/15"
              />
            ) : (
              <span
                className="max-w-[12rem] truncate"
                onDoubleClick={() => startRename(doc)}
              >
                {doc.name || DOC_TYPE_LABEL[doc.type]}
              </span>
            )}
            {!readOnly && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(doc.id);
                }}
                className="flex h-4 w-4 items-center justify-center rounded text-current/50 opacity-0 hover:bg-gray-900/10 group-hover:opacity-100"
                title="Close tab"
                aria-label={`Close ${doc.name}`}
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
      </div>

      {!readOnly && (
        <div className="relative shrink-0">
          <button
            onClick={() => setAddOpen((o) => !o)}
            className="ml-0.5 flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-900/5 hover:text-gray-700 transition-colors"
            title="New document"
            aria-haspopup="menu"
            aria-expanded={addOpen}
          >
            <Plus size={16} />
          </button>
          {addOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setAddOpen(false)} />
              <div
                role="menu"
                className="absolute left-0 mt-1.5 z-20 min-w-[11rem] rounded-xl bg-white border border-gray-900/10 shadow-lg shadow-gray-900/5 py-1"
              >
                <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  New document
                </div>
                {CREATABLE_DOC_TYPES.map((type) => {
                  const t = modeTheme(DOC_TYPE_TO_MODE[type]);
                  return (
                    <button
                      key={type}
                      role="menuitem"
                      onClick={() => {
                        onCreate(type);
                        setAddOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-100"
                    >
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: t.solid }} />
                      {DOC_TYPE_LABEL[type]}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
