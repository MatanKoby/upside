-- 016_watchlist_markers_per_conid.sql — bug fix (2026-05-29).
--
-- Markers were keyed by watchlist_items.id, which meant the SAME ticker on
-- two lists (e.g. "Next" + "Splitting") had two separate watchlist_items
-- rows and a marker added on one wouldn't show on the other. That's not the
-- mental model — a marker is per-(user, ticker), not per-row-in-a-list.
--
-- Re-keys watchlist_markers by (user_id, conid). Item_id is dropped so the
-- old per-row semantics can't sneak back through stale queries. Existing
-- markers are backfilled from the item → list chain.

alter table public.watchlist_markers
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists conid   bigint;

-- Backfill from the existing item_id chain.
update public.watchlist_markers wm
   set user_id = wl.user_id,
       conid   = wi.conid
  from public.watchlist_items wi
  join public.watchlist_lists wl on wl.id = wi.list_id
 where wi.id = wm.item_id
   and (wm.user_id is null or wm.conid is null);

-- Lock the new columns down.
alter table public.watchlist_markers
  alter column user_id set not null,
  alter column conid   set not null;

-- RLS policies: drop the old item-chain ones, install simple user_id-scoped.
drop policy if exists "watchlist_markers: owner read"   on public.watchlist_markers;
drop policy if exists "watchlist_markers: owner write"  on public.watchlist_markers;
drop policy if exists "watchlist_markers: owner update" on public.watchlist_markers;
drop policy if exists "watchlist_markers: owner delete" on public.watchlist_markers;

-- Drop the old item_id linkage (and its FK + NOT NULL).
alter table public.watchlist_markers drop column if exists item_id;

-- Old item-keyed index → drop. New user+conid index for the poller-side
-- "find markers for this conid" + the FE's per-row lookup.
drop index if exists public.watchlist_markers_item_idx;
drop index if exists public.watchlist_markers_enabled_idx;
create index if not exists watchlist_markers_user_conid_idx
  on public.watchlist_markers(user_id, conid);
create index if not exists watchlist_markers_conid_enabled_idx
  on public.watchlist_markers(conid) where enabled = true;



create policy "watchlist_markers: owner read"   on public.watchlist_markers
  for select using (auth.uid() = user_id);
create policy "watchlist_markers: owner write"  on public.watchlist_markers
  for insert with check (auth.uid() = user_id);
create policy "watchlist_markers: owner update" on public.watchlist_markers
  for update using (auth.uid() = user_id);
create policy "watchlist_markers: owner delete" on public.watchlist_markers
  for delete using (auth.uid() = user_id);
