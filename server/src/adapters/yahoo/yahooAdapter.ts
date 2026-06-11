// Yahoo adapter — the SOLE path of access to query1.finance.yahoo.com.
// Implements YahooPort. The keyless per-symbol gap-fill the universe producer
// uses for tickers Polygon's grouped response omits. Lifted out of
// services/universeQuote.ts (Batch ARCH-5); same endpoint, params, headers, and
// field mapping — no behavior change.

import { HttpAdapter } from '../HttpAdapter.js';
import type { DailyOhlcv } from '../../types/index.js';
import type { YahooPort } from './port.js';

// Yahoo v8/chart response (only the fields we use):
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

class YahooAdapter extends HttpAdapter implements YahooPort {
  constructor() {
    super('yahoo', 'https://query1.finance.yahoo.com', 15_000);
  }

  async chart(symbol: string): Promise<DailyOhlcv | null> {
    const res = await this.get<YahooChartResponse>(
      `/v8/finance/chart/${encodeURIComponent(symbol)}`,
      {
        params: { range: '1d', interval: '1m' },
        headers: { 'User-Agent': 'Mozilla/5.0 (upside-screener)' },
      },
    );
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
}

export const yahoo: YahooPort = new YahooAdapter();
