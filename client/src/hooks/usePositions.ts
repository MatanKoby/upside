import { useEffect, useRef, useState } from 'react';
import { supabase } from '../services/supabase';
import { readCache, writeCache } from './dataCache';
import type { Position } from '../types';

// Stale-while-revalidate cache key (Batch X11). A remount paints the last
// positions snapshot instantly while Realtime + a background reload revalidate.
const CACHE_KEY = 'positions';

// Price SSOT (Batch X5): `positions` holds holding facts only; the per-share
// price + P&L are recomputed from `quotes.canonical_price` × shares. This hook
// joins the two tables client-side (positions ⨝ quotes by conid) and subscribes
// to both Realtime channels so cards stay live as the quote ticks.

interface DbPosition {
  conid: number | null;
  account_id: string | null;
  symbol: string;
  company_name: string | null;
  shares: number | string;
  avg_cost: number | string;
  vwap_value: number | string | null;
  industry: string | null;
  category: string | null;
  zone_entered_at: string | null;
  entered_zone_via_gap: boolean | null;
}

interface QuoteRow {
  canonical_price: number | string | null;
  today_change_pct: number | string | null;
}

function n(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

function rowToPosition(r: DbPosition, q: QuoteRow | undefined): Position {
  const shares = n(r.shares);
  const avgCost = n(r.avg_cost);
  const price = n(q?.canonical_price);
  const pct = n(q?.today_change_pct);
  const marketValue = price * shares;
  const costBasis = avgCost * shares;
  const unrealizedPnL = price > 0 ? marketValue - costBasis : 0;
  const unrealizedPnLPercent = price > 0 && costBasis !== 0 ? (unrealizedPnL / costBasis) * 100 : 0;
  // Per-share $ change derived from the % (prevClose = price / (1 + pct/100)).
  const todayChange = price > 0 && pct !== 0 ? price - price / (1 + pct / 100) : 0;
  return {
    conid: r.conid ?? null,
    symbol: r.symbol,
    name: r.company_name ?? r.symbol,
    shares,
    avgCost,
    currentPrice: price,
    marketValue,
    unrealizedPnL,
    unrealizedPnLPercent,
    todayChange,
    todayChangePercent: pct,
    vwap: n(r.vwap_value),
    sparkline: [],            // populated by PositionCard via /sparkline endpoint
    signal: undefined,        // signals merged in by PortfolioHome via useSignals (Batch 14)
    zoneEnteredAt: r.zone_entered_at ?? null,
    enteredZoneViaGap: Boolean(r.entered_zone_via_gap),
  };
}

export interface UsePositionsResult {
  positions: Position[];
  isLoading: boolean;
  error: string | null;
}

export function usePositions(): UsePositionsResult {
  // Seed from the cache so a remount shows the last rows immediately; only a
  // cold cache starts in the loading state.
  const cached = readCache<Position[]>(CACHE_KEY);
  const [positions, setPositions] = useState<Position[]>(cached ?? []);
  const [isLoading, setIsLoading] = useState(cached === undefined);
  const [error, setError] = useState<string | null>(null);
  const heldConids = useRef<Set<number>>(new Set());

  useEffect(() => {
    let alive = true;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;

    async function loadInitial() {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) {
        if (alive) {
          setPositions([]);
          setIsLoading(false);
        }
        return;
      }

      const { data, error: fetchError } = await supabase
        .from('positions')
        .select('*')
        .eq('user_id', userId);

      if (!alive) return;
      if (fetchError) {
        setError(fetchError.message);
        setIsLoading(false);
        return;
      }
      const rows = (data ?? []) as DbPosition[];

      // Pull the canonical price for the held conids from `quotes` (the one
      // price home) and recompute market value + P&L.
      const conids = rows.map((r) => Number(r.conid)).filter((c) => Number.isFinite(c));
      heldConids.current = new Set(conids);
      const quoteByConid = new Map<number, QuoteRow>();
      if (conids.length > 0) {
        const { data: quotes } = await supabase
          .from('quotes')
          .select('conid, canonical_price, today_change_pct')
          .in('conid', conids);
        for (const q of quotes ?? []) {
          const c = Number((q as { conid: number | string | null }).conid);
          if (Number.isFinite(c)) quoteByConid.set(c, q as QuoteRow);
        }
      }
      if (!alive) return;
      const mapped = rows.map((r) => rowToPosition(r, quoteByConid.get(Number(r.conid))));
      mapped.sort((a, b) => b.marketValue - a.marketValue);
      writeCache(CACHE_KEY, mapped);
      setPositions(mapped);
      setIsLoading(false);
    }

    function scheduleReload() {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void loadInitial(), 250);
    }

    void loadInitial();

    const channel = supabase
      .channel('positions-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'positions' },
        () => scheduleReload(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'quotes' },
        (payload) => {
          // The quotes table ticks for the whole watchlist/curated universe;
          // only reload when a *held* conid changed.
          const row = (payload.new ?? payload.old) as { conid?: number | string } | null;
          const conid = row?.conid != null ? Number(row.conid) : NaN;
          if (Number.isFinite(conid) && heldConids.current.has(conid)) scheduleReload();
        },
      )
      .subscribe();

    return () => {
      alive = false;
      if (reloadTimer) clearTimeout(reloadTimer);
      void supabase.removeChannel(channel);
    };
  }, []);

  return { positions, isLoading, error };
}
