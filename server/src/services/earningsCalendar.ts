// Shared daily pull of the Finnhub earnings calendar (Batch X6).
//
// catalystReversalProducer (3d lookback) and postEarningsDriftProducer (5d) both
// need the recent earnings calendar. Before X6 they each made their own
// `earningsCalendarRange` call every day — two Finnhub calls for overlapping
// windows. This memoizes ONE call per UTC day for the widest window both need;
// each producer filters to its own lookback. Both run in the same Node process,
// so the in-memory memo is shared across their cron ticks.
//
// See spec/data/sources.md → Observations.

import { finnhub } from '../adapters/finnhub/finnhubAdapter.js';
import type { FinnhubEarningsRow } from '../adapters/finnhub/port.js';

// Must be ≥ the largest lookback any consumer requests (catalyst 3, postEarnings
// 5). Bump this if a new consumer needs a wider window.
export const EARNINGS_WINDOW_DAYS = 5;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

let cache: { date: string; rows: FinnhubEarningsRow[] } | null = null;
let inflight: Promise<FinnhubEarningsRow[]> | null = null;

/**
 * Earnings rows for `[today - EARNINGS_WINDOW_DAYS, today]`, fetched at most once
 * per UTC day across all callers (concurrent callers coalesce onto one request).
 * Callers filter to their own lookback. Throws on fetch failure without poisoning
 * the cache, so the next call retries.
 */
export async function getEarningsWindow(): Promise<FinnhubEarningsRow[]> {
  const today = todayIso();
  if (cache && cache.date === today) return cache.rows;
  if (!inflight) {
    inflight = finnhub.earningsCalendarRange(isoDaysAgo(EARNINGS_WINDOW_DAYS), today)
      .then((rows) => {
        cache = { date: today, rows };
        return rows;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Test hook — clears the memo + any in-flight request. */
export function _resetEarningsCache(): void {
  cache = null;
  inflight = null;
}
