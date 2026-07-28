-- Atomic task claiming (race fix). Claiming a task (approved → executing) used
-- to be read-then-check-then-write: the Go handler validated the state machine,
-- then the store ran an UNCONDITIONAL update — so two concurrent task_starts
-- could both win. The claim is now a single conditional UPDATE in the API
-- (... WHERE state = 'approved'); these columns record WHO holds the claim and
-- since when, so the loser can be told who beat it, task_list/task_get can
-- surface the claimant, and the web Tasks panel can release a stuck claim
-- (which clears both columns).

ALTER TABLE actions
  ADD COLUMN claimed_by TEXT,
  ADD COLUMN claimed_at TIMESTAMPTZ;
