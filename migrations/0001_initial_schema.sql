-- AgentCanvas Phase 2 — initial schema
-- Postgres (Supabase). Apply once against a fresh database.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── canvases ──────────────────────────────────────────────────────────────────
CREATE TABLE canvases (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        CHAR(8)     UNIQUE NOT NULL,
  name        TEXT        NOT NULL,
  mode        TEXT        NOT NULL DEFAULT 'map'
                          CHECK (mode IN ('map', 'itinerary', 'docs')),
  version     INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── pins ──────────────────────────────────────────────────────────────────────
CREATE TABLE pins (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  pin_type    TEXT        NOT NULL DEFAULT 'marker'
                          CHECK (pin_type IN ('marker', 'annotation')),
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  label       TEXT,
  body        TEXT,
  color       TEXT,
  created_by  TEXT        NOT NULL DEFAULT 'agent'
                          CHECK (created_by IN ('agent', 'user')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── events ────────────────────────────────────────────────────────────────────
CREATE TABLE events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ,
  pin_id      UUID        REFERENCES pins(id) ON DELETE SET NULL,
  created_by  TEXT        NOT NULL DEFAULT 'agent'
                          CHECK (created_by IN ('agent', 'user')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── notes ─────────────────────────────────────────────────────────────────────
CREATE TABLE notes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  body        TEXT        NOT NULL DEFAULT '',
  image_refs  TEXT[]      NOT NULL DEFAULT '{}',
  parent_id   UUID,
  parent_kind TEXT        CHECK (parent_kind IN ('pin', 'event')),
  created_by  TEXT        NOT NULL DEFAULT 'agent'
                          CHECK (created_by IN ('agent', 'user')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── pending_edits ─────────────────────────────────────────────────────────────
CREATE TABLE pending_edits (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  entity_id   UUID        NOT NULL,
  instruction TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── updated_at triggers ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER canvases_updated_at BEFORE UPDATE ON canvases
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER pins_updated_at BEFORE UPDATE ON pins
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER events_updated_at BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER notes_updated_at BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
