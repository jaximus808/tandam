-- v1 (Tandem × ANDR): the execution primitive. Turns the canvas from a planning
-- surface into a control surface — agents coordinate on `actions` through shared
-- state, and `agents` carries the identity/provenance that makes the canvas
-- multi-agent. No new mode: actions render inside the existing map view.
--
-- Schema notes:
--   - actions.payload + actions.linked_pin_ids are JSONB (same handling as
--     charts.y_columns / sheet_rows.data — raw-message in, json.Marshal on write).
--   - state machine (proposed → approved → executing → done/failed, plus
--     proposed → rejected) is enforced in the Go handler layer; the column only
--     constrains the allowed *values*.
--   - proposed_by / approved_by are free-text agent ids (provenance), NOT the
--     'agent'|'user' enum the other tables use — multi-agent is the whole point.

-- ── agents: who is connected and writing ──────────────────────────────────────
CREATE TABLE agents (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id     UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN ('planner', 'executor')),
  model         TEXT,
  status        TEXT        NOT NULL DEFAULT 'online'
                            CHECK (status IN ('online', 'offline')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agents_canvas_id_idx ON agents(canvas_id);

-- ── actions: the unit agents coordinate on and humans approve ─────────────────
CREATE TABLE actions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id      UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  type           TEXT        NOT NULL DEFAULT 'navigate',
  state          TEXT        NOT NULL DEFAULT 'proposed'
                             CHECK (state IN ('proposed', 'approved', 'rejected',
                                              'executing', 'done', 'failed')),
  payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  proposed_by    TEXT        NOT NULL DEFAULT 'agent',
  approved_by    TEXT,
  result         TEXT,
  error          TEXT,
  linked_pin_ids JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX actions_canvas_id_idx    ON actions(canvas_id);
CREATE INDEX actions_canvas_state_idx ON actions(canvas_id, state);

CREATE TRIGGER actions_updated_at BEFORE UPDATE ON actions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
