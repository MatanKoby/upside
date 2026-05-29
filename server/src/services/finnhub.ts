// Finnhub HTTP wrappers. Every outbound call routes through `finnhubQueue`
// for rate limiting and per-(category, key) min-interval enforcement, and
// every call is instrumented to `external_api_metrics` with `provider: 'finnhub'`.
//
// Per-category min-intervals default to 0s in Batch 13.7 (the queue acts as
// a pure rate limiter). Batch 13.9 will tune them based on real usage.

import axios, { type AxiosInstance } from 'axios';
import { env } from '../env.js';
import { supabase } from './supabase.js';
import { finnhubQueue } from './finnhubQueue.js';
import { notifyApiFailure } from './notify.js';

const BASE = 'https://finnhub.io/api/v1';

let _client: AxiosInstance | null = null;

function client(): AxiosInstance {
  if (!_client) {
    _client = axios.create({
      baseURL: BASE,
      params: { token: env.finnhubApiKey },
      timeout: 10_000,
      validateStatus: () => true,
    });
  }
  return _client;
}

// Records the call to external_api_metrics. Fire-and-forget — the audit row
// shouldn't fail the caller.
function recordMetric(
  category: string,
  durationMs: number,
  status: number,
  succeeded: boolean,
): void {
  void supabase()
    .from('external_api_metrics')
    .insert({
      provider: 'finnhub',
      endpoint: `finnhub:${category}`,
      conid: null,
      duration_ms: durationMs,
      retries: 0,
      status,
      succeeded,
    })
    .then(
      () => undefined,
      (err) => console.error('[external_api_metrics insert]', err?.message ?? err),
    );
}

// Wraps a single Finnhub call with the queue and audit insert.
async function call<T>(
  category: string,
  key: string,
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<{ status: number; data: T | null }> {
  return finnhubQueue.request(category, key, async () => {
    const start = performance.now();
    const res = await client().get<T>(path, { params });
    const durationMs = Math.round(performance.now() - start);
    const succeeded = res.status >= 200 && res.status < 300;
    recordMetric(category, durationMs, res.status, succeeded);
    // Same Discord policy as IB calls — real API errors surface, expected
    // churn (429 etc.) is suppressed. Keyed per category, rate-limited.
    notifyApiFailure(`finnhub_api.${category}`, res.status, {
      params,
      body: succeeded ? undefined : res.data,
    });
    return { status: res.status, data: succeeded ? res.data : null };
  });
}

export async function companyNews(symbol: string, from: string, to: string): Promise<unknown[]> {
  const { data } = await call<unknown[]>('news', symbol, '/company-news', { symbol, from, to });
  return Array.isArray(data) ? data : [];
}

export async function newsSentiment(symbol: string): Promise<unknown> {
  const { data } = await call('news', symbol, '/news-sentiment', { symbol });
  return data;
}

export async function earningsCalendar(symbol: string): Promise<unknown> {
  const { data } = await call('earnings', symbol, '/calendar/earnings', { symbol });
  return data;
}

export async function insiderTransactions(symbol: string): Promise<unknown> {
  const { data } = await call('insider', symbol, '/stock/insider-transactions', { symbol });
  return data;
}

// Real-time-ish quote for one symbol. Used by the fallback finnhubPricePoller
// when IB is disconnected. Shape (Finnhub):
//   c  = current price
//   h  = today's high
//   l  = today's low
//   o  = today's open
//   pc = previous close
//   t  = unix-seconds timestamp
export interface FinnhubQuote {
  c: number | null;   // current
  h: number | null;   // today high
  l: number | null;   // today low
  o: number | null;   // today open
  pc: number | null;  // prior close
  t: number | null;   // unix-seconds
  d: number | null;   // today change ($)
  dp: number | null;  // today change (%)
}

export async function getQuote(symbol: string): Promise<FinnhubQuote | null> {
  const { data } = await call<FinnhubQuote>('quote', symbol, '/quote', { symbol });
  if (!data || typeof data !== 'object') return null;
  // Finnhub returns 0s for unknown symbols rather than throwing — let the
  // caller decide whether 0 is meaningful.
  return data;
}

// Basic financials / fundamentals via `/stock/metric?metric=all`. These don't
// change intraday, so the queue's `profile` category (long min-interval) is the
// right bucket. Finnhub is the source of record for the Market Stats panel +
// 52-week range: IB Client Portal's snapshot fundamental fields are
// subscription-gated and unreliable, and — under the on-demand IBeam model —
// IB is usually OFF, so IB-sourced fundamentals would be blank most of the time.
// Finnhub is IB-independent and free-tier. (Intraday fields stay IB-primary; see
// the snapshot route.) Keys vary by symbol; callers fall back across synonyms.
export type FinnhubMetrics = Record<string, number | string | null | undefined>;

export async function basicFinancials(symbol: string): Promise<FinnhubMetrics | null> {
  const { data } = await call<{ metric?: FinnhubMetrics }>(
    'profile',
    symbol,
    '/stock/metric',
    { symbol, metric: 'all' },
  );
  return data?.metric ?? null;
}
