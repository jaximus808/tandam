-- Canvas ownership (organization, not access control).
--
-- A canvas may be owned by a user account. owner_user_id NULL = anonymous /
-- legacy canvas (today's behavior, unchanged) — still fully accessible by code.
-- Ownership is assigned ONLY at creation (a logged-in web create) and powers the
-- "my canvases" list so users stop losing canvases across devices. Anonymous
-- canvases are never "claimed" — a user makes one theirs by deep-COPYING it
-- (see migration 0018's copy_canvas).
--
-- ON DELETE SET NULL: deleting a user orphans their canvases (back to anonymous)
-- rather than destroying them.

ALTER TABLE canvases
  ADD COLUMN owner_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX canvases_owner_user_id_idx ON canvases(owner_user_id);
