-- TDM-35 (E3.1): outbound webhooks — config + delivery log.
--
-- APPLY MANUALLY (Jaxon), alongside 0037 (context freshness). 0037 is owned by a
-- parallel branch and is unrelated to this file; the two touch disjoint tables and
-- may be applied in either order. Numbering 0038 was assigned by the orchestrator —
-- do NOT renumber this file to 0037 even if 0037 is missing from your checkout.
--
-- WHAT THIS IS FOR
-- A canvas can notify an external system when its task queue moves. Three event
-- types, and only three, for MVP:
--
--   task.approved      — a task entered the ready-to-work queue
--   task.completed     — a task finished (result recorded)
--   task.claim_expired — an agent's claim on a task went stale and was released
--
-- Deliveries are HMAC-signed, retried with backoff, and dead-lettered after the
-- retry budget is spent. Webhook config is human-set in the web UI only: there is
-- deliberately no MCP surface for it (an agent must not be able to point the
-- canvas at an endpoint it controls). This migration is TABLES ONLY — the Go
-- emitter + delivery worker land in TDM-36 (E3.2), which treats the columns below
-- as its contract. The "worker contract" notes are for that task.
--
-- RLS: none, matching every other table in this schema. The API is the only
-- client and talks to Supabase with the service key; authorization lives in the
-- Go layer (ResolveCanvasRole). Adding RLS here only would be cargo-cult.

-- ── webhooks: per-canvas endpoint config (human-set, web UI only) ──────────────
--
-- secret is stored in PLAINTEXT, which deliberately breaks the hash-at-rest rule
-- of 0027 (PATs) and 0029 (OAuth tokens). It has to be: HMAC signing needs the
-- key material itself, so there is nothing to compare a hash against. The
-- mitigations are app-side and mandatory in E3.2:
--   • never include `secret` in list/read responses — a dedicated owner-only
--     reveal endpoint, or show only the trailing 4 chars;
--   • never log it;
--   • rotation is a plain UPDATE of the column (no versioning for MVP — the
--     receiver briefly sees signatures it can't verify, which is acceptable at
--     this scale; dual-secret rotation is a later migration if anyone asks).
--
-- Per-canvas limit is APP-ENFORCED (suggested: 5). A DB-level cap needs a trigger
-- or a counter column, and neither is worth it for a bound nobody will hit; the
-- count query rides webhooks_canvas_id_idx.
--
-- No UNIQUE (canvas_id, url) on purpose: two configs pointing at the same URL
-- with different event filters (and different secrets) is legitimate.
CREATE TABLE IF NOT EXISTS webhooks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  url         TEXT        NOT NULL CHECK (url ~ '^https?://'),
  secret      TEXT        NOT NULL,                    -- HMAC-SHA256 key, plaintext (see above)
  events      TEXT[]      NOT NULL DEFAULT '{task.approved,task.completed,task.claim_expired}',
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  name        TEXT        NOT NULL DEFAULT '',         -- short label for the config list
  description TEXT        NOT NULL DEFAULT '',         -- optional longer note
  created_by  TEXT        NOT NULL DEFAULT 'user',     -- provenance; always 'user' today
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The event filter is a TEXT[] subset, not three booleans. Rationale:
  --   • a 4th event type costs one widened CHECK here — no new column, no Go
  --     struct field, no UI checkbox wired to a new key;
  --   • "does this webhook want event E" is one containment predicate
  --     (events @> ARRAY[E] / PostgREST `cs.`), not a growing OR chain;
  --   • it round-trips as []string in Go and as a JSON array in the web config
  --     page, which is exactly the shape a checkbox group serializes to
  --     (precedent: notes.image_refs is already TEXT[] through this store).
  -- The subset CHECK is worth its maintenance cost: without it a typo'd event
  -- name is accepted and the webhook silently never fires — the worst failure
  -- mode for this feature. Non-empty because a webhook that matches nothing is
  -- config the user didn't mean to save; disabling is what `enabled` is for.
  -- De-duplicating / sorting the array is app-enforced.
  CONSTRAINT webhooks_events_known CHECK (
    events <@ ARRAY['task.approved', 'task.completed', 'task.claim_expired']::TEXT[]
  ),
  CONSTRAINT webhooks_events_nonempty CHECK (array_length(events, 1) >= 1)
);

-- The only lookup: "enabled webhooks on this canvas" at emit time, plus the
-- config list in the UI. Row counts per canvas are tiny, so canvas_id alone is
-- enough — filtering `enabled` and `events` on top of it is free.
CREATE INDEX IF NOT EXISTS webhooks_canvas_id_idx ON webhooks(canvas_id);

DROP TRIGGER IF EXISTS webhooks_updated_at ON webhooks;
CREATE TRIGGER webhooks_updated_at BEFORE UPDATE ON webhooks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── webhook_deliveries: one row per (webhook, event), retried in place ─────────
--
-- IDENTIFIERS (this is the replay/idempotency contract):
--   id       — the DELIVERY id. Sent as `Tandem-Delivery-Id`. STABLE ACROSS
--              RETRIES: every attempt of this row carries the same id, so a
--              receiver that has already applied it can dedupe a retry.
--   event_id — the SOURCE-EVENT id, shared by every delivery row fanned out from
--              one canvas event. Lets you answer "who did we tell about this
--              approval", and, with the UNIQUE below, makes the fan-out insert
--              idempotent: the emitter mints event_id ONCE per source event and
--              re-uses it if the insert is retried (ON CONFLICT DO NOTHING).
--
-- Replay protection is per ATTEMPT, not per row, and needs no column: the worker
-- signs `<unix_ts>.<body>` and sends `Tandem-Signature: t=<unix_ts>,v1=<hex>`.
-- The receiver rejects anything where |now - t| > 60s. So a captured attempt goes
-- stale in 60s while a legitimate retry — new t, new signature, same delivery id —
-- is still accepted and deduped by id. Nothing about t is worth persisting.
--
-- payload is what gets signed and sent. Sign EXACTLY the bytes written to the
-- wire: marshal the payload at send time and HMAC that buffer. Do not sign a
-- string rebuilt separately from this column — jsonb normalizes key order, so a
-- re-marshal is not byte-identical to what was inserted (harmless, since each
-- attempt is signed fresh, but fatal if you sign one rendering and send another).
--
-- canvas_id is denormalized from webhooks so the canvas-scoped UI lists (recent
-- deliveries, dead letters) are a plain filter instead of an embed through
-- webhooks. Both FKs cascade: deleting the canvas or the webhook drops the log.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      UUID        NOT NULL REFERENCES webhooks(id)  ON DELETE CASCADE,
  canvas_id       UUID        NOT NULL REFERENCES canvases(id)  ON DELETE CASCADE,
  event_id        UUID        NOT NULL,
  event_type      TEXT        NOT NULL
                              CHECK (event_type IN ('task.approved',
                                                    'task.completed',
                                                    'task.claim_expired')),
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Lifecycle. Terminal states are 'ok' and 'dead'; there is no separate
  -- dead_letter boolean, because a flag beside a status is a second source of
  -- truth that will eventually disagree with it. 'dead' IS the dead letter, and
  -- last_attempt_at is when it died.
  --   pending    — enqueued, never attempted
  --   delivering — leased by a worker, in flight
  --   ok         — 2xx received (terminal)
  --   failed     — attempt failed, retry budget remains, next_attempt_at is in
  --                the future (distinct from 'pending' purely so the UI can say
  --                "retrying" vs "queued")
  --   dead       — retry budget spent, or a non-retryable rejection (terminal)
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'delivering',
                                                'ok', 'failed', 'dead')),
  attempt_count   INTEGER     NOT NULL DEFAULT 0,

  -- STAMPED WHEN AN ATTEMPT STARTS (at lease time), not when it finishes. That
  -- makes it double as the lease clock: a worker that crashes mid-flight leaves a
  -- row stuck in 'delivering', and the reaper finds it with
  --   status = 'delivering' AND last_attempt_at < now() - interval '5 minutes'
  -- and pushes it back to 'failed'. No separate locked_at/lease_expires_at column.
  last_attempt_at TIMESTAMPTZ,
  -- Due time. Defaults to now() so a freshly enqueued row is immediately
  -- eligible; the worker sets it forward on each failure (suggested backoff:
  -- 10s, 1m, 5m, 30m, 2h — 5 attempts, then 'dead').
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Debugging surface for the UI's delivery detail view.
  response_status INTEGER,      -- HTTP status; NULL if the request never got one
  response_body   TEXT,         -- TRUNCATED by the worker (suggested 2 KB cap)
  error           TEXT,         -- transport-level failure (DNS, TLS, timeout)

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- Producer-side idempotency: re-running a fan-out with the same event_id is a
  -- no-op per webhook. Also the lookup for "all deliveries of this event".
  CONSTRAINT webhook_deliveries_webhook_event_key UNIQUE (webhook_id, event_id)
);

-- No updated_at / trigger here: this table is machine-written and every mutation
-- already stamps last_attempt_at. Same call as notifications and form_submissions.

-- The worker's poll, and the hottest query in the feature:
--   status IN ('pending','failed') AND next_attempt_at <= now()
-- Partial on the two non-terminal, retry-eligible states, so the index stays
-- proportional to the QUEUE (small, bounded by in-flight work) while the table
-- itself grows with history. 'delivering' is deliberately excluded — the reaper
-- sweep is rare and can afford a scan.
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- UI: per-webhook history, and the dead-letter list (status = 'dead'), newest
-- first. Covers both the filter and the sort.
CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_status_idx
  ON webhook_deliveries (webhook_id, status, created_at DESC);

-- UI: canvas-wide recent deliveries / dead letters across all of a canvas's
-- webhooks, without embedding through webhooks.
CREATE INDEX IF NOT EXISTS webhook_deliveries_canvas_idx
  ON webhook_deliveries (canvas_id, created_at DESC);

-- ── notes for E3.2 (delivery worker) ──────────────────────────────────────────
--
-- LEASING. The store speaks PostgREST, not SQL, so `FOR UPDATE SKIP LOCKED` is
-- not directly available. Two workable strategies — E3.2 picks:
--   (a) Conditional PATCH, the 0032 atomic-claim pattern:
--         PATCH ?status=in.(pending,failed)&next_attempt_at=lte.<now>
--         { "status": "delivering", "last_attempt_at": <now>,
--           "attempt_count": … }  with Prefer: return=representation
--       Row locks serialize concurrent updaters and the loser's predicate
--       re-check fails, so no row is ever leased twice. Downside: PostgREST
--       batches the whole matching set, so a single API instance grabs the queue
--       (fine while the API is one process; each row still needs its own
--       attempt_count increment, so expect a per-row PATCH anyway).
--   (b) A `claim_webhook_deliveries(n int)` SECURITY DEFINER RPC doing
--       UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING *,
--       following the reserve_task_tickets pattern (0034). Correct for multiple
--       API instances and one round trip. Deliberately NOT written here: it is
--       the worker's design decision, and a guessed signature would be dead code.
--
-- RETENTION. Terminal rows accumulate forever. Out of scope here; when it
-- matters, a purge of `status = 'ok' AND created_at < now() - interval '30 days'`
-- (dead letters kept) is the obvious move — as an API-side sweep or a later
-- migration, not a pg_cron dependency.
--
-- SSRF. url is CHECK-constrained to http(s) only, which is a typo guard, not a
-- security control. Blocking private/link-local/metadata addresses, capping
-- redirects, and setting a request timeout are the worker's job.
