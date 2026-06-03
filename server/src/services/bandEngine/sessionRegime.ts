// Band engine — Layer 1: session regime classifier (Batch S3).
//
// Publishes one label per ticker per day at 15:45 IDT (15 min after regular
// open). Pure function — given the day's gap %, first-15-min direction %,
// and pre-market relative volume, returns the regime label. The label rides
// on band_state.session_regime; FE renders it as a small chip + uses it to
// dim bands that won't fill ("bullish_trend dims the low band" etc.).
//
// Spec: spec/signals/band-engine.md → Layer 1.
//
// Thresholds (anchored to the spec table):
//   |gap| < 2%               → flat-ish, base case
//   |gap| ≥ 2% AND aligned   → trend day (bullish if up, bearish if down)
//   |gap| ≥ 2% AND opposed   → mixed
//   |gap| < 2% AND large first-15-min move → mixed
//
// premktVolRatio = today's pre-mkt cumulative vs 30d pre-mkt median. Currently
// only used to upgrade an otherwise-flat day to `mixed` when pre-mkt was
// abnormally heavy (>2x); it doesn't shift the trend labels (the gap+first15
// signal owns those). When premkt volume telemetry isn't available, pass null.

export type SessionRegime =
  | 'mean_reversion'
  | 'bullish_trend'
  | 'bearish_trend'
  | 'mixed';

export interface SessionRegimeInputs {
  /** Today's open vs prior regular-session close, signed % (e.g. +3.2 for a 3.2% gap up). */
  gapPct: number;
  /** Close at (regular_open + 15min) vs regular_open, signed %. */
  first15Pct: number;
  /** Pre-mkt cumulative volume / 30d pre-mkt median. null when unavailable. */
  premktVolRatio: number | null;
}

const GAP_TREND_THRESHOLD_PCT = 2;     // |gap| ≥ this counts as a meaningful gap
const FIRST15_MOVE_THRESHOLD_PCT = 1;  // |first15| ≥ this counts as directional
const PREMKT_VOL_ABNORMAL = 2;         // ratio above this on a flat day → mixed

export function classifySessionRegime(inp: SessionRegimeInputs): SessionRegime {
  const { gapPct, first15Pct, premktVolRatio } = inp;
  const gapUp = gapPct >= GAP_TREND_THRESHOLD_PCT;
  const gapDown = gapPct <= -GAP_TREND_THRESHOLD_PCT;
  const first15Up = first15Pct >= FIRST15_MOVE_THRESHOLD_PCT;
  const first15Down = first15Pct <= -FIRST15_MOVE_THRESHOLD_PCT;

  // Trend days — gap and first-15 aligned.
  if (gapUp && first15Up) return 'bullish_trend';
  if (gapDown && first15Down) return 'bearish_trend';

  // Conflicting signals — gap one way, first-15 the other way.
  if ((gapUp && first15Down) || (gapDown && first15Up)) return 'mixed';

  // Flat-ish gap. Large opening move with no gap context = mixed.
  if (!gapUp && !gapDown && (first15Up || first15Down)) return 'mixed';

  // Flat gap + flat first-15. Check abnormal pre-mkt volume as a tiebreaker.
  if (premktVolRatio != null && premktVolRatio >= PREMKT_VOL_ABNORMAL) {
    return 'mixed';
  }
  return 'mean_reversion';
}
