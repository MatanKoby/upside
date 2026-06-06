-- 029_daily_bars.sql — Batch X4 (daily_bars layer).
--
-- Daily OHLCV bars are the only data type with no non-IB fallback today, so
-- the curated list / swing pack / sparkline all die when IB history 503s
-- (weekends, off-hours). Polygon grouped-daily returns the whole universe's
-- OHLCV in one call and is weekend-safe; this table makes Polygon the
-- daily-grain SSOT and demotes IB to live-only. See spec/data/sources.md →
-- Reliability posture + spec/schema.md → daily_bars.
--
-- Subsumes the old "universe.last_avg_volume precompute" — that column is now
-- one derived output of this layer (refresh_universe_avg_volume below).

-- ── daily_bars ────────────────────────────────────────────────────────────
-- conid references universe.real_conid (the IB conid; same key as curated_list
-- / trait_scores). One row per (conid, trading date). ~40-day retention by the
-- producer. NOT published to Realtime (high churn; all consumers are crons /
-- the sparkline route, server-side).
create table if not exists public.daily_bars (
  conid       bigint      not null,
  date        date        not null,
  o           numeric     not null,
  h           numeric     not null,
  l           numeric     not null,
  c           numeric     not null,
  v           bigint      not null,
  source      text        not null default 'polygon',
  computed_at timestamptz not null default now(),

  primary key (conid, date)
);
-- date-scoped lookups: "which dates are already covered" (producer backfill)
-- + retention deletes.
create index if not exists daily_bars_date_idx on public.daily_bars(date);

-- ── universe.last_avg_volume → bigint ─────────────────────────────────────
-- It was integer (migration 019); high-volume sub-dollar names can trade
-- >2.1B shares/day and overflow int. Volume is a share count — bigint, like
-- universe.last_volume. Now populated from daily_bars (was never populated).
alter table public.universe
  alter column last_avg_volume type bigint;

comment on column public.universe.last_avg_volume is
  '30-day median daily volume from daily_bars (refresh_universe_avg_volume, Batch X4). Robust median, not mean — a single news-day spike cannot distort it.';

-- ── refresh_universe_avg_volume() ─────────────────────────────────────────
-- Recompute universe.last_avg_volume = 30d median daily volume per ticker, in
-- one statement (cheaper than reading every conid's bars in app code). The
-- producer calls this once per cycle after writing the day's bars. Same
-- definition of "average daily volume" the curated-list gate uses (median of
-- the last-30 daily volumes) — one definition across the system.
create or replace function public.refresh_universe_avg_volume()
returns void
language sql
security definer
as $$
  update public.universe u
  set last_avg_volume = sub.med
  from (
    select conid,
           round(percentile_cont(0.5) within group (order by v))::bigint as med
    from (
      select conid, v,
             row_number() over (partition by conid order by date desc) as rn
      from public.daily_bars
    ) ranked
    where rn <= 30
    group by conid
  ) sub
  where u.real_conid = sub.conid;
$$;

-- ── grants ────────────────────────────────────────────────────────────────
-- Service-role writes (the producer is the sole writer). authenticated/anon
-- get select for consistency with the other instrument-keyed tables (no FE
-- consumer today — the sparkline route reads server-side).
grant select, insert, update, delete on public.daily_bars to service_role;
grant select on public.daily_bars to authenticated, anon;
grant execute on function public.refresh_universe_avg_volume() to service_role;
