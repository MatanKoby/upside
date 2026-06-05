import { describe, it, expect } from 'vitest';
import { buildCuratedList, type CuratedCandidate } from './buildCuratedList.js';

function cand(over: Partial<CuratedCandidate> & { conid: number }): CuratedCandidate {
  return {
    intradayRangeTraderScore: 50,
    avgDailyVolume: 2_000_000,
    dailyAtrPct: 3,
    ...over,
  };
}

describe('buildCuratedList', () => {
  it('caps at targetSize, ranks by score desc', () => {
    const candidates = Array.from({ length: 300 }, (_, i) =>
      cand({ conid: i + 1, intradayRangeTraderScore: i }),
    );
    const out = buildCuratedList(candidates, { targetSize: 250 });
    expect(out).toHaveLength(250);
    expect(out[0]!.rank).toBe(1);
    expect(out[0]!.intradayRangeTraderScore).toBe(299); // highest first
    expect(out[249]!.rank).toBe(250);
    // monotonic non-increasing scores
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.intradayRangeTraderScore).toBeLessThanOrEqual(out[i - 1]!.intradayRangeTraderScore);
    }
  });

  it('drops names below the liquidity gate', () => {
    const out = buildCuratedList([
      cand({ conid: 1, avgDailyVolume: 999_999 }),
      cand({ conid: 2, avgDailyVolume: 1_000_000 }),
    ]);
    expect(out.map((r) => r.conid)).toEqual([2]);
  });

  it('drops names below the daily-ATR gate', () => {
    const out = buildCuratedList([
      cand({ conid: 1, dailyAtrPct: 1.49 }),
      cand({ conid: 2, dailyAtrPct: 1.5 }),
    ]);
    expect(out.map((r) => r.conid)).toEqual([2]);
  });

  it('drops names with null volume or ATR', () => {
    const out = buildCuratedList([
      cand({ conid: 1, avgDailyVolume: null }),
      cand({ conid: 2, dailyAtrPct: null }),
      cand({ conid: 3 }),
    ]);
    expect(out.map((r) => r.conid)).toEqual([3]);
  });

  it('returns fewer than target when only a few pass (cap, not floor)', () => {
    const out = buildCuratedList([cand({ conid: 1 }), cand({ conid: 2 }), cand({ conid: 3 })], {
      targetSize: 250,
    });
    expect(out).toHaveLength(3);
  });
});
