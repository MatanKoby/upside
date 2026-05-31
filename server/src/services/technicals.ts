// Technicals — deterministic feature computation for the signal engine.
//
// Two layers:
//   1. Single-value helpers (rsi/macd/bollinger/vwap) kept for ibMappers and
//      any caller that just wants one reading.
//   2. `buildFeaturePack` (Batch 14g) — the structured grounding the LLM
//      reasons over. We do all the arithmetic here, deterministically, and hand
//      the model precise *named levels*. Its job is to narrate, pick levels for
//      each playbook leg, and rate — never to calculate or invent prices.
//      Anchoring every leg to a real computed level is the biggest quality win.

import { RSI, MACD, BollingerBands, SMA, EMA, ATR } from 'technicalindicators';

export interface TechnicalSeries {
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const out = RSI.calculate({ values: closes, period });
  return out.length ? (out[out.length - 1] ?? null) : null;
}

export function macd(closes: number[]): { macd: number; signal: number; histogram: number } | null {
  if (closes.length < 35) return null;
  const out = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const last = out[out.length - 1];
  if (!last || last.MACD === undefined || last.signal === undefined || last.histogram === undefined) return null;
  return { macd: last.MACD, signal: last.signal, histogram: last.histogram };
}

export function bollinger(closes: number[], period = 20, stdDev = 2): { upper: number; middle: number; lower: number } | null {
  if (closes.length < period) return null;
  const out = BollingerBands.calculate({ values: closes, period, stdDev });
  const last = out[out.length - 1];
  if (!last) return null;
  return { upper: last.upper, middle: last.middle, lower: last.lower };
}

export function vwap(highs: number[], lows: number[], closes: number[], volumes: number[]): number | null {
  if (highs.length === 0 || highs.length !== volumes.length) return null;
  let cumPv = 0;
  let cumV = 0;
  for (let i = 0; i < highs.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const close = closes[i];
    const volume = volumes[i];
    if (high === undefined || low === undefined || close === undefined || volume === undefined) continue;
    const typical = (high + low + close) / 3;
    cumPv += typical * volume;
    cumV += volume;
  }
  return cumV > 0 ? cumPv / cumV : null;
}

// ---------------------------------------------------------------------------
// Feature pack (Batch 14g)
// ---------------------------------------------------------------------------

export interface Bars {
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

// The structured grounding handed to the LLM. Every number is a real computed
// level/reading; the prompt tells the model to anchor each leg to one of these.
export interface FeaturePack {
  price: { current: number | null; lastClose: number | null; priorClose: number | null };
  levels: {
    pivots: { p: number; r1: number; r2: number; s1: number; s2: number } | null;
    swingHighs: number[]; // recent pivot highs, newest first
    swingLows: number[]; // recent pivot lows, newest first
    high20: number | null;
    low20: number | null;
    high52w: number | null;
    low52w: number | null;
    roundNumbers: number[]; // round-number magnets bracketing current price
  };
  volatility: { atr14: number | null; atr14Pct: number | null };
  trend: {
    sma20: number | null;
    sma50: number | null;
    sma200: number | null;
    ema20: number | null;
    ema50: number | null;
    priceVsSma20Pct: number | null;
    priceVsSma50Pct: number | null;
    priceVsSma200Pct: number | null;
    structure: 'higher-highs' | 'lower-lows' | 'mixed' | null;
  };
  momentum: {
    rsi14: number | null;
    rsiState: 'overbought' | 'oversold' | 'neutral' | null;
    macd: { line: number; signal: number; histogram: number; cross: 'bullish' | 'bearish' | 'none' } | null;
    bollinger: { upper: number; middle: number; lower: number; percentB: number | null; bandwidthPct: number | null } | null;
    vwap: number | null;
    vwapDistancePct: number | null;
    relativeVolume10d: number | null;
    relativeVolume30d: number | null;
  };
  // null when the ticker is not held (watchlist candidate / BUY analysis).
  positionRelative: {
    avgCost: number;
    pctFromAvgCost: number | null;
    pctFrom52wHigh: number | null;
    pctFrom52wLow: number | null;
  } | null;
}

function r(n: number | null | undefined, digits = 2): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function pctChange(from: number | null, to: number | null): number | null {
  if (from == null || to == null || from === 0) return null;
  return r(((to - from) / from) * 100);
}

function lastOf(arr: number[]): number | null {
  return arr.length ? (arr[arr.length - 1] ?? null) : null;
}

function smaLast(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const out = SMA.calculate({ values, period });
  return lastOf(out);
}

function emaLast(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const out = EMA.calculate({ values, period });
  return lastOf(out);
}

function atrLast(bars: Bars, period = 14): number | null {
  if (bars.c.length < period + 1) return null;
  const out = ATR.calculate({ high: bars.h, low: bars.l, close: bars.c, period });
  return lastOf(out);
}

// Public ATR helper for surfaces that don't build a full feature pack —
// MarketStats panel uses this directly (Batch C+1, 2026-05-30).
export function atr(bars: Bars, period = 14): number | null {
  return atrLast(bars, period);
}

// Classic floor-trader pivots from the prior completed session's H/L/C.
function classicPivots(priorHigh: number, priorLow: number, priorClose: number) {
  const p = (priorHigh + priorLow + priorClose) / 3;
  return {
    p,
    r1: 2 * p - priorLow,
    s1: 2 * p - priorHigh,
    r2: p + (priorHigh - priorLow),
    s2: p - (priorHigh - priorLow),
  };
}

// Fractal swing points: a bar is a swing high if its high is the max of a
// (2*width+1) window centred on it; symmetric for lows. Returns the most
// recent `max` prices, newest first.
function swingPoints(series: number[], kind: 'high' | 'low', width = 2, max = 4): number[] {
  const out: number[] = [];
  for (let i = series.length - width - 1; i >= width; i--) {
    const v = series[i];
    if (v == null) continue;
    let pivot = true;
    for (let j = i - width; j <= i + width; j++) {
      if (j === i) continue;
      const o = series[j];
      if (o == null) continue;
      if (kind === 'high' ? o > v : o < v) {
        pivot = false;
        break;
      }
    }
    if (pivot) {
      out.push(v);
      if (out.length >= max) break;
    }
  }
  return out;
}

// Round-number magnets bracketing `price` — the kind of level retail orders
// cluster on. Step scales with price magnitude (sub-$10 → $0.50, etc.).
function roundMagnets(price: number | null): number[] {
  if (price == null || price <= 0) return [];
  const step = price < 10 ? 0.5 : price < 100 ? 1 : price < 1000 ? 5 : 50;
  const below = Math.floor(price / step) * step;
  return [r(below) as number, r(below + step) as number].filter((n, i, a) => a.indexOf(n) === i);
}

// Builds the full feature pack from daily + intraday bars and (optionally) the
// held position. All arithmetic is done here so the LLM never calculates.
export function buildFeaturePack(opts: {
  daily: Bars;
  intraday: Bars | null;
  currentPrice: number | null;
  avgCost: number | null;
}): FeaturePack {
  const { daily, intraday, currentPrice, avgCost } = opts;
  const closes = daily.c;
  const lastClose = lastOf(closes);
  // Prior session = the bar before the last (for pivots, which use a completed
  // session). Falls back to last close when only one bar exists.
  const n = daily.c.length;
  const priorIdx = n >= 2 ? n - 2 : n - 1;
  const priorHigh = daily.h[priorIdx] ?? null;
  const priorLow = daily.l[priorIdx] ?? null;
  const priorClose = daily.c[priorIdx] ?? null;
  const px = currentPrice ?? lastClose;

  // Levels
  const pivots =
    priorHigh != null && priorLow != null && priorClose != null
      ? (() => {
          const p = classicPivots(priorHigh, priorLow, priorClose);
          return { p: r(p.p)!, r1: r(p.r1)!, r2: r(p.r2)!, s1: r(p.s1)!, s2: r(p.s2)! };
        })()
      : null;

  const window20 = daily.c.length >= 20 ? 20 : daily.c.length;
  const high20 = daily.h.length ? r(Math.max(...daily.h.slice(-window20))) : null;
  const low20 = daily.l.length ? r(Math.min(...daily.l.slice(-window20))) : null;
  const high52w = daily.h.length ? r(Math.max(...daily.h)) : null; // ~1y of daily bars passed in
  const low52w = daily.l.length ? r(Math.min(...daily.l)) : null;

  // Volatility
  const atr = atrLast(daily);
  const atr14Pct = atr != null && px ? r((atr / px) * 100) : null;

  // Trend
  const sma20 = smaLast(closes, 20);
  const sma50 = smaLast(closes, 50);
  const sma200 = smaLast(closes, 200);
  const ema20 = emaLast(closes, 20);
  const ema50 = emaLast(closes, 50);
  const swingHighs = swingPoints(daily.h, 'high').map((v) => r(v)!);
  const swingLows = swingPoints(daily.l, 'low').map((v) => r(v)!);
  let structure: 'higher-highs' | 'lower-lows' | 'mixed' | null = null;
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const hh = swingHighs[0]! > swingHighs[1]!;
    const hl = swingLows[0]! > swingLows[1]!;
    const lh = swingHighs[0]! < swingHighs[1]!;
    const ll = swingLows[0]! < swingLows[1]!;
    structure = hh && hl ? 'higher-highs' : lh && ll ? 'lower-lows' : 'mixed';
  }

  // Momentum
  const rsi14 = rsi(closes);
  const rsiState: 'overbought' | 'oversold' | 'neutral' | null =
    rsi14 == null ? null : rsi14 >= 70 ? 'overbought' : rsi14 <= 30 ? 'oversold' : 'neutral';

  const m = macd(closes);
  const macdOut = m
    ? {
        line: r(m.macd)!,
        signal: r(m.signal)!,
        histogram: r(m.histogram, 4)!,
        cross: (m.macd > m.signal ? 'bullish' : m.macd < m.signal ? 'bearish' : 'none') as
          | 'bullish'
          | 'bearish'
          | 'none',
      }
    : null;

  const bb = bollinger(closes);
  const bollingerOut =
    bb && px
      ? {
          upper: r(bb.upper)!,
          middle: r(bb.middle)!,
          lower: r(bb.lower)!,
          percentB: bb.upper !== bb.lower ? r(((px - bb.lower) / (bb.upper - bb.lower)) * 100) : null,
          bandwidthPct: bb.middle ? r(((bb.upper - bb.lower) / bb.middle) * 100) : null,
        }
      : null;

  const vw = intraday ? vwap(intraday.h, intraday.l, intraday.c, intraday.v) : null;
  const vwapDistancePct = vw != null && px ? r(((px - vw) / vw) * 100) : null;

  // Relative volume: today's (last daily bar) vs trailing average, excluding today.
  const vols = daily.v;
  const todayVol = lastOf(vols);
  const avgVol = (period: number): number | null => {
    if (vols.length < period + 1) return null;
    const slice = vols.slice(-(period + 1), -1); // exclude today
    const sum = slice.reduce((a, b) => a + (b ?? 0), 0);
    return slice.length ? sum / slice.length : null;
  };
  const relVol = (period: number): number | null => {
    const a = avgVol(period);
    return a && todayVol != null && a > 0 ? r(todayVol / a) : null;
  };

  // Position-relative
  const positionRelative =
    avgCost != null && avgCost > 0
      ? {
          avgCost: r(avgCost)!,
          pctFromAvgCost: pctChange(avgCost, px),
          pctFrom52wHigh: pctChange(high52w, px),
          pctFrom52wLow: pctChange(low52w, px),
        }
      : null;

  return {
    price: { current: r(currentPrice), lastClose: r(lastClose), priorClose: r(priorClose) },
    levels: {
      pivots,
      swingHighs,
      swingLows,
      high20,
      low20,
      high52w,
      low52w,
      roundNumbers: roundMagnets(px),
    },
    volatility: { atr14: r(atr), atr14Pct },
    trend: {
      sma20: r(sma20),
      sma50: r(sma50),
      sma200: r(sma200),
      ema20: r(ema20),
      ema50: r(ema50),
      priceVsSma20Pct: pctChange(sma20, px),
      priceVsSma50Pct: pctChange(sma50, px),
      priceVsSma200Pct: pctChange(sma200, px),
      structure,
    },
    momentum: {
      rsi14: r(rsi14),
      rsiState,
      macd: macdOut,
      bollinger: bollingerOut,
      vwap: r(vw),
      vwapDistancePct,
      relativeVolume10d: relVol(10),
      relativeVolume30d: relVol(30),
    },
    positionRelative,
  };
}
