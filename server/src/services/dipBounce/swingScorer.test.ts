import { describe, it, expect } from 'vitest';
import { computeSwingDipBounceScore, type SwingScoreInputs } from './swingScorer.js';

function inputs(over: Partial<SwingScoreInputs> = {}): SwingScoreInputs {
  return {
    trendStructure: 'higher-highs',
    rsi14: 38,
    atrDaily: 0.5,
    currentPrice: 14.2,
    sessionRegime: 'mean_reversion',
    volRegimeShift: false,
    overnightZone: { price: 14.0, hasConfluence: true }, // |14.2-14.0| = 0.2 ≤ 1·0.5
    multidayZone: { price: 13.2, hasConfluence: true },
    ...over,
  };
}

describe('computeSwingDipBounceScore', () => {
  it('scores 100 and fires when every component is on', () => {
    const r = computeSwingDipBounceScore(inputs());
    expect(r.score).toBe(100);
    expect(r.fired).toBe(true);
  });

  it('trend: higher-highs + mixed qualify, lower-lows vetoes', () => {
    expect(computeSwingDipBounceScore(inputs({ trendStructure: 'mixed' })).components.DAILY_TREND_OK).toBe(1);
    expect(computeSwingDipBounceScore(inputs({ trendStructure: 'lower-lows' })).components.DAILY_TREND_OK).toBe(0);
    expect(computeSwingDipBounceScore(inputs({ trendStructure: null })).components.DAILY_TREND_OK).toBe(0);
  });

  it('near-zone needs confluence, an ATR, and proximity within 1·ATR', () => {
    expect(computeSwingDipBounceScore(inputs()).components.NEAR_ENTRY_ZONE_SWING).toBe(1);
    // outside 1·ATR of both zones
    expect(
      computeSwingDipBounceScore(inputs({ currentPrice: 16, multidayZone: null })).components.NEAR_ENTRY_ZONE_SWING,
    ).toBe(0);
    // zone present but no confluence
    expect(
      computeSwingDipBounceScore(
        inputs({ overnightZone: { price: 14.2, hasConfluence: false }, multidayZone: null }),
      ).components.NEAR_ENTRY_ZONE_SWING,
    ).toBe(0);
    // no ATR → cannot judge proximity
    expect(computeSwingDipBounceScore(inputs({ atrDaily: null })).components.NEAR_ENTRY_ZONE_SWING).toBe(0);
  });

  it('not-bearish is a single-day veto only (null counts as not bearish)', () => {
    expect(computeSwingDipBounceScore(inputs({ sessionRegime: 'bearish_trend' })).components.NOT_BEARISH_TODAY).toBe(0);
    expect(computeSwingDipBounceScore(inputs({ sessionRegime: null })).components.NOT_BEARISH_TODAY).toBe(1);
    expect(computeSwingDipBounceScore(inputs({ sessionRegime: 'bullish_trend' })).components.NOT_BEARISH_TODAY).toBe(1);
  });

  it('RSI pullback at/below 40 only', () => {
    expect(computeSwingDipBounceScore(inputs({ rsi14: 40 })).components.RSI_PULLBACK).toBe(1);
    expect(computeSwingDipBounceScore(inputs({ rsi14: 41 })).components.RSI_PULLBACK).toBe(0);
    expect(computeSwingDipBounceScore(inputs({ rsi14: null })).components.RSI_PULLBACK).toBe(0);
  });

  it('vol_regime_shift gates only on explicit false', () => {
    expect(computeSwingDipBounceScore(inputs({ volRegimeShift: true })).components.NOT_VOL_REGIME_SHIFT).toBe(0);
    expect(computeSwingDipBounceScore(inputs({ volRegimeShift: null })).components.NOT_VOL_REGIME_SHIFT).toBe(0);
  });

  it('does not fire below threshold', () => {
    // trend(30) + notBearish(15) + rsi(15) = 60, no zone, volshift unknown
    const r = computeSwingDipBounceScore(
      inputs({ overnightZone: null, multidayZone: null, volRegimeShift: null }),
    );
    expect(r.score).toBe(60);
    expect(r.fired).toBe(false);
  });
});
