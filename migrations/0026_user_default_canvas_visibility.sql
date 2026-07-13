-- Per-user default canvas visibility.
--
-- A user preference for whether the canvases THEY create start 'public' (anyone
-- with the code, today's behavior) or 'private' (only them + shared accounts).
-- Applied at creation time in CreateCanvas when a logged-in human makes a canvas;
-- anonymous / MCP creates ignore it and keep the public default (see migration
-- 0021 — 'public' reproduces today's fully-open behavior).
--
-- DEFAULT 'public' is load-bearing: every existing user, and every new canvas
-- created before someone opts in, stays fully open. Nothing changes until a user
-- flips this on their settings page.

ALTER TABLE users
  ADD COLUMN default_canvas_visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (default_canvas_visibility IN ('public', 'private'));
