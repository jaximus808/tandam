-- Phase: user-added tabs.
--
-- Until now a "tab" was purely derived from content (the Map tab showed iff the
-- canvas had pins, etc.) and tab switching was local to each viewer — there was
-- no persisted notion of "this canvas has an (empty) Sheets tab". This adds one.
--
-- enabled_modes holds the modes a USER explicitly turned on via the "+" tab,
-- even before they hold any content. The frontend shows the union of
-- content-derived modes and enabled_modes; the agent sees enabled_modes in
-- state.read, so an empty user-added tab reads as intent ("fill this in").
--
-- Agent-created tabs need no entry here — adding content already surfaces them.

ALTER TABLE canvases
  ADD COLUMN enabled_modes JSONB NOT NULL DEFAULT '[]'::jsonb;
