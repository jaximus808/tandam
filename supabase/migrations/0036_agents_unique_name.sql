-- TDM-8: agent identity is (canvas_id, name). RegisterAgent used to blind-
-- INSERT on every connect, so each re-registration minted a fresh row for the
-- same name; TouchAgentLastSeen (matching on name) then bumped every duplicate
-- at once — a crowd of ghost executors all looking equally alive in the swarm
-- view. Dedupe first, then enforce uniqueness so the API's new register/claim
-- UPSERT has its ON CONFLICT target.
--
-- Steps 1 and 2 must see the same ranking — apply this file as one transaction
-- (the normal manual flow), not statement-by-statement with writes in between.

-- ── 1. Repoint children of doomed duplicates ──────────────────────────────────
-- Per (canvas_id, name) the survivor is the freshest row: greatest
-- last_seen_at, id as the deterministic tiebreak. parent_agent_id is ON DELETE
-- SET NULL (0035), so deleting a duplicate parent before repointing would
-- silently flatten its subtree — move children onto the survivor FIRST.
-- child.id <> survivor.id guards the degenerate case where the survivor's own
-- recorded parent is a doomed duplicate of its own name: it must not become
-- its own parent (the delete's SET NULL leaves it unparented instead).
WITH ranked AS (
  SELECT id, canvas_id, name,
         row_number() OVER (
           PARTITION BY canvas_id, name
           ORDER BY last_seen_at DESC, created_at DESC, id DESC
         ) AS rn
  FROM agents
)
UPDATE agents child
SET parent_agent_id = survivor.id
FROM ranked doomed
JOIN ranked survivor
  ON  survivor.canvas_id = doomed.canvas_id
  AND survivor.name      = doomed.name
  AND survivor.rn        = 1
WHERE doomed.rn > 1
  AND child.parent_agent_id = doomed.id
  AND child.id <> survivor.id;

-- ── 2. Delete the duplicates ──────────────────────────────────────────────────
-- Same ranking as step 1; everything but the per-(canvas_id, name) survivor goes.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY canvas_id, name
           ORDER BY last_seen_at DESC, created_at DESC, id DESC
         ) AS rn
  FROM agents
)
DELETE FROM agents
USING ranked
WHERE agents.id = ranked.id
  AND ranked.rn > 1;

-- ── 3. One row per (canvas_id, name), from here on ────────────────────────────
-- The ON CONFLICT target for RegisterAgent's upsert and the claim path's
-- touch-or-create; its backing index also serves the touch-by-name lookup.
ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_canvas_name_key;
ALTER TABLE agents
  ADD CONSTRAINT agents_canvas_name_key UNIQUE (canvas_id, name);
