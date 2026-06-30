-- Account-level notifications (the "a canvas was shared with you" inbox).
--
-- Migration 0021 lets an owner share a private canvas with another account, but
-- the grantee had no way to learn it happened — they'd only see it if they
-- already knew the code. This adds a per-account inbox so a share surfaces on the
-- grantee's homepage with an unread badge, and a "shared with you" list.
--
-- Generic by design (kind discriminates) so later events — comments, mentions,
-- agent-finished — can reuse the same table without another migration:
--
--   • user_id       — whose inbox this lands in (the recipient).
--   • kind          — 'canvas_shared' today; the only consumer-relevant payload
--                     fields (canvas_id, actor, role) are columns, not JSON, so
--                     the join stays a plain PostgREST embed.
--   • canvas_id     — the canvas the event is about (NULL for canvas-less kinds).
--   • actor_user_id — who caused it (the owner who shared); SET NULL if they're
--                     deleted so the notification survives as "someone".
--   • role          — for 'canvas_shared', the access level granted (read|write).
--   • read_at       — NULL = unread; stamped when the recipient opens the inbox.

CREATE TABLE notifications (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  kind          TEXT        NOT NULL,
  canvas_id     UUID        REFERENCES canvases(id) ON DELETE CASCADE,
  actor_user_id UUID        REFERENCES users(id)    ON DELETE SET NULL,
  role          TEXT,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The inbox query is always "my notifications, newest first"; the unread badge is
-- "my notifications where read_at IS NULL". Both ride this index.
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
