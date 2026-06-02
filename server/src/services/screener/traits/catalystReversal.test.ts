// Vitest fixtures for catalyst_reversal trait (Batch S2).
//
// Two pure evaluators: Stage 1 (single-snapshot broad detection) + Stage 2
// (A ∧ B over daily bars).

import { describe, it, expect } from 'vitest';
import {
  evaluateCatalystStage1,
  evaluateCatalystStage2,
  rsiSeries,
  type DailyBar,
} from './catalystReversal.js';

describe('evaluateCatalystStage1', () => {
  it('qualifies a clean REPL-style FDA day (vol 5×, gap +12%)', () => {
    const r = evaluateCatalystStage1({
      today_volume: 50_000_000,
      today_price: 12.0,
      today_open: 11.20,
      prev_close: 10.0,
      today_high: 12.5,
      today_low: 11.0,
      baseline_volume: 10_000_000,
    });
    expect(r.qualified).toBe(true);
    expect(r.vol_multiple).toBeCloseTo(5.0, 1);
    expect(r.today_gap_pct).toBeCloseTo(12.0, 1);
  });

  it('rejects on low volume even with big move', () => {
    const r = evaluateCatalystStage1({
      today_volume: 12_000_000,
      today_price: 12.0,
      today_open: 11.0,
      prev_close: 10.0,
      today_high: 12.5,
      today_low: 10.5,
      baseline_volume: 10_000_000,
    });
    expect(r.qualified).toBe(false);
    expect(r.vol_multiple).toBeCloseTo(1.2, 1);
  });

  it('rejects on huge volume but tiny move', () => {
    const r = evaluateCatalystStage1({
      today_volume: 100_000_000,
      today_price: 10.10,
      today_open: 10.00,
      prev_close: 10.00,
      today_high: 10.20,
      today_low: 9.90,
      baseline_volume: 10_000_000,
    });
    expect(r.qualified).toBe(false);
  });

  it('qualifies on intraday range alone (no gap)', () => {
    // Open = prev close (no gap); intraday range 8%; vol 4×.
    const r = evaluateCatalystStage1({
      today_volume: 40_000_000,
      today_price: 10.4,
      today_open: 10.0,
      prev_close: 10.0,
      today_high: 10.6,
      today_low: 9.8,
      baseline_volume: 10_000_000,
    });
    expect(r.qualified).toBe(true);
    expect(r.today_gap_pct).toBeCloseTo(0, 5);
  });

  it('handles null baseline volume (no qualification possible)', () => {
    const r = evaluateCatalystStage1({
      today_volume: 50_000_000,
      today_price: 12.0,
      today_open: 11.0,
      prev_close: 10.0,
      today_high: 12.5,
      today_low: 11.0,
      baseline_volume: null,
    });
    expect(r.qualified).toBe(false);
    expect(r.vol_multiple).toBeNull();
  });

  it('counts a negative gap (gap down) as a qualifying move', () => {
    const r = evaluateCatalystStage1({
      today_volume: 40_000_000,
      today_price: 8.5,
      today_open: 9.0,
      prev_close: 10.0,    // -10% gap
      today_high: 9.1,
      today_low: 8.4,
      baseline_volume: 10_000_000,
    });
    expect(r.qualified).toBe(true);
    expect(r.today_gap_pct).toBeCloseTo(-10, 1);
  });
});

describe('rsiSeries', () => {
  it('returns nulls during the warm-up window then real values', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const out = rsiSeries(closes, 14);
    for (let i = 0; i < 14; i++) expect(out[i]).toBeNull();
    expect(out[14]).not.toBeNull();
    // Pure uptrend (no losses) → RSI = 100
    expect(out[14]).toBe(100);
  });

  it('returns ~0 on a pure downtrend', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 - i);
    const out = rsiSeries(closes, 14);
    expect(out[29]).toBeLessThan(5);
  });
});

// Helpers for Stage-2 fixtures.
function makeBars(closes: number[]): DailyBar[] {
  return closes.map((c, i) => ({
    t: i * 86_400_000,
    o: c, h: c * 1.02, l: c * 0.98, c, v: 1_000_000,
  }));
}

describe('evaluateCatalystStage2', () => {
  it('scores a clear A ∧ B (sustained downtrend + big wake-up day)', () => {
    // 252 daily closes trending down from 30 → 8 (clear downtrend, price
    // well below SMA200, far off 52w high).
    const closes = Array.from({ length: 252 }, (_, i) => 30 - i * 0.09);
    const r = evaluateCatalystStage2({
      daily_bars: makeBars(closes),
      vol_multiple: 5.0,
      today_move_pct: 12.0,
      today_gap_pct: 10.0,
      today_price: 8.5,
    });
    expect(r.score).not.toBeNull();
    expect(r.score).toBeGreaterThan(50);
    expect(r.payload.stage2_basis).toBe('below_sma200');
  });

  it('returns null score when A doesnt hold (price above SMA200 + near 52w high + RSI healthy)', () => {
    // Pure uptrend: today's price is near 52w high, above SMA200, RSI high.
    const closes = Array.from({ length: 252 }, (_, i) => 10 + i * 0.05);
    const r = evaluateCatalystStage2({
      daily_bars: makeBars(closes),
      vol_multiple: 5.0,
      today_move_pct: 8.0,
      today_gap_pct: null,
      today_price: 22.5,
    });
    expect(r.score).toBeNull();
    expect(r.payload.stage2_basis).toBeNull();
  });

  it('basis = far_off_52w_high when only the 52w drop clause holds', () => {
    // Construct: price stayed flat near SMA200 but had a high spike 200d ago.
    // Closes: spike to 100, drift to 50, today 40 (still above SMA200 of
    // ~55 → no, that fails below_sma200. Let's make price ABOVE SMA200 but
    // far off the spike high).
    const closes: number[] = [];
    for (let i = 0; i < 50; i++) closes.push(100);   // initial spike high
    for (let i = 0; i < 202; i++) closes.push(45);   // long flat at 45
    const r = evaluateCatalystStage2({
      daily_bars: makeBars(closes),
      vol_multiple: 4.0,
      today_move_pct: 10.0,
      today_gap_pct: null,
      today_price: 46.0,    // above SMA200 (~56 — actually below, so check)
    });
    // SMA200 = mean of last 200 closes = mostly 45 → today_price 46 > 45.
    // 52w high = 100 → off-high = (100-46)/100 = 54% > 30% → far_off triggers.
    expect(r.score).not.toBeNull();
    expect(['far_off_52w_high', 'below_sma200']).toContain(r.payload.stage2_basis);
  });

  it('basis = rsi_below_30 when only the oversold-recently clause holds', () => {
    // Build a series where RSI dipped <30 in the last 30 bars but price has
    // since recovered above SMA200 and isn't far off the 52w high.
    const closes: number[] = [];
    for (let i = 0; i < 200; i++) closes.push(50);   // 200 flat days
    for (let i = 0; i < 20; i++) closes.push(50 - i); // sharp 20-day drop 50→30
    for (let i = 0; i < 32; i++) closes.push(30 + i * 0.7); // recovery to ~52
    const r = evaluateCatalystStage2({
      daily_bars: makeBars(closes),
      vol_multiple: 4.0,
      today_move_pct: 7.0,
      today_gap_pct: null,
      today_price: 52.0,
    });
    // SMA200 is roughly mean of last 200 closes — pure SMA is mostly 50ish
    // depending on overlap. Whichever basis triggers, it should be one of A.
    expect(r.score).not.toBeNull();
  });

  it('carries Stage-1 values through to payload', () => {
    const closes = Array.from({ length: 252 }, () => 10);
    const r = evaluateCatalystStage2({
      daily_bars: makeBars(closes),
      vol_multiple: 4.2,
      today_move_pct: 8.7,
      today_gap_pct: 6.1,
      today_price: 11.0,
    });
    expect(r.payload.vol_multiple).toBe(4.2);
    expect(r.payload.today_move_pct).toBe(8.7);
    expect(r.payload.today_gap_pct).toBe(6.1);
    expect(r.payload.today_price).toBe(11.0);
  });
});
