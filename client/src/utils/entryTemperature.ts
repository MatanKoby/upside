// Entry temperature + factor flags (Batch X12) — the FE-derived "is this a good
// buy *right now*" layer for the Intraday / Swing virtual lists. Pure functions
// over a row's live signals (price vs the walking band, the live-fire flag,
// risk flags), so they're unit-testable and the components stay dumb.
//
// See spec/screens/watchlist.md → Reading a row.

import type { ReasonChip } from '../config/virtualList';
import {
  NEAR_BAND_FRAC,
  EXTENDED_BAND_FRAC,
  GOOD_HIT_PCT,
  LOW_HIT_PCT,
} from '../config/virtualList';
import {
  type RiskFlagRow,
  isCritical,
  dominantFlag,
  flagBadgeLabel,
  flagName,
  orderedFlags,
} from './riskFlags';
import { formatCurrency } from './formatters';

export type EntryTemp = 'hot' | 'near' | 'cool' | 'ice';

// The subset of a VirtualRow (+ its risk row) the temperature/flag logic reads.
// Structurally compatible with VirtualRow, so call sites pass `{ ...row, risk }`.
export interface RowSignals {
  price: number | null;
  source: 'ib' | 'finnhub' | 'daily' | null;
  reasons: ReasonChip[];
  justFired: boolean;
  band: {
    sessionRegime: string | null;
    volScalar: number | null;
    lowBand: number | null;
    highBand: number | null;
  } | null;
  hitRate: { pct: number; sample: number } | null;
  news: { label: 'bullish' | 'neutral' | 'bearish'; score: number; headline: string | null } | null;
  risk: RiskFlagRow | null;
}

export interface Factor {
  label: string;
  detail?: string;
}

const REASON_FACTOR_LABEL: Record<ReasonChip, string> = {
  dip: 'Dip setup',
  catalyst: 'Catalyst',
  'post-earnings': 'Post-earnings drift',
};

// A fresh canonical price is one the live pollers wrote this cycle. A seeded
// daily-close row (source 'daily', see signals/curated-list.md → freshness) can
// populate a list but must never read 🔥 — same spirit as the scorer's
// fresh-price firing gate (signals/dip-bounce-scorer.md).
function isFresh(source: RowSignals['source']): boolean {
  return source === 'ib' || source === 'finnhub';
}

// Where the price sits in the band channel: 0 at the buy band (low), 1 at the
// sell band (high). null when the band is missing or degenerate.
function bandPosition(price: number | null, lo: number | null, hi: number | null): number | null {
  if (price == null || lo == null || hi == null || hi <= lo) return null;
  return (price - lo) / (hi - lo);
}

function fmt(v: number | null): string {
  return v == null ? '—' : formatCurrency(v);
}

// The live entry verdict. CRITICAL risk overrides everything (stay away); 🔥
// requires a fresh price; the rest is read off the band position.
export function entryTemperature(r: RowSignals): { temp: EntryTemp; reason: string } {
  if (isCritical(r.risk)) {
    return { temp: 'ice', reason: `Stay away — CRITICAL risk: ${flagBadgeLabel(dominantFlag(r.risk!))}.` };
  }

  const lo = r.band?.lowBand ?? null;
  const hi = r.band?.highBand ?? null;
  const fresh = isFresh(r.source);
  const atBuyBand = r.price != null && lo != null && r.price <= lo;

  if (fresh && (r.justFired || atBuyBand)) {
    const why = r.justFired
      ? 'a dip-bounce signal just fired'
      : `price ${fmt(r.price)} is at/below the buy band ${fmt(lo)}`;
    return { temp: 'hot', reason: `Hot entry now — ${why}.` };
  }

  const pos = bandPosition(r.price, lo, hi);
  if (pos != null) {
    if (pos >= EXTENDED_BAND_FRAC) {
      return { temp: 'ice', reason: 'Stay away — extended near the top of the band (no dip to buy).' };
    }
    if (pos <= NEAR_BAND_FRAC) {
      return { temp: 'near', reason: `Approaching the buy band ${fmt(lo)}.` };
    }
  }
  return { temp: 'cool', reason: 'Not a buy this moment — mid-band, no edge right now.' };
}

// Sort rank for the leaderboard: hottest first, ice last. Composite score is the
// within-tier tiebreaker (applied by the caller).
export const TEMP_ORDER: Record<EntryTemp, number> = { hot: 0, near: 1, cool: 2, ice: 3 };

// Glyph + label per temperature, shared by the row badge and the why-sheet. cool
// renders no glyph on the row (it's the quiet default).
export const TEMP_META: Record<EntryTemp, { glyph: string; label: string }> = {
  hot: { glyph: '🔥', label: 'Hot — buy now' },
  near: { glyph: '🟡', label: 'Near — approaching' },
  cool: { glyph: '', label: 'Neutral' },
  ice: { glyph: '🧊', label: 'Stay away' },
};

// Roll every for/against signal on the row up into two lists. The badge shows
// the counts; the why-sheet renders the items. Taxonomy is tunable presentation.
export function factorFlags(r: RowSignals): { tailwinds: Factor[]; headwinds: Factor[] } {
  const tailwinds: Factor[] = [];
  const headwinds: Factor[] = [];

  // Why it qualified for the list at all.
  for (const reason of r.reasons) tailwinds.push({ label: REASON_FACTOR_LABEL[reason] });

  if (r.justFired) tailwinds.push({ label: 'Signal just fired' });

  const lo = r.band?.lowBand ?? null;
  const hi = r.band?.highBand ?? null;
  const fresh = isFresh(r.source);
  const pos = bandPosition(r.price, lo, hi);

  if (fresh && r.price != null && lo != null && r.price <= lo) {
    tailwinds.push({ label: 'At/below the buy band', detail: `${fmt(r.price)} ≤ ${fmt(lo)}` });
  } else if (pos != null && pos >= EXTENDED_BAND_FRAC) {
    headwinds.push({ label: 'Extended vs band', detail: 'near the top of the channel' });
  }

  const regime = r.band?.sessionRegime ?? null;
  if (regime === 'mean_reversion' || regime === 'mixed') {
    tailwinds.push({ label: 'Mean-reversion regime' });
  } else if (regime === 'bearish_trend') {
    headwinds.push({ label: 'Bearish-trend regime' });
  }

  if (r.news && r.news.label === 'bullish') {
    tailwinds.push({ label: 'News bullish today', detail: r.news.headline ?? undefined });
  } else if (r.news && r.news.label === 'bearish') {
    headwinds.push({ label: 'News bearish today', detail: r.news.headline ?? undefined });
  }

  if (r.hitRate) {
    const pct = Math.round(r.hitRate.pct);
    if (r.hitRate.pct >= GOOD_HIT_PCT) {
      tailwinds.push({ label: `Hit-rate ${pct}%`, detail: `n${r.hitRate.sample}` });
    } else if (r.hitRate.pct < LOW_HIT_PCT) {
      headwinds.push({ label: `Low hit-rate ${pct}%`, detail: `n${r.hitRate.sample}` });
    }
  }

  // Each active risk flag is its own headwind (the why-sheet itemizes them).
  if (r.risk) {
    for (const f of orderedFlags(r.risk)) {
      headwinds.push({ label: flagName(f.key), detail: r.risk.severity === 'critical' ? 'CRITICAL' : undefined });
    }
  }

  return { tailwinds, headwinds };
}
