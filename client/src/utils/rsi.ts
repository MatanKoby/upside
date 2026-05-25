import type { CandlestickData, LineData, Time } from 'lightweight-charts';

// Wilder's RSI computed client-side from fetched candle closes. The chart's RSI
// subchart was hardcoded to `[]` on the real-data path (only the mock had RSI),
// so the banded pane rendered with no line. This produces the line so the bands
// have data to sit behind. Returns [] when there aren't enough bars to seed the
// first average, which the caller uses to suppress the bands entirely.
export function rsiLineFromCandles(candles: CandlestickData<Time>[], period = 14): LineData<Time>[] {
  if (candles.length <= period) return [];

  const closes = candles.map((c) => c.close);
  const out: LineData<Time>[] = [];

  // Seed average gain/loss over the first `period` deltas.
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gainSum += delta;
    else lossSum -= delta;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  const push = (idx: number) => {
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    out.push({ time: candles[idx].time, value: rsi });
  };

  // First RSI value lands on the bar at index `period`.
  push(period);

  // Wilder smoothing for the rest.
  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    push(i);
  }

  return out;
}
