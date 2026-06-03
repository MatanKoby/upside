-- 026_band_state.sql — Batch S3 (post-MVP screener track).
--
-- Adaptive band engine's persistence layer. One row per (conid, session_date)
-- holding the walking band-state machine's state — anchors history, currently-
-- published low/high bands, session_regime label, today's vol_scalar, daily
-- vol_regime_shift flag, and a per-(conid, band_kind) cooldown clock for
-- Discord band-touch notifications.
--
-- conid here references universe.real_conid (the IBKR conid), NOT the
-- synthetic universe.conid PK — same convention as trait_scores.
--
-- Reset rule: cleanly cleared at 16:30 IDT next session by bandEngineCron's
-- reset mode (no AH carryover) — new session_date = new row, the prior row
-- stays as a historical artifact until traitScoresRetention-style cleanup
-- ages it out (deferred to a follow-up retention cron when the table grows).
--
-- anchors jsonb shape: chronological array of {kind, price, ts} records:
--   [{ "kind": "low", "price": 17.96, "ts": "2026-06-04T15:31:00Z" },
--    { "kind": "high", "price": 18.42, "ts": "2026-06-04T15:47:00Z" }, ...]
--
-- band_touch_last_fired_at jsonb shape: per-band-kind cooldown timestamps:
--   { "low": "2026-06-04T15:55:00Z", "high": null }
-- Touched/updated by the band-engine cron after each notifyBandTouch* call.

create table if not exists public.band_state (
  conid                       bigint        not null,
  session_date                date          not null,
  anchors                     jsonb         not null default '[]'::jsonb,
  current_low_band            numeric,
  current_high_band           numeric,
  session_regime              text          check (session_regime in (
                                'mean_reversion',
                                'bullish_trend',
                                'bearish_trend',
                                'mixed',
                                'ah_low_confidence'
                              )),
  vol_scalar                  numeric,
  vol_regime_shift            boolean       not null default false,
  band_touch_last_fired_at    jsonb         not null default '{}'::jsonb,
  updated_at                  timestamptz   not null default now(),

  primary key (conid, session_date)
);

-- Read patterns: cron loop pulls today's rows for the curated list; FE band
-- chips read the latest row per conid via the Realtime subscription.
create index if not exists band_state_session_date_idx
  on public.band_state(session_date desc);

-- Realtime — Screener tab + Watchlist band-chip subscribers.
alter publication supabase_realtime add table public.band_state;

-- Service-role writes (band-engine cron is sole producer); authenticated reads for FE.
grant select, insert, update, delete on public.band_state to service_role;
grant select on public.band_state to authenticated, anon;
