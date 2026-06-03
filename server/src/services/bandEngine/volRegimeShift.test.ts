import { describe, it, expect } from 'vitest';
import { computeVolRegimeShift, type SessionBar } from './volRegimeShift.js';

function flatSessions(count: number, range: number, startDate = '2026-04-01'): SessionBar[] {
  const out: SessionBar[] = [];
  const start = new Date(startDate + 'T00:00:00Z').getTime();
  for (let i = 0; i < count; i++) {
    const c = 100;
    out.push({
      date: new Date(start + i * 86400_000).toISOString().slice(0, 10),
      h: c + range / 2,
      l: c - range / 2,
      c,
    });
  }
  return out;
}

describe('computeVolRegimeShift', () => {
  it('insufficient history → false (not enough to compute baseline)', () => {
    expect(computeVolRegimeShift(flatSessions(20, 1.0))).toBe(false);
  });

  it('stable vol regime (recent ≈ prior) → false', () => {
    expect(computeVolRegimeShift(flatSessions(40, 1.0))).toBe(false);
  });

  it('post-catalyst REPL (recent 3× prior) → true', () => {
    const prior = flatSessions(30, 1.0, '2026-04-01');
    const recent = flatSessions(5, 3.0, '2026-05-01');
    expect(computeVolRegimeShift([...prior, ...recent])).toBe(true);
  });

  it('borderline (recent 2× prior, not strictly above threshold) → false', () => {
    const prior = flatSessions(30, 1.0, '2026-04-01');
    const recent = flatSessions(5, 2.0, '2026-05-01');
    // ratio = exactly 2.0 — strictly-greater-than fails on the boundary.
    expect(computeVolRegimeShift([...prior, ...recent])).toBe(false);
  });

  it('zero prior ATR (degenerate) → false', () => {
    const prior = flatSessions(30, 0, '2026-04-01');
    const recent = flatSessions(5, 1.0, '2026-05-01');
    expect(computeVolRegimeShift([...prior, ...recent])).toBe(false);
  });
});
