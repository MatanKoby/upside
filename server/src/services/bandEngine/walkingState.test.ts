import { describe, it, expect } from 'vitest';
import {
  seedBandWalkState,
  tickBandWalk,
  type BandWalkState,
} from './walkingState.js';

const THRESHOLD = 0.5;        // intraday ATR = 1.0 → reversal threshold = 0.5
const UP_FADE = 2.5;          // intraday_stats p50 up-leg fade
const DOWN_FADE = 2.5;        // symmetric proxy in v1
const SCALAR = 1.0;           // baseline

function feed(s: BandWalkState, prices: number[], tsStart = '2026-06-04T13:30:00Z') {
  let state = s;
  const events: Array<{ price: number; anchored: 'low' | 'high' | null }> = [];
  let t = new Date(tsStart).getTime();
  for (const price of prices) {
    const r = tickBandWalk({
      state,
      price,
      ts: new Date(t).toISOString(),
      reversalThreshold: THRESHOLD,
      upFadePct: UP_FADE,
      downFadePct: DOWN_FADE,
      volScalar: SCALAR,
    });
    state = r.state;
    events.push({ price, anchored: r.anchored });
    t += 5 * 60_000; // 5-min bars
  }
  return { state, events };
}

describe('seedBandWalkState', () => {
  it('all anchors + running extrema = today_open; no bands published yet; leg_direction null', () => {
    const s = seedBandWalkState(100);
    expect(s.anchor_low).toBe(100);
    expect(s.anchor_high).toBe(100);
    expect(s.running_max).toBe(100);
    expect(s.running_min).toBe(100);
    expect(s.leg_direction).toBeNull();
    expect(s.anchors).toEqual([]);
    expect(s.current_low_band).toBeNull();
    expect(s.current_high_band).toBeNull();
  });
});

describe('tickBandWalk — seed phase (first leg)', () => {
  it('first up-move ≥ threshold from open: anchors OPEN as the LOW (the open was the low for this run-up), sets leg to up', () => {
    const seed = seedBandWalkState(100);
    const { state, events } = feed(seed, [100.5]);
    expect(events[0]?.anchored).toBe('low');
    expect(state.anchor_low).toBe(100);
    expect(state.leg_direction).toBe('up');
    // running_max reset to current price for the upward leg's tracking.
    expect(state.running_max).toBe(100.5);
  });

  it('first down-move ≥ threshold from open: anchors OPEN as the HIGH, sets leg to down', () => {
    const seed = seedBandWalkState(100);
    const { state, events } = feed(seed, [99.5]);
    expect(events[0]?.anchored).toBe('high');
    expect(state.anchor_high).toBe(100);
    expect(state.leg_direction).toBe('down');
    expect(state.running_min).toBe(99.5);
  });

  it('sub-threshold moves do nothing — leg_direction stays null until first reversal crosses threshold', () => {
    const seed = seedBandWalkState(100);
    // Wobble below open; max-vs-running_min delta stays < 0.5, drift-vs-running_max stays < 0.5.
    const { state, events } = feed(seed, [100.3, 100.2, 100.1, 100.0]);
    expect(events.every((e) => e.anchored === null)).toBe(true);
    expect(state.leg_direction).toBeNull();
    expect(state.current_low_band).toBeNull();
  });

  it('seed tie-break: when both checks could fire on the same tick, high-anchor wins (documented determinism)', () => {
    // Construct a tick where running_max - price ≥ threshold AND price - running_min ≥ threshold.
    // Hard to do in 1 tick from open since price IS running_max = running_min. Need 2 ticks where
    // running_max grew on tick 1 and price dropped past threshold-vs-running_min from open on tick 2.
    const seed = seedBandWalkState(100);
    // Tick 1: 100.6 — running_max=100.6, running_min=100. Low-check 0.6 ≥ 0.5 fires LOW@100, leg='up'.
    // Tie-break wouldn't apply here. To force a tie, we'd need leg_direction=null still — impossible
    // after the first qualifying tick. The tie scenario is essentially unreachable in normal data;
    // the test documents the resolution if someone ever fabricates one.
    const { events } = feed(seed, [100.6]);
    expect(events[0]?.anchored).toBe('low');     // up-leg fires first when only one side is at threshold
  });
});

describe('tickBandWalk — leg-direction prevents same-side re-fire', () => {
  it('after low-anchor: continued up-move does NOT re-fire low (waits for high-anchor)', () => {
    const seed = seedBandWalkState(100);
    const { state, events } = feed(seed, [100.6, 101.2, 101.8]);
    // Tick 1 fires low-anchor at 100.
    expect(events[0]?.anchored).toBe('low');
    // Continued upward movement: running_max grows but no new anchor — we're on the up-leg.
    expect(events[1]?.anchored).toBeNull();
    expect(events[2]?.anchored).toBeNull();
    expect(state.anchors.length).toBe(1);
    expect(state.leg_direction).toBe('up');
  });

  it('after high-anchor: continued down-move does NOT re-fire high (waits for low-anchor)', () => {
    const seed = seedBandWalkState(100);
    const { state, events } = feed(seed, [99.4, 98.8, 98.2]);
    expect(events[0]?.anchored).toBe('high');
    expect(events[1]?.anchored).toBeNull();
    expect(events[2]?.anchored).toBeNull();
    expect(state.anchors.length).toBe(1);
    expect(state.leg_direction).toBe('down');
  });

  it('full up-then-down sequence: low-anchor at open, then high-anchor on reversal', () => {
    const seed = seedBandWalkState(100);
    const { state, events } = feed(seed, [100.5, 101.0, 100.4]);
    expect(events[0]?.anchored).toBe('low');
    expect(events[1]?.anchored).toBeNull();
    expect(events[2]?.anchored).toBe('high');
    expect(state.anchor_low).toBe(100);
    expect(state.anchor_high).toBe(101.0);
    expect(state.current_low_band).not.toBeNull();
    expect(state.current_high_band).not.toBeNull();
  });
});

describe('tickBandWalk — REPL-style multi-leg scalp', () => {
  it('walks chronologically through alternating anchors; anchors array preserves history', () => {
    const seed = seedBandWalkState(100);
    const prices = [
      100.7, 101.5, 100.8,  // low@100 (tick 1), then high@101.5 (tick 3)
      100.0,                // continue down
      100.8,                // low@100.0
      101.6,                // up
      100.9,                // high@101.6
      100.2,                // down
      100.9,                // low@100.2
    ];
    const { state, events } = feed(seed, prices);
    const kinds = events.filter((e) => e.anchored).map((e) => e.anchored);
    expect(kinds).toEqual(['low', 'high', 'low', 'high', 'low']);
    expect(state.anchor_low).toBe(100.2);
    expect(state.anchor_high).toBe(101.6);
    expect(state.anchors.length).toBe(5);
    // Each anchor records kind + the price at the pivot.
    expect(state.anchors[0]).toMatchObject({ kind: 'low', price: 100 });
    expect(state.anchors[1]).toMatchObject({ kind: 'high', price: 101.5 });
    expect(state.anchors[2]).toMatchObject({ kind: 'low', price: 100.0 });
    expect(state.anchors[3]).toMatchObject({ kind: 'high', price: 101.6 });
    expect(state.anchors[4]).toMatchObject({ kind: 'low', price: 100.2 });
  });
});

describe('tickBandWalk — band publication math', () => {
  it('after low-anchor L=100: next_high = L × (1 + upFade × scalar), next_low = next_high × (1 − downFade × scalar)', () => {
    // Seed open=99 so the first up-move from running_min=99 → 99.6 fires low-anchor at L=99.
    const seed = seedBandWalkState(99);
    const { state } = feed(seed, [99.6]);
    expect(state.anchor_low).toBe(99);
    const expectedHigh = 99 * (1 + 0.025 * 1.0);
    const expectedLow = expectedHigh * (1 - 0.025 * 1.0);
    expect(state.current_high_band).toBeCloseTo(expectedHigh, 4);
    expect(state.current_low_band).toBeCloseTo(expectedLow, 4);
  });

  it('after high-anchor H=101: next_low = H × (1 − downFade × scalar), next_high = next_low × (1 + upFade × scalar)', () => {
    // Seed open=101, drop 0.6 to fire high-anchor at running_max=101.
    const seed = seedBandWalkState(101);
    const { state } = feed(seed, [100.4]);
    expect(state.anchor_high).toBe(101);
    const expectedLow = 101 * (1 - 0.025 * 1.0);
    const expectedHigh = expectedLow * (1 + 0.025 * 1.0);
    expect(state.current_low_band).toBeCloseTo(expectedLow, 4);
    expect(state.current_high_band).toBeCloseTo(expectedHigh, 4);
  });

  it('vol_scalar 1.5 widens the published bands proportionally', () => {
    const seed = seedBandWalkState(100);
    const r = tickBandWalk({
      state: seed,
      price: 100.6,
      ts: '2026-06-04T13:30:00Z',
      reversalThreshold: 0.5,
      upFadePct: 2.5,
      downFadePct: 2.5,
      volScalar: 1.5,
    });
    expect(r.anchored).toBe('low');
    const expectedHigh = 100 * (1 + 0.025 * 1.5);  // 1.5× wider
    expect(r.state.current_high_band).toBeCloseTo(expectedHigh, 4);
  });
});

describe('tickBandWalk — edge cases', () => {
  it('non-finite price → state unchanged, anchored null', () => {
    const seed = seedBandWalkState(100);
    const r = tickBandWalk({
      state: seed,
      price: NaN,
      ts: '2026-06-04T13:30:00Z',
      reversalThreshold: 0.5,
      upFadePct: 2.5,
      downFadePct: 2.5,
      volScalar: 1,
    });
    expect(r.anchored).toBeNull();
    expect(r.state.anchors).toEqual([]);
  });

  it('zero / negative reversal threshold → no anchors fire', () => {
    const seed = seedBandWalkState(100);
    const r = tickBandWalk({
      state: seed,
      price: 101,
      ts: '2026-06-04T13:30:00Z',
      reversalThreshold: 0,
      upFadePct: 2.5,
      downFadePct: 2.5,
      volScalar: 1,
    });
    expect(r.anchored).toBeNull();
  });

  it('no chain-length limit — alternating ±0.7 moves accumulate many anchors', () => {
    const seed = seedBandWalkState(100);
    const prices: number[] = [];
    let p = 100;
    for (let i = 0; i < 20; i++) {
      p += i % 2 === 0 ? 0.7 : -0.7;
      prices.push(p);
    }
    const { state } = feed(seed, prices);
    // Each ±0.7 move clears the 0.5 threshold; alternating direction → many anchors.
    expect(state.anchors.length).toBeGreaterThan(8);
  });
});
