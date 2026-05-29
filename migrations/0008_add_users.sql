-- Phase 7: user accounts (Google OAuth).
--
-- Authentication only for now: identify a human and tie them to an account.
-- Authorization (canvas ownership / membership / sharing) layers on later via
-- separate tables + nullable columns on `canvases` — see project auth notes.
--
-- We store our own user row (no Supabase Auth) and mint our own session JWT
-- after verifying Google's ID token, so we keep one auth system and stay
-- portable off Supabase.

CREATE TABLE users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub    TEXT        UNIQUE NOT NULL,   -- Google's stable subject id
  email         TEXT        NOT NULL DEFAULT '',
  display_name  TEXT        NOT NULL DEFAULT '',
  avatar_url    TEXT        NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX users_google_sub_idx ON users(google_sub);
