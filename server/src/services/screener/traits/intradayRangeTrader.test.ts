// Vitest fixtures for intradayRangeTrader trait (Batch S2).

import { describe, it, expect } from 'vitest';
import { scoreIntradayRangeTrader } from './intradayRangeTrader.js';

describe('scoreIntradayRangeTrader', () => {
  it('scores a textbook range trader (REPL-shaped: deep + tight + cheap)', () => {
    const r = scoreIntradayRangeTrader(
      { intraday_low_pct_p50: 4.0, intraday_low_pct_p75: 5.5, sample_size: 60 },
      8.50,
      8.45,
    );
    expect(r).not.toBeNull();
    // p50=4 → 33.3, tight=0.875 → ~12.5, sample saturated → 10, sub-$10 → +10
    // ≈ 66. A perfect candidate (p50=6) would saturate to ~90+.
    expect(r!.score).toBeGreaterThan(60);
    // Sub-$10 → full +10 price bonus
    expect(r!.payload.p50).toBe(4.0);
    expect(r!.payload.today_open_band_low).toBeCloseTo(8.16, 2);
  });

  it('rejects too-shallow p50 (< 2%)', () => {
    const r = scoreIntradayRangeTrader(
      { intraday_low_pct_p50: 1.5, intraday_low_pct_p75: 2.0, sample_size: 60 },
      25, 25,
    );
    expect(r).toBeNull();
  });

  it('rejects too-small sample size', () => {
    const r = scoreIntradayRangeTrader(
      { intraday_low_pct_p50: 3.0, intraday_low_pct_p75: 4.0, sample_size: 20 },
      25, 25,
    );
    expect(r).toBeNull();
  });

  it('rejects too-wide envelope (tightness > 1.5)', () => {
    // p25 derived as p50/2 = 1.0; p75 - p25 = 7.0; tightness = 7.0/2.0 = 3.5
    const r = scoreIntradayRangeTrader(
      { intraday_low_pct_p50: 2.0, intraday_low_pct_p75: 8.0, sample_size: 60 },
      25, 25,
    );
    expect(r).toBeNull();
  });

  it('uses explicit p25 when present, not the proxy', () => {
    // Explicit p25 = 1.5 → tightness = (4.0 - 1.5) / 3.0 = 0.83 (in band)
    const r = scoreIntradayRangeTrader(
      { intraday_low_pct_p50: 3.0, intraday_low_pct_p75: 4.0, intraday_low_pct_p25: 1.5, sample_size: 60 },
      50, 50,
    );
    expect(r).not.toBeNull();
    expect(r!.payload.p25).toBe(1.5);
  });

  it('drops a candidate when explicit p25 falls below the 1.0% floor', () => {
    const r = scoreIntradayRangeTrader(
      { intraday_low_pct_p50: 2.5, intraday_low_pct_p75: 3.5, intraday_low_pct_p25: 0.5, sample_size: 60 },
      25, 25,
    );
    expect(r).toBeNull();
  });

  it('returns null on null percentile inputs', () => {
    const r = scoreIntradayRangeTrader(
      { intraday_low_pct_p50: null, intraday_low_pct_p75: null, sample_size: 60 },
      10, 10,
    );
    expect(r).toBeNull();
  });

  it('mid-price (sub-$30, not sub-$10) gets +5 bonus only', () => {
    const cheap = scoreIntradayRangeTrader(
      { intraday_low_pct_p50: 3.0, intraday_low_pct_p75: 4.0, sample_size: 60 },
      8, 8,
    );
    const mid = scoreIntradayRangeTrader(
      { intraday_low_pct_p50: 3.0, intraday_low_pct_p75: 4.0, sample_size: 60 },
      25, 25,
    );
    const expensive = scoreIntradayRangeTrader(
      { intraday_low_pct_p50: 3.0, intraday_low_pct_p75: 4.0, sample_size: 60 },
      80, 80,
    );
    expect(cheap!.score).toBeGreaterThan(mid!.score);
    expect(mid!.score).toBeGreaterThan(expensive!.score);
    expect(cheap!.score - mid!.score).toBe(5);
    expect(mid!.score - expensive!.score).toBe(5);
  });

  it('emits today_open_band_low = open × (1 - p50/100)', () => {
    const r = scoreIntradayRangeTrader(
      { intraday_low_pct_p50: 5.0, intraday_low_pct_p75: 6.0, sample_size: 60 },
      20.00,
      20.00,
    );
    expect(r!.payload.today_open_band_low).toBeCloseTo(19.00, 2);
  });

  it('handles missing open gracefully (band_low → null)', () => {
    const r = scoreIntradayRangeTrader(
      { intraday_low_pct_p50: 3.0, intraday_low_pct_p75: 4.0, sample_size: 60 },
      null,
      8,
    );
    expect(r).not.toBeNull();
    expect(r!.payload.today_open_band_low).toBeNull();
  });
});
