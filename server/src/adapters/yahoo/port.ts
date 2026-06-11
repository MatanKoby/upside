import type { DailyOhlcv } from '../../types/index.js';

/** The Yahoo calls we actually make — the contract callers depend on. */
export interface YahooPort {
  /**
   * Per-symbol daily OHLCV gap-fill via Yahoo's keyless v8/chart endpoint — the
   * fallback for tickers Polygon's grouped response omits (IPOs, halted, special
   * situations). Returns null when the symbol isn't found or required fields are
   * missing. `open` is synthesized from previousClose when Yahoo omits a true open.
   */
  chart(symbol: string): Promise<DailyOhlcv | null>;
}
