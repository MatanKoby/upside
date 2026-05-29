-- 017_intraday_stats.sql — Batch B.
--
-- LLM-free per-symbol statistics computed nightly from historical 5-min bars.
-- Surfaces "this stock typically does X intraday" so the user can decide
-- where to set price markers and so we can fire alerts when current price
-- enters a stats-derived zone (e.g. "today is heading into the typical
-- intraday-low band").
--
-- Three stats in the first cut (user pick, 2026-05-29):
--   open_fade_pct        — typical % move in the first ~30 min after open
--   close_fade_pct       — typical % move in the last ~30 min into close
--   intraday_low_pct     — typical % drop from open to the day's low (positive
--                          number; bigger = deeper typical dip)
--
-- Each stat stored as mean + median (p50) + an "extreme" percentile (p25 for
-- fades = typical-soft-dip, p75 for intraday_low = typical-deep-dip). Multiple
-- percentiles let the FE show a band instead of a point and let the alert
-- engine pick its trigger threshold without recompute.
--
-- Lookback: configurable per-row (default 60 trading days — responsive enough
-- to reflect a stock's current character, broad enough to be statistically
-- meaningful). Stored so future tuning is per-symbol if needed.

create table if not exists public.intraday_stats (
  conid                    bigint primary key,
  symbol                   text not null,

  open_fade_pct_mean       numeric,
  open_fade_pct_p50        numeric,
  open_fade_pct_p25        numeric,   -- the soft / typical fade

  close_fade_pct_mean      numeric,
  close_fade_pct_p50       numeric,
  close_fade_pct_p25       numeric,

  intraday_low_pct_mean    numeric,
  intraday_low_pct_p50     numeric,
  intraday_low_pct_p75     numeric,   -- the deeper, less common dip

  sample_size              integer not null,
  lookback_days            integer not null,

  last_fired_at            timestamptz,        -- 24h cooldown for stats-derived alerts
  computed_at              timestamptz not null default now()
);

create index if not exists intraday_stats_symbol_idx on public.intraday_stats(symbol);

-- Instrument-keyed (not user-keyed): authenticated read, service-role write.
alter table public.intraday_stats enable row level security;
drop policy if exists "intraday_stats: authenticated read" on public.intraday_stats;
create policy "intraday_stats: authenticated read" on public.intraday_stats
  for select to authenticated using (true);
grant select on public.intraday_stats to authenticated;
grant all    on public.intraday_stats to service_role;

-- Realtime so the FE updates without polling once the nightly cron writes.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'intraday_stats'
  ) then
    alter publication supabase_realtime add table public.intraday_stats;
  end if;
end $$;
