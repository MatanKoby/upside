import { Router, type Request, type Response } from 'express';
import { ibSnapshot, ibHistory, ibStatus } from '../services/ibGateway.js';
import { ibHistoryToBundle } from '../services/ibMappers.js';
import { getQuote, basicFinancials, type FinnhubMetrics } from '../services/finnhub.js';
import { get as redisGet, setWithTtl, marketSnapshotKey } from '../services/redis.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
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
// Intraday fields (day high/low, open, prior close, last, volume): IB snapshot
// when IB is connected, Finnhub /quote otherwise. Fundamentals (52-week range,
// P/E, EPS, beta, market cap, avg vol, dividend): Finnhub /stock/metric always
// (see finnhub.ts:basicFinancials for why not IB). Short Redis cache per symbol.
// ---------------------------------------------------------------------------
const SNAPSHOT_CACHE_TTL_S = 45;

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

  // Cache hit — return the shared per-symbol snapshot.
  const cacheKey = marketSnapshotKey(symbol);
  try {
    const cached = await redisGet(cacheKey);
    if (cached) {
      res.json(JSON.parse(cached) as MarketSnapshot);
      return;
    }
  } catch {
    // Redis unavailable → just compute fresh.
  }

  // Intraday fields prefer IB when its session is live; skip the (up to 2s)
  // IB snapshot poll entirely when IB is disconnected to keep the route snappy.
  const conid = await resolveConid(req.user.id, symbol);
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

  // Finnhub quote + fundamentals in parallel — the reliable, IB-independent base.
  const [quote, metric] = await Promise.all([
    getQuote(symbol).catch(() => null),
    basicFinancials(symbol).catch(() => null),
  ]);

  // Intraday: IB value if present, else Finnhub quote (0 from Finnhub means
  // "unknown" — treat as null).
  const fq = (v: number | null | undefined): number | null =>
    v == null || v === 0 ? null : v;
  const last = parseAbbrev(ibRow?.['31']) ?? fq(quote?.c);
  const dayHigh = parseAbbrev(ibRow?.['70']) ?? fq(quote?.h);
  const dayLow = parseAbbrev(ibRow?.['71']) ?? fq(quote?.l);
  const open = parseAbbrev(ibRow?.['7295']) ?? fq(quote?.o);
  const prevClose = parseAbbrev(ibRow?.['7296']) ?? fq(quote?.pc);
  const volume = parseAbbrev(ibRow?.['87']); // not on Finnhub free /quote

  // Fundamentals — Finnhub only. marketCap + avg-vol come in millions.
  const marketCapM = pickMetric(metric, ['marketCapitalization']);
  const avgVolM = pickMetric(metric, [
    '10DayAverageTradingVolume',
    '3MonthAverageTradingVolume',
  ]);

  const ibUsed = parseAbbrev(ibRow?.['31']) != null || parseAbbrev(ibRow?.['70']) != null;
  const fhUsed = quote != null || metric != null;

  const snapshot: MarketSnapshot = {
    symbol,
    source: ibUsed && fhUsed ? 'mixed' : ibUsed ? 'ib' : fhUsed ? 'finnhub' : 'none',
    last,
    open,
    prevClose,
    dayLow,
    dayHigh,
    week52High: pickMetric(metric, ['52WeekHigh']),
    week52Low: pickMetric(metric, ['52WeekLow']),
    stats: {
      volume,
      peRatio: pickMetric(metric, ['peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM']),
      eps: pickMetric(metric, ['epsTTM', 'epsBasicExclExtraItemsTTM', 'epsInclExtraItemsTTM']),
      marketCap: marketCapM == null ? null : marketCapM * 1e6,
      beta: pickMetric(metric, ['beta']),
      avgVol30d: avgVolM == null ? null : avgVolM * 1e6,
      dividend: pickMetric(metric, ['dividendPerShareTTM', 'dividendPerShareAnnual']),
    },
  };

  // Cache even 'none' results briefly so a bad symbol / both-sources-down
  // doesn't get hammered. Fire-and-forget.
  void setWithTtl(cacheKey, JSON.stringify(snapshot), SNAPSHOT_CACHE_TTL_S).catch(
    () => undefined,
  );

  res.json(snapshot);
});

export default router;
