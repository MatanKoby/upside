-- 024_trait_scores.sql — Batch S2 (post-MVP screener track).
--
-- Per-(conid, trait, asof_date) scoring rows written by the three trait
-- producers (intradayRangeTrader, catalystReversal, postEarningsDrift).
-- The Screener FE tab (S4) subscribes via Realtime; each row is rewritten
-- on each scoring pass and dropped beyond its shelf life.
--
-- conid here references universe.real_conid (the IBKR conid), NOT the
-- synthetic universe.conid PK — all downstream joins (intraday_stats,
-- positions, watchlist_items) key on real_conid. See
-- spec/signals/screener-universe.md → Conid resolution (S1.5).
--
-- payload is trait-specific FE-ready details, e.g. for intraday_range_trader:
--   { "p25": 1.2, "p50": 2.4, "p75": 3.6, "sample_size": 60,
--     "today_open_band_low": 17.96 }
-- For catalyst_reversal:
--   { "vol_multiple": 4.2, "today_move_pct": 8.5, "pct_off_52w_high": 38,
--     "rsi14": 27, "today_price": 12.34, "stage2_basis": "rsi_below_30" }
-- For post_earnings_drift:
--   { "report_date": "2026-05-28", "report_day_pop_pct": 3.4,
--     "days_since_earnings": 2, "today_price": 12.34 }

create table if not exists public.trait_scores (
  conid           bigint        not null,
  trait           text          not null check (trait in (
                    'intraday_range_trader',
                    'catalyst_reversal',
                    'post_earnings_drift'
                  )),
  asof_date       date          not null,
  score           numeric       not null,
  payload         jsonb         not null default '{}'::jsonb,
  computed_at     timestamptz   not null default now(),

  -- last_fired_at gates the once-per-day notifyTraitFirstFire ping;
  -- nulled out on insert + stamped after the Discord ping lands.
  last_fired_at   timestamptz,

  primary key (conid, trait, asof_date)
);

-- Read patterns: Screener FE pulls "today's top-N per trait" + per-conid
-- spot lookups when a watchlist row wants to show its trait badges.
create index if not exists trait_scores_trait_asof_score_idx
  on public.trait_scores(trait, asof_date desc, score desc);
create index if not exists trait_scores_conid_idx
  on public.trait_scores(conid);

-- Realtime — Screener tab + Watchlist trait-chip subscribers.
alter publication supabase_realtime add table public.trait_scores;

-- Service-role writes (backend is sole producer); authenticated reads for FE.
grant select, insert, update, delete on public.trait_scores to service_role;
grant select on public.trait_scores to authenticated, anon;
