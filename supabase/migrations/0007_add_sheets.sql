-- Phase 6: sheets mode (multiple spreadsheets per canvas with dynamic columns).
--
-- Schema notes:
--   - Columns live as JSONB on the sheet row (rather than their own table)
--     because a sheet typically has <30 columns and renames/deletes are atomic.
--   - Row data is JSONB keyed by column.id (uuid), not column.name. Renames
--     are free; deletions cascade by removing the field from each row's JSONB.
--   - Column shape: { id, name, type, sortOrder }
--   - Cell value types: string | number | boolean | null (date stored as
--     ISO-8601 string).

ALTER TABLE canvases DROP CONSTRAINT canvases_mode_check;
ALTER TABLE canvases
  ADD CONSTRAINT canvases_mode_check
  CHECK (mode IN ('welcome', 'map', 'itinerary', 'docs', 'roadmap', 'sheets'));

CREATE TABLE sheets (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL DEFAULT 'Untitled sheet',
  columns     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_by  TEXT        NOT NULL DEFAULT 'agent'
                          CHECK (created_by IN ('agent', 'user')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sheet_rows (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id    UUID        NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  data        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_by  TEXT        NOT NULL DEFAULT 'agent'
                          CHECK (created_by IN ('agent', 'user')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sheets_canvas_id_idx   ON sheets(canvas_id);
CREATE INDEX sheet_rows_sheet_id_idx ON sheet_rows(sheet_id);

CREATE TRIGGER sheets_updated_at BEFORE UPDATE ON sheets
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER sheet_rows_updated_at BEFORE UPDATE ON sheet_rows
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
