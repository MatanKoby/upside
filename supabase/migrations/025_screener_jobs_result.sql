-- 025_screener_jobs_result.sql — Batch S2.
--
-- Adds `result jsonb` column to screener_jobs so multi-stage producer flows
-- (catalyst_reversal Stage 1 → Stage 2) can hand off computed values
-- between worker stages without inventing a new ephemeral table.
--
-- The producer pattern still owns dependency logic per spec/job-queue.md;
-- this column just gives the worker a clean place to attach its computed
-- output for the producer's drain step to consume.
--
-- Existing actions (resolve_conid, fallback_yahoo_quote, noop:*) ignore
-- this column — they write their output to a target table directly. New
-- multi-stage actions populate `result` and the producer reads it during
-- drainDone before deleting the row.

alter table public.screener_jobs
  add column if not exists result jsonb not null default '{}'::jsonb;
