-- Per-user default public role.
--
-- Companion to default_canvas_visibility (0026). When a user creates a PUBLIC
-- canvas, this preference decides whether a bare code-holder gets 'write' (can
-- edit) or 'read' (view only). Applied at creation time in CreateCanvas for a
-- logged-in human; anonymous / MCP creates ignore it and keep the canvas column
-- default (see 0021).
--
-- This does NOT affect the owner or shared members: ResolveCanvasRole resolves
-- owner→write and an explicit canvas_access row→its role BEFORE ever falling back
-- to public_role. So "added to the canvas" (or owning it) always grants the
-- shared role regardless of this setting — public_role only governs code-only,
-- unauthenticated access.
--
-- DEFAULT 'read' deliberately DIFFERS from the canvas column default ('write',
-- which 0021 kept load-bearing for backwards compatibility). A code that grants
-- write to anyone who has it is a footgun; new accounts should hand out view-only
-- by default and opt into write. Existing users pick up 'read' here too — they
-- can flip it back to 'write' in settings if they prefer the old behavior.

ALTER TABLE users
  ADD COLUMN default_public_role TEXT NOT NULL DEFAULT 'read'
    CHECK (default_public_role IN ('read', 'write'));
