-- Roadmap item 8.5: Folders for documents (an explorer tree).
--
-- Documents already carry a `parent_id` (migration 0024 reserved it: "flat now,
-- tree-ready"). This migration lights it up by introducing a `folder` document
-- type — a document that holds no content, existing only to parent other
-- documents (and nested folders) so the explorer can render a tree.
--
-- Two changes:
--
--   1. Allow type='folder'. Folders are creatable via canvas_document_add /
--      document.add like any other type; they simply never render as a tab.
--
--   2. Flip parent_id's FK from ON DELETE CASCADE to ON DELETE SET NULL. A folder
--      is an organizational container, NOT an owner: deleting a folder must move
--      its children back to the root, never cascade-delete them (and everything
--      inside them). Content still cascades via each row's document_id FK
--      (unchanged) — only the parent_id (folder membership) link is relaxed.
--
-- The constraint names below are Postgres's auto-generated defaults from
-- migration 0024 (documents_type_check, documents_parent_id_fkey).

-- 1. Permit the folder type.
ALTER TABLE documents DROP CONSTRAINT documents_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_type_check
  CHECK (type IN ('map', 'notes', 'itinerary', 'roadmap', 'sheet', 'chart', 'folder'));

-- 2. Folder delete orphans its children to the root instead of cascading.
ALTER TABLE documents DROP CONSTRAINT documents_parent_id_fkey;
ALTER TABLE documents ADD CONSTRAINT documents_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES documents(id) ON DELETE SET NULL;
