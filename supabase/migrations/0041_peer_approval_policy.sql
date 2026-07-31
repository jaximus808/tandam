-- Peer approval (TDM-145): a FOURTH approval policy, 'peer', alongside the three
-- migration 0033 introduced.
--
--   'strict' — every agent-proposed task lands proposed (unchanged).
--   'epic'   — (default) a task under an APPROVED epic is born approved (unchanged).
--   'auto'   — every agent task is born approved (unchanged).
--   'peer'   — NEW. Every agent task lands proposed, exactly like 'strict'; what
--              'peer' changes is WHO may approve it afterwards. A REGISTERED
--              agent may approve a proposed task that a DIFFERENT agent
--              proposed, so an orchestrator + reviewer pair can pilot a pipeline
--              without a human clicking Approve on every card. The non-self rule
--              is enforced SERVER-SIDE from provenance (the approver's derived
--              authored_by vs the stored authored_by of the row), never from the
--              request body. Born-approved, reject, bulk approve and EPIC
--              approval all stay human-only under 'peer'. Approving an epic does
--              NOT cascade under 'peer' (same as 'strict') — the per-task gate is
--              the reviewer's. See apps/api/internal/api/peer_approval.go.
--
-- This migration ONLY widens the CHECK constraint. It changes no row's value and
-- no column's default: every existing canvas keeps the policy it has and behaves
-- byte-for-byte as it did, because 'peer' is reachable only by an explicit
-- owner-only PATCH /api/canvases/{code}/approval-policy.
--
-- An approval made under 'peer' is recorded in actions.approved_by as the
-- approving agent's server-derived identity, "agent:<name>" — the same
-- vocabulary as authored_by (migration 0039). A reader tells an agent approval
-- from a human one by that prefix: 'human' is a human, 'agent:…' is a peer
-- agent, 'policy:auto' / 'policy:epic' are the birth-time cascades.

-- APPLY MANUALLY (Jaxon). Apply BEFORE deploying the API change: until the CHECK
-- is widened, a PATCH setting 'peer' is rejected by the database. Nothing else
-- breaks in the meantime — the API refuses peer approval on every other policy,
-- which is every canvas.
--
-- 0033 declared the CHECK inline on ADD COLUMN, so Postgres auto-named it
-- (canvases_approval_policy_check by the usual <table>_<column>_check rule).
-- Dropping it by that assumed name would SILENTLY NO-OP if this database ever
-- named it something else, and the old three-value CHECK would still be there
-- rejecting 'peer' — a failure that looks like the app is broken, not the
-- migration. So find it by what it constrains rather than by what it is called.
DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'canvases' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%approval_policy%'
  LOOP
    EXECUTE format('ALTER TABLE public.canvases DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE public.canvases ADD CONSTRAINT canvases_approval_policy_check
  CHECK (approval_policy IN ('strict', 'epic', 'auto', 'peer'));

COMMENT ON COLUMN canvases.approval_policy IS
  'How much human gating agent-proposed tasks get: strict | epic (default) | auto | peer. peer = a registered agent may approve a task a DIFFERENT agent proposed (non-self enforced server-side from provenance); nothing is born approved under it.';
