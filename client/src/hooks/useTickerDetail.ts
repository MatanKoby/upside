import { useEffect, useMemo, useState } from 'react';
import { apiFetch, supabase } from '../services/supabase';
import { formatCompact, formatCompactCurrency, formatCurrency } from '../utils/formatters';
import type { MarketStat, TickerDetailData } from '../types';

// Loads a position from Supabase by user_id + symbol and maps it into the
// TickerDetailData shape the TickerDetail screen consumes. Fields not yet
// produced by the backend (indicators, signal) are returned as empty /
// placeholder values — later batches fill them in:
//   - signal: Batch 14a (signal engine)
//   - indicators: Batch 14a (computed in signalEngine)
// Day high/low + Market Stats come from GET /api/marketdata/snapshot/:symbol
// (Batch 14e), fetched separately and merged below.

// Mirrors the server's MarketSnapshot (server/src/routes/marketdata.ts).
interface MarketSnapshot {
  symbol: string;
  source: 'ib' | 'finnhub' | 'mixed' | 'none';
  last: number | null;
  open: number | null;
  prevClose: number | null;
  dayLow: number | null;
  dayHigh: number | null;
  week52High: number | null;
  week52Low: number | null;
  stats: {
    volume: number | null;
    peRatio: number | null;
    eps: number | null;
    marketCap: number | null;
    beta: number | null;
    avgVol30d: number | null;
    dividend: number | null;
    // Volatility (added 2026-05-30) — null when IB is disconnected.
    atrPctOfPrice: number | null;
    atrDollar: number | null;
    scalpableSessions30d: number | null;
    scalpableTotalSessions: number | null;
  };
}

const DASH = '—';

// Build the Market Stats pool from a snapshot. Default visible set + order
// mirror the spec (Row 1: Vol | P/E | Prev close | Beta — Row 2: Open | EPS |
// MktCap | AvgVol). `user_preferences.stat_config` persistence is Batch 15.
function buildMarketStats(snap: MarketSnapshot): MarketStat[] {
  const s = snap.stats;
  const cur = (v: number | null) => (v == null ? DASH : formatCurrency(v));
  const num = (v: number | null, d = 2) => (v == null ? DASH : v.toFixed(d));
  const cnt = (v: number | null) => (v == null ? DASH : formatCompact(v));
  // Compact "$3.01–$9.39" (no spaces) so it fits a 4-up grid cell.
  const range52 =
    snap.week52Low == null || snap.week52High == null
      ? DASH
      : `${formatCurrency(snap.week52Low)}–${formatCurrency(snap.week52High)}`;

  // Volatility cells — "5.2% · $0.42" format. Both halves carry meaning: the
  // % tells you "scalpable" (3%+ = real moves), the $ tells you absolute
  // tick magnitude (helpful for sizing limit orders). Hidden when ATR is
  // null (IB disconnected; no Finnhub free candle fallback).
  const atrCell =
    s.atrPctOfPrice == null || s.atrDollar == null
      ? DASH
      : `${s.atrPctOfPrice.toFixed(1)}% · ${formatCurrency(s.atrDollar)}`;
  // Range today — purely client-side from existing snapshot fields (no extra
  // call). Same dual format as ATR so they compare cleanly side-by-side.
  const rangeTodayCell = (() => {
    if (snap.dayLow == null || snap.dayHigh == null) return DASH;
    const range = snap.dayHigh - snap.dayLow;
    if (range <= 0) return DASH;
    const base = snap.open ?? snap.last ?? snap.prevClose;
    if (base == null || base <= 0) return formatCurrency(range);
    return `${((range / base) * 100).toFixed(1)}% · ${formatCurrency(range)}`;
  })();
  const scalpableCell =
    s.scalpableSessions30d == null || s.scalpableTotalSessions == null
      ? DASH
      : `${s.scalpableSessions30d}/${s.scalpableTotalSessions}` +
        (s.scalpableTotalSessions > 0
          ? `  (${Math.round((s.scalpableSessions30d / s.scalpableTotalSessions) * 100)}%)`
          : '');

  // Default-visible set, shown 4-per-row. Order puts the scalping-decision
  // metrics in prime real estate (ATR + Range today + Scalpable sessions on
  // top), with traditional fundamentals (P/E, EPS, beta) deeper in the grid.
  // Beta stays in the grid but no longer headlined as the volatility cell —
  // it measures correlation to the market, not intraday swing magnitude
  // (see `spec/signals/screener-universe.md` rationale).
  return [
    { key: 'atr', label: 'ATR (14d)', value: atrCell, enabled: true },
    { key: 'rangeToday', label: 'Range today', value: rangeTodayCell, enabled: true },
    { key: 'scalpableSessions', label: 'Scalpable sessions', value: scalpableCell, enabled: true },
    { key: 'range52w', label: '52w range', value: range52, enabled: true },
    { key: 'volume', label: 'Volume', value: cnt(s.volume), enabled: true },
    { key: 'avgVolume', label: 'Avg volume', value: cnt(s.avgVol30d), enabled: true },
    { key: 'marketCap', label: 'Market cap', value: s.marketCap == null ? DASH : formatCompactCurrency(s.marketCap), enabled: true },
    { key: 'priorClose', label: 'Prior close', value: cur(snap.prevClose), enabled: true },
    { key: 'open', label: 'Open', value: cur(snap.open), enabled: true },
    { key: 'fwdPE', label: 'P/E', value: num(s.peRatio, 1), enabled: true },
    { key: 'eps', label: 'EPS', value: cur(s.eps), enabled: true },
    { key: 'beta', label: 'Beta', value: num(s.beta, 2), enabled: true },
    { key: 'dividend', label: 'Dividend', value: cur(s.dividend), enabled: true },
    { key: 'putCall', label: 'Put/call', value: DASH, enabled: false },
    { key: 'tweetVolume', label: 'Tweet volume', value: DASH, enabled: false },
  ];
}

function ratioInRange(price: number, low: number | null, high: number | null): number {
  if (low == null || high == null || high <= low) return 0;
  return Math.max(0, Math.min(1, (price - low) / (high - low)));
}

interface DbPosition {
  conid: number | null;
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
  daily_return: number | string | null;
  first_seen_source: string | null;
  first_seen_at: string | null;
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
    conid: r.conid ?? null,
    symbol: r.symbol,
    company: r.company_name ?? r.symbol,
    price: num(r.current_price),
    todayChange: num(r.today_change),
    todayChangePercent: num(r.today_change_pct),
    // Base values — the snapshot fetch (below) merges real day range +
    // Market Stats over these once it resolves.
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
      daysHeldSource: r.first_seen_source === 'ib_transactions' ? 'ib_transactions' : 'observed',
      dailyReturnPercent: r.daily_return == null ? null : num(r.daily_return),
      entryDate: r.first_seen_at,
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
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);

  // Snapshot (day range + Market Stats) is symbol-keyed and independent of the
  // positions Realtime subscription, so fetch it in its own effect. The route
  // caches per-symbol (~45s), so reopening a ticker is cheap.
  useEffect(() => {
    setSnapshot(null);
    if (!symbol) return;
    let alive = true;
    apiFetch(`/api/marketdata/snapshot/${encodeURIComponent(symbol)}`)
      .then(async (res) => {
        if (!alive || !res.ok) return;
        setSnapshot((await res.json()) as MarketSnapshot);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [symbol]);

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
      if (target) {
        setResult({ state: 'loaded', detail: rowToTickerDetail(target, total) });
        return;
      }

      // Not held — fall back to the watchlist surface (Batch A1). Find the
      // conid via watchlist_items by symbol, then read the canonical price
      // from `quotes`. positionStats stays null; TickerDetail hides that
      // section when null.
      const sym = symbol!.toUpperCase();
      const wlItem = await supabase
        .from('watchlist_items')
        .select('conid, symbol')
        .eq('symbol', sym)
        .limit(1)
        .maybeSingle();
      if (!wlItem.data) {
        setResult({ state: 'not-held', symbol: sym });
        return;
      }
      const quote = await supabase
        .from('quotes')
        .select('canonical_price, canonical_source, canonical_updated_at')
        .eq('conid', wlItem.data.conid)
        .maybeSingle();
      setResult({
        state: 'loaded',
        detail: {
          conid: typeof wlItem.data.conid === 'number' ? wlItem.data.conid : Number(wlItem.data.conid),
          symbol: sym,
          company: sym,                   // no company name on watchlist_items yet
          price: num(quote.data?.canonical_price as number | null | undefined),
          todayChange: 0,
          todayChangePercent: 0,
          dayLow: 0,
          dayHigh: 0,
          currentInRange: 0,
          marketStats: [],
          signal: null,
          positionStats: null,            // hides Position Stats section
          indicators: [],
        },
      });
    }

    void load();

    // Realtime: re-fetch on any change to the user's positions OR the quotes
    // table (covers watchlist-only ticker price updates).
    const channel = supabase
      .channel(`ticker-detail-${symbol}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'positions' },
        () => void load(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'quotes' },
        () => void load(),
      )
      .subscribe();

    return () => {
      alive = false;
      void supabase.removeChannel(channel);
    };
  }, [symbol]);

  // Merge the snapshot over the position-derived detail. marketStats only
  // depends on the snapshot (not the live price), so it's stable across the
  // frequent positions re-renders; currentInRange uses the live price.
  const stats = useMemo(() => (snapshot ? buildMarketStats(snapshot) : []), [snapshot]);

  if (result.state !== 'loaded' || !snapshot) return result;
  const { detail } = result;
  return {
    state: 'loaded',
    detail: {
      ...detail,
      dayLow: snapshot.dayLow ?? 0,
      dayHigh: snapshot.dayHigh ?? 0,
      currentInRange: ratioInRange(detail.price, snapshot.dayLow, snapshot.dayHigh),
      marketStats: stats,
    },
  };
}
