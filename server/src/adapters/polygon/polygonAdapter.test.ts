// Polygon adapter parser fixtures (moved from services/universeQuote.test.ts in
// Batch ARCH-5). The HTTP call needs a real key + network; what's testable is
// the response-parsing surface. The adapter builds its client via
// axios.create(), so we mock create to return a stable fake client and drive
// its .get — the Phase-2 "adapter takes its http client so a test can inject a
// fake" seam.

import { describe, it, expect, vi } from 'vitest';

vi.mock('axios', () => {
  const get = vi.fn();
  const client = { get, post: vi.fn() };
  return { default: { create: vi.fn(() => client) } };
});
vi.mock('../../env.js', () => ({
  env: { polygonApiKey: 'test-key' },
}));

import axios from 'axios';
import { polygon } from './polygonAdapter.js';

// axios.create() returns the shared fake client the adapter also holds.
const mockGet = (axios.create as unknown as () => { get: ReturnType<typeof vi.fn> })().get;

describe('polygon.groupedDaily', () => {
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
    const map = await polygon.groupedDaily('2026-06-01');
    expect(Object.keys(map).sort()).toEqual(['AAPL', 'REPL']);
    expect(map['REPL']).toEqual({ open: 8.69, high: 10, low: 8.8, close: 9.0, volume: 10_918_760 });
  });

  it('returns an empty map when results is empty (non-trading day)', async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: { status: 'OK', resultsCount: 0, results: [] },
    });
    expect(await polygon.groupedDaily('2026-06-01')).toEqual({});
  });

  it('throws on HTTP error', async () => {
    mockGet.mockResolvedValueOnce({ status: 401, data: { error: 'invalid api key' } });
    await expect(polygon.groupedDaily('2026-06-01')).rejects.toThrow(/HTTP 401/);
  });

  it('throws on Polygon-side ERROR status even with HTTP 200', async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: { status: 'NOT_AUTHORIZED', error: 'You are not entitled to this data.' },
    });
    await expect(polygon.groupedDaily('2026-06-01')).rejects.toThrow(/NOT_AUTHORIZED/);
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
    const map = await polygon.groupedDaily('2026-06-01');
    expect(Object.keys(map)).toEqual(['AAPL']);
  });
});
