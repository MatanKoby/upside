-- 012_watchlist_markers.sql — Batch A2 (watchlist pivot).
--
-- User-defined price markers attached to a watchlist_items row. Vocabulary
-- mirrors playbook legs (at_or_above | at_or_below | about — geometric vs.
-- current price; see spec/signals/playbook.md → schema note). Pollers check
-- markers on every `quotes` write and fire Discord alerts with a per-marker
-- cooldown (default 24h, configurable per marker for future use). First-cut
-- alert path wires only at_or_below → #upside-dip-buys; the other conditions
-- are accepted in schema for forward-compatibility but their alert channels
-- are queued for a follow-up batch.
--
-- See spec/signals/markers.md and spec/flows.md → Marker Hit Flow.

create table if not exists public.watchlist_markers (
  id              uuid primary key default uuid_generate_v4(),
  item_id         uuid not null references public.watchlist_items(id) on delete cascade,
  label           text,
  price           numeric not null,
  condition       text not null check (condition in ('at_or_above', 'at_or_below', 'about')),
  enabled         boolean not null default true,
  cooldown_hours  integer not null default 24 check (cooldown_hours > 0),
  last_fired_at   timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists watchlist_markers_item_idx on public.watchlist_markers(item_id);
-- For the poller-side "find active markers for this conid" query (which joins
-- through watchlist_items by conid). Filters to enabled rows so the index
-- stays selective even with many disabled markers around.
create index if not exists watchlist_markers_enabled_idx
  on public.watchlist_markers(item_id) where enabled = true;

-- RLS — scoped to lists owned by auth.uid() via the item → list chain.
alter table public.watchlist_markers enable row level security;

drop policy if exists "watchlist_markers: owner read"   on public.watchlist_markers;
drop policy if exists "watchlist_markers: owner write"  on public.watchlist_markers;
drop policy if exists "watchlist_markers: owner update" on public.watchlist_markers;
drop policy if exists "watchlist_markers: owner delete" on public.watchlist_markers;

create policy "watchlist_markers: owner read"
  on public.watchlist_markers for select
  using (
    item_id in (
      select i.id from public.watchlist_items i
      join public.watchlist_lists l on l.id = i.list_id
      where l.user_id = auth.uid()
    )
  );

create policy "watchlist_markers: owner write"
  on public.watchlist_markers for insert
  with check (
    item_id in (
      select i.id from public.watchlist_items i
      join public.watchlist_lists l on l.id = i.list_id
      where l.user_id = auth.uid()
    )
  );

create policy "watchlist_markers: owner update"
  on public.watchlist_markers for update
  using (
    item_id in (
      select i.id from public.watchlist_items i
      join public.watchlist_lists l on l.id = i.list_id
      where l.user_id = auth.uid()
    )
  );

create policy "watchlist_markers: owner delete"
  on public.watchlist_markers for delete
  using (
    item_id in (
      select i.id from public.watchlist_items i
      join public.watchlist_lists l on l.id = i.list_id
      where l.user_id = auth.uid()
    )
  );

grant select, insert, update, delete on public.watchlist_markers to authenticated;
grant all on public.watchlist_markers to service_role;

-- Realtime so the FE updates marker chips + last_fired_at in real time.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'watchlist_markers'
  ) then
    alter publication supabase_realtime add table public.watchlist_markers;
  end if;
end $$;
