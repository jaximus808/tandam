-- TDM-27 (E1.1): context freshness + briefing designation.
--
-- WHAT THIS ADDS
--   1. `verified_at` (timestamptz, nullable) and `stale_after_seconds` (int,
--      nullable) on the three tables that hold durable canvas context:
--        - documents      (the named document itself — a whole doc can be verified)
--        - notes          (Docs-mode note bodies)
--        - roadmap_items  (roadmap goals / sub-items)
--   2. `canvases.briefing_doc_id` — nullable FK to the document designated as this
--      canvas's briefing (the "read me first" doc an agent pulls on connect).
--
-- WHY — freshness is rot made visible.
--   Shared context silently decays: a note written three weeks ago reads exactly
--   like one written this morning, so agents cite stale facts with full
--   confidence and humans can't tell which parts of a canvas they can still
--   trust. These two columns make decay legible instead of invisible.
--
--   `verified_at` is the last time a human or agent asserted "this is still
--   true" — deliberately NOT `updated_at`. updated_at means "the bytes changed";
--   verified_at means "someone vouched for the content." Fixing a typo bumps
--   updated_at and should not bump verified_at.
--
--   `stale_after_seconds` is the per-item shelf life — how long a verification
--   stays good. It varies enormously by content ("our deploy target is GCP"
--   ages over months; "the staging DB is down" ages in hours), so it is
--   per-row and author-set rather than a global constant.
--
--   Neither column stores a status. Freshness is DERIVED at read time from the
--   pair (E1.3's context_get computes it, so it is never stale-on-read itself):
--     - fresh   — verified_at + stale_after_seconds is comfortably in the future
--     - aging   — approaching that horizon
--     - stale   — past it
--     - unknown — verified_at IS NULL (never verified; not the same as stale)
--   The exact aging threshold is policy and lives in Go (E1.2/E1.3), not here —
--   so it can be tuned without a migration.
--
--   Both columns are NULLABLE with no default, on purpose: existing rows are
--   "never verified / no shelf life declared", which the derivation reads as
--   `unknown`. Backfilling a fake verified_at would be asserting a
--   verification that never happened — exactly the lie this feature exists to
--   remove. No backfill runs here.
--
-- BRIEFING DESIGNATION — why `canvases.briefing_doc_id`, not `documents.is_briefing`.
--   A canvas has AT MOST ONE briefing document. A single nullable FK on the
--   canvas makes that cardinality structural: it cannot represent two briefings,
--   so no invariant needs defending in application code. The `is_briefing` flag
--   would allow N flagged docs per canvas and would need a partial unique index
--   plus a clear-then-set dance on every re-designation. Reads win too: the
--   canvas row is already loaded on every connect, so "does this canvas have a
--   briefing, and which doc is it?" costs zero extra queries — whereas a flag
--   forces a scan of the canvas's documents. ON DELETE SET NULL means deleting
--   the briefing document just un-designates it rather than blocking the delete.
--
-- APPLYING — Jaxon applies this manually to Supabase; nothing in CI runs it.
--   Every statement is guarded (IF NOT EXISTS / DROP … IF EXISTS before ADD), so
--   a re-run is a no-op. Apply as one transaction, the normal manual flow.
--
-- CONTRACT NOTE: the names `verified_at` and `stale_after_seconds` are fixed —
-- E1.2 (Go store layer) and E1.3 (context_get endpoint) read and write exactly
-- these. Do not rename them in a later migration without touching both.

-- ── 1. Freshness columns on the context-bearing tables ────────────────────────
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS verified_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stale_after_seconds INTEGER;

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS verified_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stale_after_seconds INTEGER;

ALTER TABLE roadmap_items
  ADD COLUMN IF NOT EXISTS verified_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stale_after_seconds INTEGER;

-- A shelf life of zero or a negative one has no meaning (it would make an item
-- stale at, or before, the instant it was verified). NULL stays legal — that is
-- "no shelf life declared". Named + dropped-first so a re-run is clean.
ALTER TABLE documents      DROP CONSTRAINT IF EXISTS documents_stale_after_positive;
ALTER TABLE documents
  ADD CONSTRAINT documents_stale_after_positive
  CHECK (stale_after_seconds IS NULL OR stale_after_seconds > 0);

ALTER TABLE notes          DROP CONSTRAINT IF EXISTS notes_stale_after_positive;
ALTER TABLE notes
  ADD CONSTRAINT notes_stale_after_positive
  CHECK (stale_after_seconds IS NULL OR stale_after_seconds > 0);

ALTER TABLE roadmap_items  DROP CONSTRAINT IF EXISTS roadmap_items_stale_after_positive;
ALTER TABLE roadmap_items
  ADD CONSTRAINT roadmap_items_stale_after_positive
  CHECK (stale_after_seconds IS NULL OR stale_after_seconds > 0);

-- ── 2. Briefing designation on the canvas ─────────────────────────────────────
-- Column and FK are added separately so the guarded re-run still (re)establishes
-- the constraint even when the column already exists from a prior partial apply.
ALTER TABLE canvases
  ADD COLUMN IF NOT EXISTS briefing_doc_id UUID;

ALTER TABLE canvases
  DROP CONSTRAINT IF EXISTS canvases_briefing_doc_id_fkey;
ALTER TABLE canvases
  ADD CONSTRAINT canvases_briefing_doc_id_fkey
  FOREIGN KEY (briefing_doc_id) REFERENCES documents(id) ON DELETE SET NULL;

-- The FK's referencing side is unindexed by default; index it so the ON DELETE
-- SET NULL fired by a document delete (and the "is this doc the briefing?"
-- check) doesn't seq-scan canvases. Partial — the overwhelming majority of
-- canvases have no briefing.
CREATE INDEX IF NOT EXISTS canvases_briefing_doc_id_idx
  ON canvases (briefing_doc_id) WHERE briefing_doc_id IS NOT NULL;

-- ── Column comments (self-documenting in psql \d+ / Supabase table view) ──────
COMMENT ON COLUMN documents.verified_at IS
  'Last time a human or agent asserted this document is still true. Distinct from updated_at (bytes changed). NULL = never verified.';
COMMENT ON COLUMN documents.stale_after_seconds IS
  'Shelf life of a verification, in seconds. NULL = no declared shelf life. Freshness is derived from (verified_at, stale_after_seconds) at read time.';
COMMENT ON COLUMN notes.verified_at IS
  'Last time a human or agent asserted this note is still true. Distinct from updated_at (bytes changed). NULL = never verified.';
COMMENT ON COLUMN notes.stale_after_seconds IS
  'Shelf life of a verification, in seconds. NULL = no declared shelf life.';
COMMENT ON COLUMN roadmap_items.verified_at IS
  'Last time a human or agent asserted this roadmap item is still true. Distinct from updated_at (bytes changed). NULL = never verified.';
COMMENT ON COLUMN roadmap_items.stale_after_seconds IS
  'Shelf life of a verification, in seconds. NULL = no declared shelf life.';
COMMENT ON COLUMN canvases.briefing_doc_id IS
  'The document designated as this canvas''s briefing (read-me-first context for agents). At most one per canvas by construction. NULL = no briefing designated.';
