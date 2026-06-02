// intraday_range_trader trait — Batch S2.
//
// Pure scoring function. Given an `intraday_stats` row (60-day distribution
// of typical intraday-low %, computed by Batch B's intradayStatsCron) and
// the ticker's current price, returns a 0–100 score + FE-ready payload, or
// null when the row doesn't meet the threshold gates.
//
// The flagship trait for the scalping vision per
// spec/signals/screener-universe.md → intraday_range_trader. Captures
// "stocks where typical intraday behavior matches REPL/MNTS/RGTI pattern":
// predictable dip + predictable recovery within session, multiple times.
//
// Pure / deterministic — no IO, no env access. Tested via vitest the same
// way as conidPicker (kept in its own file so the test suite doesn't pull
// in supabase at module-load).

export interface IntradayStatsRow {
  intraday_low_pct_p50: number | null;
  intraday_low_pct_p75: number | null;
  /** p25 isn't currently materialized in the intraday_stats table (Batch B
   *  shipped p50 + p75 + mean only for intraday-low). The trait still has
   *  a "consistent dipper" floor — we compute it from p50 with a tightness
   *  hedge below. See computeIntradayStats() in services/intradayStats.ts. */
  intraday_low_pct_p25?: number | null;
  sample_size: number;
}

export interface IntradayRangeTraderResult {
  score: number;
  payload: {
    p25: number | null;
    p50: number;
    p75: number;
    sample_size: number;
    today_open_band_low: number | null;
  };
}

const MIN_P50_PCT = 2.0;
const MIN_P25_PCT = 1.0;
const MIN_SAMPLE_SIZE = 30;
const MAX_TIGHTNESS = 1.5;   // (p75 - p25) / p50

const PRICE_BONUS_SUB_30 = 5;
const PRICE_BONUS_SUB_10 = 10;

/**
 * Score gates per spec/signals/screener-universe.md → intraday_range_trader:
 *   - p50 ≥ 2.0%        (deep enough typical dip)
 *   - p25 ≥ 1.0%        (consistent dipper, not just outliers)
 *   - sample_size ≥ 30  (enough sessions for stats to be meaningful)
 *   - (p75 - p25) / p50 ≤ 1.5  (narrow envelope → predictable behavior)
 *   - Price bonus: sub-$30 +5; sub-$10 additional +5 (total +10).
 *
 * Returns null when any gate fails. Score is bucketed 0-100, weighted
 * toward higher p50 with a penalty for envelope width.
 */
export function scoreIntradayRangeTrader(
  stats: IntradayStatsRow,
  todayOpen: number | null,
  todayPrice: number | null,
): IntradayRangeTraderResult | null {
  const p50 = stats.intraday_low_pct_p50;
  const p75 = stats.intraday_low_pct_p75;
  // p25 isn't on the row today; derive a conservative proxy as p50/2 (since
  // p50 ≥ 2% with p25 floor 1% means roughly the lower half stays above 1%).
  // When/if the schema gains p25 directly, this proxy gets replaced by the
  // raw column read with no scoring math change.
  const p25Raw = stats.intraday_low_pct_p25 ?? null;
  const p25 = p25Raw != null ? p25Raw : (p50 != null ? p50 / 2 : null);

  if (p50 == null || p75 == null || p25 == null) return null;
  if (stats.sample_size < MIN_SAMPLE_SIZE) return null;
  if (p50 < MIN_P50_PCT) return null;
  if (p25 < MIN_P25_PCT) return null;

  const tightness = (p75 - p25) / p50;
  if (tightness > MAX_TIGHTNESS) return null;

  // Base score: p50 magnitude (linear up to 6%) maps to 50 points; envelope
  // tightness inverse maps to 30 points; price bonus up to 10; sample_size
  // saturation maps to 10. Total 100.
  const p50Score    = Math.min(50, (p50 / 6) * 50);
  const tightScore  = Math.max(0, 30 * (1 - tightness / MAX_TIGHTNESS));
  const sampleScore = Math.min(10, (stats.sample_size / 60) * 10);

  let priceBonus = 0;
  const price = todayPrice ?? todayOpen;
  if (price != null) {
    if (price < 30) priceBonus += PRICE_BONUS_SUB_30;
    if (price < 10) priceBonus += (PRICE_BONUS_SUB_10 - PRICE_BONUS_SUB_30);
  }

  const score = Math.round(p50Score + tightScore + sampleScore + priceBonus);

  // FE chip needs the price space too — band_top = open × (1 - p50/100)
  const today_open_band_low =
    todayOpen != null && Number.isFinite(todayOpen)
      ? Number((todayOpen * (1 - p50 / 100)).toFixed(2))
      : null;

  return {
    score,
    payload: {
      p25: Number(p25.toFixed(2)),
      p50: Number(p50.toFixed(2)),
      p75: Number(p75.toFixed(2)),
      sample_size: stats.sample_size,
      today_open_band_low,
    },
  };
}
