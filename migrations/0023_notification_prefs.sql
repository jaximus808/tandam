-- Per-user, per-canvas notification preferences for canvas activity.
--
-- The agent-activity feed (toasts + bell) narrates what agents do on a canvas —
-- "Claude created a doc", "…updated a spreadsheet row". Until now every viewer
-- saw every event; the only control was a client-only "mute popups" flag that
-- didn't persist across devices and couldn't distinguish event types.
--
-- This stores each user's choice of which events reach them, per canvas, so it
-- follows the account rather than the browser. One JSONB blob (not a column per
-- toggle) keeps the shape forward-compatible: new event categories and new
-- delivery channels — email, push — slot in without another migration. v1 honours
-- only the in-app channel (delivery is filtered client-side); email/push are
-- stored-but-dormant scaffolding for a later worker to consume.
--
-- Shape of `prefs` (all fields optional; absent = the app's default):
--   {
--     "categories": { "docs": true, "sheets": true, "roadmap": true,
--                     "map": true, "itinerary": true, "charts": true },
--     "minorEdits": false,                       -- chatty updates/removals
--     "channels":   { "inApp": true, "email": false, "push": false }
--   }
--
--   • user_id    — whose preferences these are.
--   • canvas_id  — the canvas they apply to (prefs are per-canvas in v1).
--   • prefs      — the JSONB blob above.
--   • (user_id, canvas_id) is the natural key: one row per user per canvas,
--     upserted on write.

CREATE TABLE notification_prefs (
  user_id    UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  canvas_id  UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  prefs      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, canvas_id)
);
