-- 018_quotes_today_open.sql — Batch B.
-- Adds today_open so the stats-alert engine can compute the typical-
-- intraday-low band (open × (1 - intraday_low_pct_p50/100), etc.). Nullable;
-- the pollers populate it on each write (IB snapshot field 7295 / Finnhub
-- /quote `o`).

alter table public.quotes
  add column if not exists today_open numeric;
