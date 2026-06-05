-- 027_risk_flags.sql — Batch R1 (risk-flags track).
--
-- Daily-grain enter-risk flags per (conid, asof_date). A row exists ONLY when
-- ≥1 flag is active; absence of a row = clean. Recomputed nightly for held +
-- active-watchlist conids, and topped-up on-demand at Analyze. conid is the IB
-- conid (joins positions / watchlist_items / quotes). See
-- spec/signals/risk-flags.md.
--
-- flags jsonb shape: array of active flags, one entry per fired condition:
--   [{ "key": "price_surge", "since": "2026-06-02",
--      "payload": { "surge_pct": 31.4, "window": 5 } }, ...]
-- `since` = first day the condition went true (inherited across nightly runs
-- while it stays true), so the FE can read "flagged since <date>".

create table if not exists public.risk_flags (
  conid        bigint       not null,
  asof_date    date         not null,
  flags        jsonb        not null default '[]'::jsonb,
  severity     text         not null check (severity in ('warning', 'critical')),
  computed_at  timestamptz  not null default now(),

  primary key (conid, asof_date)
);

create index if not exists risk_flags_asof_date_idx
  on public.risk_flags(asof_date desc);

-- Realtime — Portfolio / Watchlist card danger badge + TickerDetail Risk-flags
-- section subscribe.
alter publication supabase_realtime add table public.risk_flags;

-- Service-role writes (the risk-flag engine is the sole producer); authenticated
-- reads for the FE. Instrument-keyed (no user_id), same grant pattern as
-- band_state / trait_scores — no row-level policy.
grant select, insert, update, delete on public.risk_flags to service_role;
grant select on public.risk_flags to authenticated, anon;

-- Tunable risk-flag thresholds live on the user's prefs row; null = seed
-- defaults (see server/src/config/riskFlags.ts). The Settings UI (Batch R2)
-- writes this; R1 only reads it.
alter table public.user_preferences
  add column if not exists risk_flag_config jsonb;
