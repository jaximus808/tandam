-- Ticket IDs for tasks (display form "TDM-<n>", per canvas).
--
-- Every action of type 'task' gets a small, human-readable sequential number
-- scoped to its canvas — referenceable in commit messages ("TDM-142") and the
-- web Tasks panel, unlike a UUID. Only the integer is stored; the "TDM-" display
-- form is constructed in the API serialization layer.
--
--   - canvases.next_ticket is the per-canvas counter (next number to hand out).
--   - actions.ticket is NULL for non-task action types (e.g. 'navigate').
--   - reserve_task_tickets is the atomic allocator: a single UPDATE on the
--     canvas row, so concurrent task creations can never receive the same
--     number (row-level locking serializes the increments). It reserves n
--     CONSECUTIVE numbers in one call so a batch insert costs one round trip.

ALTER TABLE canvases ADD COLUMN next_ticket INT NOT NULL DEFAULT 1;
ALTER TABLE actions  ADD COLUMN ticket INT;

-- Atomically reserves n consecutive ticket numbers for a canvas and returns
-- the FIRST of the reserved range (the caller assigns first, first+1, …,
-- first+n-1). Follows the bump_canvas_version RPC-helper pattern (0003).
CREATE OR REPLACE FUNCTION reserve_task_tickets(canvas_id UUID, n INT DEFAULT 1)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  first_ticket INTEGER;
BEGIN
  IF n < 1 THEN
    RAISE EXCEPTION 'reserve_task_tickets: n must be >= 1 (got %)', n;
  END IF;

  UPDATE canvases
  SET next_ticket = next_ticket + n
  WHERE id = canvas_id
  RETURNING next_ticket - n INTO first_ticket;

  IF first_ticket IS NULL THEN
    RAISE EXCEPTION 'canvas not found: %', canvas_id;
  END IF;

  RETURN first_ticket;
END;
$$;

-- Grant execute to the anon and service_role so PostgREST can call it.
GRANT EXECUTE ON FUNCTION reserve_task_tickets(UUID, INT) TO anon, service_role;
