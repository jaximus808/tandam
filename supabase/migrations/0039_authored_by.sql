-- TDM-40 (E4.1): provenance — who authored a row, decided by the SERVER.
--
-- APPLY MANUALLY (Jaxon). 0037 (context freshness) is owned by a parallel branch
-- and is unrelated to this file; the two touch disjoint columns and may be applied
-- in either order. Numbering 0039 was assigned by the orchestrator — do NOT
-- renumber this file even if 0037 is missing from your checkout.
--
-- WHY THIS EXISTS
-- A board that mixes human and agent writes is only trustworthy if you can tell
-- the two apart at a glance. We already have `created_by` / `proposed_by`, but
-- those are FREEFORM LABELS the client sends: the MCP gateway hardcodes the
-- literal string 'agent' on note/document creates, the web app sends 'human',
-- and nothing on the server checks either. A caller can write whatever it likes
-- there, so they cannot answer "did a person do this?".
--
-- authored_by is the answer to that question, and it is never read off the
-- request body. The API derives it per request from the AUTH CONTEXT
-- (apps/api/internal/api/provenance.go) and stamps it on INSERT only.
--
-- VOCABULARY  (exactly three shapes; anything else is a bug)
--
--   'human'            the request carried a valid Google session (browser
--                      cookie / WebSocket connection resolved to a user id).
--                      This is the load-bearing one: a caller CANNOT claim it
--                      without a real signed session, so 'human' is unforgeable.
--
--   'agent:<identity>' the request asserted an agent identity — the
--                      X-Tandem-Agent header the MCP gateway sends on every
--                      canvas call, carrying the same claimant string used for
--                      task claims (the agent_register name when registered,
--                      otherwise the per-session handle, e.g. 'session-a1b2c3').
--                      HONEST LIMIT: <identity> is CLIENT-ASSERTED. An agent can
--                      call itself anything, exactly as it can today with
--                      claimed_by. What is server-derived — and what this column
--                      is for — is the CLASSIFICATION: the 'agent:' prefix is
--                      stamped by the server, and an agent can never emit a bare
--                      'human' or borrow a session it doesn't have.
--
--   'anonymous'        a valid canvas token (or public-canvas WebSocket) with no
--                      user session and no asserted agent identity. Someone with
--                      the canvas code and no account.
--
--   NULL               UNKNOWN — the row predates provenance. Deliberately not
--                      backfilled: guessing 'human' for a million old rows would
--                      be a lie stored in a column whose entire value is that it
--                      doesn't lie. The UI renders nothing for NULL.
--
-- Nullable, no default, no CHECK constraint: a DB-level enum here would have to
-- allow the open-ended 'agent:*' arm anyway, and the Go layer is the only writer.
-- No index — this is display metadata read as part of the canvas state blob, and
-- nothing filters on it.

ALTER TABLE actions   ADD COLUMN IF NOT EXISTS authored_by TEXT;
ALTER TABLE notes     ADD COLUMN IF NOT EXISTS authored_by TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS authored_by TEXT;

COMMENT ON COLUMN actions.authored_by   IS 'Server-derived provenance: human | agent:<identity> | anonymous. NULL = predates TDM-40. Never client-supplied.';
COMMENT ON COLUMN notes.authored_by     IS 'Server-derived provenance: human | agent:<identity> | anonymous. NULL = predates TDM-40. Never client-supplied.';
COMMENT ON COLUMN documents.authored_by IS 'Server-derived provenance: human | agent:<identity> | anonymous. NULL = predates TDM-40. Never client-supplied.';
