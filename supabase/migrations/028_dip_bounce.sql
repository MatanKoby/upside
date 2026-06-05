-- 028_dip_bounce.sql — Batch X1 (dip-bounce track).
--
-- Three tables + one view:
--   curated_list    — auto-maintained ~200-300 high-potential dip-bounce pool
--                     per session date (the alert pool + walking-band pool).
--   signal_fires    — every scorer fire (generic across signal kinds; band-touch
--                     + marker fires port onto this backbone later).
--   signal_outcomes — price snapshots at +30m/+2h/+1d/+3d after each fire.
--   signal_hit_rate_30d (view) — rolling-30d hit-rate per signal_kind.
-- See spec/signals/curated-list.md + spec/signals/dip-bounce-scorer.md +
-- spec/schema.md.

-- ── curated_list ────────────────────────────────────────────────────────────
-- conid references universe.real_conid. Rewritten daily (09:00 IDT full +
-- 15:30 IDT pre-market). Realtime enabled (Screener FE + Watchlist chips).
create table if not exists public.curated_list (
  conid                        bigint      not null,
  asof_date                    date        not null,
  rank                         integer     not null,
  intraday_range_trader_score  numeric,
  avg_daily_volume             bigint,
  daily_atr_pct                numeric,
  computed_at                  timestamptz not null default now(),

  primary key (conid, asof_date)
);
create index if not exists curated_list_asof_rank_idx
  on public.curated_list(asof_date, rank);

alter publication supabase_realtime add table public.curated_list;

-- ── signal_fires ────────────────────────────────────────────────────────────
-- Every fire by any scorer. components jsonb carries the per-rule 0/1 breakdown
-- so failures are diagnosable. NOT published to Realtime (high churn; FE reads
-- the aggregated view).
create table if not exists public.signal_fires (
  id            uuid        primary key default uuid_generate_v4(),
  conid         bigint      not null,
  signal_kind   text        not null check (signal_kind in
                  ('intraday_dip_bounce','swing_dip_bounce','band_touch_low','band_touch_high')),
  score         numeric,
  components    jsonb       not null default '{}'::jsonb,
  horizon       text,
  price_at_fire numeric,
  fire_ts       timestamptz not null default now()
);
create index if not exists signal_fires_kind_ts_idx
  on public.signal_fires(signal_kind, fire_ts desc);
-- cooldown lookup: latest fire for a (conid, kind).
create index if not exists signal_fires_conid_kind_ts_idx
  on public.signal_fires(conid, signal_kind, fire_ts desc);

-- ── signal_outcomes ─────────────────────────────────────────────────────────
create table if not exists public.signal_outcomes (
  fire_id     uuid        not null references public.signal_fires(id) on delete cascade,
  t_offset    text        not null check (t_offset in ('+30m','+2h','+1d','+3d')),
  snapshot_ts timestamptz,
  price       numeric,
  return_pct  numeric,

  primary key (fire_id, t_offset)
);

-- ── signal_hit_rate_30d (view) ──────────────────────────────────────────────
-- Per signal_kind: intraday reads +2h outcomes vs +1%, swing reads +3d vs +5%.
create or replace view public.signal_hit_rate_30d as
with eval as (
  select
    f.id,
    f.signal_kind,
    case f.signal_kind
      when 'intraday_dip_bounce' then '+2h'
      when 'swing_dip_bounce'    then '+3d'
    end as eval_offset,
    case f.signal_kind
      when 'intraday_dip_bounce' then 1.0
      when 'swing_dip_bounce'    then 5.0
    end as hit_threshold
  from public.signal_fires f
  where f.fire_ts >= now() - interval '30 days'
    and f.signal_kind in ('intraday_dip_bounce','swing_dip_bounce')
)
select
  e.signal_kind,
  count(*)                                                            as fires,
  count(o.return_pct)                                                 as evaluated,
  count(*) filter (where o.return_pct >= e.hit_threshold)             as hits,
  round(100.0 * count(*) filter (where o.return_pct >= e.hit_threshold)
        / nullif(count(o.return_pct), 0), 1)                          as hit_rate_pct
from eval e
left join public.signal_outcomes o
  on o.fire_id = e.id and o.t_offset = e.eval_offset
group by e.signal_kind;

-- ── grants ──────────────────────────────────────────────────────────────────
-- Service-role writes (the crons are the sole producers). Instrument-keyed, no
-- RLS policy (band_state / trait_scores pattern). signal_fires/outcomes get
-- authenticated select too so the security-invoker view resolves for the FE.
grant select, insert, update, delete on public.curated_list    to service_role;
grant select, insert, update, delete on public.signal_fires    to service_role;
grant select, insert, update, delete on public.signal_outcomes to service_role;
grant select on public.curated_list        to authenticated, anon;
grant select on public.signal_fires        to authenticated, anon;
grant select on public.signal_outcomes     to authenticated, anon;
grant select on public.signal_hit_rate_30d to authenticated, anon;
