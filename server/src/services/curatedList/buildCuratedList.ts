// buildCuratedList (Batch X1) — pure membership + ranking. The cron assembles
// candidates (trait_scores + a daily-bar pull → ATR% + median ADV); this applies
// the gates, sorts by trait score desc, and caps at TARGET_SIZE. See
// spec/signals/curated-list.md → Membership rule.

import { MIN_AVG_VOLUME, MIN_DAILY_ATR_PCT, TARGET_SIZE } from '../../config/curatedList.js';

export interface CuratedCandidate {
  conid: number;
  intradayRangeTraderScore: number;
  avgDailyVolume: number | null;
  dailyAtrPct: number | null;
}

export interface CuratedRow {
  conid: number;
  rank: number;
  intradayRangeTraderScore: number;
  avgDailyVolume: number | null;
  dailyAtrPct: number | null;
}

export interface CuratedGates {
  targetSize?: number;
  minAvgVolume?: number;
  minDailyAtrPct?: number;
}

export function buildCuratedList(
  candidates: CuratedCandidate[],
  gates: CuratedGates = {},
): CuratedRow[] {
  const targetSize = gates.targetSize ?? TARGET_SIZE;
  const minAvgVolume = gates.minAvgVolume ?? MIN_AVG_VOLUME;
  const minDailyAtrPct = gates.minDailyAtrPct ?? MIN_DAILY_ATR_PCT;

  const passing = candidates.filter(
    (c) =>
      c.avgDailyVolume != null &&
      c.avgDailyVolume >= minAvgVolume &&
      c.dailyAtrPct != null &&
      c.dailyAtrPct >= minDailyAtrPct,
  );

  passing.sort((a, b) => b.intradayRangeTraderScore - a.intradayRangeTraderScore);

  return passing.slice(0, targetSize).map((c, i) => ({
    conid: c.conid,
    rank: i + 1,
    intradayRangeTraderScore: c.intradayRangeTraderScore,
    avgDailyVolume: c.avgDailyVolume,
    dailyAtrPct: c.dailyAtrPct,
  }));
}
