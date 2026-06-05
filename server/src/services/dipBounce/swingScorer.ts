// Swing dip-bounce scorer (Batch X1) — pure composition. Daily indicators
// (trend structure, RSI(14), ATR) come from the feature pack (technicals.ts)
// that the cron computes once per session per conid; band_state + entry_zones
// come from tables. See spec/signals/dip-bounce-scorer.md → Swing scorer.

import {
  SWING_WEIGHTS,
  SWING_FIRE_THRESHOLD,
  SWING_RSI_PULLBACK_MAX,
  SWING_NEAR_ZONE_ATR_MULT,
} from '../../config/dipBounceScorer.js';
import type { DipBounceScore } from './intradayScorer.js';

export interface SwingScoreInputs {
  // technicals daily feature pack:
  trendStructure: 'higher-highs' | 'lower-lows' | 'mixed' | null;
  rsi14: number | null;
  atrDaily: number | null;
  currentPrice: number | null;
  // band_state (today):
  sessionRegime: string | null;
  volRegimeShift: boolean | null;
  // entry_zones swing horizons:
  overnightZone: { price: number; hasConfluence: boolean } | null;
  multidayZone: { price: number; hasConfluence: boolean } | null;
}

function nearConfluentZone(
  price: number | null,
  atrDaily: number | null,
  zones: Array<{ price: number; hasConfluence: boolean } | null>,
): boolean {
  if (price == null || atrDaily == null || atrDaily <= 0) return false;
  const tol = SWING_NEAR_ZONE_ATR_MULT * atrDaily;
  return zones.some((z) => z != null && z.hasConfluence && Math.abs(price - z.price) <= tol);
}

export function computeSwingDipBounceScore(inp: SwingScoreInputs): DipBounceScore {
  // DAILY_TREND_OK: higher-highs → up, mixed → mixed (both qualify); lower-lows
  // vetoes.
  const trendOk: 0 | 1 =
    inp.trendStructure === 'higher-highs' || inp.trendStructure === 'mixed' ? 1 : 0;

  const nearZone: 0 | 1 = nearConfluentZone(inp.currentPrice, inp.atrDaily, [
    inp.overnightZone,
    inp.multidayZone,
  ])
    ? 1
    : 0;

  // Single-day veto only — absence of band_state isn't "bearish".
  const notBearish: 0 | 1 = inp.sessionRegime === 'bearish_trend' ? 0 : 1;
  const rsiPullback: 0 | 1 = inp.rsi14 != null && inp.rsi14 <= SWING_RSI_PULLBACK_MAX ? 1 : 0;
  const notVolShift: 0 | 1 = inp.volRegimeShift === false ? 1 : 0;

  const components = {
    DAILY_TREND_OK: trendOk,
    NEAR_ENTRY_ZONE_SWING: nearZone,
    NOT_BEARISH_TODAY: notBearish,
    RSI_PULLBACK: rsiPullback,
    NOT_VOL_REGIME_SHIFT: notVolShift,
  };
  const score =
    trendOk * SWING_WEIGHTS.DAILY_TREND_OK +
    nearZone * SWING_WEIGHTS.NEAR_ENTRY_ZONE_SWING +
    notBearish * SWING_WEIGHTS.NOT_BEARISH_TODAY +
    rsiPullback * SWING_WEIGHTS.RSI_PULLBACK +
    notVolShift * SWING_WEIGHTS.NOT_VOL_REGIME_SHIFT;

  return { score, components, dropPct: null, fired: score >= SWING_FIRE_THRESHOLD };
}
