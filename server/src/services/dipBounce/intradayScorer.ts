// Intraday dip-bounce scorer (Batch X1) — pure composition of table inputs.
// No recompute, no IB/Finnhub. Caller assembles inputs from quotes +
// intraday_stats + band_state + entry_zones and applies the cooldown.
// See spec/signals/dip-bounce-scorer.md → Intraday scorer.

import {
  INTRADAY_WEIGHTS,
  INTRADAY_FIRE_THRESHOLD,
} from '../../config/dipBounceScorer.js';

export interface IntradayScoreInputs {
  todayOpen: number | null;
  currentPrice: number | null;
  intradayLowPctP50: number | null; // typical intraday-low % (stats.md)
  intradayLowPctP75: number | null; // deep intraday-low % (the veto boundary)
  sessionRegime: string | null; // band_state.session_regime
  volRegimeShift: boolean | null; // band_state.vol_regime_shift
  intradayZone: { trendRegime: string | null; hasConfluence: boolean } | null; // entry_zones intraday
}

export interface DipBounceScore {
  score: number;
  components: Record<string, 0 | 1>;
  /** drop from open %, surfaced for the Discord embed / diagnostics. */
  dropPct: number | null;
  fired: boolean; // score ≥ threshold (cooldown applied by the caller)
}

export function computeIntradayDipBounceScore(inp: IntradayScoreInputs): DipBounceScore {
  const dropPct =
    inp.todayOpen != null && inp.currentPrice != null && inp.todayOpen > 0
      ? ((inp.todayOpen - inp.currentPrice) / inp.todayOpen) * 100
      : null;

  // IN_TYPICAL_BAND: drop in [p50, p75). Critical guard — deep (≥ p75) is the
  // outlier-day signal where the 60d prior misfires, so it scores 0.
  let inTypicalBand: 0 | 1 = 0;
  if (dropPct != null && inp.intradayLowPctP50 != null && dropPct >= inp.intradayLowPctP50) {
    if (inp.intradayLowPctP75 == null || dropPct < inp.intradayLowPctP75) inTypicalBand = 1;
  }

  const meanReversion: 0 | 1 =
    inp.sessionRegime === 'mean_reversion' || inp.sessionRegime === 'mixed' ? 1 : 0;
  const notVolShift: 0 | 1 = inp.volRegimeShift === false ? 1 : 0;
  const confluence: 0 | 1 = inp.intradayZone?.hasConfluence ? 1 : 0;
  const trendOk: 0 | 1 =
    inp.intradayZone?.trendRegime === 'up' || inp.intradayZone?.trendRegime === 'mixed' ? 1 : 0;

  const components = {
    IN_TYPICAL_BAND: inTypicalBand,
    MEAN_REVERSION_REGIME: meanReversion,
    NOT_VOL_REGIME_SHIFT: notVolShift,
    ENTRY_ZONE_CONFLUENCE: confluence,
    ENTRY_ZONE_TREND_OK: trendOk,
  };
  const score =
    inTypicalBand * INTRADAY_WEIGHTS.IN_TYPICAL_BAND +
    meanReversion * INTRADAY_WEIGHTS.MEAN_REVERSION_REGIME +
    notVolShift * INTRADAY_WEIGHTS.NOT_VOL_REGIME_SHIFT +
    confluence * INTRADAY_WEIGHTS.ENTRY_ZONE_CONFLUENCE +
    trendOk * INTRADAY_WEIGHTS.ENTRY_ZONE_TREND_OK;

  return { score, components, dropPct, fired: score >= INTRADAY_FIRE_THRESHOLD };
}
