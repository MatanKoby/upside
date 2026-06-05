import { describe, it, expect } from 'vitest';
import { computeIntradayDipBounceScore, type IntradayScoreInputs } from './intradayScorer.js';

// Open 100, p50 = 2%, p75 = 4%. A current price of 97.5 → drop 2.5% (in band).
function inputs(over: Partial<IntradayScoreInputs> = {}): IntradayScoreInputs {
  return {
    todayOpen: 100,
    currentPrice: 97.5,
    intradayLowPctP50: 2,
    intradayLowPctP75: 4,
    sessionRegime: 'mean_reversion',
    volRegimeShift: false,
    intradayZone: { trendRegime: 'up', hasConfluence: true },
    ...over,
  };
}

describe('computeIntradayDipBounceScore', () => {
  it('scores 100 and fires when every component is on', () => {
    const r = computeIntradayDipBounceScore(inputs());
    expect(r.score).toBe(100);
    expect(r.fired).toBe(true);
    expect(r.dropPct).toBeCloseTo(2.5, 5);
  });

  it('typical-band: in [p50, p75), deep (≥ p75) vetoes to 0', () => {
    expect(computeIntradayDipBounceScore(inputs({ currentPrice: 98 })).components.IN_TYPICAL_BAND).toBe(1); // drop 2% = p50
    expect(computeIntradayDipBounceScore(inputs({ currentPrice: 96.1 })).components.IN_TYPICAL_BAND).toBe(1); // drop 3.9% < p75
    expect(computeIntradayDipBounceScore(inputs({ currentPrice: 96 })).components.IN_TYPICAL_BAND).toBe(0); // drop 4% = p75 → deep
    expect(computeIntradayDipBounceScore(inputs({ currentPrice: 95 })).components.IN_TYPICAL_BAND).toBe(0); // drop 5% deep
    expect(computeIntradayDipBounceScore(inputs({ currentPrice: 99 })).components.IN_TYPICAL_BAND).toBe(0); // drop 1% < p50
  });

  it('mean_reversion + mixed regimes count; bearish does not', () => {
    expect(computeIntradayDipBounceScore(inputs({ sessionRegime: 'mixed' })).components.MEAN_REVERSION_REGIME).toBe(1);
    expect(computeIntradayDipBounceScore(inputs({ sessionRegime: 'bearish_trend' })).components.MEAN_REVERSION_REGIME).toBe(0);
    expect(computeIntradayDipBounceScore(inputs({ sessionRegime: null })).components.MEAN_REVERSION_REGIME).toBe(0);
  });

  it('vol_regime_shift gates only on explicit false', () => {
    expect(computeIntradayDipBounceScore(inputs({ volRegimeShift: true })).components.NOT_VOL_REGIME_SHIFT).toBe(0);
    expect(computeIntradayDipBounceScore(inputs({ volRegimeShift: null })).components.NOT_VOL_REGIME_SHIFT).toBe(0);
    expect(computeIntradayDipBounceScore(inputs({ volRegimeShift: false })).components.NOT_VOL_REGIME_SHIFT).toBe(1);
  });

  it('entry-zone confluence + trend gate independently', () => {
    const noZone = computeIntradayDipBounceScore(inputs({ intradayZone: null }));
    expect(noZone.components.ENTRY_ZONE_CONFLUENCE).toBe(0);
    expect(noZone.components.ENTRY_ZONE_TREND_OK).toBe(0);
    const down = computeIntradayDipBounceScore(inputs({ intradayZone: { trendRegime: 'down', hasConfluence: false } }));
    expect(down.components.ENTRY_ZONE_CONFLUENCE).toBe(0);
    expect(down.components.ENTRY_ZONE_TREND_OK).toBe(0);
  });

  it('fires at exactly the threshold, not below', () => {
    // typical(30) + mean_rev(25) + notVolShift(15) = 70 → fires; drop confluence + trend.
    const r70 = computeIntradayDipBounceScore(inputs({ intradayZone: { trendRegime: 'down', hasConfluence: false } }));
    expect(r70.score).toBe(70);
    expect(r70.fired).toBe(true);
    // remove notVolShift → 55, no fire.
    const r55 = computeIntradayDipBounceScore(
      inputs({ volRegimeShift: true, intradayZone: { trendRegime: 'down', hasConfluence: false } }),
    );
    expect(r55.score).toBe(55);
    expect(r55.fired).toBe(false);
  });

  it('null open/price → no drop, band off', () => {
    const r = computeIntradayDipBounceScore(inputs({ todayOpen: null, currentPrice: null }));
    expect(r.dropPct).toBeNull();
    expect(r.components.IN_TYPICAL_BAND).toBe(0);
  });
});
