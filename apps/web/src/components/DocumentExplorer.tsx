import { useMemo, useState } from "react";
import { ChevronsLeft, Pencil, Search, Trash2 } from "lucide-react";
import type { CanvasState, Document, DocumentType } from "../types";
import { sendOp } from "../lib/ws";
import { modeTheme } from "../lib/modeTheme";
import { DOC_TYPE_TO_MODE, DOC_TYPE_LABEL } from "../lib/docTypes";

/* ─────────────────────────────────────────────────────────────────────────────
   DocumentExplorer — the left-hand document sidebar (roadmap item 9).

   A flat list of EVERY document on the canvas (not just the open tabs), grouped
   by type, searchable, with inline rename + delete. Clicking a document opens it
   as a tab and focuses it. Open/active state is owned by App (the tab strip);
   rename/delete are shared mutations sent straight over the WS (document.update /
   document.delete), same as DocumentTabs.

   Flat now, tree-ready: documents already carry a reserved `parentId`, and this
   renders one `DocRow` per document under a per-type group. A folder tree would
   slot in by nesting rows under their parent doc instead of grouping by type —
   the row component and the open/rename/delete plumbing stay as-is.
   ──────────────────────────────────────────────────────────────────────────── */

// The order type groups appear in the explorer — mirrors the tab "+" menu, with
// charts last (they're derived from a sheet).
const GROUP_ORDER: DocumentType[] = ["map", "notes", "itinerary", "roadmap", "sheet", "chart"];

interface Props {
  /** Every document on the canvas, in display (sortOrder) order. */
  documents: Document[];
  /** Full canvas state — used to show each document's item count. */
  state: CanvasState;
  /** Documents currently open as tabs (to mark them in the list). */
  openIds: Set<string>;
  /** The focused document, highlighted in the list. */
  activeDocId: string | null;
  /** Open (or focus, if already open) a document as a tab. */
  onOpen: (id: string) => void;
  /** Delete a document for everyone (App also drops it from the tab state). */
  onDelete: (id: string) => void;
  readOnly: boolean;
  onClose: () => void;
}

export default function DocumentExplorer({
  documents,
  state,
  openIds,
  activeDocId,
  onOpen,
  onDelete,
  readOnly,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // How many primary entities each document holds — a cheap "is this empty?"
  // signal. Sheet rows resolve through their parent sheet's document.
  const countByDoc = useMemo(() => {
    const c: Record<string, number> = {};
    const add = (id?: string) => {
      if (id) c[id] = (c[id] ?? 0) + 1;
    };
    for (const p of Object.values(state.pins)) add(p.documentId);
    for (const e of Object.values(state.events)) add(e.documentId);
    for (const n of Object.values(state.notes)) add(n.documentId);
    for (const r of Object.values(state.roadmapItems)) add(r.documentId);
    for (const ch of Object.values(state.charts)) add(ch.documentId);
    const sheetDoc: Record<string, string | undefined> = {};
    for (const s of Object.values(state.sheets)) sheetDoc[s.id] = s.documentId;
    for (const row of Object.values(state.sheetRows)) add(sheetDoc[row.sheetId]);
    return c;
  }, [state]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? documents.filter(
            (d) =>
              (d.name || DOC_TYPE_LABEL[d.type]).toLowerCase().includes(q) ||
              DOC_TYPE_LABEL[d.type].toLowerCase().includes(q),
          )
        : documents,
    [documents, q],
  );

  // Bucket the (already sortOrder-ordered) documents by type for grouped display.
  const groups = useMemo(() => {
    const byType: Record<string, Document[]> = {};
    for (const d of filtered) (byType[d.type] ??= []).push(d);
    return GROUP_ORDER.filter((t) => byType[t]?.length).map((t) => ({ type: t, docs: byType[t] }));
  }, [filtered]);

  function startRename(doc: Document) {
    if (readOnly) return;
    setDeletingId(null);
    setRenamingId(doc.id);
    setDraft(doc.name);
  }

  function commitRename(id: string) {
    const name = draft.trim();
    const current = documents.find((d) => d.id === id);
    setRenamingId(null);
    if (name && current && name !== current.name) {
      sendOp({ op: "document.update", id, partial: { name } });
    }
  }

  return (
    <>
      <div className="flex items-center justify-between border-b border-ink/10 px-3 py-3 pl-4">
        <span className="text-sm font-semibold text-ink">Documents</span>
        <button
          onClick={onClose}
          title="Hide documents"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-ink/35 transition-colors hover:bg-ink/5 hover:text-ink/60"
        >
          <ChevronsLeft size={16} strokeWidth={1.75} />
        </button>
      </div>

      <div className="border-b border-ink/10 p-2.5">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink/30"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documents"
            className="w-full rounded-lg border border-ink/15 bg-white py-1.5 pl-8 pr-2.5 text-[13px] text-ink outline-none placeholder:text-ink/30 focus:border-ink/40"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {documents.length === 0 && (
          <p className="px-2 py-3 text-[12px] leading-relaxed text-ink/45">
            No documents yet. Use the “+” in the tab bar to create a map, notes, itinerary,
            roadmap, or sheet.
          </p>
        )}
        {documents.length > 0 && groups.length === 0 && (
          <p className="px-2 py-3 text-[12px] leading-relaxed text-ink/45">
            No documents match “{query.trim()}”.
          </p>
        )}

        {groups.map(({ type, docs }) => {
          const t = modeTheme(DOC_TYPE_TO_MODE[type]);
          return (
            <div key={type} className="mb-3">
              <div className="mb-1 flex items-center gap-1.5 px-2">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.solid }} />
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/40">
                  {DOC_TYPE_LABEL[type]} · {docs.length}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                {docs.map((doc) => (
                  <DocRow
                    key={doc.id}
                    doc={doc}
                    theme={t}
                    count={countByDoc[doc.id] ?? 0}
                    open={openIds.has(doc.id)}
                    active={doc.id === activeDocId}
                    readOnly={readOnly}
                    renaming={renamingId === doc.id}
                    draft={draft}
                    onDraft={setDraft}
                    onCommitRename={() => commitRename(doc.id)}
                    onCancelRename={() => setRenamingId(null)}
                    onOpen={() => onOpen(doc.id)}
                    onStartRename={() => startRename(doc)}
                    deleting={deletingId === doc.id}
                    onAskDelete={() => {
                      setRenamingId(null);
                      setDeletingId(doc.id);
                    }}
                    onCancelDelete={() => setDeletingId(null)}
                    onConfirmDelete={() => {
                      onDelete(doc.id);
                      setDeletingId(null);
                    }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function DocRow({
  doc,
  theme,
  count,
  open,
  active,
  readOnly,
  renaming,
  draft,
  onDraft,
  onCommitRename,
  onCancelRename,
  onOpen,
  onStartRename,
  deleting,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  doc: Document;
  theme: ReturnType<typeof modeTheme>;
  count: number;
  open: boolean;
  active: boolean;
  readOnly: boolean;
  renaming: boolean;
  draft: string;
  onDraft: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onOpen: () => void;
  onStartRename: () => void;
  deleting: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const label = doc.name || DOC_TYPE_LABEL[doc.type];

  if (renaming) {
    return (
      <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: theme.solid }} />
        <input
          autoFocus
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename();
            if (e.key === "Escape") onCancelRename();
          }}
          className="w-full rounded bg-white px-1.5 py-0.5 text-[13px] text-ink outline-none ring-1 ring-ink/20"
        />
      </div>
    );
  }

  return (
    <div
      onClick={onOpen}
      onDoubleClick={onStartRename}
      className={[
        "group/row flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors",
        active ? "" : "text-ink/70 hover:bg-ink/[0.04] hover:text-ink",
      ].join(" ")}
      style={active ? { backgroundColor: theme.soft, color: theme.solid } : undefined}
      title={open ? `${label} — open` : `Open ${label}`}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: theme.solid }} />
      <span className={`min-w-0 flex-1 truncate ${active ? "font-medium" : ""}`}>{label}</span>

      {deleting ? (
        <span className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onConfirmDelete}
            className="rounded-md bg-rose-600 px-1.5 py-0.5 text-[11px] font-semibold text-white"
            title="Delete this document and everything in it"
          >
            Delete
          </button>
          <button
            onClick={onCancelDelete}
            className="rounded-md border border-ink/15 px-1.5 py-0.5 text-[11px] font-medium text-ink/60 hover:border-ink/30"
          >
            Cancel
          </button>
        </span>
      ) : (
        <>
          {/* Dot marks an open tab; hover reveals rename/delete. Both live in the
              same slot so the row width doesn't jump. */}
          {open && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-40 group-hover/row:hidden"
              title="Open as a tab"
            />
          )}
          {count > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-current/45 group-hover/row:hidden">
              {count}
            </span>
          )}
          {!readOnly && (
            <span className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onStartRename();
                }}
                title="Rename"
                className="flex h-5 w-5 items-center justify-center rounded text-current/50 hover:bg-ink/10 hover:text-current"
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onAskDelete();
                }}
                title="Delete document"
                className="flex h-5 w-5 items-center justify-center rounded text-current/50 hover:bg-rose-50 hover:text-rose-600"
              >
                <Trash2 size={12} />
              </button>
            </span>
          )}
        </>
      )}
    </div>
  );
}
