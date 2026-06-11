// Polygon adapter — the SOLE path of access to api.polygon.io. Implements
// PolygonPort. Lifted out of services/universeQuote.ts (Batch ARCH-5, the
// Phase-2 reference slice); same endpoint, params, and field mapping — no
// behavior change. The caller (universeQuoteProducer) keeps its own
// notify-on-throw policy.
//
// Primary daily-grain source: `/v2/aggs/grouped/locale/us/market/stocks/{date}`
// returns ALL US stocks' OHLCV for one day in a single call (fits the 5-cpm
// free tier). See docs/arch/target-architecture.md → Phase 2.

import { HttpAdapter } from '../HttpAdapter.js';
import { env } from '../../env.js';
import type { DailyOhlcv } from '../../types/index.js';
import type { PolygonPort } from './port.js';

// Polygon's grouped-daily-bars response (the fields we use):
//   results: [{ T: 'AAPL', v, o, h, l, c, t, vw, n }, …]
// Symbol is in `T` (ticker), volume in `v`, OHLC as named.
interface PolygonGroupedResult {
  T: string; // ticker
  v: number; // volume
  vw?: number; // VWAP (ignored)
  o: number;
  h: number;
  l: number;
  c: number;
  t?: number; // timestamp ms (ignored)
  n?: number; // num transactions (ignored)
}

interface PolygonGroupedResponse {
  status?: string; // 'OK' on success, 'NOT_AUTHORIZED' / 'ERROR' on failure
  resultsCount?: number;
  results?: PolygonGroupedResult[];
  error?: string;
}

class PolygonAdapter extends HttpAdapter implements PolygonPort {
  constructor() {
    super('polygon', 'https://api.polygon.io', 30_000);
  }

  async groupedDaily(date: string): Promise<Record<string, DailyOhlcv>> {
    if (!env.polygonApiKey) {
      throw new Error('POLYGON_API_KEY not configured');
    }
    const res = await this.get<PolygonGroupedResponse>(
      `/v2/aggs/grouped/locale/us/market/stocks/${date}`,
      { params: { adjusted: 'true', apiKey: env.polygonApiKey } },
    );
    if (res.status !== 200) {
      throw new Error(
        `Polygon grouped-daily ${date} HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`,
      );
    }
    const body = res.data;
    if (body.status && body.status !== 'OK' && body.status !== 'DELAYED') {
      throw new Error(
        `Polygon grouped-daily ${date} status=${body.status}: ${body.error ?? '(no error msg)'}`,
      );
    }
    const out: Record<string, DailyOhlcv> = {};
    for (const r of body.results ?? []) {
      if (!r.T) continue;
      out[r.T] = { open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v };
    }
    return out;
  }
}

export const polygon: PolygonPort = new PolygonAdapter();
