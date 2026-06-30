-- Canvas visibility + per-account access (the Google-Docs model).
--
-- Until now the 8-char canvas code WAS the access control: anyone holding it
-- could read AND write, human or agent (see migrations 0017/0020 — ownership was
-- deliberately "organization, not access control"). This migration adds the real
-- authorization layer that ownership left for later.
--
-- Two new columns on `canvases` + one join table:
--
--   • visibility  — 'public' (anyone with the code, today's behavior) or
--                   'private' (only the owner + accounts in canvas_access).
--   • public_role — when public, whether the code grants 'write' (today) or only
--                   'read'. Meaningless when private (gate is membership, not code).
--   • canvas_access(canvas_id, user_id, role) — accounts the owner has shared a
--     private (or read-only public) canvas with, each at 'read' or 'write'.
--
-- The resolver (apps/api store) combines these: owner → write; access row → its
-- role; else public → public_role; else (private, not a member) → none.
--
-- DEFAULTS ARE LOAD-BEARING: 'public' / 'write' reproduce exactly today's
-- behavior, so every existing canvas — and every new one created before the
-- owner opts in — stays fully open. Nothing is restricted until someone chooses.

ALTER TABLE canvases
  ADD COLUMN visibility  TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'private')),
  ADD COLUMN public_role TEXT NOT NULL DEFAULT 'write'
    CHECK (public_role IN ('read', 'write'));

CREATE TABLE canvas_access (
  canvas_id  UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  role       TEXT        NOT NULL CHECK (role IN ('read', 'write')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One access level per (canvas, user); re-sharing updates the role in place.
  PRIMARY KEY (canvas_id, user_id)
);

-- "Canvases shared with me" lookups hit user_id; the PK already covers
-- (canvas_id, user_id) for the per-canvas member list + resolver point-check.
CREATE INDEX canvas_access_user_id_idx ON canvas_access(user_id);
