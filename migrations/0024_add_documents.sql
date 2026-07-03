-- Roadmap item 6: Named-document data model.
--
-- Until now a canvas conflated "view type" with "instance": exactly one Map, one
-- Docs/notes view, one Itinerary, one Roadmap per canvas, with the tab strip
-- hardcoded to those types. Sheets and charts were the exception — already
-- named, multi-instance rows. This generalizes what sheets do to EVERY type: a
-- canvas becomes a bag of named `documents`, each an instance of a type, and the
-- per-kind child rows point back at their document via document_id.
--
-- This migration is ADDITIVE. It does NOT drop canvases.mode / map_id /
-- enabled_modes — the currently-deployed API + web still read them. The tab strip
-- (item 8) and tools (item 7) flip the app over to documents later; until then
-- documents ride alongside the old columns.
--
-- Design notes:
--   - config JSONB carries type-specific settings — {"mapId":"tokyo"} for a map
--     document, {} for the rest.
--   - parent_id is reserved for a future folder tree (the document explorer
--     sidebar, item 9). Always NULL today: flat now, tree-ready with no rework.
--   - Every document_id FK is ON DELETE CASCADE, so a document owns its children:
--     deleting the document (the canonical delete, wired in item 7) removes its
--     pins / notes / events / roadmap items, or its sheet / chart row (which in
--     turn cascade to their own rows).

CREATE TABLE documents (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL
                          CHECK (type IN ('map', 'notes', 'itinerary', 'roadmap', 'sheet', 'chart')),
  name        TEXT        NOT NULL DEFAULT '',
  parent_id   UUID        REFERENCES documents(id) ON DELETE CASCADE,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  config      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by  TEXT        NOT NULL DEFAULT 'agent'
                          CHECK (created_by IN ('agent', 'user')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX documents_canvas_id_idx ON documents(canvas_id);
CREATE INDEX documents_parent_id_idx ON documents(parent_id);

CREATE TRIGGER documents_updated_at BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── document_id on every child ────────────────────────────────────────────────
-- Nullable: back-compat rows written before item 7 wires the tools may lack one,
-- and cross-type refs (event.pin_id, chart.sheet_id) are untouched.
ALTER TABLE pins          ADD COLUMN document_id UUID REFERENCES documents(id) ON DELETE CASCADE;
ALTER TABLE events        ADD COLUMN document_id UUID REFERENCES documents(id) ON DELETE CASCADE;
ALTER TABLE notes         ADD COLUMN document_id UUID REFERENCES documents(id) ON DELETE CASCADE;
ALTER TABLE roadmap_items ADD COLUMN document_id UUID REFERENCES documents(id) ON DELETE CASCADE;
ALTER TABLE sheets        ADD COLUMN document_id UUID REFERENCES documents(id) ON DELETE CASCADE;
ALTER TABLE charts        ADD COLUMN document_id UUID REFERENCES documents(id) ON DELETE CASCADE;

CREATE INDEX pins_document_id_idx          ON pins(document_id);
CREATE INDEX events_document_id_idx        ON events(document_id);
CREATE INDEX notes_document_id_idx         ON notes(document_id);
CREATE INDEX roadmap_items_document_id_idx ON roadmap_items(document_id);
CREATE INDEX sheets_document_id_idx        ON sheets(document_id);
CREATE INDEX charts_document_id_idx        ON charts(document_id);

-- ── Backfill ──────────────────────────────────────────────────────────────────
-- Turn each canvas's existing implicit views into concrete document rows and
-- adopt the orphaned children. The doc_id is generated in a CTE so the same value
-- feeds both the INSERT and the child UPDATE in one statement.
--
-- Singleton types (map/notes/itinerary/roadmap): one document per canvas that
-- holds any such content. created_by 'user' since these predate authorship.

-- Map: one per canvas with pins; carry the canvas's base map into config.mapId.
WITH pairs AS (
  SELECT c.id AS canvas_id, gen_random_uuid() AS doc_id, COALESCE(c.map_id, 'world') AS map_id
  FROM canvases c
  WHERE EXISTS (SELECT 1 FROM pins p WHERE p.canvas_id = c.id)
), ins AS (
  INSERT INTO documents (id, canvas_id, type, name, sort_order, config, created_by)
  SELECT doc_id, canvas_id, 'map', 'Map', 0, jsonb_build_object('mapId', map_id), 'user' FROM pairs
)
UPDATE pins SET document_id = pairs.doc_id
FROM pairs WHERE pins.canvas_id = pairs.canvas_id;

-- Notes.
WITH pairs AS (
  SELECT c.id AS canvas_id, gen_random_uuid() AS doc_id
  FROM canvases c
  WHERE EXISTS (SELECT 1 FROM notes n WHERE n.canvas_id = c.id)
), ins AS (
  INSERT INTO documents (id, canvas_id, type, name, sort_order, config, created_by)
  SELECT doc_id, canvas_id, 'notes', 'Notes', 1, '{}'::jsonb, 'user' FROM pairs
)
UPDATE notes SET document_id = pairs.doc_id
FROM pairs WHERE notes.canvas_id = pairs.canvas_id;

-- Itinerary (events).
WITH pairs AS (
  SELECT c.id AS canvas_id, gen_random_uuid() AS doc_id
  FROM canvases c
  WHERE EXISTS (SELECT 1 FROM events e WHERE e.canvas_id = c.id)
), ins AS (
  INSERT INTO documents (id, canvas_id, type, name, sort_order, config, created_by)
  SELECT doc_id, canvas_id, 'itinerary', 'Itinerary', 2, '{}'::jsonb, 'user' FROM pairs
)
UPDATE events SET document_id = pairs.doc_id
FROM pairs WHERE events.canvas_id = pairs.canvas_id;

-- Roadmap.
WITH pairs AS (
  SELECT c.id AS canvas_id, gen_random_uuid() AS doc_id
  FROM canvases c
  WHERE EXISTS (SELECT 1 FROM roadmap_items r WHERE r.canvas_id = c.id)
), ins AS (
  INSERT INTO documents (id, canvas_id, type, name, sort_order, config, created_by)
  SELECT doc_id, canvas_id, 'roadmap', 'Roadmap', 3, '{}'::jsonb, 'user' FROM pairs
)
UPDATE roadmap_items SET document_id = pairs.doc_id
FROM pairs WHERE roadmap_items.canvas_id = pairs.canvas_id;

-- Sheets: already named + multi-instance — one document PER sheet, preserving
-- the sheet's own name / sort_order / authorship.
WITH pairs AS (
  SELECT s.id AS sheet_id, s.canvas_id, gen_random_uuid() AS doc_id, s.name, s.sort_order, s.created_by
  FROM sheets s
), ins AS (
  INSERT INTO documents (id, canvas_id, type, name, sort_order, config, created_by)
  SELECT doc_id, canvas_id, 'sheet', name, sort_order, '{}'::jsonb, created_by FROM pairs
)
UPDATE sheets SET document_id = pairs.doc_id
FROM pairs WHERE sheets.id = pairs.sheet_id;

-- Charts: one document per chart.
WITH pairs AS (
  SELECT ch.id AS chart_id, ch.canvas_id, gen_random_uuid() AS doc_id, ch.name, ch.sort_order, ch.created_by
  FROM charts ch
), ins AS (
  INSERT INTO documents (id, canvas_id, type, name, sort_order, config, created_by)
  SELECT doc_id, canvas_id, 'chart', name, sort_order, '{}'::jsonb, created_by FROM pairs
)
UPDATE charts SET document_id = pairs.doc_id
FROM pairs WHERE charts.id = pairs.chart_id;
