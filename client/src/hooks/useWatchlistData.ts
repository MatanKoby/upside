import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';

// One imported IB watchlist. `active` controls whether the BE poller writes
// quotes for its tickers (and whether the FE renders it as a sub-tab). See
// spec/screens/watchlist.md.
export interface WatchlistList {
  id: string;
  name: string;
  active: boolean;
  ib_list_id: string;
  ib_modified_at: string | null;
  synced_at: string;
}

export interface WatchlistItem {
  id: string;
  list_id: string;
  conid: number;
  symbol: string;
}

// One row of the `quotes` table, keyed by conid (instrument, not user).
export interface QuoteRow {
  conid: number;
  symbol: string;
  canonical_price: number | null;
  canonical_source: 'ib' | 'finnhub' | null;
  canonical_updated_at: string | null;
}

// A user-defined price marker on a watchlist_items row (Batch A2). See
// spec/signals/markers.md.
export interface Marker {
  id: string;
  item_id: string;
  label: string | null;
  price: number;
  condition: 'at_or_above' | 'at_or_below' | 'about';
  enabled: boolean;
  cooldown_hours: number;
  last_fired_at: string | null;
  created_at: string;
}

// One row of `entry_zones` (Batch A+). Three rows per active conid (one per
// horizon). See spec/signals/entry-zones.md.
export type Horizon = 'intraday' | 'overnight' | 'multiday';
export interface EntryZoneRow {
  conid: number;
  horizon: Horizon;
  price: number;
  reasoning: string;
  confidence: number;
  trend_regime: 'up' | 'down' | 'mixed';
  overbought_tightened: boolean;
  computed_at: string;
}

export interface UseWatchlistData {
  lists: WatchlistList[];
  itemsByList: Record<string, WatchlistItem[]>;
  quotesByConid: Record<number, QuoteRow>;
  markersByItem: Record<string, Marker[]>;
  entryZonesByConid: Record<number, Partial<Record<Horizon, EntryZoneRow>>>;
  isLoading: boolean;
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

// Loads watchlist_lists + watchlist_items + quotes (for active-list conids)
// with a single Realtime subscription per table. Lists with active=false are
// included so the in-screen settings sheet can render them; the page itself
// filters to active for the sub-tab strip.
export function useWatchlistData(): UseWatchlistData {
  const [lists, setLists] = useState<WatchlistList[]>([]);
  const [itemsByList, setItemsByList] = useState<Record<string, WatchlistItem[]>>({});
  const [quotesByConid, setQuotesByConid] = useState<Record<number, QuoteRow>>({});
  const [markersByItem, setMarkersByItem] = useState<Record<string, Marker[]>>({});
  const [entryZonesByConid, setEntryZonesByConid] = useState<Record<number, Partial<Record<Horizon, EntryZoneRow>>>>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    async function load() {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.user.id) {
        if (alive) setIsLoading(false);
        return;
      }

      const listsRes = await supabase
        .from('watchlist_lists')
        .select('id, name, active, ib_list_id, ib_modified_at, synced_at')
        .order('name', { ascending: true });
      const listRows = (listsRes.data ?? []) as WatchlistList[];

      const itemsRes = await supabase
        .from('watchlist_items')
        .select('id, list_id, conid, symbol')
        .in('list_id', listRows.map((l) => l.id).length ? listRows.map((l) => l.id) : ['00000000-0000-0000-0000-000000000000']);
      const itemRows = (itemsRes.data ?? []) as WatchlistItem[];

      const itemsByListMap: Record<string, WatchlistItem[]> = {};
      const allConids: number[] = [];
      for (const it of itemRows) {
        (itemsByListMap[it.list_id] ??= []).push(it);
        allConids.push(Number(it.conid));
      }

      const conidSet = Array.from(new Set(allConids));
      const quotesRes = conidSet.length
        ? await supabase
            .from('quotes')
            .select('conid, symbol, canonical_price, canonical_source, canonical_updated_at')
            .in('conid', conidSet)
        : { data: [] as QuoteRow[] };
      const qMap: Record<number, QuoteRow> = {};
      for (const r of (quotesRes.data ?? []) as QuoteRow[]) {
        qMap[Number(r.conid)] = { ...r, canonical_price: num(r.canonical_price) };
      }

      // Markers: scoped to items the user owns. RLS handles this at the
      // table level (marker → item → list → user_id).
      const itemIds = itemRows.map((r) => r.id);
      const markersRes = itemIds.length
        ? await supabase
            .from('watchlist_markers')
            .select('id, item_id, label, price, condition, enabled, cooldown_hours, last_fired_at, created_at')
            .in('item_id', itemIds)
        : { data: [] as Marker[] };
      const markersByItemMap: Record<string, Marker[]> = {};
      for (const m of (markersRes.data ?? []) as Marker[]) {
        const mp = { ...m, price: Number(m.price) };
        (markersByItemMap[m.item_id] ??= []).push(mp);
      }

      // Entry zones (Batch A+). Three rows per conid (one per horizon),
      // populated by the entryZonesCron. Indexed nested for easy lookup.
      const zonesRes = conidSet.length
        ? await supabase
            .from('entry_zones')
            .select('conid, horizon, price, reasoning, confidence, trend_regime, overbought_tightened, computed_at')
            .in('conid', conidSet)
        : { data: [] as EntryZoneRow[] };
      const zMap: Record<number, Partial<Record<Horizon, EntryZoneRow>>> = {};
      for (const r of (zonesRes.data ?? []) as EntryZoneRow[]) {
        const c = Number(r.conid);
        const horizon = r.horizon as Horizon;
        (zMap[c] ??= {})[horizon] = { ...r, price: Number(r.price) };
      }

      if (!alive) return;
      setLists(listRows);
      setItemsByList(itemsByListMap);
      setQuotesByConid(qMap);
      setMarkersByItem(markersByItemMap);
      setEntryZonesByConid(zMap);
      setIsLoading(false);
    }

    void load();

    // Realtime: re-pull on any change. Keep it simple — the data set is small.
    const ch = supabase
      .channel('watchlist-data')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'watchlist_lists' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'watchlist_items' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'quotes' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'watchlist_markers' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'entry_zones' }, () => void load())
      .subscribe();

    return () => {
      alive = false;
      void supabase.removeChannel(ch);
    };
  }, []);

  return { lists, itemsByList, quotesByConid, markersByItem, entryZonesByConid, isLoading };
}
