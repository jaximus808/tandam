-- Phase 9.1: optional per-event "day tag" so the map can prefix the
-- day-cluster label with something punchier than the date alone
-- (e.g. "DAY 1 · Friday, May 29"). Lives on the event because day grouping is
-- derived from events; any event on that day can carry the tag, the renderer
-- picks the first non-empty tag (sorted by start_time). NULL → no prefix.

ALTER TABLE events ADD COLUMN day_tag TEXT;
