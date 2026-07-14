-- RPC helpers called by the Go API via Supabase PostgREST
-- These run atomically inside the DB, solving the version-bump problem
-- without needing a direct Postgres connection or transactions.

-- Atomically increments canvas version and returns the new value.
CREATE OR REPLACE FUNCTION bump_canvas_version(canvas_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_version INTEGER;
BEGIN
  UPDATE canvases
  SET version = version + 1, updated_at = now()
  WHERE id = canvas_id
  RETURNING version INTO new_version;

  IF new_version IS NULL THEN
    RAISE EXCEPTION 'canvas not found: %', canvas_id;
  END IF;

  RETURN new_version;
END;
$$;

-- Grant execute to the anon and service_role so PostgREST can call it.
GRANT EXECUTE ON FUNCTION bump_canvas_version(UUID) TO anon, service_role;
