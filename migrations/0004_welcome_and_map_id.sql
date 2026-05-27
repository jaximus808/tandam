-- Phase 3: welcome mode + dynamic map presets

ALTER TABLE canvases DROP CONSTRAINT canvases_mode_check;
ALTER TABLE canvases
  ADD CONSTRAINT canvases_mode_check
  CHECK (mode IN ('welcome', 'map', 'itinerary', 'docs'));

ALTER TABLE canvases ALTER COLUMN mode SET DEFAULT 'welcome';

ALTER TABLE canvases ADD COLUMN map_id TEXT;

-- Backfill existing map-mode canvases so they keep the Phase 2 Tokyo default
-- (rather than silently shifting to the new "world" fallback). See §9r.
UPDATE canvases SET map_id = 'tokyo' WHERE mode = 'map' AND map_id IS NULL;
