// dailyBars — Batch X4.
//
// Read/shape helpers over the `daily_bars` SSOT (Polygon-primary daily OHLCV).
// The producer (universeQuoteProducer) writes the table; the daily-grain
// consumers (curatedListCron, the swing dip-bounce pack, the sparkline route)
// read it here instead of calling IB history — so they survive IB 503s
// (weekends, off-hours). See spec/data/sources.md → daily_bars.

import type { DailyOhlcv } from '../types/index.js';
import { dailyBarsTableModule } from '../db/dailyBarsTableModule.js';

export interface DailyBar {
  date: string; // YYYY-MM-DD
  t: number;    // epoch ms (parsed from date) — mirrors RawIbHistory bar shape
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface DailyBarRow {
  conid: number;
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  source: string;
  computed_at: string;
}

/**
 * The `n` most recent weekdays (Mon-Fri) strictly before `asof`'s date,
 * most-recent first, as YYYY-MM-DD. The producer backfills these dates from
 * Polygon grouped-daily; today's bar isn't closed yet so we start at
 * yesterday. Holidays still appear here (Polygon returns no rows for them —
 * harmless), but weekends are skipped so a Monday run targets Friday's bar
 * (the weekend-safety the layer exists for).
 */
export function recentWeekdays(n: number, asof: Date = new Date()): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(asof.getUTCFullYear(), asof.getUTCMonth(), asof.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1); // start at yesterday
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

/**
 * Map a Polygon grouped-daily response (keyed by symbol) onto daily_bars rows
 * for the universe, keyed by `real_conid`. Symbols Polygon didn't return are
 * skipped (the producer gap-fills those via Yahoo).
 */
export function buildDailyBarRows(
  date: string,
  grouped: Record<string, DailyOhlcv>,
  symbolToConid: Map<string, number>,
  source: string,
  computedAt: string,
): DailyBarRow[] {
  const rows: DailyBarRow[] = [];
  for (const [symbol, conid] of symbolToConid) {
    const b = grouped[symbol];
    if (!b) continue;
    rows.push({
      conid,
      date,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: Math.round(b.volume),
      source,
      computed_at: computedAt,
    });
  }
  return rows;
}

/**
 * Read a conid's daily bars from the SSOT, oldest→newest (so the array matches
 * the chronological order RawIbHistory.data gives the consumers). Grabs the
 * most-recent `lookbackDays` rows. Returns [] when the conid has no bars
 * (e.g. a held name outside the universe, or before the first producer run).
 */
export async function loadDailyBars(conid: number, lookbackDays = 90): Promise<DailyBar[]> {
  let rows;
  try {
    rows = await dailyBarsTableModule.getBars(conid, lookbackDays);
  } catch {
    return []; // a held name outside the universe, or before the first producer run
  }
  return rows.map((r) => ({ ...r, t: new Date(r.date).getTime() }));
}
