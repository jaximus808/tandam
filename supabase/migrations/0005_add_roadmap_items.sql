-- Phase 4: roadmap mode (hierarchical outliner)

ALTER TABLE canvases DROP CONSTRAINT canvases_mode_check;
ALTER TABLE canvases
  ADD CONSTRAINT canvases_mode_check
  CHECK (mode IN ('welcome', 'map', 'itinerary', 'docs', 'roadmap'));

CREATE TABLE roadmap_items (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  parent_id   UUID        REFERENCES roadmap_items(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  body        TEXT        NOT NULL DEFAULT '',
  status      TEXT        NOT NULL DEFAULT 'todo'
                          CHECK (status IN ('todo', 'in_progress', 'done', 'blocked')),
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_by  TEXT        NOT NULL DEFAULT 'agent'
                          CHECK (created_by IN ('agent', 'user')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX roadmap_items_canvas_id_idx ON roadmap_items(canvas_id);
CREATE INDEX roadmap_items_canvas_parent_idx ON roadmap_items(canvas_id, parent_id);

CREATE TRIGGER roadmap_items_updated_at BEFORE UPDATE ON roadmap_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
