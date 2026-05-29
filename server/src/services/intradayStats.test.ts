// Scenario fixtures for computeIntradayStats (Batch B). Synthetic 5-min bar
// generators keep the inputs controlled so each scenario asserts a specific
// statistic. Real-IB captures land later for real-world validation.

import { describe, it, expect } from 'vitest';
import { computeIntradayStats, type IntradayBar } from './intradayStats.js';

// Bars at 5-min intervals starting at the given ET wall-clock open. Each day
// is 78 bars (6.5h × 12 bars/h). Returns the bars sorted by time across all
// requested days, oldest first.
interface DayShape {
  date: string;     // YYYY-MM-DD (ET wall-clock for the open)
  open: number;
  // Shape generator hits intraday low at `bars[lowIdx].l` and intraday high
  // at `bars[highIdx].h`. Close = openOf(last bar) + closeDeltaPct%.
  lowOffsetPct?: number;     // (open → low), negative = low below open
  highOffsetPct?: number;    // (open → high)
  openFadePct?: number;      // (open → end-of-6th-bar c). negative = faded down
  closeFadePct?: number;     // (open-of-last-6-bars → session close)
}

function dayBars(shape: DayShape, bars = 78): IntradayBar[] {
  // Treat 9:30 ET as a fixed UTC offset (-4 = EDT). Tests don't care about
  // the absolute timestamp, only that bars within the same calendar date
  // share an ET date.
  const startUtc = Date.UTC(
    Number(shape.date.slice(0, 4)),
    Number(shape.date.slice(5, 7)) - 1,
    Number(shape.date.slice(8, 10)),
    13, 30,                                  // 9:30 ET = 13:30 UTC (EDT)
  );
  const open = shape.open;
  const low = open * (1 + (shape.lowOffsetPct ?? -1) / 100);
  const high = open * (1 + (shape.highOffsetPct ?? 1) / 100);
  const openFadeEnd = open * (1 + (shape.openFadePct ?? -0.3) / 100);   // small fade down by default
  const closeFadeStart = open * (1 + 0.2 / 100);                        // mild lift mid-day
  const sessionClose = closeFadeStart * (1 + (shape.closeFadePct ?? -0.1) / 100);

  const out: IntradayBar[] = [];
  for (let i = 0; i < bars; i++) {
    let close: number;
    if (i < 6) {
      // First six bars: linearly interpolate open → openFadeEnd.
      close = open + (openFadeEnd - open) * ((i + 1) / 6);
    } else if (i < bars - 6) {
      // Mid-session noise around closeFadeStart.
      close = closeFadeStart + Math.sin(i / 4) * (open * 0.001);
    } else {
      // Last six bars: linear closeFadeStart → sessionClose.
      const step = (i - (bars - 6) + 1) / 6;
      close = closeFadeStart + (sessionClose - closeFadeStart) * step;
    }
    const o = out.length ? out[out.length - 1]!.c : open;
    // Force the day's high/low into specific bars so the engine can find them.
    const h = i === 8  ? high : Math.max(o, close);
    const l = i === 12 ? low  : Math.min(o, close);
    out.push({ t: startUtc + i * 5 * 60 * 1000, o, h, l, c: close, v: 1_000_000 });
  }
  return out;
}

function range(n: number, startDateIso: string, perDay: (i: number) => DayShape): IntradayBar[] {
  const startMs = new Date(startDateIso + 'T00:00:00Z').getTime();
  const out: IntradayBar[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(startMs + i * 24 * 60 * 60 * 1000);
    const date = d.toISOString().slice(0, 10);
    out.push(...dayBars({ ...perDay(i), date }));
  }
  return out;
}

describe('computeIntradayStats — typical-fade ticker', () => {
  it('captures a consistent open-down + close-down fade across many days', () => {
    const bars = range(60, '2026-01-05', () => ({
      open: 100,
      lowOffsetPct: -1.2,
      openFadePct: -0.6,
      closeFadePct: -0.3,
    }));
    const stats = computeIntradayStats({ bars, lookbackDays: 60 });

    expect(stats.sample_size).toBe(60);
    expect(stats.open_fade_pct_mean).not.toBeNull();
    expect(stats.open_fade_pct_mean!).toBeLessThan(0);   // fades down
    expect(stats.close_fade_pct_mean!).toBeLessThan(0);
    expect(stats.intraday_low_pct_mean!).toBeGreaterThan(0); // low below open
  });
});

describe('computeIntradayStats — no fade / rising ticker', () => {
  it('returns positive (or near-zero) fades when sessions trend up all day', () => {
    const bars = range(60, '2026-01-05', () => ({
      open: 50,
      lowOffsetPct: -0.05,    // basically no dip
      openFadePct: 0.6,       // open ramps UP in first 30 min
      closeFadePct: 0.4,      // and continues up into close
    }));
    const stats = computeIntradayStats({ bars, lookbackDays: 60 });

    expect(stats.open_fade_pct_mean!).toBeGreaterThan(0);
    expect(stats.close_fade_pct_mean!).toBeGreaterThan(0);
    expect(stats.intraday_low_pct_mean!).toBeLessThan(0.5);
  });
});

describe('computeIntradayStats — lookback respects N most-recent sessions', () => {
  it('only sees the last N sessions when more are provided', () => {
    // 100 sessions with two phases: first 50 = ramp-up days, last 50 = fade days.
    const ramp: IntradayBar[] = range(50, '2026-01-05', () => ({
      open: 50, openFadePct: 0.8, closeFadePct: 0.5,
    }));
    const fade: IntradayBar[] = range(50, '2026-03-16', () => ({
      open: 50, openFadePct: -0.7, closeFadePct: -0.4,
    }));
    const bars = [...ramp, ...fade];

    const recent60 = computeIntradayStats({ bars, lookbackDays: 60 });
    expect(recent60.sample_size).toBe(60);
    // 50 fade days + 10 ramp days → still net negative.
    expect(recent60.open_fade_pct_mean!).toBeLessThan(0);

    const all100 = computeIntradayStats({ bars, lookbackDays: 100 });
    expect(all100.sample_size).toBe(100);
  });
});

describe('computeIntradayStats — empty input', () => {
  it('returns null stats + sample_size 0 when no bars are provided', () => {
    const stats = computeIntradayStats({ bars: [] });
    expect(stats.sample_size).toBe(0);
    expect(stats.open_fade_pct_mean).toBeNull();
    expect(stats.intraday_low_pct_p75).toBeNull();
  });
});

describe('computeIntradayStats — typical intraday-low band quantifies', () => {
  it('p75 of intraday-low% is deeper than p50 (the engine surfaces both as a band)', () => {
    // Mix of mild and deep dip days so the distribution has spread.
    const bars = range(60, '2026-01-05', (i) => ({
      open: 100,
      lowOffsetPct: i % 3 === 0 ? -3.0 : -1.0,  // ~33% of days are a deep dip
      openFadePct: -0.4,
      closeFadePct: -0.2,
    }));
    const stats = computeIntradayStats({ bars });

    expect(stats.intraday_low_pct_p50).not.toBeNull();
    expect(stats.intraday_low_pct_p75).not.toBeNull();
    expect(stats.intraday_low_pct_p75!).toBeGreaterThan(stats.intraday_low_pct_p50!);
  });
});
