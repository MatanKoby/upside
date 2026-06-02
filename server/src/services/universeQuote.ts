// Universe price + volume coverage (Batch S0.5).
//
// Spec: spec/signals/data-sources.md → Universe coverage.
//
// Primary: Polygon `/v2/aggs/grouped/locale/us/market/stocks/{date}` — one
// call returns ALL US stocks' OHLCV for one day. Fits comfortably in the
// 5-cpm free-tier rate.
//
// Fallback: Yahoo `query1.finance.yahoo.com/v8/finance/chart/{symbol}` —
// per-symbol, keyless, full OHLCV. Used by the producer to gap-fill
// tickers Polygon's grouped response doesn't include (IPOs, halted,
// special situations).

import axios from 'axios';
import { env } from '../env.js';

export interface DailyOhlcv {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const POLYGON_BASE = 'https://api.polygon.io';
const YAHOO_BASE = 'https://query1.finance.yahoo.com';

// Polygon's grouped-daily-bars response shape (the fields we care about):
//   results: [{ T: 'AAPL', v: 12345, o, h, l, c, t: <ms>, vw, n }, …]
// Symbol is in `T` (ticker), volume in `v`, OHLC as named.
interface PolygonGroupedResult {
  T: string;        // ticker
  v: number;        // volume
  vw?: number;      // VWAP (ignored)
  o: number;        // open
  h: number;        // high
  l: number;        // low
  c: number;        // close
  t?: number;       // timestamp ms (ignored)
  n?: number;       // num transactions (ignored)
}

interface PolygonGroupedResponse {
  status?: string;          // 'OK' on success, 'NOT_AUTHORIZED' / 'ERROR' on failure
  resultsCount?: number;
  results?: PolygonGroupedResult[];
  error?: string;
}

/**
 * Pull the entire US stock universe's OHLCV for a given trading date.
 * Returns a map keyed by **symbol** (Polygon's `T` field, which is the
 * ticker). Callers join to `universe` rows by symbol.
 *
 * `date` should be a calendar date in `YYYY-MM-DD` form. Polygon may
 * return an empty `results` array for non-trading days (weekends,
 * holidays) — caller decides how to handle that (probably "use the
 * previous trading day's data" or skip the producer cycle).
 *
 * Throws on auth / network errors so the producer can log + skip.
 */
export async function polygonGroupedDaily(
  date: string,
): Promise<Record<string, DailyOhlcv>> {
  if (!env.polygonApiKey) {
    throw new Error('POLYGON_API_KEY not configured');
  }
  const url = `${POLYGON_BASE}/v2/aggs/grouped/locale/us/market/stocks/${date}`;
  const res = await axios.get<PolygonGroupedResponse>(url, {
    params: { adjusted: 'true', apiKey: env.polygonApiKey },
    timeout: 30_000,
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    throw new Error(`Polygon grouped-daily ${date} HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const body = res.data;
  if (body.status && body.status !== 'OK' && body.status !== 'DELAYED') {
    throw new Error(`Polygon grouped-daily ${date} status=${body.status}: ${body.error ?? '(no error msg)'}`);
  }
  const out: Record<string, DailyOhlcv> = {};
  for (const r of body.results ?? []) {
    if (!r.T) continue;
    out[r.T] = {
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v,
    };
  }
  return out;
}

// Yahoo v8/chart response shape (only the fields we use):
//   chart.result[0].meta.regularMarketPrice / regularMarketVolume / etc.
interface YahooChartMeta {
  regularMarketPrice?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  previousClose?: number;
  chartPreviousClose?: number;
}

interface YahooChartResult {
  meta?: YahooChartMeta;
}

interface YahooChartResponse {
  chart?: {
    result?: YahooChartResult[];
    error?: { code?: string; description?: string } | null;
  };
}

/**
 * Per-symbol gap-fill via Yahoo's v8/chart endpoint. Keyless. Caller-side
 * rate-limited (the universe producer's gap list is typically tens per day,
 * not thousands, so simple sequential calls are fine).
 *
 * Returns null when the symbol isn't found or required fields are missing.
 * Note Yahoo lacks a true "today's open" alongside last; we synthesize
 * `open` from the `regularMarketOpen` field when present, else default to
 * `previousClose` so the OHLCV shape is filled but signals "previous close
 * is the only anchor" to the caller.
 */
export async function yahooChart(symbol: string): Promise<DailyOhlcv | null> {
  const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const res = await axios.get<YahooChartResponse>(url, {
    params: { range: '1d', interval: '1m' },
    headers: { 'User-Agent': 'Mozilla/5.0 (upside-screener)' },
    timeout: 15_000,
    validateStatus: () => true,
  });
  if (res.status !== 200) return null;
  const meta = res.data.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const close = meta.regularMarketPrice;
  const high = meta.regularMarketDayHigh;
  const low = meta.regularMarketDayLow;
  const volume = meta.regularMarketVolume;
  const open = meta.previousClose ?? meta.chartPreviousClose ?? close;
  if (close == null || high == null || low == null || volume == null || open == null) {
    return null;
  }
  return { open, high, low, close, volume };
}
