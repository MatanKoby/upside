import { RSI, MACD, BollingerBands } from 'technicalindicators';

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
