-- Phase 7: charts mode. A chart visualizes data from a sheet — pick a source
-- sheet, an x-axis (category) column, and one or more numeric y columns to plot
-- as series. Column refs are stored as SheetColumn.id (stable across renames);
-- the API resolves column names → ids on write.
--
-- Schema notes:
--   - y_columns is a JSONB array of column ids.
--   - sheet_id has ON DELETE CASCADE so deleting a sheet removes its charts.
--   - chart_type ∈ bar | line | area | pie.

ALTER TABLE canvases DROP CONSTRAINT canvases_mode_check;
ALTER TABLE canvases
  ADD CONSTRAINT canvases_mode_check
  CHECK (mode IN ('welcome', 'map', 'itinerary', 'docs', 'roadmap', 'sheets', 'charts'));

CREATE TABLE charts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  sheet_id    UUID        NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL DEFAULT 'Untitled chart',
  chart_type  TEXT        NOT NULL DEFAULT 'bar'
                          CHECK (chart_type IN ('bar', 'line', 'area', 'pie')),
  x_column    TEXT        NOT NULL DEFAULT '',
  y_columns   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_by  TEXT        NOT NULL DEFAULT 'agent'
                          CHECK (created_by IN ('agent', 'user')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX charts_canvas_id_idx ON charts(canvas_id);
CREATE INDEX charts_sheet_id_idx  ON charts(sheet_id);

CREATE TRIGGER charts_updated_at BEFORE UPDATE ON charts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
