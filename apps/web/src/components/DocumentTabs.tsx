import { useRef, useState } from "react";
import { X, Plus } from "lucide-react";
import type { Document, DocumentType } from "../types";
import { sendOp } from "../lib/ws";
import { DOC_TYPE_LABEL, CREATABLE_DOC_TYPES } from "../lib/docTypes";

interface Props {
  /** Open documents, in display (sortOrder) order. */
  docs: Document[];
  activeDocId: string | null;
  onSelect: (id: string) => void;
  /** Close = hide this tab locally (non-destructive; the document still exists). */
  onClose: (id: string) => void;
  /** Create a new document of this type and open it. */
  onCreate: (type: DocumentType) => void;
  /** The pinned client-side Board pseudo-tab (full-page task board). It is NOT
      a document — always present, never closable, purely local navigation. */
  boardActive: boolean;
  onSelectBoard: () => void;
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
  boardActive,
  onSelectBoard,
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
      {/* Pinned Board pseudo-tab — outside the scrollable doc-tab list so it's
          always reachable, styled like a tab (it's product chrome, not a
          document). Active/selected = accent, like every tab. */}
      <button
        onClick={onSelectBoard}
        className={[
          "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] font-medium shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          boardActive ? "bg-accent/[0.08] text-accent" : "text-ink/55 hover:bg-ink/5 hover:text-ink/80",
        ].join(" ")}
        title="Task board — every task and epic on this canvas"
        aria-pressed={boardActive}
      >
        <span
          className={["h-2 w-2 rounded-full shrink-0 bg-current", boardActive ? "" : "opacity-40"].join(" ")}
        />
        Board
      </button>
      <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-ink/10" />

      {/* Only the tab list scrolls. The "+" and its menu live OUTSIDE this
          overflow container — a dropdown rendered inside an `overflow-x-auto`
          box gets clipped vertically (overflow-y computes to auto too), which
          is why the menu never appeared. */}
      <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto no-scrollbar">
      {docs.map((doc) => {
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
              "group flex items-center gap-1.5 rounded-md pl-2.5 pr-1.5 py-1 text-[13px] font-medium shrink-0 cursor-pointer transition-colors",
              active ? "bg-accent/[0.08] text-accent" : "text-ink/55 hover:bg-ink/5 hover:text-ink/80",
            ].join(" ")}
            title={DOC_TYPE_LABEL[doc.type]}
          >
            <span className={["h-2 w-2 rounded-full shrink-0 bg-current", active ? "" : "opacity-40"].join(" ")} />
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
                className="w-24 bg-surface rounded px-1 py-0 text-[13px] text-ink outline-none ring-2 ring-accent/40"
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
                className="flex h-4 w-4 items-center justify-center rounded text-current/50 opacity-0 hover:bg-ink/10 group-hover:opacity-100"
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
            className="ml-0.5 flex h-7 w-7 items-center justify-center rounded-md text-ink/45 hover:bg-ink/5 hover:text-ink/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
                className="absolute left-0 mt-1.5 z-20 min-w-[11rem] rounded-lg bg-surface border border-ink/10 shadow-lg py-1"
              >
                <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-ink/45">
                  New document
                </div>
                {CREATABLE_DOC_TYPES.map((type) => (
                  <button
                    key={type}
                    role="menuitem"
                    onClick={() => {
                      onCreate(type);
                      setAddOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] font-medium text-ink/70 hover:bg-ink/5 hover:text-ink"
                  >
                    <span className="h-2 w-2 rounded-full shrink-0 bg-ink/25" />
                    {DOC_TYPE_LABEL[type]}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
