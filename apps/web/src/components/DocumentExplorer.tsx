import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import type { CanvasState, Document, DocumentType } from "../types";
import { sendOp } from "../lib/ws";
import { modeTheme } from "../lib/modeTheme";
import { DOC_TYPE_TO_MODE, DOC_TYPE_LABEL } from "../lib/docTypes";

/* ─────────────────────────────────────────────────────────────────────────────
   DocumentExplorer — the left-hand document sidebar, as a folder tree (item 8.5).

   Documents carry a reserved `parentId` (migration 0024). A `folder` document
   (migration 0025) holds no content; it exists only to nest other documents. This
   renders the hierarchy:

     • Root-level folders first, each expand/collapse-able, showing their children
       (nested folders recurse; loose docs list flat).
     • Then the root-level documents, grouped by type (the common no-folders case).

   Drag a document (or folder) onto a folder to move it in; drop it on the empty
   body to pull it back to the root. Moves go over the WS as document.reorder
   (parentId + sortOrder); rename/delete/open reuse the existing plumbing. A
   folder delete moves its children back to the root (the DB FK is ON DELETE SET
   NULL) — it never cascades.

   While a search query is active we drop the tree and show a flat, type-grouped
   list of every matching document, so a collapsed folder never hides a hit.
   ──────────────────────────────────────────────────────────────────────────── */

const ROOT = "__root__";

// The order type groups appear in — mirrors the tab "+" menu, charts last.
const GROUP_ORDER: DocumentType[] = ["map", "notes", "itinerary", "roadmap", "sheet", "chart"];

interface Props {
  /** Every document on the canvas (including folders), in sortOrder order. */
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
  /** Create a new (empty) folder at the root. */
  onCreateFolder: () => void;
  /** Move a document into a folder (parentId) or back to the root (null). */
  onMove: (id: string, parentId: string | null) => void;
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
  onCreateFolder,
  onMove,
  readOnly,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Folders are expanded by default; this holds the ids the user has collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // folder id or ROOT

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

  // Documents bucketed by parent (ROOT for top-level). Preserves sortOrder since
  // `documents` arrives sorted.
  const childrenByParent = useMemo(() => {
    const m: Record<string, Document[]> = {};
    for (const d of documents) (m[d.parentId ?? ROOT] ??= []).push(d);
    return m;
  }, [documents]);

  // Descendant-folder ids of a folder — so a folder can't be dropped into itself
  // or its own subtree (which would orphan the branch / make a cycle).
  const descendantsOf = (id: string): Set<string> => {
    const out = new Set<string>();
    const walk = (pid: string) => {
      for (const child of childrenByParent[pid] ?? []) {
        out.add(child.id);
        if (child.type === "folder") walk(child.id);
      }
    };
    walk(id);
    return out;
  };

  const q = query.trim().toLowerCase();

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

  function toggleCollapsed(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Whether the currently-dragged doc may drop onto folder `id` (or ROOT).
  function canDrop(targetFolderId: string): boolean {
    if (!draggingId || readOnly) return false;
    if (targetFolderId === ROOT) {
      const dragged = documents.find((d) => d.id === draggingId);
      return (dragged?.parentId ?? null) !== null; // already at root → no-op
    }
    if (targetFolderId === draggingId) return false;
    const dragged = documents.find((d) => d.id === draggingId);
    if ((dragged?.parentId ?? null) === targetFolderId) return false; // already here
    if (dragged?.type === "folder" && descendantsOf(draggingId).has(targetFolderId)) return false;
    return true;
  }

  function handleDropOn(targetFolderId: string) {
    if (draggingId && canDrop(targetFolderId)) {
      onMove(draggingId, targetFolderId === ROOT ? null : targetFolderId);
    }
    setDraggingId(null);
    setDropTarget(null);
  }

  const rowShared = {
    countByDoc,
    openIds,
    activeDocId,
    readOnly,
    renamingId,
    draft,
    deletingId,
    onDraft: setDraft,
    onCommitRename: commitRename,
    onCancelRename: () => setRenamingId(null),
    onOpen,
    onStartRename: startRename,
    onAskDelete: (id: string) => {
      setRenamingId(null);
      setDeletingId(id);
    },
    onCancelDelete: () => setDeletingId(null),
    onConfirmDelete: (id: string) => {
      onDelete(id);
      setDeletingId(null);
    },
    // Drag plumbing
    draggingId,
    dropTarget,
    onDragStart: (id: string) => setDraggingId(id),
    onDragEnd: () => {
      setDraggingId(null);
      setDropTarget(null);
    },
    canDrop,
    onDragOverFolder: (id: string) => setDropTarget(id),
    onDropOn: handleDropOn,
  };

  // Renders a flat list of non-folder docs grouped by type, at a given depth.
  function renderTypeGroups(docs: Document[], depth: number) {
    const byType: Record<string, Document[]> = {};
    for (const d of docs) if (d.type !== "folder") (byType[d.type] ??= []).push(d);
    const groups = GROUP_ORDER.filter((t) => byType[t]?.length);
    return groups.map((type) => {
      const t = modeTheme(DOC_TYPE_TO_MODE[type]);
      return (
        <div key={type} className="mb-2">
          <div
            className="mb-1 flex items-center gap-1.5 px-2"
            style={{ paddingLeft: 8 + depth * 14 }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.solid }} />
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/40">
              {DOC_TYPE_LABEL[type]} · {byType[type].length}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {byType[type].map((doc) => (
              <DocRow key={doc.id} doc={doc} theme={t} depth={depth} {...rowShared} />
            ))}
          </div>
        </div>
      );
    });
  }

  // Renders one folder and, when expanded, its subtree.
  function renderFolder(folder: Document, depth: number) {
    const kids = childrenByParent[folder.id] ?? [];
    const subFolders = kids.filter((d) => d.type === "folder");
    const isCollapsed = collapsed.has(folder.id);
    return (
      <div key={folder.id}>
        <FolderRow
          folder={folder}
          depth={depth}
          childCount={kids.length}
          collapsed={isCollapsed}
          onToggle={() => toggleCollapsed(folder.id)}
          {...rowShared}
        />
        {!isCollapsed && (
          <div>
            {subFolders.map((f) => renderFolder(f, depth + 1))}
            {renderTypeGroups(kids, depth + 1)}
            {kids.length === 0 && (
              <p
                className="py-1 text-[11px] italic text-ink/30"
                style={{ paddingLeft: 34 + depth * 14 }}
              >
                Empty — drag documents here
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  const rootChildren = childrenByParent[ROOT] ?? [];
  const rootFolders = rootChildren.filter((d) => d.type === "folder");

  // Flat, type-grouped search results (every matching doc, folders ignored).
  const searchResults = useMemo(() => {
    if (!q) return [];
    return documents.filter(
      (d) =>
        d.type !== "folder" &&
        ((d.name || DOC_TYPE_LABEL[d.type]).toLowerCase().includes(q) ||
          DOC_TYPE_LABEL[d.type].toLowerCase().includes(q)),
    );
  }, [documents, q]);

  return (
    <>
      <div className="flex items-center justify-between border-b border-ink/10 px-3 py-3 pl-4">
        <span className="text-sm font-semibold text-ink">Documents</span>
        <div className="flex items-center gap-0.5">
          {!readOnly && (
            <button
              onClick={onCreateFolder}
              title="New folder"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-ink/35 transition-colors hover:bg-ink/5 hover:text-ink/60"
            >
              <FolderPlus size={16} strokeWidth={1.75} />
            </button>
          )}
          <button
            onClick={onClose}
            title="Hide documents"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink/35 transition-colors hover:bg-ink/5 hover:text-ink/60"
          >
            <ChevronsLeft size={16} strokeWidth={1.75} />
          </button>
        </div>
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

      {/* Body doubles as the root drop zone: a drop that isn't claimed by a folder
          moves the dragged document back to the top level. */}
      <div
        className={[
          "min-h-0 flex-1 overflow-y-auto p-2",
          dropTarget === ROOT ? "bg-ink/[0.03]" : "",
        ].join(" ")}
        onDragOver={(e) => {
          if (canDrop(ROOT)) {
            e.preventDefault();
            setDropTarget(ROOT);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          handleDropOn(ROOT);
        }}
      >
        {documents.length === 0 && (
          <p className="px-2 py-3 text-[12px] leading-relaxed text-ink/45">
            No documents yet. Use the “+” in the tab bar to create a map, notes, itinerary,
            roadmap, or sheet — then group them with the folder button above.
          </p>
        )}

        {q ? (
          searchResults.length === 0 ? (
            <p className="px-2 py-3 text-[12px] leading-relaxed text-ink/45">
              No documents match “{query.trim()}”.
            </p>
          ) : (
            renderTypeGroups(searchResults, 0)
          )
        ) : (
          <>
            {rootFolders.map((f) => renderFolder(f, 0))}
            {renderTypeGroups(rootChildren, 0)}
          </>
        )}
      </div>
    </>
  );
}

// ── Rows ──────────────────────────────────────────────────────────────────────

// The props every row shares (passed through from the explorer via {...rowShared}).
interface RowShared {
  countByDoc: Record<string, number>;
  openIds: Set<string>;
  activeDocId: string | null;
  readOnly: boolean;
  renamingId: string | null;
  draft: string;
  deletingId: string | null;
  onDraft: (v: string) => void;
  onCommitRename: (id: string) => void;
  onCancelRename: () => void;
  onOpen: (id: string) => void;
  onStartRename: (doc: Document) => void;
  onAskDelete: (id: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (id: string) => void;
  draggingId: string | null;
  dropTarget: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  canDrop: (targetFolderId: string) => boolean;
  onDragOverFolder: (id: string) => void;
  onDropOn: (targetFolderId: string) => void;
}

function FolderRow({
  folder,
  depth,
  childCount,
  collapsed,
  onToggle,
  ...s
}: RowShared & {
  folder: Document;
  depth: number;
  childCount: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const renaming = s.renamingId === folder.id;
  const deleting = s.deletingId === folder.id;
  const isDropTarget = s.dropTarget === folder.id && s.canDrop(folder.id);
  const label = folder.name || "Folder";
  const pad = 8 + depth * 14;

  if (renaming) {
    return (
      <div className="flex items-center gap-2 rounded-lg py-1.5 pr-2" style={{ paddingLeft: pad }}>
        <Folder size={14} className="shrink-0 text-amber-500" />
        <input
          autoFocus
          value={s.draft}
          onChange={(e) => s.onDraft(e.target.value)}
          onBlur={() => s.onCommitRename(folder.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") s.onCommitRename(folder.id);
            if (e.key === "Escape") s.onCancelRename();
          }}
          className="w-full rounded bg-white px-1.5 py-0.5 text-[13px] text-ink outline-none ring-1 ring-ink/20"
        />
      </div>
    );
  }

  return (
    <div
      draggable={!s.readOnly}
      onDragStart={(e) => {
        e.stopPropagation();
        s.onDragStart(folder.id);
      }}
      onDragEnd={s.onDragEnd}
      onClick={onToggle}
      onDoubleClick={() => s.onStartRename(folder)}
      onDragOver={(e) => {
        if (s.canDrop(folder.id)) {
          e.preventDefault();
          e.stopPropagation();
          s.onDragOverFolder(folder.id);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        s.onDropOn(folder.id);
      }}
      className={[
        "group/row flex cursor-pointer items-center gap-1 rounded-lg py-1.5 pr-2 text-[13px] font-medium transition-colors",
        isDropTarget ? "bg-amber-100 ring-1 ring-amber-300" : "text-ink/80 hover:bg-ink/[0.04]",
      ].join(" ")}
      style={{ paddingLeft: pad }}
      title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
    >
      {collapsed ? (
        <ChevronRight size={14} className="shrink-0 text-ink/40" />
      ) : (
        <ChevronDown size={14} className="shrink-0 text-ink/40" />
      )}
      {collapsed ? (
        <Folder size={15} className="shrink-0 text-amber-500" />
      ) : (
        <FolderOpen size={15} className="shrink-0 text-amber-500" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>

      {deleting ? (
        <span className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => s.onConfirmDelete(folder.id)}
            className="rounded-md bg-rose-600 px-1.5 py-0.5 text-[11px] font-semibold text-white"
            title="Delete this folder (its documents move to the root)"
          >
            Delete
          </button>
          <button
            onClick={s.onCancelDelete}
            className="rounded-md border border-ink/15 px-1.5 py-0.5 text-[11px] font-medium text-ink/60 hover:border-ink/30"
          >
            Cancel
          </button>
        </span>
      ) : (
        <>
          {childCount > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-ink/35 group-hover/row:hidden">
              {childCount}
            </span>
          )}
          {!s.readOnly && (
            <span className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  s.onStartRename(folder);
                }}
                title="Rename folder"
                className="flex h-5 w-5 items-center justify-center rounded text-ink/50 hover:bg-ink/10 hover:text-ink"
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  s.onAskDelete(folder.id);
                }}
                title="Delete folder"
                className="flex h-5 w-5 items-center justify-center rounded text-ink/50 hover:bg-rose-50 hover:text-rose-600"
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

function DocRow({
  doc,
  theme,
  depth,
  ...s
}: RowShared & {
  doc: Document;
  theme: ReturnType<typeof modeTheme>;
  depth: number;
}) {
  const label = doc.name || DOC_TYPE_LABEL[doc.type];
  const open = s.openIds.has(doc.id);
  const active = doc.id === s.activeDocId;
  const renaming = s.renamingId === doc.id;
  const deleting = s.deletingId === doc.id;
  const pad = 18 + depth * 14;

  if (renaming) {
    return (
      <div className="flex items-center gap-2 rounded-lg py-1.5 pr-2" style={{ paddingLeft: pad }}>
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: theme.solid }} />
        <input
          autoFocus
          value={s.draft}
          onChange={(e) => s.onDraft(e.target.value)}
          onBlur={() => s.onCommitRename(doc.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") s.onCommitRename(doc.id);
            if (e.key === "Escape") s.onCancelRename();
          }}
          className="w-full rounded bg-white px-1.5 py-0.5 text-[13px] text-ink outline-none ring-1 ring-ink/20"
        />
      </div>
    );
  }

  return (
    <div
      draggable={!s.readOnly}
      onDragStart={(e) => {
        e.stopPropagation();
        s.onDragStart(doc.id);
      }}
      onDragEnd={s.onDragEnd}
      onClick={() => s.onOpen(doc.id)}
      onDoubleClick={() => s.onStartRename(doc)}
      className={[
        "group/row flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2 text-[13px] transition-colors",
        active ? "" : "text-ink/70 hover:bg-ink/[0.04] hover:text-ink",
      ].join(" ")}
      style={active ? { backgroundColor: theme.soft, color: theme.solid, paddingLeft: pad } : { paddingLeft: pad }}
      title={open ? `${label} — open` : `Open ${label}`}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: theme.solid }} />
      <span className={`min-w-0 flex-1 truncate ${active ? "font-medium" : ""}`}>{label}</span>

      {deleting ? (
        <span className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => s.onConfirmDelete(doc.id)}
            className="rounded-md bg-rose-600 px-1.5 py-0.5 text-[11px] font-semibold text-white"
            title="Delete this document and everything in it"
          >
            Delete
          </button>
          <button
            onClick={s.onCancelDelete}
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
          {(s.countByDoc[doc.id] ?? 0) > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-current/45 group-hover/row:hidden">
              {s.countByDoc[doc.id]}
            </span>
          )}
          {!s.readOnly && (
            <span className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  s.onStartRename(doc);
                }}
                title="Rename"
                className="flex h-5 w-5 items-center justify-center rounded text-current/50 hover:bg-ink/10 hover:text-current"
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  s.onAskDelete(doc.id);
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
