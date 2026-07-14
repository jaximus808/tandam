-- copy_canvas: deep-copy a canvas into a brand-new one owned by p_owner.
--
-- This is how a user "owns" an existing (anonymous) canvas — by COPYING it, not
-- claiming it (claiming would let anyone steal a canvas they merely hold the
-- code to). Atomic: the whole copy runs in the RPC's transaction, so a failure
-- leaves nothing half-written.
--
-- Strategy: regenerate every entity's id, and remap internal references through
-- per-entity old->new id maps. Sheet COLUMN ids are deliberately preserved (they
-- live in sheets.columns JSONB and are referenced by sheet_rows.data keys and
-- charts.x_column/y_columns) — so keeping them means row data + chart refs stay
-- valid for free; only the row/sheet/chart row-ids change.
--
-- Copies content only (pins, events, notes, roadmap_items, sheets, sheet_rows,
-- charts). Runtime rows (actions, agents, pending_edits) are intentionally not
-- copied. p_code is supplied by the caller (Go generates it with the canonical
-- alphabet + retries on unique-violation), so code generation stays in one place.

CREATE OR REPLACE FUNCTION copy_canvas(p_src uuid, p_owner uuid, p_name text, p_code text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_new uuid := gen_random_uuid();
BEGIN
  INSERT INTO canvases (id, code, name, mode, map_id, enabled_modes, owner_user_id)
  SELECT v_new, p_code, p_name, mode, map_id, enabled_modes, p_owner
  FROM canvases WHERE id = p_src;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'source canvas % not found', p_src;
  END IF;

  CREATE TEMP TABLE _pin_map   (old uuid PRIMARY KEY, new uuid) ON COMMIT DROP;
  CREATE TEMP TABLE _evt_map   (old uuid PRIMARY KEY, new uuid) ON COMMIT DROP;
  CREATE TEMP TABLE _note_map  (old uuid PRIMARY KEY, new uuid) ON COMMIT DROP;
  CREATE TEMP TABLE _rm_map    (old uuid PRIMARY KEY, new uuid) ON COMMIT DROP;
  CREATE TEMP TABLE _sheet_map (old uuid PRIMARY KEY, new uuid) ON COMMIT DROP;

  INSERT INTO _pin_map   SELECT id, gen_random_uuid() FROM pins          WHERE canvas_id = p_src;
  INSERT INTO _evt_map   SELECT id, gen_random_uuid() FROM events        WHERE canvas_id = p_src;
  INSERT INTO _note_map  SELECT id, gen_random_uuid() FROM notes         WHERE canvas_id = p_src;
  INSERT INTO _rm_map    SELECT id, gen_random_uuid() FROM roadmap_items WHERE canvas_id = p_src;
  INSERT INTO _sheet_map SELECT id, gen_random_uuid() FROM sheets        WHERE canvas_id = p_src;

  -- pins
  INSERT INTO pins (id, canvas_id, pin_type, lat, lng, label, body, color, created_by)
  SELECT m.new, v_new, p.pin_type, p.lat, p.lng, p.label, p.body, p.color, p.created_by
  FROM pins p JOIN _pin_map m ON m.old = p.id
  WHERE p.canvas_id = p_src;

  -- events (remap pin_id / from_pin_id / to_pin_id and each element of pin_ids[],
  -- preserving array order; dangling ids fall through unchanged)
  INSERT INTO events (id, canvas_id, title, start_time, end_time, pin_id, from_pin_id,
                      to_pin_id, travel_mode, pin_ids, day_tag, timezone, cost, created_by)
  SELECT em.new, v_new, e.title, e.start_time, e.end_time,
         pm1.new, pm2.new, pm3.new, e.travel_mode,
         COALESCE((
           SELECT array_agg(COALESCE(mp.new, u.elem) ORDER BY u.ord)
           FROM unnest(e.pin_ids) WITH ORDINALITY AS u(elem, ord)
           LEFT JOIN _pin_map mp ON mp.old = u.elem
         ), '{}'::uuid[]),
         e.day_tag, e.timezone, e.cost, e.created_by
  FROM events e
  JOIN _evt_map em ON em.old = e.id
  LEFT JOIN _pin_map pm1 ON pm1.old = e.pin_id
  LEFT JOIN _pin_map pm2 ON pm2.old = e.from_pin_id
  LEFT JOIN _pin_map pm3 ON pm3.old = e.to_pin_id
  WHERE e.canvas_id = p_src;

  -- notes (remap parent_id via the pin or event map per parent_kind)
  INSERT INTO notes (id, canvas_id, body, image_refs, parent_id, parent_kind, created_by)
  SELECT nm.new, v_new, n.body, n.image_refs,
         CASE n.parent_kind
           WHEN 'pin'   THEN (SELECT new FROM _pin_map WHERE old = n.parent_id)
           WHEN 'event' THEN (SELECT new FROM _evt_map WHERE old = n.parent_id)
           ELSE NULL
         END,
         n.parent_kind, n.created_by
  FROM notes n JOIN _note_map nm ON nm.old = n.id
  WHERE n.canvas_id = p_src;

  -- roadmap_items: insert with NULL parent first (self-ref FK), then wire parents
  INSERT INTO roadmap_items (id, canvas_id, parent_id, title, body, status, stage, sort_order, created_by)
  SELECT rm.new, v_new, NULL, r.title, r.body, r.status, r.stage, r.sort_order, r.created_by
  FROM roadmap_items r JOIN _rm_map rm ON rm.old = r.id
  WHERE r.canvas_id = p_src;

  UPDATE roadmap_items child
  SET parent_id = pm.new
  FROM roadmap_items src
  JOIN _rm_map cm ON cm.old = src.id
  JOIN _rm_map pm ON pm.old = src.parent_id
  WHERE src.canvas_id = p_src
    AND src.parent_id IS NOT NULL
    AND child.id = cm.new;

  -- sheets (columns JSONB copied verbatim → column ids preserved)
  INSERT INTO sheets (id, canvas_id, name, columns, sort_order, created_by)
  SELECT sm.new, v_new, s.name, s.columns, s.sort_order, s.created_by
  FROM sheets s JOIN _sheet_map sm ON sm.old = s.id
  WHERE s.canvas_id = p_src;

  -- sheet_rows (remap sheet_id; data keys are column ids, preserved → copy as-is)
  INSERT INTO sheet_rows (id, sheet_id, data, sort_order, created_by)
  SELECT gen_random_uuid(), sm.new, sr.data, sr.sort_order, sr.created_by
  FROM sheet_rows sr
  JOIN sheets s ON s.id = sr.sheet_id
  JOIN _sheet_map sm ON sm.old = sr.sheet_id
  WHERE s.canvas_id = p_src;

  -- charts (remap sheet_id; x_column / y_columns are column ids, preserved)
  INSERT INTO charts (id, canvas_id, sheet_id, name, chart_type, x_column, y_columns, sort_order, created_by)
  SELECT gen_random_uuid(), v_new, sm.new, c.name, c.chart_type, c.x_column, c.y_columns, c.sort_order, c.created_by
  FROM charts c JOIN _sheet_map sm ON sm.old = c.sheet_id
  WHERE c.canvas_id = p_src;

  RETURN p_code;
END;
$$;
