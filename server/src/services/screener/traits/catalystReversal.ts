// catalyst_reversal trait — Batch S2.
//
// Three-stage discovery path that promotes filtered-out tickers back into
// the screener on event days (REPL-on-FDA-day pattern). Per
// spec/signals/screener-universe.md → catalyst_reversal:
//
//   Stage 0: bulk Finnhub /calendar/earnings + (deferred) news sweep →
//            candidate set ~100–300/day. Runs inline in the producer.
//   Stage 1: IB snapshot per candidate → flag those with ≥3× vol vs
//            yesterday AND ≥5% gap/intraday move. ~9 min IB/day.
//            Worker action 'eval_catalyst_stage1' on `ib` pool.
//   Stage 2: ibGateway.history(1y, 1d) per Stage-1 hit → evaluate A ∧ B
//            (beaten-down + confirmed wake-up). ~5–50/day, ~1 min IB.
//            Worker action 'eval_catalyst_stage2' on `ib` pool.
//
// This file holds the two pure evaluators (Stage 1 + Stage 2) — IO lives
// in the producer / worker handler files. Module isolation same as
// conidPicker: vitest exercises the math without supabase/env at load.

export interface CatalystStage1Input {
  /** Today's volume (from IB snapshot field 87). */
  today_volume: number;
  /** Today's last price (snapshot field 31). */
  today_price: number;
  /** Today's open (snapshot field 7295) — used for gap measurement. */
  today_open: number;
  /** Prior close (snapshot field 7296). */
  prev_close: number;
  /** Today's intraday high (snapshot field 70). */
  today_high: number;
  /** Today's intraday low (snapshot field 71). */
  today_low: number;
  /** Baseline volume to compare against. Today the producer passes
   *  universe.last_volume (yesterday's single-day shares) since the
   *  30-day median isn't populated yet — once the weekly producer lands,
   *  swap to universe.last_avg_volume here. */
  baseline_volume: number | null;
}

export interface CatalystStage1Result {
  qualified: boolean;
  vol_multiple: number | null;
  today_move_pct: number | null;
  today_gap_pct: number | null;
}

const STAGE1_VOL_MULTIPLE_MIN = 3.0;
const STAGE1_MOVE_PCT_MIN = 5.0;

/**
 * Stage 1: cheap broad detection from a single IB snapshot. Returns
 * `qualified=true` when BOTH conditions hold:
 *   - today_volume / baseline_volume ≥ 3×
 *   - max(|gap %|, |intraday move %|) ≥ 5%
 *
 * `gap %` = (today_open - prev_close) / prev_close × 100
 * `intraday move %` = (today_high - today_low) / today_open × 100 (range),
 *   bounded below by the open→current move magnitude so a single direction
 *   gap-and-go still passes.
 */
export function evaluateCatalystStage1(input: CatalystStage1Input): CatalystStage1Result {
  const { today_volume, today_price, today_open, prev_close, today_high, today_low, baseline_volume } = input;

  let volMultiple: number | null = null;
  if (baseline_volume != null && baseline_volume > 0 && Number.isFinite(today_volume)) {
    volMultiple = today_volume / baseline_volume;
  }

  let gapPct: number | null = null;
  if (Number.isFinite(prev_close) && prev_close > 0 && Number.isFinite(today_open)) {
    gapPct = ((today_open - prev_close) / prev_close) * 100;
  }

  let movePct: number | null = null;
  if (Number.isFinite(today_open) && today_open > 0) {
    const rangePct = Number.isFinite(today_high) && Number.isFinite(today_low)
      ? ((today_high - today_low) / today_open) * 100
      : 0;
    const directional = Number.isFinite(today_price)
      ? Math.abs(((today_price - today_open) / today_open) * 100)
      : 0;
    movePct = Math.max(rangePct, directional);
  }

  const volOk = volMultiple != null && volMultiple >= STAGE1_VOL_MULTIPLE_MIN;
  const movement = Math.max(
    gapPct != null ? Math.abs(gapPct) : 0,
    movePct ?? 0,
  );
  const moveOk = movement >= STAGE1_MOVE_PCT_MIN;

  return {
    qualified: volOk && moveOk,
    vol_multiple: volMultiple,
    today_move_pct: movePct,
    today_gap_pct: gapPct,
  };
}

// ---------------------------------------------------------------------------
// Stage 2 — A ∧ B over daily bars.
// ---------------------------------------------------------------------------

export interface DailyBar {
  /** Unix ms timestamp of session date. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface CatalystStage2Input {
  /** Daily bars from ibGateway.history(real_conid, '1y', '1d'). Oldest first.
   *  The most recent bar may be today's incomplete bar; consumers should
   *  exclude or trust it consistently — we accept whatever was passed. */
  daily_bars: DailyBar[];
  /** Stage-1 carry-overs (so payload doesn't need re-derivation). */
  vol_multiple: number;
  today_move_pct: number;
  today_gap_pct: number | null;
  today_price: number;
}

export interface CatalystStage2Result {
  /** 0–100 composite; null when A ∧ B doesn't hold. */
  score: number | null;
  payload: {
    vol_multiple: number;
    today_move_pct: number;
    today_gap_pct: number | null;
    today_price: number;
    pct_off_52w_high: number | null;
    sma200: number | null;
    rsi14: number | null;
    /** Which sub-clause of A satisfied (for FE/debug). */
    stage2_basis: 'below_sma200' | 'far_off_52w_high' | 'rsi_below_30' | null;
  };
}

const STAGE2_BELOW_HIGH_PCT = 30;
const STAGE2_RSI_OVERSOLD = 30;
const STAGE2_RSI_LOOKBACK = 30;     // sessions back to scan for RSI<30 print
const STAGE2_SMA_PERIOD = 200;
const STAGE2_RSI_PERIOD = 14;
const STAGE2_52W_LOOKBACK = 252;

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Wilder's RSI(14). Returns the series of RSI values aligned to closes
 * starting at index `period`. Earlier indices are null (warm-up).
 */
export function rsiSeries(closes: number[], period = STAGE2_RSI_PERIOD): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gainSum += d; else lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Stage 2 evaluator. A = beaten-down (any sub-clause); B = confirmed
 * wake-up (Stage 1's vol + move). Stage 1 has already verified B, so we
 * re-emit B for the payload and gate on A here.
 *
 * Score: composite of (vol multiple × move magnitude × depth-from-high),
 * normalized to 0-100.
 */
export function evaluateCatalystStage2(input: CatalystStage2Input): CatalystStage2Result {
  const { daily_bars, vol_multiple, today_move_pct, today_gap_pct, today_price } = input;
  const closes = daily_bars.map((b) => b.c);

  const highs52w = daily_bars.slice(-STAGE2_52W_LOOKBACK).map((b) => b.h);
  const high52w = highs52w.length > 0 ? Math.max(...highs52w) : null;
  const pct_off_52w_high = high52w != null && high52w > 0
    ? ((high52w - today_price) / high52w) * 100
    : null;

  const sma200 = sma(closes, STAGE2_SMA_PERIOD);
  const rsiVals = rsiSeries(closes, STAGE2_RSI_PERIOD);
  const rsi14 = rsiVals.length > 0 ? rsiVals[rsiVals.length - 1] : null;
  const recentRsi = rsiVals.slice(-STAGE2_RSI_LOOKBACK).filter((v): v is number => v != null);
  const rsiOversoldRecently = recentRsi.some((v) => v < STAGE2_RSI_OVERSOLD);

  // A — beaten-down. Pick the satisfying sub-clause (for FE display).
  let basis: CatalystStage2Result['payload']['stage2_basis'] = null;
  if (sma200 != null && today_price < sma200) basis = 'below_sma200';
  else if (pct_off_52w_high != null && pct_off_52w_high > STAGE2_BELOW_HIGH_PCT) basis = 'far_off_52w_high';
  else if (rsiOversoldRecently) basis = 'rsi_below_30';

  const payload: CatalystStage2Result['payload'] = {
    vol_multiple,
    today_move_pct,
    today_gap_pct,
    today_price,
    pct_off_52w_high: pct_off_52w_high != null ? Number(pct_off_52w_high.toFixed(2)) : null,
    sma200: sma200 != null ? Number(sma200.toFixed(4)) : null,
    rsi14: rsi14 != null ? Number(rsi14.toFixed(2)) : null,
    stage2_basis: basis,
  };

  if (basis == null) {
    return { score: null, payload };
  }

  // Composite score: vol multiple (0-40), move % (0-40), depth-from-high
  // (0-20). All saturate at sane upper bounds so a 50× volume spike
  // doesn't overwhelm the other dimensions.
  const volScore   = Math.min(40, (vol_multiple / 10) * 40);
  const moveScore  = Math.min(40, (today_move_pct / 15) * 40);
  const depthScore = pct_off_52w_high != null
    ? Math.min(20, (pct_off_52w_high / 70) * 20)
    : 0;
  const score = Math.round(volScore + moveScore + depthScore);

  return { score, payload };
}
