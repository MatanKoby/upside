// Vitest fixtures for the Ring-1 filter — covers every enum branch + the
// pre-DB sieve.

import { describe, it, expect } from 'vitest';
import { filterRing1, preFilterByTypeAndMic } from './universeFilter.js';

const baseInput = {
  type: 'Common Stock',
  mic: 'XNAS',
  price: 25,
  marketCapM: 1500,
  avgVolume: 2_500_000,
};

describe('filterRing1', () => {
  it('passes a well-behaved mid-cap', () => {
    expect(filterRing1(baseInput)).toBe('in');
  });

  it('passes an ADR on NYSE', () => {
    expect(filterRing1({ ...baseInput, type: 'ADR', mic: 'XNYS' })).toBe('in');
  });

  it('passes a small-cap on NYSE American', () => {
    expect(
      filterRing1({ ...baseInput, mic: 'XASE', marketCapM: 200 }),
    ).toBe('in');
  });

  it('passes when avg volume is unknown (gate is opt-in for v1)', () => {
    expect(filterRing1({ ...baseInput, avgVolume: null })).toBe('in');
  });

  it('drops ETFs by type', () => {
    expect(filterRing1({ ...baseInput, type: 'ETP' })).toBe('out_type');
  });

  it('drops missing type', () => {
    expect(filterRing1({ ...baseInput, type: null })).toBe('out_type');
  });

  it('drops OTC listings by MIC', () => {
    expect(filterRing1({ ...baseInput, mic: 'OOTC' })).toBe('out_mic');
  });

  it('drops missing MIC', () => {
    expect(filterRing1({ ...baseInput, mic: null })).toBe('out_mic');
  });

  it('treats Finnhub 0-price as no_data, not out_price', () => {
    expect(filterRing1({ ...baseInput, price: 0 })).toBe('no_data');
  });

  it('treats null price as no_data', () => {
    expect(filterRing1({ ...baseInput, price: null })).toBe('no_data');
  });

  it('drops sub-$1 penny stocks', () => {
    expect(filterRing1({ ...baseInput, price: 0.5 })).toBe('out_price');
  });

  it('drops over-$100 stocks', () => {
    expect(filterRing1({ ...baseInput, price: 250 })).toBe('out_price');
  });

  it('drops missing market cap as no_data', () => {
    expect(filterRing1({ ...baseInput, marketCapM: null })).toBe('no_data');
  });

  it('drops sub-$150M micro-caps', () => {
    expect(filterRing1({ ...baseInput, marketCapM: 50 })).toBe('out_cap');
  });

  it('drops thin-volume tickers when avg volume is known and below floor', () => {
    expect(filterRing1({ ...baseInput, avgVolume: 500_000 })).toBe('out_volume');
  });

  it('check ordering — out_type beats out_mic', () => {
    expect(filterRing1({ ...baseInput, type: 'REIT', mic: 'OOTC' })).toBe('out_type');
  });

  it('check ordering — out_price beats out_cap', () => {
    expect(filterRing1({ ...baseInput, price: 0.5, marketCapM: 50 })).toBe('out_price');
  });
});

describe('preFilterByTypeAndMic', () => {
  it('passes Common Stock on NASDAQ', () => {
    expect(preFilterByTypeAndMic({ type: 'Common Stock', mic: 'XNAS' })).toBe(true);
  });

  it('passes ADR on NYSE', () => {
    expect(preFilterByTypeAndMic({ type: 'ADR', mic: 'XNYS' })).toBe(true);
  });

  it('passes Common Stock on NYSE American', () => {
    expect(preFilterByTypeAndMic({ type: 'Common Stock', mic: 'XASE' })).toBe(true);
  });

  it('drops ETPs even on allowed MIC', () => {
    expect(preFilterByTypeAndMic({ type: 'ETP', mic: 'XNAS' })).toBe(false);
  });

  it('drops OTC even with allowed type', () => {
    expect(preFilterByTypeAndMic({ type: 'Common Stock', mic: 'OOTC' })).toBe(false);
  });

  it('drops missing type', () => {
    expect(preFilterByTypeAndMic({ type: null, mic: 'XNAS' })).toBe(false);
  });

  it('drops missing MIC', () => {
    expect(preFilterByTypeAndMic({ type: 'Common Stock', mic: null })).toBe(false);
  });
});
