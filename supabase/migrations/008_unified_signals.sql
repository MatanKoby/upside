-- 008_unified_signals.sql — Batch 14a
--
-- Unified SELL+BUY signal model. One Analyze call produces one `analyses` row
-- (shared context) plus 1-2 `signals` rows, one per emitted direction.
--
-- Safe as a clean reshape: `signals` is empty at migration time (the analyze
-- pipeline was a 501 stub through Batch 13.x), so the columns that move to
-- `analyses` are dropped rather than backfilled.

-- ============================================================================
-- analyses — one row per Analyze call. Holds the shared analysis context
-- (narrative + indicator snapshot) so the SELL and BUY signal rows from the
-- same analysis reference it instead of duplicating it.
-- ============================================================================
create table if not exists public.analyses (
  analysis_id        uuid primary key default uuid_generate_v4(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  symbol             text not null,
  conid              bigint,                                  -- stored at analysis time
  indicator_snapshot jsonb not null default '[]'::jsonb,
  reasoning          text,
  analyzed_at        timestamptz not null default now(),
  expires_at         timestamptz
);
create index if not exists analyses_user_symbol_idx on public.analyses(user_id, symbol, analyzed_at desc);

-- ============================================================================
-- signals reshape — one row per *direction* of a unified analysis.
-- ============================================================================
-- Shared context now lives on `analyses`; drop it from the per-direction row.
alter table public.signals drop column if exists reasoning;
alter table public.signals drop column if exists indicator_snapshot;
alter table public.signals drop column if exists indicator_bullets;

-- Widen signal_type to include the BUY direction.
alter table public.signals drop constraint if exists signals_signal_type_check;
alter table public.signals add constraint signals_signal_type_check
  check (signal_type in ('sell', 'buy', 'no_signal'));

-- Re-point superseding at the parent analysis: superseding is whole-analysis,
-- not per-direction. (The old column referenced a sibling signal row.)
alter table public.signals drop column if exists superseded_by_analysis_id;

alter table public.signals add column if not exists analysis_id uuid
  references public.analyses(analysis_id) on delete cascade;
alter table public.signals add column if not exists motivation text;
alter table public.signals add column if not exists rationale text;
alter table public.signals add column if not exists acted_on_at timestamptz;
alter table public.signals add column if not exists superseded_by_analysis_id uuid
  references public.analyses(analysis_id) on delete set null;

-- Motivation is a per-direction enum; null for no_signal. Enforced against
-- signal_type so a SELL can't carry a BUY motivation and vice versa.
alter table public.signals drop constraint if exists signals_motivation_check;
alter table public.signals add constraint signals_motivation_check check (
  motivation is null
  or (signal_type = 'sell' and motivation in ('take_profit', 'derisk', 'avoid_downside'))
  or (signal_type = 'buy'  and motivation in ('pullback_entry', 'breakout_continuation', 'value'))
);

-- "Latest non-superseded per symbol" query path.
create index if not exists signals_user_symbol_analyzed_idx
  on public.signals(user_id, symbol, analyzed_at desc);

-- ============================================================================
-- user_preferences — profit-taking zone threshold (Batch 14a / 14c).
-- ============================================================================
alter table public.user_preferences add column if not exists profit_zone_threshold_pct
  numeric not null default 2.0;

-- ============================================================================
-- RLS + grants for `analyses`.
-- Owner-read for the FE (to fetch a signal's parent context). NOT added to the
-- realtime publication — the FE subscribes to `signals` and fetches the parent
-- analysis on demand. Server writes via the service role (bypasses RLS).
-- ============================================================================
alter table public.analyses enable row level security;
create policy "analyses: owner read" on public.analyses for select using (auth.uid() = user_id);
grant select on public.analyses to authenticated;
grant all    on public.analyses to service_role;
