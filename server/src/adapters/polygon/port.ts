import type { DailyOhlcv } from '../../types/index.js';

/** The Polygon calls we actually make — the contract callers depend on. */
export interface PolygonPort {
  /**
   * Pull the entire US stock universe's OHLCV for a trading date. Returns a map
   * keyed by symbol (Polygon's `T` ticker field); callers join to `universe`
   * rows by symbol. May be empty for non-trading days. Throws on auth / network
   * / non-OK Polygon status so the caller can log + skip.
   */
  groupedDaily(date: string): Promise<Record<string, DailyOhlcv>>;
}
