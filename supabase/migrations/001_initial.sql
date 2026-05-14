-- Upside MVP schema — baseline.
--
-- Consolidated schema reflecting Batches 5, 6 (schema reconciliation from IB
-- captures), and 7.5 (this collapse). Future post-deploy migrations will be
-- 002+. position_history was specced originally but DROPPED from MVP — MTD
-- return is pulled directly from IB's account summary endpoint and signal
-- accuracy lives on the signals row itself.

create extension if not exists "uuid-ossp";

-- ============================================================================
-- positions — current holdings per user. Written by pricePoller every 5-15s
-- during market sessions; read by FE via REST + Supabase Realtime.
-- ============================================================================
create table if not exists public.positions (
  id                      uuid primary key default uuid_generate_v4(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  -- IB identity (Batch 6)
  conid                   bigint,                -- nullable until pricePoller writes
  account_id              text,                  -- IB acctId (e.g. "U19950548")
  symbol                  text not null,
  company_name            text,                  -- comes from contracts cache; nullable on first write
  -- Position math
  shares                  numeric not null,
  avg_cost                numeric not null,
  current_price           numeric,
  market_value            numeric,
  unrealized_pnl          numeric,
  unrealized_pnl_pct      numeric,
  realized_pnl            numeric,
  today_change            numeric,
  today_change_pct        numeric,
  -- Live indicators (paired value + freshness; computed BE-side from intraday bars)
  vwap_value              numeric,
  vwap_updated_at         timestamptz,
  -- Portfolio context (computed)
  portfolio_weight        numeric,
  portfolio_contribution  numeric,
  daily_return            numeric,
  trading_days_held       integer,
  -- Contract metadata (denormalized from contracts cache for convenience)
  currency                text not null default 'USD',
  asset_class             text not null default 'STK',
  industry                text,
  category                text,
  updated_at              timestamptz not null default now(),
  unique (user_id, symbol)
);
create index if not exists positions_user_idx       on public.positions(user_id);
create index if not exists positions_conid_idx      on public.positions(conid);
create index if not exists positions_account_idx    on public.positions(account_id);

-- ============================================================================
-- signals (range-based per MVP signal model).
-- ============================================================================
create table if not exists public.signals (
  id                          uuid primary key default uuid_generate_v4(),
  user_id                     uuid not null references auth.users(id) on delete cascade,
  symbol                      text not null,
  conid                       bigint,           -- stored at analysis time
  signal_type                 text not null check (signal_type in ('sell', 'no_signal')),
  signal_quality              integer not null check (signal_quality between 0 and 100),
  price_range_low             numeric,
  price_range_high            numeric,
  optimal_price               numeric,
  reasoning                   text not null,
  indicator_bullets           jsonb not null default '[]'::jsonb,
  indicator_snapshot          jsonb not null default '[]'::jsonb,
  actual_max_since_analysis   numeric,
  actual_min_since_analysis   numeric,
  entered_range_at            timestamptz,
  exited_range_at             timestamptz,
  superseded_by_analysis_id   uuid references public.signals(id) on delete set null,
  analyzed_at                 timestamptz not null default now(),
  expires_at                  timestamptz
);
create index if not exists signals_user_symbol_idx  on public.signals(user_id, symbol);
create index if not exists signals_user_active_idx  on public.signals(user_id) where superseded_by_analysis_id is null;
create index if not exists signals_conid_idx        on public.signals(conid);

-- ============================================================================
-- user_preferences — one row per user, keyed by Supabase user ID.
-- ============================================================================
create table if not exists public.user_preferences (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  signal_threshold        integer not null default 70,
  signal_min_market_value numeric not null default 1000,
  suppressed_symbols      text[] not null default '{}',
  sort_order              text not null default 'signals' check (sort_order in ('signals', 'pnl', 'custom')),
  stat_config             text[] not null default '{}',
  theme                   text not null default 'dark' check (theme in ('dark', 'light')),
  quiet_hours_start       time,
  quiet_hours_end         time,
  llm_provider            text not null default 'gemini' check (llm_provider in ('gemini', 'claude', 'openai')),
  updated_at              timestamptz not null default now()
);

-- ============================================================================
-- analysis_locks — concurrency control for signal analysis.
-- ============================================================================
create table if not exists public.analysis_locks (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  symbol      text not null,
  started_at  timestamptz not null default now(),
  status      text not null default 'running' check (status in ('running', 'failed')),
  unique (user_id, symbol, status)
);
create index if not exists analysis_locks_started_idx on public.analysis_locks(started_at);

-- ============================================================================
-- access_attempts — Google OAuth attempt log (granted + non-whitelisted).
-- ============================================================================
create table if not exists public.access_attempts (
  id            uuid primary key default uuid_generate_v4(),
  email         text not null,
  granted       boolean not null,
  ip_address    text,
  user_agent    text,
  attempted_at  timestamptz not null default now()
);
create index if not exists access_attempts_email_idx     on public.access_attempts(email);
create index if not exists access_attempts_attempted_idx on public.access_attempts(attempted_at desc);

-- ============================================================================
-- contracts — per-conid metadata cache.
-- Populated lazily by pricePoller / signal pipeline; weekly refresh.
-- Server-only access via service-role key; no RLS needed.
-- ============================================================================
create table if not exists public.contracts (
  conid              bigint primary key,
  symbol             text not null,
  company_name       text,
  industry           text,
  category           text,
  asset_class        text not null default 'STK',
  currency           text not null default 'USD',
  exchange           text,                       -- primary listing, e.g. 'NYSE'
  valid_exchanges    text,                       -- comma-separated list from IB
  refreshed_at       timestamptz not null default now()
);
create index if not exists contracts_symbol_idx on public.contracts(symbol);

-- ============================================================================
-- ib_api_metrics — per-IB-call instrumentation. 30-day TTL handled by cron.
-- Server-only; no RLS.
-- ============================================================================
create table if not exists public.ib_api_metrics (
  id            uuid primary key default uuid_generate_v4(),
  endpoint      text not null,
  conid         bigint,
  duration_ms   integer not null,
  retries       integer not null default 0,
  status        integer not null,
  succeeded     boolean not null,
  captured_at   timestamptz not null default now()
);
create index if not exists ib_api_metrics_endpoint_idx on public.ib_api_metrics(endpoint, captured_at desc);
create index if not exists ib_api_metrics_captured_idx on public.ib_api_metrics(captured_at desc);

-- ============================================================================
-- Row Level Security — user-data tables only.
-- The server uses the service role key which bypasses RLS;
-- these policies protect against the anon key being misused.
-- contracts and ib_api_metrics are server-only and intentionally have no RLS.
-- ============================================================================
alter table public.positions          enable row level security;
alter table public.signals            enable row level security;
alter table public.user_preferences   enable row level security;
alter table public.analysis_locks     enable row level security;

create policy "positions: owner read"          on public.positions          for select using (auth.uid() = user_id);
create policy "signals: owner read"            on public.signals            for select using (auth.uid() = user_id);
create policy "user_preferences: owner read"   on public.user_preferences   for select using (auth.uid() = user_id);
create policy "user_preferences: owner write"  on public.user_preferences   for update using (auth.uid() = user_id);
create policy "analysis_locks: owner read"     on public.analysis_locks     for select using (auth.uid() = user_id);

-- ============================================================================
-- Realtime — publish tables that the FE subscribes to.
-- ============================================================================
alter publication supabase_realtime add table public.positions;
alter publication supabase_realtime add table public.signals;
alter publication supabase_realtime add table public.analysis_locks;
