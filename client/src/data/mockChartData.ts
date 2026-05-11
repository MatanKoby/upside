import type { CandlestickData, HistogramData, LineData, Time } from 'lightweight-charts';

export type ChartTimeframe = '30m' | '2h' | '1D' | '2D' | '1W' | '1M' | '3M' | '1Y' | '5Y' | 'All';

export type TickerChartData = {
  candles: CandlestickData<Time>[];
  closeLine: LineData<Time>[];
  vwap: LineData<Time>[];
  volume: HistogramData<Time>[];
  rsi: LineData<Time>[];
  entryPrice: number;
  entryDate: Time;
};

function toTime(ts: number): Time {
  return Math.floor(ts / 1000) as Time;
}

function buildSeries(start: number, count: number, stepMs: number, anchor: number): TickerChartData {
  const candles: CandlestickData<Time>[] = [];
  const closeLine: LineData<Time>[] = [];
  const vwap: LineData<Time>[] = [];
  const volume: HistogramData<Time>[] = [];
  const rsi: LineData<Time>[] = [];

  let close = anchor;
  for (let i = 0; i < count; i += 1) {
    const time = toTime(start + i * stepMs);
    const drift = Math.sin(i / 5) * 0.7 + (i % 7 === 0 ? 0.8 : -0.2);
    const open = close;
    close = Math.max(1, close + drift);
    const high = Math.max(open, close) + 0.9 + Math.abs(Math.sin(i * 0.4));
    const low = Math.min(open, close) - 0.8 - Math.abs(Math.cos(i * 0.35));
    const vwapValue = (open + high + low + close) / 4;
    const rsiValue = 45 + Math.sin(i / 3.7) * 19 + (i % 13 === 0 ? 8 : 0);

    candles.push({ time, open, high, low, close });
    closeLine.push({ time, value: close });
    vwap.push({ time, value: vwapValue });
    rsi.push({ time, value: Math.max(10, Math.min(90, rsiValue)) });
    volume.push({
      time,
      value: Math.round(32000 + Math.abs(Math.sin(i / 2)) * 14000 + (i % 9) * 1200),
      color: close >= open ? 'rgba(99, 153, 34, 0.45)' : 'rgba(226, 75, 74, 0.45)',
    });
  }

  const entryIndex = Math.max(0, Math.floor(count * 0.28));
  const entry = candles[entryIndex];
  return {
    candles,
    closeLine,
    vwap,
    volume,
    rsi,
    entryPrice: entry.close,
    entryDate: entry.time,
  };
}

const now = Date.now();

export const mockChartDataByTimeframe: Record<ChartTimeframe, TickerChartData> = {
  '30m': buildSeries(now - 30 * 60 * 1000, 45, 60 * 1000, 139),
  '2h': buildSeries(now - 2 * 60 * 60 * 1000, 60, 2 * 60 * 1000, 139),
  '1D': buildSeries(now - 24 * 60 * 60 * 1000, 72, 20 * 60 * 1000, 138.5),
  '2D': buildSeries(now - 2 * 24 * 60 * 60 * 1000, 70, 45 * 60 * 1000, 137.5),
  '1W': buildSeries(now - 7 * 24 * 60 * 60 * 1000, 84, 2 * 60 * 60 * 1000, 136.5),
  '1M': buildSeries(now - 30 * 24 * 60 * 60 * 1000, 90, 8 * 60 * 60 * 1000, 131),
  '3M': buildSeries(now - 90 * 24 * 60 * 60 * 1000, 90, 24 * 60 * 60 * 1000, 124),
  '1Y': buildSeries(now - 365 * 24 * 60 * 60 * 1000, 80, 5 * 24 * 60 * 60 * 1000, 102),
  '5Y': buildSeries(now - 5 * 365 * 24 * 60 * 60 * 1000, 84, 24 * 24 * 60 * 60 * 1000, 55),
  All: buildSeries(now - 8 * 365 * 24 * 60 * 60 * 1000, 90, 32 * 24 * 60 * 60 * 1000, 38),
};
