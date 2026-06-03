import { describe, it, expect } from 'vitest';
import { classifySessionRegime } from './sessionRegime.js';

describe('classifySessionRegime', () => {
  it('typical (flat gap, flat first-15, normal premkt vol) → mean_reversion', () => {
    expect(classifySessionRegime({ gapPct: 0.4, first15Pct: 0.2, premktVolRatio: 1.1 }))
      .toBe('mean_reversion');
  });

  it('bullish trend (gap up + first-15 up)', () => {
    expect(classifySessionRegime({ gapPct: 3.5, first15Pct: 1.8, premktVolRatio: 1.5 }))
      .toBe('bullish_trend');
  });

  it('bearish trend (gap down + first-15 down)', () => {
    expect(classifySessionRegime({ gapPct: -2.7, first15Pct: -2.1, premktVolRatio: 1.3 }))
      .toBe('bearish_trend');
  });

  it('mixed: gap up but first-15 down', () => {
    expect(classifySessionRegime({ gapPct: 2.5, first15Pct: -1.2, premktVolRatio: 1.0 }))
      .toBe('mixed');
  });

  it('mixed: gap down but first-15 up', () => {
    expect(classifySessionRegime({ gapPct: -2.2, first15Pct: 1.4, premktVolRatio: 1.0 }))
      .toBe('mixed');
  });

  it('mixed: flat gap but large first-15 move (rip from open)', () => {
    expect(classifySessionRegime({ gapPct: 0.3, first15Pct: 1.6, premktVolRatio: 1.0 }))
      .toBe('mixed');
  });

  it('mixed: flat day but abnormal premkt volume', () => {
    expect(classifySessionRegime({ gapPct: 0.5, first15Pct: 0.3, premktVolRatio: 2.5 }))
      .toBe('mixed');
  });

  it('mean_reversion: null premkt vol falls back to flat-day classification', () => {
    expect(classifySessionRegime({ gapPct: 0.6, first15Pct: -0.4, premktVolRatio: null }))
      .toBe('mean_reversion');
  });

  it('boundary: gap exactly at +2% with aligned first-15 → bullish_trend', () => {
    expect(classifySessionRegime({ gapPct: 2.0, first15Pct: 1.0, premktVolRatio: 1.0 }))
      .toBe('bullish_trend');
  });

  it('boundary: gap just below threshold treated as flat', () => {
    expect(classifySessionRegime({ gapPct: 1.9, first15Pct: 0.5, premktVolRatio: 1.0 }))
      .toBe('mean_reversion');
  });
});
