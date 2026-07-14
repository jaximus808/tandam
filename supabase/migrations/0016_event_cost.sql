-- Phase 9.2: optional per-event cost so the itinerary is the source of truth for
-- spend. The trip's total cost is derived from events (summed live in the UI),
-- so editing the itinerary always keeps the total correct — no separate sheet to
-- hand-maintain. Stored as NUMERIC; NULL → no cost recorded for this event.

ALTER TABLE events ADD COLUMN cost NUMERIC;
