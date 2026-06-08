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

// Price SSOT (Batch X5): positions holds holding facts only; price + P&L come
// from `quotes.canonical_price` × shares, computed here.
interface DbPosition {
  conid: number | null;
  symbol: string;
  company_name: string | null;
  shares: number | string;
  avg_cost: number | string;
  trading_days_held: number | string | null;
  first_seen_source: string | null;
  first_seen_at: string | null;
}

interface QuoteRow {
  canonical_price: number | string | null;
  today_change_pct: number | string | null;
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

function rowToTickerDetail(r: DbPosition, q: QuoteRow | undefined, totalPortfolioValue: number): TickerDetailData {
  const shares = num(r.shares);
  const avgCost = num(r.avg_cost);
  const price = num(q?.canonical_price);
  const pct = num(q?.today_change_pct);
  const marketValue = price * shares;
  const costBasis = avgCost * shares;
  const unrealizedPnL = price > 0 ? marketValue - costBasis : 0;
  const unrealizedPnLPercent = price > 0 && costBasis !== 0 ? (unrealizedPnL / costBasis) * 100 : 0;
  const weightPct = totalPortfolioValue > 0 ? (marketValue / totalPortfolioValue) * 100 : 0;
  // contribution = position P&L% weighted by portfolio share (weight in [0,1]).
  const contributionPct = unrealizedPnLPercent * (weightPct / 100);
  // Per-share $ change derived from the % (prevClose = price / (1 + pct/100)).
  const todayChange = price > 0 && pct !== 0 ? price - price / (1 + pct / 100) : 0;
  const daysHeld = num(r.trading_days_held);

  return {
    conid: r.conid ?? null,
    symbol: r.symbol,
    company: r.company_name ?? r.symbol,
    price,
    todayChange,
    todayChangePercent: pct,
    // Base values — the snapshot fetch (below) merges real day range +
    // Market Stats over these once it resolves.
    dayLow: 0,
    dayHigh: 0,
    currentInRange: 0,
    marketStats: [],
    signal: null,
    positionStats: {
      shares,
      avgCost,
      marketValue,
      unrealizedPnL,
      unrealizedPnLPercent,
      dayPnL: shares * todayChange,
      dayPnLPercent: pct,
      portfolioWeightPercent: weightPct,
      contributionPercent: contributionPct,
      daysHeld,
      daysHeldSource: r.first_seen_source === 'ib_transactions' ? 'ib_transactions' : 'observed',
      dailyReturnPercent: daysHeld > 0 ? unrealizedPnLPercent / daysHeld : null,
      entryDate: r.first_seen_at,
    },
    indicators: [],
  };
}

export type UseTickerDetailResult =
  | { state: 'loading' }
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
      // Canonical price per held conid from `quotes` (price SSOT, Batch X5),
      // for both this ticker's P&L and the portfolio total (weight calc).
      const conids = rows.map((r) => Number(r.conid)).filter((c) => Number.isFinite(c));
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
      const total = rows.reduce(
        (acc, r) => acc + num(quoteByConid.get(Number(r.conid))?.canonical_price) * num(r.shares),
        0,
      );
      const target = symbol ? rows.find((r) => r.symbol.toUpperCase() === symbol.toUpperCase()) : undefined;
      if (target) {
        setResult({ state: 'loaded', detail: rowToTickerDetail(target, quoteByConid.get(Number(target.conid)), total) });
        return;
      }

      // Not held — TickerDetail still opens for ANY ticker (watchlist, virtual
      // curated, or just searched). Resolve the conid + price from `quotes` by
      // symbol (the price SSOT; held / watchlist / curated names all have a row,
      // curated via the daily seed). Day range + Market Stats come from the
      // /snapshot fetch (works for any symbol), so even a name with no quote row
      // yet renders — positionStats stays null and TickerDetail hides that
      // section. We never block the screen on "not held".
      const sym = symbol!.toUpperCase();
      const { data: qrows } = await supabase
        .from('quotes')
        .select('conid, symbol, canonical_price')
        .eq('symbol', sym)
        .order('canonical_updated_at', { ascending: false })
        .limit(1);
      let conid: number | null = null;
      let price = 0;
      if (qrows && qrows.length > 0) {
        conid = num((qrows[0] as { conid: number | string | null }).conid) || null;
        price = num((qrows[0] as { canonical_price: number | string | null }).canonical_price);
      } else {
        // No quote row yet — resolve a conid from watchlist_items so the screen
        // still opens; price falls back to the snapshot's last (merged below).
        const wl = await supabase
          .from('watchlist_items')
          .select('conid')
          .eq('symbol', sym)
          .limit(1)
          .maybeSingle();
        if (wl.data) conid = num(wl.data.conid) || null;
      }
      if (!alive) return;
      setResult({
        state: 'loaded',
        detail: {
          conid,
          symbol: sym,
          company: sym,                   // no company name off-position yet
          price,
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
  // For an off-position name with no quote row, the headline price falls back to
  // the snapshot's last so the screen isn't priced at 0.
  const price = detail.price > 0 ? detail.price : num(snapshot.last);
  return {
    state: 'loaded',
    detail: {
      ...detail,
      price,
      dayLow: snapshot.dayLow ?? 0,
      dayHigh: snapshot.dayHigh ?? 0,
      currentInRange: ratioInRange(price, snapshot.dayLow, snapshot.dayHigh),
      marketStats: stats,
    },
  };
}
