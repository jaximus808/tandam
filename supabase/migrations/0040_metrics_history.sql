-- TDM-94 (E10): metrics history — turn /api/metrics into a time series you can
-- do data on, and give the loadtest baselines a run history.
--
-- APPLY MANUALLY (Jaxon). Independent of 0037-0039: disjoint tables, any order.
--
-- WHAT THIS IS FOR
-- GET /api/metrics already serves per-route p50/p95/p99/max, broadcast fan-out,
-- the contention counters (claims, claim_conflicts, ttl_expiries, fenced_writes),
-- webhook outcomes and ws_clients — but it is an in-memory ring buffer with a
-- 300s window that dies with the process. There is no SERIES, so "is p95 claim
-- latency worse than last week" is unanswerable and nothing can be charted. And
-- cmd/loadtest writes point-in-time baseline JSON to a directory in the repo,
-- which is a pile of files, not a run history.
--
-- Two tables, two different shapes of question:
--
--   metrics_snapshots — continuous production behaviour, one row per scrape
--                       (the API's own collector; see internal/metrics/collector.go).
--                       Answers "what changed since the last deploy".
--   loadtest_runs     — deliberate synthetic load, one row per (run, scenario)
--                       published from cmd/loadtest -publish. Answers "did the
--                       256-agent ceiling move".
--
-- PRIVACY — the constraint that shapes every column below. internal/metrics is
-- documented as aggregates-only precisely because GET /api/metrics is open, and
-- persisting it must not smuggle in what the in-memory version refused to hold.
-- So: route keys are chi ROUTE PATTERNS (/api/canvas/actions/{id}), never
-- concrete ids; every counter is a process-wide scalar; gauges are counts. There
-- is deliberately NO canvas_id on metrics_snapshots — not "nullable", not "for
-- later": the numbers are per-process, and a per-canvas breakdown would be a new
-- decision with a new privacy argument, not a column added quietly here.
--
-- READ PATH is NOT open, unlike /api/metrics. These tables carry deploy-shaped
-- operational history (restart times, error rates, throughput ceilings), which is
-- business information even though it is not user data. Both are served behind an
-- owner-email allowlist (METRICS_OWNER_EMAILS) — see api.RequireMetricsOwner.
--
-- RLS: none, matching every other table in this schema. The API is the only
-- client and talks to Supabase with the service key; authorization lives in the
-- Go layer. Adding RLS here only would be cargo-cult.

-- ── metrics_snapshots: one row per scrape of the in-memory registry ────────────
--
-- COLUMN STRATEGY — extracted columns + full payload, both. The chart plots the
-- extracted DOUBLE PRECISION / BIGINT columns so a 30-day read is a plain index
-- scan with no jsonb parsing per row; `payload` keeps the complete snapshot
-- (every route's percentiles, every op, every gauge) so a question nobody thought
-- to extract is still answerable after the fact without a backfill. The extracted
-- set is a projection of the payload, never a separate source of truth.
--
-- process_started_at IS THE LOAD-BEARING COLUMN. Every counter here is cumulative
-- SINCE BOOT and every percentile comes from a ring buffer that starts empty, so
-- two rows are only comparable when this value matches. When it changes between
-- consecutive rows the process restarted (a deploy, a crash, a scale event) and
-- the reader MUST break the series rather than diff across the boundary — a naive
-- diff there reads as a huge negative spike. The /metrics page draws that as a
-- restart rule, which is also how it answers "what changed since the last
-- deploy": deploys are exactly where this column changes.
CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Boot time of the process that produced this row. See above: the series is
  -- only continuous while this is constant.
  process_started_at TIMESTAMPTZ NOT NULL,
  uptime_seconds     DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- The registry's percentile window (metrics.DefaultWindow, 300s today).
  -- Recorded per row so a later change to the window is visible in the data
  -- instead of silently changing what p95 means.
  window_seconds     DOUBLE PRECISION NOT NULL DEFAULT 0,

  -- Aggregate request volume: the sum of every route's since-boot count.
  -- Cumulative, so chart the per-interval delta.
  requests_total     BIGINT      NOT NULL DEFAULT 0,
  -- The WORST route p95 in the window, and which route pattern it was. A single
  -- headline latency number: "the slowest thing users/agents hit right now".
  -- Deliberately not an average of p95s (meaningless) and not every route as its
  -- own column (unbounded); per-route detail lives in payload.
  route_p95_ms       DOUBLE PRECISION NOT NULL DEFAULT 0,
  route_p95_route    TEXT        NOT NULL DEFAULT '',  -- chi route PATTERN, never an id
  route_p95_method   TEXT        NOT NULL DEFAULT '',
  -- WebSocket broadcast fan-out p95 (metrics.OpBroadcastFanout): the number that
  -- decides whether an agent fleet feels live or laggy, and invisible to the
  -- request-latency middleware.
  fanout_p95_ms      DOUBLE PRECISION NOT NULL DEFAULT 0,

  -- Task-queue contention + webhook outcomes. All cumulative since boot.
  claims             BIGINT      NOT NULL DEFAULT 0,
  claim_conflicts    BIGINT      NOT NULL DEFAULT 0,
  ttl_expiries       BIGINT      NOT NULL DEFAULT 0,
  fenced_writes      BIGINT      NOT NULL DEFAULT 0,
  webhook_ok         BIGINT      NOT NULL DEFAULT 0,
  webhook_failed     BIGINT      NOT NULL DEFAULT 0,
  webhook_dead       BIGINT      NOT NULL DEFAULT 0,

  -- Connected WebSocket clients — a GAUGE, not cumulative: plot it as-is.
  ws_clients         INTEGER     NOT NULL DEFAULT 0,

  -- The whole /api/metrics response as served at captured_at.
  payload            JSONB       NOT NULL DEFAULT '{}'::jsonb
);

-- No updated_at / touch_updated_at trigger here: this table is machine-written
-- and append-only, and a snapshot is never edited. Same call as notifications and
-- webhook_deliveries.

-- Every read is "the last N hours, newest first" (the /metrics page) or "older
-- than X" (the retention prune). One DESC index serves both.
CREATE INDEX IF NOT EXISTS metrics_snapshots_captured_at_idx
  ON metrics_snapshots (captured_at DESC);

-- ── loadtest_runs: cmd/loadtest baselines, one row per (run, scenario) ─────────
--
-- GRAIN IS THE SCENARIO, not the run. A single loadtest invocation measures
-- several concurrency points (agents-8, agents-64, …) and the interesting series
-- is per-point — "ops/sec at 64 agents over time" — because that is where a
-- regression or a raised ceiling shows. Rolling a run up to one row would average
-- 8-agent and 64-agent numbers together and hide exactly that.
--
-- run_id + git_rev are the provenance that make two rows comparable: same
-- scenario, different git_rev is a regression signal; same scenario, git_dirty
-- true is a number you should not quote. schema mirrors resultsSchema
-- ("tandem.loadtest.v1") — two rows are only comparable at the same schema,
-- which is why it is stored rather than assumed.
CREATE TABLE IF NOT EXISTS loadtest_runs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            TEXT        NOT NULL,               -- loadtest's own short run id
  scenario          TEXT        NOT NULL,               -- e.g. 'agents-64'
  schema_version    TEXT        NOT NULL DEFAULT '',    -- resultsSchema of the producing build
  started_at        TIMESTAMPTZ NOT NULL,
  finished_at       TIMESTAMPTZ NOT NULL,
  api               TEXT        NOT NULL DEFAULT '',    -- target base URL (which env produced this)
  git_rev           TEXT        NOT NULL DEFAULT '',
  git_dirty         BOOLEAN     NOT NULL DEFAULT FALSE,

  live_agents       INTEGER     NOT NULL DEFAULT 0,
  measured_seconds  DOUBLE PRECISION NOT NULL DEFAULT 0,
  task_ops_per_sec  DOUBLE PRECISION NOT NULL DEFAULT 0,
  error_rate        DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- The two op latencies the targets in cmd/loadtest/assert.go gate on. Kept as
  -- columns because they are the headline regression signal; every other op's
  -- percentiles stay in payload.
  claim_p95_ms      DOUBLE PRECISION NOT NULL DEFAULT 0,
  queue_p95_ms      DOUBLE PRECISION NOT NULL DEFAULT 0,

  assertions_passed INTEGER     NOT NULL DEFAULT 0,
  assertions_failed INTEGER     NOT NULL DEFAULT 0,
  -- Aborted/skipped scenarios are STORED, not dropped: "the 256-agent point could
  -- not complete" is the finding, and a missing row would read as a run that was
  -- never attempted.
  aborted           BOOLEAN     NOT NULL DEFAULT FALSE,
  skipped           BOOLEAN     NOT NULL DEFAULT FALSE,
  notes             TEXT        NOT NULL DEFAULT '',

  payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Publishing is idempotent: re-POSTing the same baseline file (or a retried
-- -publish) must not double the history. This unique key is what the store's
-- upsert conflict-targets, so the second write updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS loadtest_runs_run_scenario_key
  ON loadtest_runs (run_id, scenario);

-- Reads are "the run history, newest first", optionally filtered to one scenario.
CREATE INDEX IF NOT EXISTS loadtest_runs_started_at_idx
  ON loadtest_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS loadtest_runs_scenario_started_at_idx
  ON loadtest_runs (scenario, started_at DESC);

-- ── retention (decided up front, enforced in Go) ───────────────────────────────
--
-- metrics_snapshots: 30 DAYS, deleted by the collector itself (one DELETE after
-- each scrape, METRICS_RETENTION_DAYS=0 to disable). Sizing at the 60s default:
-- 1,440 rows/day → ~43k rows and, at a few KB of payload each, a few hundred MB
-- per 30-day window. That is small enough that a cheap periodic DELETE beats
-- partitioning, and 30 days covers the only question anyone actually asks of it
-- ("since the last deploy" / "versus last week"). Enforcement lives in the
-- collector rather than pg_cron because migrations here are applied by hand and a
-- retention policy that depends on someone remembering to install a cron job is
-- not a policy.
--
-- loadtest_runs: NO retention. Each row is a deliberate, human-triggered
-- measurement — a few dozen per month at most — and the whole value is the long
-- baseline. Pruning it would delete the comparison it exists to make.
--
-- ── notes for whoever extends this ────────────────────────────────────────────
--
-- • Do NOT add a canvas_id to metrics_snapshots. See the PRIVACY note above.
-- • A second API instance writing the same table is fine and needs no change:
--   rows are independent and process_started_at distinguishes the writers. But
--   the /metrics page's per-interval deltas assume ONE writer — interleaved rows
--   from two processes will read as restart churn. If Tandem ever scales out,
--   add an instance_id column and group by it before charting.
-- • The prune is a plain DELETE on an indexed timestamp; if the table ever grows
--   past what that comfortably handles, the next move is monthly partitions on
--   captured_at, not a smaller retention window.
