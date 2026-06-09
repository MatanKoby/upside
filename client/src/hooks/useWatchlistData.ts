import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';
import { readCache, writeCache } from './dataCache';

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
  today_open: number | null;
  sparkline_closes: number[] | null;
}

// One row of `intraday_stats` (Batch B). Per-instrument historical character
// — typical open/close fade and typical intraday-low dip from open. Computed
// nightly by `intradayStatsCron`. See spec/signals/stats.md.
export interface IntradayStatsRow {
  conid: number;
  open_fade_pct_mean: number | null;
  open_fade_pct_p50: number | null;
  open_fade_pct_p25: number | null;
  close_fade_pct_mean: number | null;
  close_fade_pct_p50: number | null;
  close_fade_pct_p25: number | null;
  intraday_low_pct_mean: number | null;
  intraday_low_pct_p50: number | null;
  intraday_low_pct_p75: number | null;
  sample_size: number;
  lookback_days: number;
  computed_at: string;
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
  statsByConid: Record<number, IntradayStatsRow>;
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
// Single snapshot of everything the hook returns, so the stale-while-revalidate
// cache (Batch X11) holds one value per remount and the load writes it in one
// shot. See ./dataCache + spec/architecture.md → Frontend data caching.
interface WatchlistSnapshot {
  lists: WatchlistList[];
  itemsByList: Record<string, WatchlistItem[]>;
  quotesByConid: Record<number, QuoteRow>;
  markersByConid: Record<number, Marker[]>;
  entryZonesByConid: Record<number, Partial<Record<Horizon, EntryZoneRow>>>;
  statsByConid: Record<number, IntradayStatsRow>;
}
const EMPTY_WATCHLIST: WatchlistSnapshot = {
  lists: [], itemsByList: {}, quotesByConid: {}, markersByConid: {}, entryZonesByConid: {}, statsByConid: {},
};
const CACHE_KEY = 'watchlist';

export function useWatchlistData(): UseWatchlistData {
  // Seed from cache so a tab/route remount paints the last watchlist instantly;
  // only a cold cache shows the loading state.
  const cached = readCache<WatchlistSnapshot>(CACHE_KEY);
  const [data, setData] = useState<WatchlistSnapshot>(cached ?? EMPTY_WATCHLIST);
  const [isLoading, setIsLoading] = useState(cached === undefined);

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
            .select('conid, symbol, canonical_price, canonical_source, canonical_updated_at, today_change_pct, today_open, sparkline_closes')
            .in('conid', conidSet)
        : { data: [] as QuoteRow[] };
      const qMap: Record<number, QuoteRow> = {};
      for (const r of (quotesRes.data ?? []) as QuoteRow[]) {
        qMap[Number(r.conid)] = {
          ...r,
          canonical_price: num(r.canonical_price),
          today_change_pct: num(r.today_change_pct as number | null),
          today_open: num(r.today_open as number | null),
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

      // Intraday stats (Batch B). One row per conid; only present for conids
      // the nightly cron has covered. `last_fired_at` lives only on the BE
      // side (the alert-cooldown anchor) — FE doesn't need it.
      const statsRes = conidSet.length
        ? await supabase
            .from('intraday_stats')
            .select(
              'conid, open_fade_pct_mean, open_fade_pct_p50, open_fade_pct_p25, ' +
              'close_fade_pct_mean, close_fade_pct_p50, close_fade_pct_p25, ' +
              'intraday_low_pct_mean, intraday_low_pct_p50, intraday_low_pct_p75, ' +
              'sample_size, lookback_days, computed_at',
            )
            .in('conid', conidSet)
        : { data: [] as IntradayStatsRow[] };
      const sMap: Record<number, IntradayStatsRow> = {};
      for (const r of (statsRes.data ?? []) as IntradayStatsRow[]) {
        const c = Number(r.conid);
        sMap[c] = {
          ...r,
          open_fade_pct_mean: num(r.open_fade_pct_mean),
          open_fade_pct_p50: num(r.open_fade_pct_p50),
          open_fade_pct_p25: num(r.open_fade_pct_p25),
          close_fade_pct_mean: num(r.close_fade_pct_mean),
          close_fade_pct_p50: num(r.close_fade_pct_p50),
          close_fade_pct_p25: num(r.close_fade_pct_p25),
          intraday_low_pct_mean: num(r.intraday_low_pct_mean),
          intraday_low_pct_p50: num(r.intraday_low_pct_p50),
          intraday_low_pct_p75: num(r.intraday_low_pct_p75),
        };
      }

      if (!alive) return;
      const snap: WatchlistSnapshot = {
        lists: listRows,
        itemsByList: itemsByListMap,
        quotesByConid: qMap,
        markersByConid: markersByConidMap,
        entryZonesByConid: zMap,
        statsByConid: sMap,
      };
      writeCache(CACHE_KEY, snap);
      setData(snap);
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'intraday_stats' }, () => void load())
      .subscribe();

    return () => {
      alive = false;
      void supabase.removeChannel(ch);
    };
  }, []);

  return { ...data, isLoading };
}
