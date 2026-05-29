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
  company_name: string | null;
}

// One row of the `quotes` table, keyed by conid (instrument, not user).
export interface QuoteRow {
  conid: number;
  symbol: string;
  canonical_price: number | null;
  canonical_source: 'ib' | 'finnhub' | null;
  canonical_updated_at: string | null;
  today_change_pct: number | null;
  sparkline_closes: number[] | null;
}

// A user-defined price marker — keyed by (user_id, conid) since
// migration 016 so it's shared across every list a ticker appears on. See
// spec/signals/markers.md.
export interface Marker {
  id: string;
  user_id: string;
  conid: number;
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
  markersByConid: Record<number, Marker[]>;
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
  const [markersByConid, setMarkersByConid] = useState<Record<number, Marker[]>>({});
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
        .select('id, list_id, conid, symbol, company_name')
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
            .select('conid, symbol, canonical_price, canonical_source, canonical_updated_at, today_change_pct, sparkline_closes')
            .in('conid', conidSet)
        : { data: [] as QuoteRow[] };
      const qMap: Record<number, QuoteRow> = {};
      for (const r of (quotesRes.data ?? []) as QuoteRow[]) {
        qMap[Number(r.conid)] = {
          ...r,
          canonical_price: num(r.canonical_price),
          today_change_pct: num(r.today_change_pct as number | null),
          sparkline_closes: Array.isArray(r.sparkline_closes)
            ? r.sparkline_closes.map((v) => Number(v)).filter((v) => Number.isFinite(v))
            : null,
        };
      }

      // Markers are now keyed by (user_id, conid) (migration 016) — one set of
      // markers per ticker, shared across every list it appears on. RLS scopes
      // to auth.uid() = user_id, so a plain select returns just our rows.
      const markersRes = await supabase
        .from('watchlist_markers')
        .select('id, user_id, conid, label, price, condition, enabled, cooldown_hours, last_fired_at, created_at');
      const markersByConidMap: Record<number, Marker[]> = {};
      for (const m of (markersRes.data ?? []) as Marker[]) {
        const c = Number(m.conid);
        const mp = { ...m, conid: c, price: Number(m.price) };
        (markersByConidMap[c] ??= []).push(mp);
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
      setMarkersByConid(markersByConidMap);
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

  return { lists, itemsByList, quotesByConid, markersByConid, entryZonesByConid, isLoading };
}
