-- Approval policy: how much human gating agent-proposed tasks get on a canvas.
--   'strict' — every agent-proposed task lands proposed (the pre-policy behavior).
--   'epic'   — (default) a task created under an APPROVED epic is born approved
--              (approved_by='policy:epic'); tasks with no epic, or under a
--              still-proposed epic, land proposed. Approving an epic also
--              batch-approves its currently-proposed tasks.
--   'auto'   — every agent task is born approved (approved_by='policy:auto').
-- A task payload carrying requiresApproval:true always lands proposed,
-- regardless of policy (the agent self-flags deviations).
-- Enforced server-side in the action create/approve handlers; epics themselves
-- are actions rows (type='epic') and need no schema change.
ALTER TABLE canvases ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'epic'
  CHECK (approval_policy IN ('strict', 'epic', 'auto'));
