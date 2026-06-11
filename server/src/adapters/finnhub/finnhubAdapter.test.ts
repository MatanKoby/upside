// Finnhub adapter tests (Batch ARCH-7). The HTTP call needs a real key +
// network; what's testable is the parsing surface + the instrumentation the
// adapter inherits from HttpAdapter. The adapter builds its client via
// axios.create(), so we mock create to return a stable fake client and drive
// its .get — the Phase-2 "inject a fake http client" seam. The metric write +
// Discord notify (now on HttpAdapter.instrumented) are mocked so we can assert
// they fire without touching Supabase/Discord. The real finnhubQueue runs (50
// tokens, 0 min-interval → immediate) so the queue→instrument path is exercised.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => {
  const get = vi.fn();
  const client = { get, post: vi.fn() };
  return { default: { create: vi.fn(() => client) } };
});
vi.mock('../../env.js', () => ({
  env: { finnhubApiKey: 'test-key', finnhubRateLimitPerMin: 50 },
}));
vi.mock('../supabase/externalApiMetricsTableModule.js', () => ({
  externalApiMetricsTableModule: { record: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../services/notify.js', () => ({
  notifyApiFailure: vi.fn(),
}));

import axios from 'axios';
import { finnhub } from './finnhubAdapter.js';
import { externalApiMetricsTableModule } from '../supabase/externalApiMetricsTableModule.js';
import { notifyApiFailure } from '../../services/notify.js';

// axios.create() returns the shared fake client the adapter also holds.
const mockGet = (axios.create as unknown as () => { get: ReturnType<typeof vi.fn> })().get;
const mockRecord = externalApiMetricsTableModule.record as unknown as ReturnType<typeof vi.fn>;
const mockNotify = notifyApiFailure as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('finnhub adapter — parsing', () => {
  it('getQuote returns the quote object on a healthy 2xx', async () => {
    const quote = { c: 12.3, h: 13, l: 11, o: 11.5, pc: 11.8, t: 1, d: 0.5, dp: 4.2 };
    mockGet.mockResolvedValueOnce({ status: 200, data: quote });
    expect(await finnhub.getQuote('AAPL')).toEqual(quote);
  });

  it('getQuote returns null on a non-2xx (data mapped to null)', async () => {
    mockGet.mockResolvedValueOnce({ status: 500, data: { error: 'boom' } });
    expect(await finnhub.getQuote('AAPL')).toBeNull();
  });

  it('companyNews coerces a non-array body to []', async () => {
    mockGet.mockResolvedValueOnce({ status: 200, data: { error: 'no access' } });
    expect(await finnhub.companyNews('AAPL', '2026-06-01', '2026-06-10')).toEqual([]);
  });

  it('basicFinancials unwraps the .metric envelope', async () => {
    mockGet.mockResolvedValueOnce({ status: 200, data: { metric: { peTTM: 30, beta: 1.1 } } });
    expect(await finnhub.basicFinancials('AAPL')).toEqual({ peTTM: 30, beta: 1.1 });
  });

  it('earningsCalendarRange unwraps the .earningsCalendar array', async () => {
    const rows = [{ date: '2026-06-05', symbol: 'AAPL', hour: 'amc' }];
    mockGet.mockResolvedValueOnce({ status: 200, data: { earningsCalendar: rows } });
    expect(await finnhub.earningsCalendarRange('2026-06-01', '2026-06-10')).toEqual(rows);
  });
});

describe('finnhub adapter — instrumentation (absorbed by HttpAdapter)', () => {
  it('sends the api token + records a success metric on 2xx', async () => {
    mockGet.mockResolvedValueOnce({ status: 200, data: { c: 1, h: 1, l: 1, o: 1, pc: 1, t: 1, d: 0, dp: 0 } });
    await finnhub.getQuote('AAPL');

    // token rides as a query param; the symbol path is the /quote endpoint.
    expect(mockGet).toHaveBeenCalledWith('/quote', { params: { symbol: 'AAPL', token: 'test-key' } });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'finnhub',
        endpoint: 'finnhub:quote',
        status: 200,
        succeeded: true,
        retries: 0,
        conid: null,
      }),
    );
    expect(mockNotify).toHaveBeenCalledWith('finnhub_api.quote', 200, expect.anything());
  });

  it('records a failed metric + notifies with the body on a non-2xx', async () => {
    mockGet.mockResolvedValueOnce({ status: 429, data: { error: 'rate limited' } });
    await finnhub.getQuote('AAPL');

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'finnhub:quote', status: 429, succeeded: false }),
    );
    expect(mockNotify).toHaveBeenCalledWith(
      'finnhub_api.quote',
      429,
      expect.objectContaining({ body: { error: 'rate limited' } }),
    );
  });
});
