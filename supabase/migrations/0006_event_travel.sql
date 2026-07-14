-- Phase 5: travel segments — events that span two pins.
-- A "travel event" has fromPinId + toPinId + travelMode set together; the map
-- renders it as a polyline (with a mode icon at the midpoint) and the itinerary
-- renders it as a "A → B" card. Events without these fields behave as before.

ALTER TABLE events
  ADD COLUMN from_pin_id  UUID REFERENCES pins(id) ON DELETE SET NULL,
  ADD COLUMN to_pin_id    UUID REFERENCES pins(id) ON DELETE SET NULL,
  ADD COLUMN travel_mode  TEXT CHECK (travel_mode IN ('flight', 'train', 'drive'));

CREATE INDEX events_from_pin_idx ON events(from_pin_id);
CREATE INDEX events_to_pin_idx   ON events(to_pin_id);
