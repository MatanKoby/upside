-- 022_universe_last_volume.sql — Batch S0.5.
--
-- Adds `last_volume` (yesterday's shares-traded count) to the universe
-- table. `last_avg_volume` (already on the table from migration 019) is
-- reserved for the 30-day median computed by the weekly cron; `last_volume`
-- is the per-day refresh that the daily Polygon grouped-bars producer
-- writes. catalyst_reversal Stage-1 reads both:
--   today's volume (intraday via IB) / last_avg_volume (30d median)
-- last_volume just gives the screener-tab + diagnostics a "yesterday's
-- close volume" number to show without a new IB call.

alter table public.universe
  add column if not exists last_volume bigint;

comment on column public.universe.last_volume is
  'Yesterday''s shares-traded volume (Polygon grouped-daily). Distinct from last_avg_volume which is the 30d median.';
