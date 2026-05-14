import { useEffect, useState } from 'react';
import { apiFetch } from '../services/supabase';
import type { CandlestickData, HistogramData, LineData, Time } from 'lightweight-charts';

interface RawBar { t: number; o: number; h: number; l: number; c: number; v: number; }
interface RawVwap { t: number; v: number; }
interface RawBundle { bars: RawBar[]; vwap: RawVwap[]; }

export interface ChartHistory {
  candles: CandlestickData<Time>[];
  closeLine: LineData<Time>[];
  vwap: LineData<Time>[];
  volume: HistogramData<Time>[];
}

function toTime(ms: number): Time {
  return Math.floor(ms / 1000) as Time;
}

function bundleToChartHistory(b: RawBundle): ChartHistory {
  const candles: CandlestickData<Time>[] = b.bars.map((bar) => ({
    time: toTime(bar.t),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
  }));
  const closeLine: LineData<Time>[] = b.bars.map((bar) => ({
    time: toTime(bar.t),
    value: bar.c,
  }));
  const vwap: LineData<Time>[] = b.vwap.map((p) => ({
    time: toTime(p.t),
    value: p.v,
  }));
  const volume: HistogramData<Time>[] = b.bars.map((bar) => ({
    time: toTime(bar.t),
    value: bar.v,
  }));
  return { candles, closeLine, vwap, volume };
}

export function useChartHistory(symbol: string | undefined, timeframe: string): {
  history: ChartHistory | null;
  isLoading: boolean;
  error: string | null;
} {
  const [history, setHistory] = useState<ChartHistory | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!symbol) {
      setHistory(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);

    apiFetch(`/api/marketdata/history/${encodeURIComponent(symbol)}?timeframe=${encodeURIComponent(timeframe)}`)
      .then(async (res) => {
        if (!alive) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? `history fetch failed (${res.status})`);
          setHistory(null);
          return;
        }
        const bundle = (await res.json()) as RawBundle;
        setHistory(bundleToChartHistory(bundle));
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
      })
      .finally(() => {
        if (alive) setIsLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [symbol, timeframe]);

  return { history, isLoading, error };
}
