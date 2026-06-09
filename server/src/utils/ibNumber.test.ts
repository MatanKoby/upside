import { describe, it, expect } from 'vitest';
import { parseIbNumber } from './ibNumber.js';

describe('parseIbNumber', () => {
  it('parses magnitude suffixes (the volume bug)', () => {
    expect(parseIbNumber('65595.7B')).toBeCloseTo(65595.7e9, 0);
    expect(parseIbNumber('1.2M')).toBe(1.2e6);
    expect(parseIbNumber('523K')).toBe(523_000);
    expect(parseIbNumber('3T')).toBe(3e12);
  });

  it('is case-insensitive on the suffix', () => {
    expect(parseIbNumber('1.2m')).toBe(1.2e6);
    expect(parseIbNumber('523k')).toBe(523_000);
  });

  it('parses plain numbers, commas, percent, and native numbers', () => {
    expect(parseIbNumber('12.34')).toBe(12.34);
    expect(parseIbNumber('1,234')).toBe(1234);
    expect(parseIbNumber('0.5%')).toBe(0.5);
    expect(parseIbNumber('-3.1')).toBe(-3.1);
    expect(parseIbNumber(42)).toBe(42);
  });

  it('returns NaN for empty / non-numeric / prefixed-flag / nullish', () => {
    expect(parseIbNumber('')).toBeNaN();
    expect(parseIbNumber('   ')).toBeNaN();
    expect(parseIbNumber('x')).toBeNaN();
    expect(parseIbNumber('C12.34')).toBeNaN(); // IB closed-market flag
    expect(parseIbNumber('1.2X')).toBeNaN(); // unknown suffix
    expect(parseIbNumber(null)).toBeNaN();
    expect(parseIbNumber(undefined)).toBeNaN();
    expect(parseIbNumber({})).toBeNaN();
  });
});
