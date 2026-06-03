import { describe, it, expect } from 'vitest';
import { atr, computeVolScalar } from './volScalar.js';

// Synthesize 5-min bars with a given typical true-range. Each bar's high/low
// straddle `c` by ±range/2, and the prev close gap is zero so TR = high-low.
function bars(closes: number[], range: number) {
  return closes.map((c) => ({ h: c + range / 2, l: c - range / 2, c }));
}

describe('atr', () => {
  it('returns null on <2 bars', () => {
    expect(atr([])).toBeNull();
    expect(atr([{ h: 10, l: 9, c: 9.5 }])).toBeNull();
  });

  it('averages true-range over the supplied bars (skipping the first, which has no prev)', () => {
    // Closes flat; per-bar range = 1.0 → TR = 1.0 every bar → ATR = 1.0.
    const series = bars([100, 100, 100, 100, 100], 1.0);
    expect(atr(series)).toBeCloseTo(1.0, 5);
  });

  it('captures gap-driven TR', () => {
    // Two bars; second bar gaps up (prev close 100, this high 105, this low 103),
    // so true-range = max(105-103, |105-100|, |103-100|) = 5.
    const series = [
      { h: 101, l: 99, c: 100 },
      { h: 105, l: 103, c: 104 },
    ];
    expect(atr(series)).toBeCloseTo(5, 5);
  });
});

describe('computeVolScalar', () => {
  it('typical day: today ATR ≈ baseline → baseline (1.0) + null annotation', () => {
    const res = computeVolScalar({ recentBars: bars([100, 100, 100, 100, 100], 1.0), baselineAtr: 1.0 });
    expect(res.scalar).toBe(1.0);
    expect(res.annotation).toBeNull();
    expect(res.ratio).toBeCloseTo(1.0, 5);
  });

  it('trend / high-vol day (REPL-style): today ATR 2× baseline → scalar 1.5 + high_vol_today', () => {
    // Today's range is 2.0 vs baseline 1.0 → ratio = 2.0 → high-vol path.
    const res = computeVolScalar({ recentBars: bars([100, 100, 100, 100, 100], 2.0), baselineAtr: 1.0 });
    expect(res.scalar).toBe(1.5);
    expect(res.annotation).toBe('high_vol_today');
    expect(res.ratio).toBeCloseTo(2.0, 5);
  });

  it('mixed / calm day: today ATR 0.3× baseline → scalar 0.7 + calm_day', () => {
    const res = computeVolScalar({ recentBars: bars([100, 100, 100, 100, 100], 0.3), baselineAtr: 1.0 });
    expect(res.scalar).toBe(0.7);
    expect(res.annotation).toBe('calm_day');
    expect(res.ratio).toBeCloseTo(0.3, 5);
  });

  it('insufficient bars → baseline fallback', () => {
    const res = computeVolScalar({ recentBars: [{ h: 10, l: 9, c: 9.5 }], baselineAtr: 1.0 });
    expect(res.scalar).toBe(1.0);
    expect(res.annotation).toBeNull();
  });

  it('null/zero baseline → baseline fallback (no division by zero)', () => {
    const series = bars([100, 100, 100, 100, 100], 1.0);
    expect(computeVolScalar({ recentBars: series, baselineAtr: null }).scalar).toBe(1.0);
    expect(computeVolScalar({ recentBars: series, baselineAtr: 0 }).scalar).toBe(1.0);
  });

  it('MNTS-style validation: today ATR ≈ 2.6× baseline → wide band path', () => {
    // Simulate MNTS 2026-05-30: today realized vol ≈ 2.6× baseline.
    const today = bars([18, 17.5, 17.0, 16.5, 16.0, 16.2, 16.5, 16.8, 17.0, 17.2, 16.8, 16.5], 2.6);
    const res = computeVolScalar({ recentBars: today, baselineAtr: 1.0 });
    expect(res.annotation).toBe('high_vol_today');
    expect(res.scalar).toBe(1.5);
  });
});
