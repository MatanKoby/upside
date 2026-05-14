-- Batch 6 — Align schema with IB Client Portal API reality.
-- Driven by gap analysis from Batch 7 captures (see captures/ — gitignored).
--
-- Changes:
--   1. positions: add conid, account_id, currency, asset_class, industry, category,
--      realized_pnl, vwap, vwap_updated_at.
--   2. signals: add conid (avoid re-resolving symbol → conid at every refresh).
--   3. new contracts table: per-conid metadata cache (company_name, industry, etc).
--   4. new ib_api_metrics table: per-call instrumentation for later optimization.

-- ============================================================================
-- positions — fields IB returns that we want to persist + computed VWAP.
-- ============================================================================
alter table public.positions
  add column conid             bigint,
  add column account_id        text,
  add column currency          text not null default 'USD',
  add column asset_class       text not null default 'STK',
  add column industry          text,
  add column category          text,
  add column realized_pnl      numeric,
  add column vwap_value        numeric,       -- snapshot VWAP at last poller cycle
  add column vwap_updated_at   timestamptz;

-- Backfill-tolerant: existing rows allowed to have null conid until pricePoller
-- repopulates them on next cycle.

-- The existing `vwap` column (created in 001) was meant for this — but it's a
-- single value and we now know we want a paired (value, updated_at). Drop the
-- old, use the new pair.
alter table public.positions drop column if exists vwap;
alter table public.positions drop column if exists vwap_diff_pct;

create index if not exists positions_conid_idx     on public.positions(conid);
create index if not exists positions_account_idx   on public.positions(account_id);

-- ============================================================================
-- signals — store conid so re-analyses skip a secdef/search round-trip.
-- ============================================================================
alter table public.signals
  add column conid bigint;
create index if not exists signals_conid_idx on public.signals(conid);

-- ============================================================================
-- contracts — metadata cache keyed by IB's contract id.
-- Populated lazily by pricePoller / signal pipeline; refreshed weekly.
-- ============================================================================
create table if not exists public.contracts (
  conid              bigint primary key,
  symbol             text not null,
  company_name       text,
  industry           text,
  category           text,
  asset_class        text not null default 'STK',
  currency           text not null default 'USD',
  exchange           text,                     -- primary listing, e.g. 'NYSE'
  valid_exchanges    text,                     -- comma-separated list from IB
  refreshed_at       timestamptz not null default now()
);
create index if not exists contracts_symbol_idx on public.contracts(symbol);

-- Server-only access via service-role key; no RLS needed (not user-scoped).

-- ============================================================================
-- ib_api_metrics — per-call instrumentation for later perf tuning.
-- TTL'd weekly via a cron job (NOT scheduled here; pricePoller will run delete).
-- ============================================================================
create table if not exists public.ib_api_metrics (
  id            uuid primary key default uuid_generate_v4(),
  endpoint      text not null,                 -- e.g. '/snapshot', '/positions'
  conid         bigint,
  duration_ms   integer not null,
  retries       integer not null default 0,
  status        integer not null,              -- HTTP status of final attempt
  succeeded     boolean not null,
  captured_at   timestamptz not null default now()
);
create index if not exists ib_api_metrics_endpoint_idx   on public.ib_api_metrics(endpoint, captured_at desc);
create index if not exists ib_api_metrics_captured_idx   on public.ib_api_metrics(captured_at desc);

-- Server-only; no RLS.
