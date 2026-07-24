-- Per-user agent-activity "follow" animation style.
--
-- When you're following an agent and it makes a batch change, the canvas shows a
-- "showcase": a highlight around everything it touched plus an auto-scroll. This
-- preference picks how dramatic that scroll is:
--   'cinematic' — start at the top of the change block and glide smoothly all the
--                 way to the bottom, so you watch every added item scroll past.
--   'minimal'   — a quick settle-into-view (center if it fits, else a short two-
--                 step nudge). Less motion for people who find the pan too much.
--
-- Device-local for signed-out visitors (localStorage 'tandem.followStyle'); this
-- column is the account-level source of truth that follows a signed-in user
-- across devices and is mirrored back into localStorage on load.
--
-- DEFAULT 'cinematic' — the showcase pan is the headline behavior; opt out to
-- 'minimal'. Existing users pick up 'cinematic' too.

ALTER TABLE users
  ADD COLUMN agent_follow_style TEXT NOT NULL DEFAULT 'cinematic'
    CHECK (agent_follow_style IN ('cinematic', 'minimal'));
