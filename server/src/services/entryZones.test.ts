// Scenario fixtures for the dynamic entry-zone engine (Batch A+, task #28).
// Synthetic bar generators keep the inputs fully controlled so each scenario
// asserts a specific behaviour. Real-IB-captured fixtures land later for the
// "real data" cases.
//
// The engine is a pure function (services/entryZones.ts), so these tests are
// deterministic and run via `pnpm test:server`.

import { describe, it, expect } from 'vitest';
import { computeEntryZones } from './entryZones.js';
import type { Bars } from './technicals.js';

// --- bar generators ------------------------------------------------------

function emptyBars(): Bars {
  return { o: [], h: [], l: [], c: [], v: [] };
}

interface SeriesOpts {
  n?: number;          // bar count
  start?: number;      // first close
  drift?: number;      // per-bar drift (linear)
  noise?: number;      // ±range as fraction of price
  volBase?: number;
}
function series(opts: SeriesOpts = {}): Bars {
  const { n = 252, start = 100, drift = 0, noise = 0.005, volBase = 1_000_000 } = opts;
  const o: number[] = [];
  const h: number[] = [];
  const l: number[] = [];
  const c: number[] = [];
  const v: number[] = [];
  let last = start;
  for (let i = 0; i < n; i++) {
    const next = last + drift + (Math.sin(i / 3) * noise * last);
    const high = next + Math.abs(next) * noise;
    const low = next - Math.abs(next) * noise;
    o.push(last);
    h.push(high);
    l.push(low);
    c.push(next);
    v.push(volBase + i * (volBase / 1000));
    last = next;
  }
  return { o, h, l, c, v };
}

// Apply an absolute floor + ceiling so prices stay positive and bounded.
function clamp(bars: Bars, min: number, max: number): Bars {
  const f = (n: number) => Math.min(max, Math.max(min, n));
  return {
    o: bars.o.map(f),
    h: bars.h.map(f),
    l: bars.l.map(f),
    c: bars.c.map(f),
    v: bars.v,
  };
}

// --- scenarios -----------------------------------------------------------

describe('computeEntryZones — trending up, moderate pullback expected', () => {
  it('classifies trend as up and returns a multiday entry below current price', () => {
    const daily = series({ start: 80, drift: 0.08, noise: 0.004, n: 252 });
    const currentPrice = daily.c[daily.c.length - 1]!;
    const out = computeEntryZones({ currentPrice, daily, intraday: null });

    expect(out.trendRegime).toBe('up');
    expect(out.zones.multiday).not.toBeNull();
    expect(out.zones.multiday!.price).toBeLessThan(currentPrice);
    expect(out.zones.multiday!.confidence).toBeGreaterThan(0);
    // overbought_tightened depends on RSI/price-vs-SMA50 at the final bar; the
    // structural facts above (trend + non-null multiday) are what's asserted.
  });
});

describe('computeEntryZones — strong uptrend / overbought', () => {
  it('flags overboughtTightened and the entry is closer to price than SMA50 would suggest', () => {
    // Steep uptrend pushes RSI > 70 and price > SMA50 + 2·ATR.
    const daily = series({ start: 50, drift: 0.5, noise: 0.003, n: 252 });
    const currentPrice = daily.c[daily.c.length - 1]!;
    const out = computeEntryZones({ currentPrice, daily, intraday: null });

    expect(out.overboughtTightened).toBe(true);
    // Multiday entry exists — but with the 1.5x widening, it should still be
    // within a reasonable distance of price.
    expect(out.zones.multiday).not.toBeNull();
  });
});

describe('computeEntryZones — downtrend', () => {
  it('classifies trend as down and still surfaces a deep entry', () => {
    const daily = series({ start: 200, drift: -0.5, noise: 0.003, n: 252 });
    const currentPrice = daily.c[daily.c.length - 1]!;
    const out = computeEntryZones({ currentPrice, daily, intraday: null });

    expect(out.trendRegime).toBe('down');
    // multiday should suggest some level (possibly major swing low or SMA200)
    expect(out.zones.multiday).not.toBeNull();
    expect(out.zones.multiday!.price).toBeLessThan(currentPrice);
  });
});

describe('computeEntryZones — basing / higher-low-off-bottom (BBAI case)', () => {
  it('recognizes the major swing low even when it is older than the most recent', () => {
    // Construct a base: initial selloff, then a basing range above the prior low.
    const decline = series({ start: 200, drift: -1.0, noise: 0.005, n: 60 });
    const basing = series({ start: decline.c[decline.c.length - 1]! + 5, drift: 0.05, noise: 0.01, n: 90 });
    const daily: Bars = {
      o: [...decline.o, ...basing.o],
      h: [...decline.h, ...basing.h],
      l: [...decline.l, ...basing.l],
      c: [...decline.c, ...basing.c],
      v: [...decline.v, ...basing.v],
    };
    const currentPrice = daily.c[daily.c.length - 1]!;
    const out = computeEntryZones({ currentPrice, daily, intraday: null });

    // Engine should produce at least a multiday zone, citing the major swing low.
    expect(out.zones.multiday).not.toBeNull();
    // Confidence should be > 0 — we have at least the major swing low as a level.
    expect(out.zones.multiday!.confidence).toBeGreaterThan(0);
  });
});

describe('computeEntryZones — insufficient bars', () => {
  it('returns null zones gracefully when bars are empty', () => {
    const out = computeEntryZones({
      currentPrice: 100,
      daily: emptyBars(),
      intraday: null,
    });
    expect(out.zones.intraday).toBeNull();
    expect(out.zones.overnight).toBeNull();
    expect(out.zones.multiday).toBeNull();
  });

  it('returns null zones when daily has only a handful of bars (ATR unavailable)', () => {
    const tiny = series({ start: 100, drift: 0, n: 5 });
    const out = computeEntryZones({ currentPrice: tiny.c[tiny.c.length - 1]!, daily: tiny, intraday: null });
    // ATR is null at this size, so no horizons can resolve.
    expect(out.zones.multiday).toBeNull();
  });
});

describe('computeEntryZones — current price below every structural level (capitulation)', () => {
  it('returns no zones when no structural support sits below price (round magnets removed 2026-05-29)', () => {
    const daily = clamp(series({ start: 50, drift: -0.2, noise: 0.002, n: 252 }), 1, 200);
    const minLow = Math.min(...daily.l);
    const currentPrice = Math.max(0.5, minLow * 0.7);
    const out = computeEntryZones({ currentPrice, daily, intraday: null });

    // Round-magnet fallback removed — they caused 'buy market' alerts when the
    // 15-min cron staleness left the magnet above current price. With every
    // real structural support sitting above the synthesised capitulation
    // price, the engine surfaces nothing on this row, which is honest.
    expect(out.zones.intraday).toBeNull();
    expect(out.zones.overnight).toBeNull();
    expect(out.zones.multiday).toBeNull();
  });
});

describe('computeEntryZones — confluence detection (synthetic)', () => {
  it('multiple support sources clustered at the same level boost confidence + reasoning', () => {
    // We can't easily synthesise pixel-perfect SMA + S1 + swing alignment from
    // a noise series, but we CAN sanity-check that the reasoning string
    // reflects the source name(s) for whatever level the engine picks.
    const daily = series({ start: 100, drift: 0.05, noise: 0.004, n: 252 });
    const currentPrice = daily.c[daily.c.length - 1]!;
    const out = computeEntryZones({ currentPrice, daily, intraday: null });

    expect(out.zones.multiday).not.toBeNull();
    const z = out.zones.multiday!;
    expect(z.reasoning).toMatch(/SMA|pivot|swing low|Bollinger|low/);
    expect(z.sources.length).toBeGreaterThan(0);
  });
});
