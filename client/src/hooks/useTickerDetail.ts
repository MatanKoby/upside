import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';
import type { TickerDetailData } from '../types';

// Loads a position from Supabase by user_id + symbol and maps it into the
// TickerDetailData shape the TickerDetail screen consumes. Fields not yet
// produced by the backend (day high/low, market stats, indicators, signal)
// are returned as empty / placeholder values — later batches fill them in:
//   - signal: Batch 14a (signal engine)
//   - indicators: Batch 14a (computed in signalEngine)
//   - dayLow/High/Market stats: when /api/marketdata/snapshot lands
//   - positionStats.daysHeld: Batch 13.5

interface DbPosition {
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
  portfolio_weight: number | string | null;
  portfolio_contribution: number | string | null;
  trading_days_held: number | string | null;
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

function rowToTickerDetail(r: DbPosition, totalPortfolioValue: number): TickerDetailData {
  const marketValue = num(r.market_value);
  const portfolioWeightFromRow = num(r.portfolio_weight);
  // `portfolio_weight` on the row is in [0, 1] (pricePoller writes it that
  // way). Surface as a percent for the UI.
  const weightPct =
    portfolioWeightFromRow > 0
      ? portfolioWeightFromRow * 100
      : totalPortfolioValue > 0
        ? (marketValue / totalPortfolioValue) * 100
        : 0;
  const contributionPct = num(r.portfolio_contribution) * 100;

  return {
    symbol: r.symbol,
    company: r.company_name ?? r.symbol,
    price: num(r.current_price),
    todayChange: num(r.today_change),
    todayChangePercent: num(r.today_change_pct),
    // Day high/low + intraday range come from IB market snapshot once we
    // expose a /api/marketdata/snapshot endpoint. Empty for now.
    dayLow: 0,
    dayHigh: 0,
    currentInRange: 0,
    marketStats: [],
    signal: null,
    positionStats: {
      shares: num(r.shares),
      avgCost: num(r.avg_cost),
      marketValue,
      unrealizedPnL: num(r.unrealized_pnl),
      unrealizedPnLPercent: num(r.unrealized_pnl_pct),
      // dayPnL is technically num(shares * todayChange); todayChange in our
      // schema is *per-share* delta. Compute both for consistency with mock.
      dayPnL: num(r.shares) * num(r.today_change),
      dayPnLPercent: num(r.today_change_pct),
      portfolioWeightPercent: weightPct,
      contributionPercent: contributionPct,
      daysHeld: num(r.trading_days_held),
    },
    indicators: [],
  };
}

export type UseTickerDetailResult =
  | { state: 'loading' }
  | { state: 'not-held'; symbol: string }
  | { state: 'loaded'; detail: TickerDetailData }
  | { state: 'error'; error: string };

export function useTickerDetail(symbol: string | undefined): UseTickerDetailResult {
  const [result, setResult] = useState<UseTickerDetailResult>({ state: 'loading' });

  useEffect(() => {
    if (!symbol) {
      setResult({ state: 'error', error: 'no symbol' });
      return;
    }

    let alive = true;

    async function load() {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) {
        if (alive) setResult({ state: 'error', error: 'not signed in' });
        return;
      }

      // We need total portfolio value to compute the weight percent — pull
      // the full positions list in one query (small) and find ours.
      const { data, error } = await supabase
        .from('positions')
        .select('*')
        .eq('user_id', userId);

      if (!alive) return;
      if (error) {
        setResult({ state: 'error', error: error.message });
        return;
      }

      const rows = (data ?? []) as DbPosition[];
      const total = rows.reduce((acc, r) => acc + num(r.market_value), 0);
      const target = symbol ? rows.find((r) => r.symbol.toUpperCase() === symbol.toUpperCase()) : undefined;
      if (!target) {
        setResult({ state: 'not-held', symbol: symbol! });
        return;
      }
      setResult({ state: 'loaded', detail: rowToTickerDetail(target, total) });
    }

    void load();

    // Realtime: re-fetch on any change to the user's positions. Simple
    // re-pull pattern, matching usePositions.
    const channel = supabase
      .channel(`ticker-detail-${symbol}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'positions' },
        () => void load(),
      )
      .subscribe();

    return () => {
      alive = false;
      void supabase.removeChannel(channel);
    };
  }, [symbol]);

  return result;
}
