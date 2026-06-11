// Finnhub adapter — the SOLE path of access to finnhub.io and the SOLE importer
// of env.finnhubApiKey. Implements FinnhubPort. Lifted out of
// services/finnhub.ts (Batch ARCH-7); same endpoints, params, queueing, and
// field mapping — no behavior change.
//
// Two finnhub-specific quirks the base doesn't carry:
//   - **Rate-limit queue.** Every call routes through `finnhubQueue` (global
//     token bucket + per-(category,key) min-interval). This is the adapter's
//     own concern — polygon/yahoo have no such ceiling.
//   - **Auth token** rides as a `?token=` query param on every call.
// The timing → external_api_metrics → notifyApiFailure instrumentation that this
// file used to hand-roll now lives in HttpAdapter.instrumented().
//
// See docs/arch/target-architecture.md → Phase 2.

import { HttpAdapter } from '../HttpAdapter.js';
import { env } from '../../env.js';
import { finnhubQueue } from './finnhubQueue.js';
import type {
  FinnhubPort,
  FinnhubEarningsRow,
  FinnhubMetrics,
  FinnhubProfile2,
  FinnhubQuote,
  FinnhubSymbolRow,
} from './port.js';

const TIMEOUT_MS = 10_000;

class FinnhubAdapter extends HttpAdapter implements FinnhubPort {
  constructor() {
    super('finnhub', 'https://finnhub.io/api/v1', TIMEOUT_MS);
  }

  // One Finnhub call: queued (rate-limit + min-interval) then instrumented
  // (timing + metric + notify). `key` is the per-(category,key) dedup/pace key.
  private call<T>(
    category: string,
    key: string,
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<{ status: number; data: T | null }> {
    return finnhubQueue.request(category, key, () =>
      this.instrumented<T>({
        category,
        notifyContext: { params },
        request: () => this.get<T>(path, { params: { ...params, token: env.finnhubApiKey } }),
      }),
    );
  }

  async companyNews(symbol: string, from: string, to: string): Promise<unknown[]> {
    const { data } = await this.call<unknown[]>('news', symbol, '/company-news', { symbol, from, to });
    return Array.isArray(data) ? data : [];
  }

  async earningsCalendar(symbol: string): Promise<unknown> {
    const { data } = await this.call('earnings', symbol, '/calendar/earnings', { symbol });
    return data;
  }

  async earningsCalendarRange(from: string, to: string): Promise<FinnhubEarningsRow[]> {
    const { data } = await this.call<{ earningsCalendar?: FinnhubEarningsRow[] }>(
      'earnings',
      `_range_${from}_${to}`,
      '/calendar/earnings',
      { from, to },
    );
    return Array.isArray(data?.earningsCalendar) ? data!.earningsCalendar! : [];
  }

  async insiderTransactions(symbol: string): Promise<unknown> {
    const { data } = await this.call('insider', symbol, '/stock/insider-transactions', { symbol });
    return data;
  }

  async getQuote(symbol: string): Promise<FinnhubQuote | null> {
    const { data } = await this.call<FinnhubQuote>('quote', symbol, '/quote', { symbol });
    if (!data || typeof data !== 'object') return null;
    // Finnhub returns 0s for unknown symbols rather than throwing — let the
    // caller decide whether 0 is meaningful.
    return data;
  }

  // Finnhub is the source of record for the Market Stats panel + 52-week range:
  // IB Client Portal's snapshot fundamental fields are subscription-gated and
  // unreliable, and IB is often OFF, so IB-sourced fundamentals would be blank
  // most of the time. Finnhub is IB-independent and free-tier. (Intraday fields
  // stay IB-primary; see the snapshot route.)
  async basicFinancials(symbol: string): Promise<FinnhubMetrics | null> {
    const { data } = await this.call<{ metric?: FinnhubMetrics }>(
      'profile',
      symbol,
      '/stock/metric',
      { symbol, metric: 'all' },
    );
    return data?.metric ?? null;
  }

  async getSymbolList(exchange = 'US'): Promise<FinnhubSymbolRow[]> {
    const { data } = await this.call<FinnhubSymbolRow[]>('symbol', exchange, '/stock/symbol', { exchange });
    return Array.isArray(data) ? data : [];
  }

  async getProfile2(symbol: string): Promise<FinnhubProfile2 | null> {
    const { data } = await this.call<FinnhubProfile2>('profile', symbol, '/stock/profile2', { symbol });
    return data ?? null;
  }
}

export const finnhub: FinnhubPort = new FinnhubAdapter();
