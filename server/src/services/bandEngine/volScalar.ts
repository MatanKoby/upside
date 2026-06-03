// Band engine — Layer 2: today's vol scalar (Batch S3).
//
// Compares the last 12 five-min bars' ATR to a 30d baseline ATR. Returns a
// band-width multiplier + an annotation enum. Updates every 5 min during the
// regular session. The static `intraday_stats` p50 band is wrong when today's
// realized vol deviates from the 60d aggregate; this layer is the magnitude
// scalar that fixes that.
//
// Spec: spec/signals/band-engine.md → Layer 2.
//
// Validated empirically 2026-05-30: on MNTS the static band predicted a low
// of $17.96, but realized fade was 16.67% (60d p50 = 6.46%). vol_ratio ≈ 2.6
// would have pushed band_width × 1.5, widening the published low to ~$16.00 —
// covering the user's three actual buys.

/** ATR = simple-moving-average of true-range over the bar window. */
export function atr(bars: ReadonlyArray<{ h: number; l: number; c: number }>): number | null {
  if (bars.length < 2) return null;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    if (!Number.isFinite(cur.h) || !Number.isFinite(cur.l) || !Number.isFinite(prev.c)) continue;
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c),
    );
    if (Number.isFinite(tr)) {
      sum += tr;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

export type VolAnnotation = 'high_vol_today' | 'calm_day' | null;

export interface VolScalarResult {
  /** Multiplier to apply to band_width. 1.0 = baseline. */
  scalar: number;
  /** FE chip annotation; null when at baseline. */
  annotation: VolAnnotation;
  /** Raw vol_ratio for debug/back-test logs. */
  ratio: number;
}

const HIGH_VOL_THRESHOLD = 1.5;   // > this → widen 1.5×
const CALM_VOL_THRESHOLD = 0.5;   // < this → tighten 0.7×
const HIGH_VOL_MULT = 1.5;
const CALM_VOL_MULT = 0.7;
const BASELINE_MULT = 1.0;

export interface VolScalarInputs {
  /** Most recent 12 five-min bars (or however many are available so far today). */
  recentBars: ReadonlyArray<{ h: number; l: number; c: number }>;
  /** 30d baseline ATR (from the same 5-min granularity, e.g. avg of session-ATRs). */
  baselineAtr: number | null;
}

/**
 * Returns the band-width scalar + annotation for the moment-in-session this
 * is called. Returns baseline (1.0, null) when inputs are insufficient — the
 * cron then publishes bands at the static p50 width, which is the right
 * fallback when we can't compute the scalar.
 */
export function computeVolScalar(inp: VolScalarInputs): VolScalarResult {
  const todayAtr = atr(inp.recentBars);
  const base = inp.baselineAtr;
  if (todayAtr == null || base == null || !Number.isFinite(base) || base <= 0) {
    return { scalar: BASELINE_MULT, annotation: null, ratio: NaN };
  }
  const ratio = todayAtr / base;
  if (ratio > HIGH_VOL_THRESHOLD) {
    return { scalar: HIGH_VOL_MULT, annotation: 'high_vol_today', ratio };
  }
  if (ratio < CALM_VOL_THRESHOLD) {
    return { scalar: CALM_VOL_MULT, annotation: 'calm_day', ratio };
  }
  return { scalar: BASELINE_MULT, annotation: null, ratio };
}
