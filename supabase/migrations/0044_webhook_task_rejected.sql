-- TDM-2: a fifth webhook event — task.rejected.
--
-- APPLY MANUALLY (Jaxon). Safe to apply before or after the code that emits the
-- event; see "ordering" below. No data is rewritten and no existing webhook
-- changes behaviour.
--
-- WHAT THIS IS FOR
-- Rejection was the one human verdict that reached nobody. A human rejects a
-- proposed task with a reason, the reason lands in actions.error, and every
-- agent waiting on that batch is told nothing: an in-session orchestrator parked
-- on queue_wait sat there until its timeout and then went back to waiting for an
-- approval that is never coming, and a webhook-launched one never woke at all.
-- The proposing agent's own plan had been answered and it had no way to hear it.
--
--   task.rejected — a PROPOSED task was rejected at the human gate, with the
--                   rejecting human's reason attached.
--
-- WHY A NEW NAME AND NOT A REUSED ONE. There was nothing to reuse: the four
-- existing events all say "there is work" (approved / returned) or "work
-- finished" (completed / claim_expired). Rejection says the opposite — this
-- ticket is dead, stop waiting for it — and a receiver that reacts to it by
-- launching a worker would be doing exactly the wrong thing. internal/api/
-- task_events.go said since TDM-37 that rejection fires nothing because "there
-- is no work to hand off, and no event name for it"; this is that name, and the
-- half of the sentence that is now false is the second one. 0038 anticipated the
-- shape of this change ("a 4th event type costs one widened CHECK here") and
-- 0043 performed it once already; this is the same widening a second time.
--
-- EXISTING CONFIGS ARE NOT BACKFILLED, deliberately — the same call 0043 made,
-- for the same reason. A row's `events` array is what its owner chose, and
-- silently appending an event type they have never heard of would start sending
-- deliveries nobody asked for. An existing webhook must tick the new box in the
-- settings panel to receive it. New configs get it by default: the API fills an
-- omitted filter from store.KnownWebhookEvents, and the column DEFAULT below is
-- widened to match so the two agree if a row is ever inserted by hand.
--
-- ORDERING. The app-side vocabulary (store.KnownWebhookEvents) and these CHECKs
-- must both know the name before a delivery can be enqueued, but neither order
-- breaks anything: apply first and no event is emitted until the code ships;
-- ship the code first and the (async, best-effort) insert fails the CHECK and is
-- logged — a missed notification, never a failed canvas mutation, because
-- emitTaskEvent runs after the state write has already committed. Note the
-- in-process half of TDM-2 (the queue_wait rejection wake) does NOT depend on
-- this migration at all: waking a parked waiter is a canvas behaviour, not a
-- webhook one, and it works on a canvas with no webhooks configured.

-- ── webhooks.events: the per-config subscription filter ───────────────────────
ALTER TABLE webhooks DROP CONSTRAINT IF EXISTS webhooks_events_known;

ALTER TABLE webhooks ADD CONSTRAINT webhooks_events_known CHECK (
  events <@ ARRAY['task.approved', 'task.completed', 'task.claim_expired', 'task.returned', 'task.rejected']::TEXT[]
);

-- The DEFAULT is only reached by a hand-written INSERT (the API always sends an
-- explicit filter), but a default that disagrees with the app's "all known
-- events" would be a trap for exactly that case.
ALTER TABLE webhooks
  ALTER COLUMN events
  SET DEFAULT '{task.approved,task.completed,task.claim_expired,task.returned,task.rejected}';

-- ── webhook_deliveries.event_type: what may be enqueued ───────────────────────
-- 0043 re-added this one under an explicit name (0038 declared it inline on the
-- column, so it carried PostgreSQL's generated name). Both names are dropped
-- here so this file applies cleanly whether or not 0043 ran first.
ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_event_type_check;
ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_event_type_known;

ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_event_type_known CHECK (
  event_type IN ('task.approved', 'task.completed', 'task.claim_expired', 'task.returned', 'task.rejected')
);
