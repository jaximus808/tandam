-- Explicit ordering for notes inside a Docs document.
--
-- Until now DocsMode sorted notes by `updated_at`, which meant editing any note
-- silently jerked it to the bottom of the page — position was a side effect of
-- typing rather than something you chose. This adds the same `sort_order` column
-- that `documents` / `sheets` / `charts` already carry (migration 0024), so order
-- is authored and persisted.
--
-- Backfill mirrors the CURRENT on-screen order (updated_at ascending) rather than
-- resetting to zero, so the first render after deploy is byte-identical to what
-- people saw before and nothing reshuffles under them.

ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Number densely (0..n-1) within each document. Partition by canvas_id as well:
-- document_id is nullable (pre-0024 rows may still lack one), and those orphans
-- should be ordered among themselves per canvas, not lumped into one global NULL
-- bucket across every canvas.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY canvas_id, document_id
           ORDER BY updated_at ASC, id ASC
         ) - 1 AS rn
  FROM notes
)
UPDATE notes SET sort_order = ranked.rn
FROM ranked WHERE notes.id = ranked.id;
