-- Phase 8: an itinerary entry (event) can cover multiple pins.
--
-- e.g. a single "check-in errands" entry that spans several stops. Pins remain
-- usable without any itinerary (ungrouped) — this just lets one entry own many.
--
-- We add an ordered array column rather than a join table to match the existing
-- "fat row" style (cf. notes.image_refs TEXT[]). Dangling ids are tolerated the
-- same way the app already tolerates a missing pin_id (the reader skips
-- unresolved ids). pin_id (singular) stays for back-compat / travel endpoints
-- use from_pin_id + to_pin_id, which are unaffected.

ALTER TABLE events ADD COLUMN pin_ids UUID[] NOT NULL DEFAULT '{}';

-- Backfill: fold any existing single pin_id into the new list.
UPDATE events SET pin_ids = ARRAY[pin_id] WHERE pin_id IS NOT NULL;
