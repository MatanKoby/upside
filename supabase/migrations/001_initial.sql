-- Upside MVP schema — initial migration.

create extension if not exists "uuid-ossp";

-- ============================================================================
-- positions
-- ============================================================================
create table if not exists public.positions (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  symbol          text not null,
  company_name    text,
  shares          numeric not null,
  avg_cost        numeric not null,
  current_price   numeric,
  market_value    numeric,
  unrealized_pnl  numeric,
  unrealized_pnl_pct numeric,
  today_change    numeric,
  today_change_pct numeric,
  vwap            numeric,
  vwap_diff_pct   numeric,
  portfolio_weight        numeric,
  portfolio_contribution  numeric,
  daily_return            numeric,
  trading_days_held       integer,
  updated_at      timestamptz not null default now(),
  unique (user_id, symbol)
);
create index if not exists positions_user_idx on public.positions(user_id);

-- ============================================================================
-- signals (range-based per MVP signal model)
-- ============================================================================
create table if not exists public.signals (
  id                          uuid primary key default uuid_generate_v4(),
  user_id                     uuid not null references auth.users(id) on delete cascade,
  symbol                      text not null,
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
create index if not exists signals_user_symbol_idx on public.signals(user_id, symbol);
create index if not exists signals_user_active_idx on public.signals(user_id) where superseded_by_analysis_id is null;

-- ============================================================================
-- user_preferences
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
-- position_history (daily snapshots)
-- ============================================================================
create table if not exists public.position_history (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  symbol          text not null,
  snapshot_date   date not null,
  shares          numeric not null,
  market_value    numeric not null,
  unrealized_pnl  numeric not null,
  current_price   numeric not null,
  created_at      timestamptz not null default now(),
  unique (user_id, symbol, snapshot_date)
);
create index if not exists position_history_user_date_idx on public.position_history(user_id, snapshot_date desc);

-- ============================================================================
-- analysis_locks (concurrency control)
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
-- access_attempts (whitelist enforcement log)
-- ============================================================================
create table if not exists public.access_attempts (
  id            uuid primary key default uuid_generate_v4(),
  email         text not null,
  granted       boolean not null,
  ip_address    text,
  user_agent    text,
  attempted_at  timestamptz not null default now()
);
create index if not exists access_attempts_email_idx on public.access_attempts(email);
create index if not exists access_attempts_attempted_idx on public.access_attempts(attempted_at desc);

-- ============================================================================
-- Row Level Security — user-data tables only.
-- The server uses the service role key which bypasses RLS;
-- these policies protect against the anon key being misused.
-- ============================================================================
alter table public.positions          enable row level security;
alter table public.signals            enable row level security;
alter table public.user_preferences   enable row level security;
alter table public.position_history   enable row level security;
alter table public.analysis_locks     enable row level security;

create policy "positions: owner read"          on public.positions          for select using (auth.uid() = user_id);
create policy "signals: owner read"            on public.signals            for select using (auth.uid() = user_id);
create policy "user_preferences: owner read"   on public.user_preferences   for select using (auth.uid() = user_id);
create policy "user_preferences: owner write"  on public.user_preferences   for update using (auth.uid() = user_id);
create policy "position_history: owner read"   on public.position_history   for select using (auth.uid() = user_id);
create policy "analysis_locks: owner read"     on public.analysis_locks     for select using (auth.uid() = user_id);

-- ============================================================================
-- Realtime — publish positions, signals, analysis_locks.
-- ============================================================================
alter publication supabase_realtime add table public.positions;
alter publication supabase_realtime add table public.signals;
alter publication supabase_realtime add table public.analysis_locks;
