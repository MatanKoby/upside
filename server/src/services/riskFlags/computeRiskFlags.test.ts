import { describe, it, expect } from 'vitest';
import { computeRiskFlags, type RiskFlagInputs } from './computeRiskFlags.js';
import {
  surgePctFromBars,
  relVolumeFromBars,
  marketCapUsdFromMetric,
  earningsDaysFromCalendar,
} from './inputs.js';
import { RISK_FLAG_DEFAULTS, type RiskFlagConfig } from '../../config/riskFlags.js';

const CFG: RiskFlagConfig = RISK_FLAG_DEFAULTS;
const ASOF = '2026-06-05';

// A deliberately-clean baseline; each test perturbs one axis.
const CLEAN: RiskFlagInputs = {
  currentPrice: 100,
  surgePct: 3,
  rsi14: 55,
  relVolume: 1.1,
  high52w: 130,
  marketCapUsd: 50_000_000_000,
  earningsDays: 40,
  newsScore: 0,
};

function keys(row: ReturnType<typeof computeRiskFlags>): string[] {
  return (row?.flags ?? []).map((f) => f.key).sort();
}

describe('computeRiskFlags — tiers + gating', () => {
  it('returns null for a clean ticker', () => {
    expect(computeRiskFlags(CLEAN, CFG, ASOF)).toBeNull();
  });

  it('price_surge alone is WARNING', () => {
    const row = computeRiskFlags({ ...CLEAN, surgePct: 30 }, CFG, ASOF);
    expect(keys(row)).toEqual(['price_surge']);
    expect(row?.severity).toBe('warning');
  });

  it('price_surge + rsi_overbought is CRITICAL (confirmed pump)', () => {
    const row = computeRiskFlags({ ...CLEAN, surgePct: 30, rsi14: 82 }, CFG, ASOF);
    expect(keys(row)).toEqual(['price_surge', 'rsi_overbought']);
    expect(row?.severity).toBe('critical');
  });

  it('price_surge + volume_spike is CRITICAL', () => {
    const row = computeRiskFlags({ ...CLEAN, surgePct: 30, relVolume: 4 }, CFG, ASOF);
    expect(row?.severity).toBe('critical');
  });

  it('micro_cap escalated by a corroborating flag is CRITICAL', () => {
    const row = computeRiskFlags(
      { ...CLEAN, marketCapUsd: 200_000_000, relVolume: 4 },
      CFG,
      ASOF,
    );
    expect(keys(row)).toEqual(['micro_cap', 'volume_spike']);
    expect(row?.severity).toBe('critical');
  });

  it('micro_cap alone is WARNING', () => {
    const row = computeRiskFlags({ ...CLEAN, marketCapUsd: 200_000_000 }, CFG, ASOF);
    expect(keys(row)).toEqual(['micro_cap']);
    expect(row?.severity).toBe('warning');
  });

  it('earnings_imminent alone is WARNING', () => {
    const row = computeRiskFlags({ ...CLEAN, earningsDays: 3 }, CFG, ASOF);
    expect(keys(row)).toEqual(['earnings_imminent']);
    expect(row?.severity).toBe('warning');
  });

  it('bad_news alone is WARNING (never escalates a pump)', () => {
    const row = computeRiskFlags({ ...CLEAN, newsScore: -0.6 }, CFG, ASOF);
    expect(keys(row)).toEqual(['bad_news']);
    expect(row?.severity).toBe('warning');
    expect(row?.flags[0]?.payload.news_score).toBe(-0.6);
  });

  it('bad_news does NOT corroborate a surge into CRITICAL', () => {
    const row = computeRiskFlags({ ...CLEAN, surgePct: 30, newsScore: -0.6 }, CFG, ASOF);
    expect(keys(row)).toEqual(['bad_news', 'price_surge']);
    expect(row?.severity).toBe('warning'); // surge alone is WARNING; bad_news can't escalate it
  });

  it('positive / null news raises no flag', () => {
    expect(computeRiskFlags({ ...CLEAN, newsScore: 0.8 }, CFG, ASOF)).toBeNull();
    expect(computeRiskFlags({ ...CLEAN, newsScore: null }, CFG, ASOF)).toBeNull();
  });
});

describe('computeRiskFlags — near_52w_high_surge is compound', () => {
  it('near the high but NOT surging → not flagged', () => {
    const row = computeRiskFlags({ ...CLEAN, currentPrice: 129, high52w: 130, surgePct: 4 }, CFG, ASOF);
    expect(row).toBeNull();
  });

  it('near the high AND surging → flagged (and CRITICAL via surge+near)', () => {
    const row = computeRiskFlags(
      { ...CLEAN, currentPrice: 129, high52w: 130, surgePct: 30 },
      CFG,
      ASOF,
    );
    expect(keys(row)).toEqual(['near_52w_high_surge', 'price_surge']);
    expect(row?.severity).toBe('critical');
  });
});

describe('computeRiskFlags — since inheritance', () => {
  it('keeps the prior since date when the flag was already up', () => {
    const row = computeRiskFlags({ ...CLEAN, surgePct: 30 }, CFG, ASOF, { price_surge: '2026-06-02' });
    expect(row?.flags[0]?.since).toBe('2026-06-02');
  });

  it('stamps today when the flag is newly raised', () => {
    const row = computeRiskFlags({ ...CLEAN, surgePct: 30 }, CFG, ASOF);
    expect(row?.flags[0]?.since).toBe(ASOF);
  });
});

describe('input assemblers', () => {
  it('surgePctFromBars computes the trailing-N return', () => {
    // closes oldest→newest; 5 sessions ago = index len-1-5
    const closes = [10, 10, 10, 10, 10, 8, 9, 9.5, 10, 11, 12];
    // current 13 vs close 5 sessions back (8) → +62.5%
    expect(surgePctFromBars(closes, 13, 5)).toBeCloseTo(62.5, 4);
  });

  it('surgePctFromBars returns null without enough history', () => {
    expect(surgePctFromBars([10, 11], 12, 5)).toBeNull();
  });

  it('relVolumeFromBars compares today vs the trailing 30d average', () => {
    const vols = [...Array(30).fill(1_000_000), 4_000_000];
    expect(relVolumeFromBars(vols)).toBeCloseTo(4, 4);
  });

  it('marketCapUsdFromMetric scales millions → USD', () => {
    expect(marketCapUsdFromMetric({ marketCapitalization: 250 })).toBe(250_000_000);
    expect(marketCapUsdFromMetric(null)).toBeNull();
  });

  it('earningsDaysFromCalendar picks the nearest future date', () => {
    const raw = { earningsCalendar: [{ date: '2026-06-09' }, { date: '2026-09-09' }] };
    expect(earningsDaysFromCalendar(raw, new Date('2026-06-05T12:00:00Z'))).toBe(4);
  });

  it('earningsDaysFromCalendar ignores past dates', () => {
    const raw = { earningsCalendar: [{ date: '2026-06-01' }] };
    expect(earningsDaysFromCalendar(raw, new Date('2026-06-05T12:00:00Z'))).toBeNull();
  });
});
