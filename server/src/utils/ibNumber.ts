// Parse an IB Client Portal display-formatted number (Batch X10.1).
//
// IB snapshot fields arrive as display strings, not raw numbers. Volume
// (field 87) in particular carries a magnitude suffix — captured values look
// like "65595.7B" / "1.2M" / "523K" — while prices come as plain "12.34",
// some values carry thousands commas or a trailing percent. The catalyst
// producer used to parse these with `Number(v.replace(/[,%]/g,''))`, which
// turns "65595.7B" into NaN → null vol-multiple → no catalyst ever qualifies.
//
// parseIbNumber normalizes all of these to a JS number. Anything it can't
// confidently read (empty, prefixed flags like "C12.34" for a closed market,
// non-strings) returns NaN, so callers gate on Number.isFinite.

const SUFFIX_FACTOR: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

export function parseIbNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  // Strip thousands separators + a trailing percent, then match a bare number
  // with an optional magnitude suffix. A leading flag char (e.g. IB's "C"/"H"
  // on field 31) fails the match → NaN, which is the honest answer.
  const s = v.trim().replace(/,/g, '').replace(/%$/, '');
  const m = /^([+-]?\d+(?:\.\d+)?)([KMBT])?$/i.exec(s);
  if (!m) return NaN;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return NaN;
  const suffix = m[2]?.toUpperCase();
  return suffix ? base * SUFFIX_FACTOR[suffix]! : base;
}
