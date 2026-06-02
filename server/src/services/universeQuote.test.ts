// Vitest fixtures for universeQuote parsers (Batch S0.5).
//
// The HTTP calls themselves (polygonGroupedDaily, yahooChart) need real
// keys + network access; their happy paths are exercised by the live cron
// after deploy. What's testable here is the response-parsing surface —
// confirming that the field mapping is correct against known sample
// payloads.

import { describe, it, expect, vi } from 'vitest';

// We test the parsers by injecting axios responses. Hoist the mock so the
// imports below resolve to the mocked module.
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));
vi.mock('../env.js', () => ({
  env: { polygonApiKey: 'test-key' },
}));

import axios from 'axios';
import { polygonGroupedDaily, yahooChart } from './universeQuote.js';

const mockGet = axios.get as unknown as ReturnType<typeof vi.fn>;

describe('polygonGroupedDaily', () => {
  it('parses a healthy grouped-bars response into a symbol map', async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: {
        status: 'OK',
        resultsCount: 2,
        results: [
          { T: 'AAPL', v: 50_000_000, o: 200, h: 205, l: 199, c: 203 },
          { T: 'REPL', v: 10_918_760, o: 8.69, h: 10, l: 8.8, c: 9.0 },
        ],
      },
    });
    const map = await polygonGroupedDaily('2026-06-01');
    expect(Object.keys(map).sort()).toEqual(['AAPL', 'REPL']);
    expect(map['REPL']).toEqual({ open: 8.69, high: 10, low: 8.8, close: 9.0, volume: 10_918_760 });
  });

  it('returns an empty map when results is empty (non-trading day)', async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: { status: 'OK', resultsCount: 0, results: [] },
    });
    const map = await polygonGroupedDaily('2026-06-01');
    expect(map).toEqual({});
  });

  it('throws on HTTP error', async () => {
    mockGet.mockResolvedValueOnce({ status: 401, data: { error: 'invalid api key' } });
    await expect(polygonGroupedDaily('2026-06-01')).rejects.toThrow(/HTTP 401/);
  });

  it('throws on Polygon-side ERROR status even with HTTP 200', async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: { status: 'NOT_AUTHORIZED', error: 'You are not entitled to this data.' },
    });
    await expect(polygonGroupedDaily('2026-06-01')).rejects.toThrow(/NOT_AUTHORIZED/);
  });

  it('skips results missing the ticker field', async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: {
        status: 'OK',
        results: [
          { T: 'AAPL', v: 1, o: 1, h: 1, l: 1, c: 1 },
          { v: 2, o: 2, h: 2, l: 2, c: 2 }, // missing T — skip
        ],
      },
    });
    const map = await polygonGroupedDaily('2026-06-01');
    expect(Object.keys(map)).toEqual(['AAPL']);
  });
});

describe('yahooChart', () => {
  it('parses a healthy chart response from meta', async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: {
        chart: {
          result: [
            {
              meta: {
                regularMarketPrice: 9.0,
                previousClose: 8.69,
                regularMarketDayHigh: 10.0,
                regularMarketDayLow: 8.8,
                regularMarketVolume: 10_918_760,
              },
            },
          ],
        },
      },
    });
    const r = await yahooChart('REPL');
    expect(r).toEqual({ open: 8.69, high: 10, low: 8.8, close: 9.0, volume: 10_918_760 });
  });

  it('returns null on HTTP error', async () => {
    mockGet.mockResolvedValueOnce({ status: 500, data: {} });
    expect(await yahooChart('XYZ')).toBeNull();
  });

  it('returns null when chart.result is empty', async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: { chart: { result: [] } },
    });
    expect(await yahooChart('XYZ')).toBeNull();
  });

  it('returns null when meta is missing required field', async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: {
        chart: {
          result: [{ meta: { regularMarketPrice: 9.0 /* no others */ } }],
        },
      },
    });
    expect(await yahooChart('XYZ')).toBeNull();
  });
});
