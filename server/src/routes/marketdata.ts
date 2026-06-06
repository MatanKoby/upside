import { Router, type Request, type Response } from 'express';
import { ibSnapshot, ibHistory, ibStatus } from '../services/ibGateway.js';
import { ibHistoryToBundle } from '../services/ibMappers.js';
import { getQuote, basicFinancials, type FinnhubMetrics } from '../services/finnhub.js';
import {
  get as redisGet,
  setWithTtl,
  marketIntradayKey,
  marketFundamentalsKey,
} from '../services/redis.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { atr } from '../services/technicals.js';
import { loadDailyBars } from '../services/dailyBars.js';
import type { RawIbSnapshot } from '../types/index.js';

const router = Router();
router.use(requireAuth);

// FE timeframe label → IB (period, bar) tuple. Mirrors the timeframes in
// client/src/components/TickerDetail/TimeframeBar.tsx.
const TIMEFRAME_MAP: Record<string, { period: string; bar: string }> = {
  '30m':  { period: '1h',  bar: '1min'  },
  '2h':   { period: '2h',  bar: '5mins' },
  '1D':   { period: '1d',  bar: '5mins' },
  '2D':   { period: '2d',  bar: '15mins'},
  '1W':   { period: '1w',  bar: '1h'    },
  '1M':   { period: '1m',  bar: '1d'    },
  '3M':   { period: '3m',  bar: '1d'    },
  '1Y':   { period: '1y',  bar: '1d'    },
  '5Y':   { period: '5y',  bar: '1w'    },
  'All':  { period: 'max', bar: '1m'    },
};

// Sparkline default: 7 daily bars.
const SPARKLINE_PERIOD = '7d';
const SPARKLINE_BAR = '1d';

async function resolveConid(userId: string, symbol: string): Promise<number | null> {
  // MVP: only held symbols are charteable. Lookup conid from positions table.
  const { data, error } = await supabase()
    .from('positions')
    .select('conid')
    .eq('user_id', userId)
    .eq('symbol', symbol)
    .maybeSingle();
  if (error || !data?.conid) return null;
  return Number(data.conid);
}

router.get('/history/:symbol', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const symbol = req.params.symbol?.toUpperCase();
  const timeframe = (req.query.timeframe as string | undefined) ?? '1D';
  if (!symbol) {
    res.status(400).json({ error: 'symbol required' });
    return;
  }
  const conid = await resolveConid(req.user.id, symbol);
  if (!conid) {
    res.status(404).json({ error: 'symbol_not_held', symbol });
    return;
  }
  const mapping = TIMEFRAME_MAP[timeframe];
  if (!mapping) {
    res.status(400).json({ error: 'unknown_timeframe', timeframe, supported: Object.keys(TIMEFRAME_MAP) });
    return;
  }
  const raw = await ibHistory(conid, mapping.period, mapping.bar);
  if (!raw) {
    res.status(502).json({ error: 'ib_history_failed', symbol, timeframe });
    return;
  }
  const bundle = ibHistoryToBundle(raw);
  res.json(bundle);
});

// GET /api/marketdata/sparkline/:symbol — 7 daily closes for a held symbol.
// Returns simple { closes: number[] } for the Sparkline component.
//
// Reads the daily_bars SSOT first (Polygon-primary, weekend-safe — Batch X4);
// falls back to a live IB history pull for held names outside the universe (no
// daily_bars row) or before the first producer run.
router.get('/sparkline/:symbol', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const symbol = req.params.symbol?.toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol required' });
    return;
  }
  const conid = await resolveConid(req.user.id, symbol);
  if (!conid) {
    res.status(404).json({ error: 'symbol_not_held', symbol });
    return;
  }
  const bars = await loadDailyBars(conid, 7);
  if (bars.length >= 1) {
    res.json({ closes: bars.map((b) => b.c) });
    return;
  }
  const raw = await ibHistory(conid, SPARKLINE_PERIOD, SPARKLINE_BAR);
  if (!raw || !Array.isArray(raw.data)) {
    res.status(502).json({ error: 'ib_history_failed', symbol });
    return;
  }
  res.json({ closes: raw.data.map((b) => b.c) });
});

// ---------------------------------------------------------------------------
// Market snapshot — Today's Range + Market Stats data for TickerDetail.
//
// Two-tier cache so opening tickers doesn't hammer Finnhub's free tier:
//   • Intraday (day high/low, open, prior close, last, volume): IB snapshot
//     when IB is connected, Finnhub /quote ONLY as the fallback when IB is off.
//     60s TTL. When IB is up, this path makes zero Finnhub calls.
//   • Fundamentals (52-week range, P/E, EPS, beta, market cap, avg vol,
//     dividend): Finnhub /stock/metric, but cached 6h — these don't change
//     intraday, so one call per symbol covers a whole session of opens.
// (Why Finnhub for fundamentals, not IB: see finnhub.ts:basicFinancials.)
// ---------------------------------------------------------------------------
const INTRADAY_TTL_S = 60;
const FUNDAMENTALS_TTL_S = 6 * 60 * 60; // 6h — fundamentals are daily-grain

export interface MarketSnapshot {
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
    // Volatility — added 2026-05-30. ATR is the right "how much does this stock
    // swing intraday" metric (beta is correlation-to-market, not vol). Computed
    // from IB daily history; null when IB is disconnected (no Finnhub free
    // candles, so no fallback). See `signals/screener-universe.md` for the
    // scalpable-sessions definition.
    atrPctOfPrice: number | null;     // ATR(14) / last close × 100 — e.g. 5.2 means typical day moves 5.2% of price
    atrDollar: number | null;         // ATR(14) in absolute dollars — e.g. 0.42
    scalpableSessions30d: number | null;  // count of last 30 sessions with intraday range ≥ 3%
    scalpableTotalSessions: number | null; // denominator (≤ 30 when fewer bars returned)
  };
}

// IB snapshot values arrive as strings, sometimes with a leading marker (e.g.
// "C140.40" when the field reflects prior close because the market is closed)
// or an abbreviated magnitude suffix on volume ("3.1M"). Parse leniently.
function parseAbbrev(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/[$,]/g, '').replace(/^[^0-9.+-]+/, '');
  const m = /^([+-]?[0-9]*\.?[0-9]+)\s*([KMBT])?$/i.exec(s);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  if (m[2]) n *= mult[m[2].toUpperCase()] ?? 1;
  return n;
}

// First finite value among the candidate keys (Finnhub metric names vary by
// symbol — peTTM vs peBasicExclExtraTTM, epsTTM vs epsBasicExclExtraItemsTTM…).
function pickMetric(metric: FinnhubMetrics | null, keys: string[]): number | null {
  if (!metric) return null;
  for (const k of keys) {
    const n = parseAbbrev(metric[k]);
    if (n != null) return n;
  }
  return null;
}

interface Intraday {
  source: 'ib' | 'finnhub' | 'mixed' | 'none';
  last: number | null;
  open: number | null;
  prevClose: number | null;
  dayLow: number | null;
  dayHigh: number | null;
  volume: number | null;
}

// Both IB (closed-market snapshots) and Finnhub (unknown symbols) report 0 for
// fields they don't have. 0 is never a real price → treat it as "unknown" so we
// render "—" / fall back rather than showing a bogus $0.00.
const nz = (v: number | null): number | null => (v === 0 ? null : v);

// IB CP field 87 (volume) carries a wrong magnitude suffix: a live capture of
// BBAI returned "87":"65595.7B" / "87_raw":65595700000000 (6.56e13) when the
// real volume was ~65.6M — the mantissa 65595.7 is correct but tagged "B"
// (billion) where it should be "K" (thousand), inflating it by exactly 1e6.
// So when the parsed value is implausibly large (no US single name trades near
// 20B shares/day), undo that 1e6 inflation and surface the real number. We
// never blank a value IB actually gave us — the only "—" is genuinely-absent
// volume (null), e.g. market closed with no field 87 in the snapshot.
const VOLUME_SANITY_CAP = 2e10;
const IB_VOLUME_INFLATION = 1e6;
const saneVolume = (v: number | null): number | null => {
  if (v == null) return null;
  return v > VOLUME_SANITY_CAP ? Math.round(v / IB_VOLUME_INFLATION) : v;
};

// Intraday tier: IB snapshot when the session is live; fall back to a Finnhub
// /quote when IB is off OR when IB's snapshot is incomplete (a closed market
// returns 0s for open/prevClose/etc., which Finnhub still has). 60s cache so
// repeat opens (and the always-running screen) don't re-hit either source.
async function getIntraday(userId: string, symbol: string): Promise<Intraday> {
  const key = marketIntradayKey(symbol);
  try {
    const cached = await redisGet(key);
    if (cached) return JSON.parse(cached) as Intraday;
  } catch {
    // Redis down → compute fresh.
  }

  const conid = await resolveConid(userId, symbol);
  let ibRow: RawIbSnapshot | undefined;
  if (conid) {
    const { authenticated, connected } = await ibStatus().catch(() => ({
      authenticated: false,
      connected: false,
    }));
    if (authenticated && connected) {
      const snap = await ibSnapshot([conid]).catch(() => [] as RawIbSnapshot[]);
      ibRow = snap[0];
    }
  }

  const result: Intraday = {
    source: 'none',
    last: nz(parseAbbrev(ibRow?.['31'])),
    dayHigh: nz(parseAbbrev(ibRow?.['70'])),
    dayLow: nz(parseAbbrev(ibRow?.['71'])),
    open: nz(parseAbbrev(ibRow?.['7295'])),
    prevClose: nz(parseAbbrev(ibRow?.['7296'])),
    volume: saneVolume(nz(parseAbbrev(ibRow?.['87']))),
  };
  const ibContributed = result.last != null || result.dayHigh != null;

  // Fill any gaps from Finnhub. When IB is fully populated (market open) there
  // are no gaps → no Finnhub call. A closed/empty IB snapshot leaves gaps →
  // one cached /quote fills open/prevClose/range. Finnhub free /quote has no
  // volume field, so volume stays IB-only.
  const missing =
    result.last == null ||
    result.dayHigh == null ||
    result.dayLow == null ||
    result.open == null ||
    result.prevClose == null;
  let fhContributed = false;
  if (missing) {
    const quote = await getQuote(symbol).catch(() => null);
    if (quote) {
      const before = { ...result };
      result.last ??= nz(quote.c ?? null);
      result.dayHigh ??= nz(quote.h ?? null);
      result.dayLow ??= nz(quote.l ?? null);
      result.open ??= nz(quote.o ?? null);
      result.prevClose ??= nz(quote.pc ?? null);
      fhContributed =
        result.last !== before.last ||
        result.dayHigh !== before.dayHigh ||
        result.dayLow !== before.dayLow ||
        result.open !== before.open ||
        result.prevClose !== before.prevClose;
    }
  }

  result.source =
    ibContributed && fhContributed
      ? 'mixed'
      : ibContributed
        ? 'ib'
        : fhContributed
          ? 'finnhub'
          : 'none';

  void setWithTtl(key, JSON.stringify(result), INTRADAY_TTL_S).catch(() => undefined);
  return result;
}

interface Volatility {
  atrPctOfPrice: number | null;
  atrDollar: number | null;
  scalpableSessions30d: number | null;
  scalpableTotalSessions: number | null;
}
const EMPTY_VOL: Volatility = {
  atrPctOfPrice: null,
  atrDollar: null,
  scalpableSessions30d: null,
  scalpableTotalSessions: null,
};

// Volatility tier: ATR(14) + last-30-sessions scalpability from IB daily bars.
// Cached 6h (daily-grain). When IB is off, no Finnhub candle fallback (paid
// tier only), so we surface null and the FE renders "—".
async function getVolatility(userId: string, symbol: string): Promise<Volatility> {
  const key = `mkt:vol:${symbol}`;
  try {
    const cached = await redisGet(key);
    if (cached) return JSON.parse(cached) as Volatility;
  } catch {
    // Redis down → compute fresh.
  }

  const conid = await resolveConid(userId, symbol);
  if (!conid) return EMPTY_VOL;

  const { authenticated, connected } = await ibStatus().catch(() => ({
    authenticated: false,
    connected: false,
  }));
  if (!authenticated || !connected) return EMPTY_VOL;

  const hist = await ibHistory(conid, '1y', '1d').catch(() => null);
  const bars = hist?.data ?? [];
  if (bars.length < 15) return EMPTY_VOL;

  // Use the last 30 daily bars for both ATR(14) and scalpable-session count.
  // ATR(14) needs 15 bars minimum; 30 gives a stable reading and matches the
  // scalpable denominator.
  const recent = bars.slice(-30);
  const barsForAtr = {
    o: recent.map((b) => b.o),
    h: recent.map((b) => b.h),
    l: recent.map((b) => b.l),
    c: recent.map((b) => b.c),
    v: recent.map((b) => b.v),
  };
  const atrAbs = atr(barsForAtr, 14);
  const lastClose = recent[recent.length - 1]?.c ?? null;
  const atrPct =
    atrAbs != null && lastClose != null && lastClose > 0 ? (atrAbs / lastClose) * 100 : null;

  // Scalpable session = intraday range ≥ 3% of the open (matches the screener
  // `intraday_range_trader` trait threshold, so this number is "how often does
  // this stock meet the screener's range bar").
  const scalpable = recent.filter((b) => b.o > 0 && (b.h - b.l) / b.o >= 0.03).length;

  const result: Volatility = {
    atrPctOfPrice: atrPct,
    atrDollar: atrAbs,
    scalpableSessions30d: scalpable,
    scalpableTotalSessions: recent.length,
  };
  void setWithTtl(key, JSON.stringify(result), FUNDAMENTALS_TTL_S).catch(() => undefined);
  return result;
}

// Fundamentals tier: Finnhub /stock/metric, cached 6h (daily-grain data).
async function getFundamentals(symbol: string): Promise<FinnhubMetrics | null> {
  const key = marketFundamentalsKey(symbol);
  try {
    const cached = await redisGet(key);
    if (cached) return JSON.parse(cached) as FinnhubMetrics;
  } catch {
    // Redis down → compute fresh.
  }
  const metric = await basicFinancials(symbol).catch(() => null);
  if (metric) void setWithTtl(key, JSON.stringify(metric), FUNDAMENTALS_TTL_S).catch(() => undefined);
  return metric;
}

router.get('/snapshot/:symbol', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const symbol = req.params.symbol?.toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol required' });
    return;
  }

  const [intraday, metric, volatility] = await Promise.all([
    getIntraday(req.user.id, symbol),
    getFundamentals(symbol),
    getVolatility(req.user.id, symbol),
  ]);

  // marketCap + avg-vol arrive from Finnhub in millions.
  const marketCapM = pickMetric(metric, ['marketCapitalization']);
  const avgVolM = pickMetric(metric, ['10DayAverageTradingVolume', '3MonthAverageTradingVolume']);

  const ibUsed = intraday.source === 'ib' || intraday.source === 'mixed';
  const fhUsed = intraday.source === 'finnhub' || intraday.source === 'mixed' || metric != null;
  const snapshot: MarketSnapshot = {
    symbol,
    source: ibUsed && fhUsed ? 'mixed' : ibUsed ? 'ib' : fhUsed ? 'finnhub' : 'none',
    last: intraday.last,
    open: intraday.open,
    prevClose: intraday.prevClose,
    dayLow: intraday.dayLow,
    dayHigh: intraday.dayHigh,
    week52High: pickMetric(metric, ['52WeekHigh']),
    week52Low: pickMetric(metric, ['52WeekLow']),
    stats: {
      volume: intraday.volume,
      peRatio: pickMetric(metric, ['peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM']),
      eps: pickMetric(metric, ['epsTTM', 'epsBasicExclExtraItemsTTM', 'epsInclExtraItemsTTM']),
      marketCap: marketCapM == null ? null : marketCapM * 1e6,
      beta: pickMetric(metric, ['beta']),
      avgVol30d: avgVolM == null ? null : avgVolM * 1e6,
      dividend: pickMetric(metric, ['dividendPerShareTTM', 'dividendPerShareAnnual']),
      atrPctOfPrice: volatility.atrPctOfPrice,
      atrDollar: volatility.atrDollar,
      scalpableSessions30d: volatility.scalpableSessions30d,
      scalpableTotalSessions: volatility.scalpableTotalSessions,
    },
  };

  res.json(snapshot);
});

export default router;
