-- Batch 14c — profit-taking zone detection.
--
-- A position is "in profit-taking zone" when its unrealized P&L percent crosses
-- a user-configurable threshold (default +2.0%). Zone state is recomputed on
-- every `positions` row write by both pollers (ibPricePoller / finnhubPricePoller).
-- This unifies pre-market gaps, run-ups, news rallies, and drawdown recoveries
-- into one mechanism — any cause that pushes P&L across the threshold triggers
-- the same flow.
--
--   zone_entered_at           — when current zone-membership began; NULL when not in zone.
--   zone_exited_at            — when the last zone-membership ended (kept for post-mortem).
--   last_zone_notification_at — cooldown anchor; a Discord ping fires at most once per 4h.
--   entered_zone_via_gap      — true if zone-entry happened outside the regular
--                               session (pre-market / overnight). Cleared at end
--                               of each regular session by zoneGapCleanup.
--
-- Existing rows default to "not in zone" (all NULL / false) — the next poll
-- cycle recomputes from live P&L.

alter table public.positions
  add column if not exists zone_entered_at           timestamptz null,
  add column if not exists zone_exited_at            timestamptz null,
  add column if not exists last_zone_notification_at timestamptz null,
  add column if not exists entered_zone_via_gap      boolean not null default false;

-- Per-user threshold (percent). Settings exposes a 0.5%–10% slider (Batch 15).
alter table public.user_preferences
  add column if not exists profit_zone_threshold_pct numeric not null default 2.0;

alter table public.user_preferences
  drop constraint if exists user_preferences_profit_zone_threshold_check;
alter table public.user_preferences
  add constraint user_preferences_profit_zone_threshold_check
  check (profit_zone_threshold_pct > 0);
