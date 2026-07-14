-- Performance indexes for Phase 2 access patterns

-- Canvas lookup by code (most frequent: MCP auth + browser open)
CREATE INDEX IF NOT EXISTS idx_canvases_code ON canvases (code);

-- Entity lookups by canvas (state reads)
CREATE INDEX IF NOT EXISTS idx_pins_canvas_id    ON pins    (canvas_id);
CREATE INDEX IF NOT EXISTS idx_events_canvas_id  ON events  (canvas_id);
CREATE INDEX IF NOT EXISTS idx_notes_canvas_id   ON notes   (canvas_id);
CREATE INDEX IF NOT EXISTS idx_pending_canvas_id ON pending_edits (canvas_id);

-- Events by canvas + time (itinerary view ordering)
CREATE INDEX IF NOT EXISTS idx_events_canvas_start ON events (canvas_id, start_time);

-- Notes by parent entity
CREATE INDEX IF NOT EXISTS idx_notes_parent ON notes (parent_id) WHERE parent_id IS NOT NULL;
