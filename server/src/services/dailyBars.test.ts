// Vitest for the pure dailyBars helpers (Batch X4). loadDailyBars is a thin
// Supabase read exercised live; recentWeekdays + buildDailyBarRows hold the
// date-math + mapping logic worth pinning.

import { describe, it, expect, vi } from 'vitest';

// loadDailyBars (untested here) imports supabase → env; stub it so importing the
// module doesn't require the live Supabase env vars. We only exercise the pure
// helpers below.
vi.mock('./supabase.js', () => ({ supabase: () => ({}) }));

import { recentWeekdays, buildDailyBarRows } from './dailyBars.js';
import type { DailyOhlcv } from './universeQuote.js';

describe('recentWeekdays', () => {
  it('returns N weekdays, most-recent first, starting at yesterday', () => {
    // Wed 2026-06-10 → yesterday Tue 06-09, then 06-08 (Mon), skip weekend, 06-05 (Fri)...
    const days = recentWeekdays(5, new Date('2026-06-10T12:00:00Z'));
    expect(days).toEqual(['2026-06-09', '2026-06-08', '2026-06-05', '2026-06-04', '2026-06-03']);
  });

  it('skips the weekend when run on a Monday (targets Friday)', () => {
    // Mon 2026-06-08 → yesterday is Sun 06-07 (skip) + Sat 06-06 (skip) → Fri 06-05 first.
    const days = recentWeekdays(3, new Date('2026-06-08T09:00:00Z'));
    expect(days).toEqual(['2026-06-05', '2026-06-04', '2026-06-03']);
  });

  it('never returns a Saturday or Sunday', () => {
    const days = recentWeekdays(40, new Date('2026-06-10T00:00:00Z'));
    expect(days).toHaveLength(40);
    for (const d of days) {
      const dow = new Date(d + 'T00:00:00Z').getUTCDay();
      expect(dow).not.toBe(0);
      expect(dow).not.toBe(6);
    }
  });
});

describe('buildDailyBarRows', () => {
  const grouped: Record<string, DailyOhlcv> = {
    AAPL: { open: 200, high: 205, low: 199, close: 203, volume: 50_000_000 },
    REPL: { open: 8.69, high: 10, low: 8.8, close: 9.0, volume: 10_918_760.4 },
  };
  const symbolToConid = new Map<string, number>([
    ['AAPL', 265598],
    ['REPL', 123456],
    ['MISSING', 999], // not in the Polygon response — skipped
  ]);

  it('maps matched symbols onto conid-keyed rows and rounds volume', () => {
    const rows = buildDailyBarRows('2026-06-05', grouped, symbolToConid, 'polygon', '2026-06-06T00:00:00Z');
    expect(rows).toHaveLength(2);
    const repl = rows.find((r) => r.conid === 123456);
    expect(repl).toEqual({
      conid: 123456,
      date: '2026-06-05',
      o: 8.69,
      h: 10,
      l: 8.8,
      c: 9.0,
      v: 10_918_760, // rounded
      source: 'polygon',
      computed_at: '2026-06-06T00:00:00Z',
    });
  });

  it('skips symbols Polygon did not return', () => {
    const rows = buildDailyBarRows('2026-06-05', grouped, symbolToConid, 'polygon', 'now');
    expect(rows.some((r) => r.conid === 999)).toBe(false);
  });

  it('returns [] when nothing matches', () => {
    const rows = buildDailyBarRows('2026-06-05', {}, symbolToConid, 'polygon', 'now');
    expect(rows).toEqual([]);
  });
});
