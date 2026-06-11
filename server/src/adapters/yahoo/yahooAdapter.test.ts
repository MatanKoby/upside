// Yahoo adapter parser fixtures (moved from services/universeQuote.test.ts in
// Batch ARCH-5). Same fake-client seam as the polygon adapter test.

import { describe, it, expect, vi } from 'vitest';

vi.mock('axios', () => {
  const get = vi.fn();
  const client = { get, post: vi.fn() };
  return { default: { create: vi.fn(() => client) } };
});

import axios from 'axios';
import { yahoo } from './yahooAdapter.js';

const mockGet = (axios.create as unknown as () => { get: ReturnType<typeof vi.fn> })().get;

describe('yahoo.chart', () => {
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
    expect(await yahoo.chart('REPL')).toEqual({ open: 8.69, high: 10, low: 8.8, close: 9.0, volume: 10_918_760 });
  });

  it('returns null on HTTP error', async () => {
    mockGet.mockResolvedValueOnce({ status: 500, data: {} });
    expect(await yahoo.chart('XYZ')).toBeNull();
  });

  it('returns null when chart.result is empty', async () => {
    mockGet.mockResolvedValueOnce({ status: 200, data: { chart: { result: [] } } });
    expect(await yahoo.chart('XYZ')).toBeNull();
  });

  it('returns null when meta is missing required field', async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: { chart: { result: [{ meta: { regularMarketPrice: 9.0 /* no others */ } }] } },
    });
    expect(await yahoo.chart('XYZ')).toBeNull();
  });
});
