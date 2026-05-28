-- 013_entry_zones.sql — Batch A+ (watchlist pivot).
--
-- Dynamic entry-zone engine state. One row per (conid, horizon) — three rows
-- per active-list conid. Upserted on every poll cycle for active watchlists
-- (the engine runs in `services/entryZones.ts`; spec/signals/entry-zones.md).
-- Realtime so the FE can render live entry chips on watchlist rows.

create table if not exists public.entry_zones (
  conid                 bigint  not null,
  horizon               text    not null check (horizon in ('intraday', 'overnight', 'multiday')),

  price                 numeric not null,
  reasoning             text    not null,        -- "SMA20 + S1 confluence" / "lower Bollinger band" / ...
  confidence            integer not null check (confidence >= 0 and confidence <= 100),

  trend_regime          text    not null check (trend_regime in ('up', 'down', 'mixed')),
  overbought_tightened  boolean not null default false,

  last_fired_at         timestamptz,             -- 24h Discord cooldown anchor per (conid, horizon)
  computed_at           timestamptz not null default now(),

  primary key (conid, horizon)
);

create index if not exists entry_zones_conid_idx on public.entry_zones(conid);

-- RLS: instrument-keyed, not user-keyed (like `quotes`). Authenticated users
-- can read; service role writes.
alter table public.entry_zones enable row level security;
drop policy if exists "entry_zones: authenticated read" on public.entry_zones;
create policy "entry_zones: authenticated read" on public.entry_zones
  for select to authenticated using (true);
grant select on public.entry_zones to authenticated;
grant all    on public.entry_zones to service_role;

-- Realtime
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'entry_zones'
  ) then
    alter publication supabase_realtime add table public.entry_zones;
  end if;
end $$;
