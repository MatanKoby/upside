-- Batch 13.8 — multi-source price polling (IB primary, Finnhub fallback).
--
-- Adds two columns to `positions`:
--   - price_source: which poller last wrote this row ('ib' or 'finnhub')
--   - last_price_update_at: when that write happened
--
-- The Finnhub fallback poller (server/src/cron/finnhubPricePoller.ts) uses
-- last_price_update_at to decide whether to skip a position (IB already
-- updated it within the freshness threshold). Existing rows are tagged 'ib'
-- since IB has been the only writer to date.

alter table public.positions
  add column if not exists price_source text not null default 'ib',
  add column if not exists last_price_update_at timestamptz null;

alter table public.positions
  drop constraint if exists positions_price_source_check;
alter table public.positions
  add constraint positions_price_source_check
  check (price_source in ('ib', 'finnhub'));

-- Helpful index for the fallback poller's filter (positions older than
-- the freshness threshold).
create index if not exists positions_last_price_update_idx
  on public.positions (user_id, last_price_update_at);
