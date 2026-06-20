-- Direct-input layer: agent-defined forms a human fills to mutate the canvas
-- directly — no agent in the submit loop. See docs/DESIGN_DIRECT_INPUT.md.
--
--   forms.fields  = input schema (FormField[])   — what the human fills in
--   forms.actions = canonical DSL (FormAction[])  — compiled fan-out (by name/ref)
--
-- A submit resolves (fields-values + actions) → a concrete `batch` in Go →
-- submit_canvas_form applies it atomically. The SQL never sees the DSL: by the
-- time it runs, every name is a uuid and every value is concrete.

CREATE TABLE IF NOT EXISTS forms (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  fields      JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- input schema (Field[])
  actions     JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- canonical DSL (Action[])
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_by  TEXT        NOT NULL DEFAULT 'agent',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forms_canvas_id_idx ON forms(canvas_id);
CREATE TRIGGER forms_updated_at BEFORE UPDATE ON forms
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Idempotency guard: a repeated submission_id is a no-op. Just enough to make a
-- submit safe to retry / dedupe a double-tap — NOT a submission analytics log
-- (deferred). The row a submit produces in sheet_rows/pins is the real record.
CREATE TABLE IF NOT EXISTS form_submissions (
  canvas_id     UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  submission_id TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (canvas_id, submission_id)
);

-- submit_canvas_form: apply a resolved batch atomically and bump the version.
--
-- The brain is in Go (the resolver computes a concrete batch); this function is a
-- dumb, typed, scope-checking applier. Shape of p_batch:
--   { "inserts": [ { "sheet_id": uuid, "data": { <colId>: <scalar> } } ],
--     "patches": [ { "row_id": uuid, "set": {<colId>:v}, "inc": {<colId>:num} }
--                | { "pin_id": uuid, "set": { color|label|body|pin_type: v } } ] }
-- Every insert/patch re-validates its target's canvas_id server-side (defense in
-- depth). Any RAISE rolls back the whole batch.
CREATE OR REPLACE FUNCTION submit_canvas_form(
  p_canvas_id uuid,
  p_batch jsonb,
  p_submission_id text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  ins      jsonb;
  pat      jsonb;
  v_sheet  uuid;
  v_row    uuid;
  v_pin    uuid;
  v_data   jsonb;
  inc_key  text;
  inc_val  numeric;
BEGIN
  -- Idempotency: a repeated submission_id returns the current version unchanged.
  IF p_submission_id IS NOT NULL AND p_submission_id <> '' THEN
    BEGIN
      INSERT INTO form_submissions (canvas_id, submission_id)
      VALUES (p_canvas_id, p_submission_id);
    EXCEPTION WHEN unique_violation THEN
      RETURN (SELECT version FROM canvases WHERE id = p_canvas_id);
    END;
  END IF;

  -- Inserts (append a new sheet row).
  FOR ins IN SELECT * FROM jsonb_array_elements(COALESCE(p_batch->'inserts', '[]'::jsonb))
  LOOP
    v_sheet := (ins->>'sheet_id')::uuid;
    PERFORM 1 FROM sheets WHERE id = v_sheet AND canvas_id = p_canvas_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'sheet % not in canvas %', v_sheet, p_canvas_id;
    END IF;
    INSERT INTO sheet_rows (id, sheet_id, data, created_by)
    VALUES (gen_random_uuid(), v_sheet, COALESCE(ins->'data', '{}'::jsonb), 'user');
  END LOOP;

  -- Patches (upsert hit → row patch; or pin patch).
  FOR pat IN SELECT * FROM jsonb_array_elements(COALESCE(p_batch->'patches', '[]'::jsonb))
  LOOP
    IF pat ? 'row_id' THEN
      v_row := (pat->>'row_id')::uuid;
      PERFORM 1 FROM sheet_rows sr JOIN sheets s ON s.id = sr.sheet_id
        WHERE sr.id = v_row AND s.canvas_id = p_canvas_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'sheet row % not in canvas %', v_row, p_canvas_id;
      END IF;
      SELECT data INTO v_data FROM sheet_rows WHERE id = v_row;
      v_data := COALESCE(v_data, '{}'::jsonb) || COALESCE(pat->'set', '{}'::jsonb);
      IF pat ? 'inc' THEN
        FOR inc_key, inc_val IN SELECT key, value::numeric FROM jsonb_each_text(pat->'inc')
        LOOP
          v_data := jsonb_set(
            v_data, ARRAY[inc_key],
            to_jsonb(COALESCE(NULLIF(v_data->>inc_key, '')::numeric, 0) + inc_val)
          );
        END LOOP;
      END IF;
      UPDATE sheet_rows SET data = v_data WHERE id = v_row;

    ELSIF pat ? 'pin_id' THEN
      v_pin := (pat->>'pin_id')::uuid;
      PERFORM 1 FROM pins WHERE id = v_pin AND canvas_id = p_canvas_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pin % not in canvas %', v_pin, p_canvas_id;
      END IF;
      UPDATE pins SET
        color    = COALESCE(pat->'set'->>'color',    color),
        label    = COALESCE(pat->'set'->>'label',    label),
        body     = COALESCE(pat->'set'->>'body',     body),
        pin_type = COALESCE(pat->'set'->>'pin_type', pin_type)
      WHERE id = v_pin;
    END IF;
  END LOOP;

  RETURN bump_canvas_version(p_canvas_id);
END;
$$;

GRANT EXECUTE ON FUNCTION submit_canvas_form(uuid, jsonb, text) TO anon, service_role;
