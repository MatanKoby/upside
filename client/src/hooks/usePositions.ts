import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';
import type { Position } from '../types';

interface DbPosition {
  conid: number | null;
  account_id: string | null;
  symbol: string;
  company_name: string | null;
  shares: number | string;
  avg_cost: number | string;
  current_price: number | string | null;
  market_value: number | string | null;
  unrealized_pnl: number | string | null;
  unrealized_pnl_pct: number | string | null;
  today_change: number | string | null;
  today_change_pct: number | string | null;
  vwap_value: number | string | null;
  industry: string | null;
  category: string | null;
  zone_entered_at: string | null;
  entered_zone_via_gap: boolean | null;
}

function n(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

function rowToPosition(r: DbPosition): Position {
  return {
    symbol: r.symbol,
    name: r.company_name ?? r.symbol,
    shares: n(r.shares),
    avgCost: n(r.avg_cost),
    currentPrice: n(r.current_price),
    marketValue: n(r.market_value),
    unrealizedPnL: n(r.unrealized_pnl),
    unrealizedPnLPercent: n(r.unrealized_pnl_pct),
    todayChange: n(r.today_change),
    todayChangePercent: n(r.today_change_pct),
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
  const [positions, setPositions] = useState<Position[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

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
        .eq('user_id', userId)
        .order('market_value', { ascending: false });

      if (!alive) return;
      if (fetchError) {
        setError(fetchError.message);
        setIsLoading(false);
        return;
      }
      const rows = (data ?? []) as DbPosition[];
      setPositions(rows.map(rowToPosition));
      setIsLoading(false);
    }

    void loadInitial();

    const channel = supabase
      .channel('positions-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'positions' },
        () => {
          // Realtime fires per-row; simplest is to re-pull the whole set since
          // we want them sorted + de-duplicated anyway.
          void loadInitial();
        },
      )
      .subscribe();

    return () => {
      alive = false;
      void supabase.removeChannel(channel);
    };
  }, []);

  return { positions, isLoading, error };
}
