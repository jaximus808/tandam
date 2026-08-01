-- TDM-170: a fourth webhook event — task.returned.
--
-- APPLY MANUALLY (Jaxon). Safe to apply before or after the code that emits the
-- event; see "ordering" below. No data is rewritten and no existing webhook
-- changes behaviour.
--
-- WHAT THIS IS FOR
-- TDM-154's rework bounce moves FINISHED work back to the ready queue (done →
-- approved), and TDM-158 found that it notified nobody outside the process: an
-- in-session orchestrator parked on queue_wait woke up, a webhook-launched one
-- did not. On a canvas using the 'peer' approval policy that is the whole review
-- loop failing quietly — the reviewer says "redo this", the ticket returns to
-- the queue, and nothing relaunches to pick it up.
--
--   task.returned — finished work went back to the ready queue: a reviewer
--                   agent's rework bounce, or a human reopening a done task.
--
-- WHY A NEW NAME AND NOT A SECOND task.approved. 0038's three events mean what
-- they say: task.approved is "passed the approval gate", and a bounce passes no
-- gate. Reusing it would tell every existing receiver that returned work is new
-- work — precisely the confusion this event exists to prevent — and would break
-- the promise (in internal/api/task_events.go, unchanged since TDM-37) that a
-- re-queue never re-fires an approval. 0038 anticipated this exact move: "a 4th
-- event type costs one widened CHECK here". This is that widened CHECK.
--
-- EXISTING CONFIGS ARE NOT BACKFILLED, deliberately. A row's `events` array is
-- what its owner chose; silently appending an event type they have never heard
-- of would start sending deliveries nobody asked for, to endpoints that will log
-- an unknown type at best. So an existing webhook must tick the new box in the
-- settings panel to receive it. New configs get it by default — the API fills an
-- omitted filter from store.KnownWebhookEvents, and the column DEFAULT below is
-- widened to match so the two agree if a row is ever inserted by hand.
--
-- ORDERING. The app-side vocabulary (store.KnownWebhookEvents) and these CHECKs
-- must both know the name before a delivery can be enqueued, but neither order
-- breaks anything: apply first and no event is emitted until the code ships;
-- ship the code first and the (async, best-effort) insert fails the CHECK and is
-- logged — a missed notification, never a failed canvas mutation, because
-- emitTaskEvent runs after the state write has already committed.

-- ── webhooks.events: the per-config subscription filter ───────────────────────
ALTER TABLE webhooks DROP CONSTRAINT IF EXISTS webhooks_events_known;

ALTER TABLE webhooks ADD CONSTRAINT webhooks_events_known CHECK (
  events <@ ARRAY['task.approved', 'task.completed', 'task.claim_expired', 'task.returned']::TEXT[]
);

-- The DEFAULT is only reached by a hand-written INSERT (the API always sends an
-- explicit filter), but a default that disagrees with the app's "all known
-- events" would be a trap for exactly that case.
ALTER TABLE webhooks
  ALTER COLUMN events
  SET DEFAULT '{task.approved,task.completed,task.claim_expired,task.returned}';

-- ── webhook_deliveries.event_type: what may be enqueued ───────────────────────
-- 0038 declared this one inline on the column, so it carries PostgreSQL's
-- generated name (<table>_<column>_check). Re-added here with an explicit name
-- so the next widening does not have to guess.
ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_event_type_check;
ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_event_type_known;

ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_event_type_known CHECK (
  event_type IN ('task.approved', 'task.completed', 'task.claim_expired', 'task.returned')
);
