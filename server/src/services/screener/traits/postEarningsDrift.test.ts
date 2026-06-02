// Vitest fixtures for post_earnings_drift trait (Batch S2).

import { describe, it, expect } from 'vitest';
import { scorePostEarningsDrift, findReportDayPop, type DailyBarMin } from './postEarningsDrift.js';

describe('scorePostEarningsDrift', () => {
  it('scores a strong fresh report (next-day, +5%) high', () => {
    const r = scorePostEarningsDrift({
      report_day_pop_pct: 5.0,
      days_since_earnings: 2,
      today_price: 25.0,
    });
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThan(80);
  });

  it('rejects a sub-threshold pop (< +2%)', () => {
    const r = scorePostEarningsDrift({
      report_day_pop_pct: 1.5,
      days_since_earnings: 2,
      today_price: 25.0,
    });
    expect(r).toBeNull();
  });

  it('rejects a negative report-day move (drift trait is up-only)', () => {
    const r = scorePostEarningsDrift({
      report_day_pop_pct: -3.0,
      days_since_earnings: 1,
      today_price: 25.0,
    });
    expect(r).toBeNull();
  });

  it('rejects beyond the shelf-life (>5 days)', () => {
    const r = scorePostEarningsDrift({
      report_day_pop_pct: 4.0,
      days_since_earnings: 7,
      today_price: 25.0,
    });
    expect(r).toBeNull();
  });

  it('freshness premium: same pop, earlier days scores higher', () => {
    const a = scorePostEarningsDrift({
      report_day_pop_pct: 3.0,
      days_since_earnings: 1,
      today_price: 25.0,
    })!;
    const b = scorePostEarningsDrift({
      report_day_pop_pct: 3.0,
      days_since_earnings: 4,
      today_price: 25.0,
    })!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('saturates pop magnitude at +5% (no extra credit beyond)', () => {
    const cap = scorePostEarningsDrift({
      report_day_pop_pct: 5.0,
      days_since_earnings: 2,
      today_price: 25.0,
    })!;
    const huge = scorePostEarningsDrift({
      report_day_pop_pct: 30.0,
      days_since_earnings: 2,
      today_price: 25.0,
    })!;
    expect(cap.score).toBe(huge.score);
  });
});

describe('findReportDayPop', () => {
  // Synth 4 trading days. Use Sept 2026 weekdays to avoid weekends/DST surprises.
  // ET dates: 2026-09-21 Mon, 09-22 Tue (report), 09-23 Wed, 09-24 Thu.
  // Build with timestamps at 14:30 UTC (~10:30 ET) to be safely inside the ET date.
  const tsAtEtDate = (etDate: string) => Date.parse(`${etDate}T14:30:00Z`);
  const bars: DailyBarMin[] = [
    { t: tsAtEtDate('2026-09-21'), c: 10.0 },
    { t: tsAtEtDate('2026-09-22'), c: 10.5 },  // report day, +5%
    { t: tsAtEtDate('2026-09-23'), c: 10.7 },
    { t: tsAtEtDate('2026-09-24'), c: 10.8 },
  ];

  it('extracts report-day pop and days_since correctly', () => {
    const r = findReportDayPop(bars, '2026-09-22');
    expect(r).not.toBeNull();
    expect(r!.report_day_pop_pct).toBeCloseTo(5.0, 1);
    expect(r!.days_since_earnings).toBe(3);  // 4 - 1 (index 1 = report)
    expect(r!.today_close).toBe(10.8);
  });

  it('returns null when the report date is not in the series', () => {
    expect(findReportDayPop(bars, '2026-09-15')).toBeNull();
  });

  it('returns null when there is no prior session in the series', () => {
    expect(findReportDayPop(bars, '2026-09-21')).toBeNull();
  });

  it('returns null on too-short bar series', () => {
    expect(findReportDayPop([bars[0]!], '2026-09-21')).toBeNull();
  });

  it('returns null on a malformed report date', () => {
    expect(findReportDayPop(bars, 'not-a-date')).toBeNull();
  });
});
