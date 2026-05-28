-- 011_watchlist_and_quotes.sql — Batch A1 (watchlist pivot)
--
-- Three new tables for the watchlist surface + the canonical instrument-keyed
-- quote store the watchlist pivot called for (see spec/architecture.md →
-- "Single source of truth for current price" + spec/schema.md).
--
--   quotes           — one row per tracked conid. Stores BOTH IB and Finnhub
--                      prices side-by-side, plus a denormalized canonical_*
--                      triple. Each poller writes only its own source's
--                      columns; the canonical is whichever is currently
--                      authoritative (IB when fresh + connected, else Finnhub).
--                      Avoids the per-surface price-column duplication trap
--                      (positions.current_price vs. a future
--                      watchlist_items.price). See architecture.md.
--
--   watchlist_lists  — imported IB user_lists (Batch 13.2 captured the
--                      filter — system_lists are skipped). `active` defaults
--                      to false; the user un-hides each list from the
--                      Watchlist screen's in-screen settings (see
--                      spec/screens/watchlist.md). Pollers iterate active
--                      lists only.
--
--   watchlist_items  — tickers within a list. The same conid can appear on
--                      multiple lists; the poller dedups by conid before
--                      writing to quotes. Held + watchlisted overlap is fine
--                      — both surfaces read the same canonical quote.
--
-- positions.current_price stays for MVP — it becomes a denormalized mirror of
-- quotes.canonical_price that the same poller writes on each cycle. A2 adds
-- watchlist_markers; A+ adds entry_zones.

-- ============================================================================
-- quotes — canonical latest quote per instrument, keyed by conid.
-- ============================================================================
create table if not exists public.quotes (
  conid                 bigint primary key,
  symbol                text not null,

  ib_price              numeric,
  ib_updated_at         timestamptz,

  finnhub_price         numeric,
  finnhub_updated_at    timestamptz,

  -- Denormalized "the price to use" — set by whichever poller is currently
  -- authoritative. Same value (modulo source) consumers should read.
  canonical_price       numeric,
  canonical_source      text check (canonical_source in ('ib', 'finnhub')),
  canonical_updated_at  timestamptz
);

create index if not exists quotes_symbol_idx on public.quotes(symbol);
create index if not exists quotes_canonical_updated_idx
  on public.quotes(canonical_updated_at desc nulls last);

-- ============================================================================
-- watchlist_lists — one row per imported IB user-list per Upside user.
-- ============================================================================
create table if not exists public.watchlist_lists (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  ib_list_id      text not null,        -- IB's list id (e.g. "100", "1234")
  name            text not null,
  active          boolean not null default false,
  ib_modified_at  timestamptz,          -- from IB's `modified_at` (Batch 13.2)
  synced_at       timestamptz not null default now(),

  unique (user_id, ib_list_id)
);

create index if not exists watchlist_lists_user_active_idx
  on public.watchlist_lists(user_id, active);

-- ============================================================================
-- watchlist_items — tickers within a list.
-- ============================================================================
create table if not exists public.watchlist_items (
  id          uuid primary key default uuid_generate_v4(),
  list_id     uuid not null references public.watchlist_lists(id) on delete cascade,
  conid       bigint not null,
  symbol      text not null,
  added_at    timestamptz not null default now(),

  unique (list_id, conid)
);

create index if not exists watchlist_items_list_idx on public.watchlist_items(list_id);
create index if not exists watchlist_items_conid_idx on public.watchlist_items(conid);

-- ============================================================================
-- RLS + grants.
-- ============================================================================
-- quotes: instrument-keyed, not user-keyed → world-readable for authenticated
-- users (no PII). Service role writes (pollers).
alter table public.quotes enable row level security;
drop policy if exists "quotes: authenticated read" on public.quotes;
create policy "quotes: authenticated read" on public.quotes
  for select to authenticated using (true);
grant select on public.quotes to authenticated;
grant all    on public.quotes to service_role;

-- watchlist_lists: per-user.
alter table public.watchlist_lists enable row level security;
drop policy if exists "watchlist_lists: owner read"  on public.watchlist_lists;
drop policy if exists "watchlist_lists: owner write" on public.watchlist_lists;
create policy "watchlist_lists: owner read"  on public.watchlist_lists
  for select using (auth.uid() = user_id);
create policy "watchlist_lists: owner write" on public.watchlist_lists
  for update using (auth.uid() = user_id);
grant select, update on public.watchlist_lists to authenticated;
grant all on public.watchlist_lists to service_role;

-- watchlist_items: per-user via list ownership.
alter table public.watchlist_items enable row level security;
drop policy if exists "watchlist_items: owner read" on public.watchlist_items;
create policy "watchlist_items: owner read" on public.watchlist_items
  for select using (
    list_id in (select id from public.watchlist_lists where user_id = auth.uid())
  );
grant select on public.watchlist_items to authenticated;
grant all    on public.watchlist_items to service_role;

-- ============================================================================
-- Realtime publication.
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'quotes'
  ) then
    alter publication supabase_realtime add table public.quotes;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'watchlist_lists'
  ) then
    alter publication supabase_realtime add table public.watchlist_lists;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'watchlist_items'
  ) then
    alter publication supabase_realtime add table public.watchlist_items;
  end if;
end $$;
