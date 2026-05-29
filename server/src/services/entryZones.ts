// Dynamic entry-zone engine (Batch A+).
//
// Pure function: given current price + daily/intraday bars, returns one entry
// suggestion per horizon (intraday / overnight / multiday). LLM-free. Reuses
// the feature-pack levels + ATR + indicators from `technicals.ts`.
//
// Design summarized (see spec/signals/entry-zones.md for the full rationale):
//
//   1. Collect candidate SUPPORT levels below current price from the feature
//      pack (pivots S1/S2, recent + major swing lows, SMA20/50/200, lower
//      Bollinger, 20-day low, 52-week low, round-number magnets).
//   2. Cluster candidates within 0.5·ATR of each other → confluence count.
//   3. Compute trend regime (simple v1: classic SMA alignment).
//   4. Compute overbought flag (RSI > 70 OR price > SMA50 + 2·ATR).
//   5. For each horizon, filter candidates by reachability: distance ≤ k·ATR
//      (k = 1 intraday, 2 overnight, 4 multiday). If overbought, multiply k
//      by 1.5 so the entry "comes toward price" rather than waiting for a
//      pullback that may never come.
//   6. Score = source_weight · (1 - distance/k·ATR) + confluence·10, pick max.
//   7. Reasoning = the picked level's source name(s) (confluence-aware).
//
// The function is deterministic and side-effect-free → unit-testable as a
// closed black box. See `entryZones.test.ts` for the scenario fixtures.

import { buildFeaturePack, type Bars, type FeaturePack } from './technicals.js';

export type TrendRegime = 'up' | 'down' | 'mixed';
export type Horizon = 'intraday' | 'overnight' | 'multiday';

export interface EntryZone {
  price: number;
  reasoning: string;
  confidence: number;     // 0-100
  sources: string[];      // contributing level names (for confluence)
}

export interface EntryZonesOutput {
  zones: Record<Horizon, EntryZone | null>;
  trendRegime: TrendRegime;
  overboughtTightened: boolean;
}

export interface ComputeEntryZonesOpts {
  currentPrice: number;
  daily: Bars;
  intraday: Bars | null;
  avgCost?: number | null;
}

// Per-source confidence weight (0-1). SMAs + pivots > 1-shot swing lows >
// generic round numbers. Calibrated as a starting point; tune empirically.
const SOURCE_WEIGHT: Record<string, number> = {
  sma20: 0.85,
  sma50: 0.90,
  sma200: 0.95,
  pivot_s1: 0.80,
  pivot_s2: 0.75,
  swing_low_recent: 0.70,
  swing_low_major: 0.85,
  lower_bollinger: 0.75,
  low20: 0.60,
  low52w: 0.65,
  round_number: 0.40,
};

const HORIZON_K: Record<Horizon, number> = {
  intraday: 1,
  overnight: 2,
  multiday: 4,
};

interface Candidate {
  price: number;
  source: string;
}

function trendFromPack(pack: FeaturePack, currentPrice: number): TrendRegime {
  // Simple v1: classic SMA alignment (price > SMA20 > SMA50 ⇒ up; reverse ⇒
  // down; anything else ⇒ mixed). Full structure work (ADX gate, major-low
  // anchor, RSI divergence, basing/consolidating labels) is deferred per
  // spec/roadmap.md → Track 1 → Deferred.
  const { sma20, sma50 } = pack.trend;
  if (sma20 == null || sma50 == null) return 'mixed';
  if (currentPrice > sma20 && sma20 > sma50) return 'up';
  if (currentPrice < sma20 && sma20 < sma50) return 'down';
  return 'mixed';
}

function isOverbought(pack: FeaturePack, currentPrice: number, atr: number): boolean {
  const rsi = pack.momentum.rsi14;
  if (rsi != null && rsi > 70) return true;
  const sma50 = pack.trend.sma50;
  if (sma50 != null && atr > 0 && currentPrice > sma50 + 2 * atr) return true;
  return false;
}

function collectCandidates(pack: FeaturePack, currentPrice: number): Candidate[] {
  const out: Candidate[] = [];
  const push = (source: string, price: number | null | undefined) => {
    if (price == null || !Number.isFinite(price)) return;
    if (price >= currentPrice) return;  // we want supports BELOW price
    if (price <= 0) return;
    out.push({ source, price });
  };

  push('sma20', pack.trend.sma20);
  push('sma50', pack.trend.sma50);
  push('sma200', pack.trend.sma200);

  if (pack.levels.pivots) {
    push('pivot_s1', pack.levels.pivots.s1);
    push('pivot_s2', pack.levels.pivots.s2);
  }

  // Recent + major swing lows. Most-recent swing low is first in the array;
  // the lowest is the "major low" — exactly the case the deferred structure
  // work wants to recognise (BBAI: lowest swing was the oldest).
  if (pack.levels.swingLows.length > 0) {
    push('swing_low_recent', pack.levels.swingLows[0]);
    const major = Math.min(...pack.levels.swingLows);
    push('swing_low_major', major);
  }

  if (pack.momentum.bollinger?.lower != null) {
    push('lower_bollinger', pack.momentum.bollinger.lower);
  }

  push('low20', pack.levels.low20);
  push('low52w', pack.levels.low52w);

  // Round-number magnets removed (user direction 2026-05-29). They produce
  // alerts like "buy at $X" where $X was below price at compute time but the
  // 15-min cron staleness leaves the zone above current price — practically a
  // "buy market" recommendation that's dangerous. Stick to real structural
  // levels (pivots, swings, MAs, Bollinger, N-day lows).

  return out;
}

/** Cluster within 0.5·ATR → returns confluence count per index (parallel array). */
function confluenceCounts(cands: Candidate[], atr: number): number[] {
  const band = atr > 0 ? atr * 0.5 : 0.01;
  return cands.map((c, i) =>
    cands.filter((o, j) => j !== i && Math.abs(o.price - c.price) <= band).length,
  );
}

function describe(pick: Candidate, partners: Candidate[]): { reasoning: string; sources: string[] } {
  const all = [pick.source, ...partners.map((p) => p.source)];
  const unique = Array.from(new Set(all));
  if (unique.length === 1) {
    return { reasoning: humanReadable(pick.source), sources: unique };
  }
  return {
    reasoning: `confluence — ${unique.map(humanReadable).join(' + ')}`,
    sources: unique,
  };
}

function humanReadable(source: string): string {
  switch (source) {
    case 'sma20': return 'SMA20';
    case 'sma50': return 'SMA50';
    case 'sma200': return 'SMA200';
    case 'pivot_s1': return 'pivot S1';
    case 'pivot_s2': return 'pivot S2';
    case 'swing_low_recent': return 'recent swing low';
    case 'swing_low_major': return 'major swing low';
    case 'lower_bollinger': return 'lower Bollinger band';
    case 'low20': return '20-day low';
    case 'low52w': return '52-week low';
    case 'round_number': return 'round-number magnet';
    default: return source;
  }
}

function scoreFor(distance: number, kAtr: number, weight: number, confluence: number): number {
  if (kAtr <= 0) return 0;
  const reachScore = Math.max(0, 1 - distance / kAtr);
  return weight * reachScore + confluence * 0.10;
}

function pickHorizon(
  cands: Candidate[],
  confluences: number[],
  currentPrice: number,
  atr: number,
  kBase: number,
  overboughtMultiplier: number,
): EntryZone | null {
  const kAtr = kBase * atr * overboughtMultiplier;
  if (kAtr <= 0) return null;

  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (!c) continue;
    const dist = currentPrice - c.price;
    if (dist > kAtr) continue;  // unreachable in this horizon
    const weight = SOURCE_WEIGHT[c.source] ?? 0.5;
    const score = scoreFor(dist, kAtr, weight, confluences[i] ?? 0);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;

  const pick = cands[bestIdx]!;
  const band = atr * 0.5;
  const partners = cands.filter(
    (o, j) => j !== bestIdx && Math.abs(o.price - pick.price) <= band,
  );
  const desc = describe(pick, partners);
  const confluence = confluences[bestIdx] ?? 0;
  // Map score → 0-100 confidence. Base from reachScore × weight, bonus +5 per
  // confluence partner (cap +25). Keeps "two strong levels" above "one strong".
  const reachComponent = Math.max(0, 1 - (currentPrice - pick.price) / kAtr);
  const baseConf = Math.round((SOURCE_WEIGHT[pick.source] ?? 0.5) * reachComponent * 100);
  const confidence = Math.min(100, baseConf + Math.min(25, confluence * 5));

  return {
    price: Math.round(pick.price * 10000) / 10000,
    reasoning: desc.reasoning,
    confidence,
    sources: desc.sources,
  };
}

export function computeEntryZones(opts: ComputeEntryZonesOpts): EntryZonesOutput {
  const pack = buildFeaturePack({
    daily: opts.daily,
    intraday: opts.intraday,
    currentPrice: opts.currentPrice,
    avgCost: opts.avgCost ?? null,
  });

  const trendRegime = trendFromPack(pack, opts.currentPrice);
  const atr = pack.volatility.atr14 ?? 0;
  const overboughtTightened = isOverbought(pack, opts.currentPrice, atr);

  if (atr <= 0) {
    return {
      zones: { intraday: null, overnight: null, multiday: null },
      trendRegime,
      overboughtTightened,
    };
  }

  const cands = collectCandidates(pack, opts.currentPrice);
  const confl = confluenceCounts(cands, atr);
  const obMultiplier = overboughtTightened ? 1.5 : 1.0;

  return {
    zones: {
      intraday:  pickHorizon(cands, confl, opts.currentPrice, atr, HORIZON_K.intraday,  obMultiplier),
      overnight: pickHorizon(cands, confl, opts.currentPrice, atr, HORIZON_K.overnight, obMultiplier),
      multiday:  pickHorizon(cands, confl, opts.currentPrice, atr, HORIZON_K.multiday,  obMultiplier),
    },
    trendRegime,
    overboughtTightened,
  };
}
