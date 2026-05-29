-- Phase 9: per-event timezone so the itinerary displays each event in its
-- location's local time (not the viewer's machine zone).
--
-- start_time stays a true UTC instant (timestamptz). timezone is the IANA name
-- of THIS event's location (e.g. 'America/Chicago'). The frontend formats and
-- day-groups the stored instant in this zone. Per-event (not a global setting)
-- so cross-timezone trips render correctly. NULL → frontend falls back to the
-- viewer's local zone.

ALTER TABLE events ADD COLUMN timezone TEXT;
