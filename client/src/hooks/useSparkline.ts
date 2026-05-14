import { useEffect, useState } from 'react';
import { apiFetch } from '../services/supabase';

// Module-level memo so we don't re-fetch sparklines on every render of
// PositionCard. Sparklines are stable through a trading day (7 daily closes).
// Stale entries refresh when the user reopens the app.
const cache = new Map<string, number[]>();

export function useSparkline(symbol: string): number[] {
  const [closes, setCloses] = useState<number[]>(() => cache.get(symbol) ?? []);

  useEffect(() => {
    if (cache.has(symbol)) return;
    let alive = true;
    apiFetch(`/api/marketdata/sparkline/${encodeURIComponent(symbol)}`)
      .then(async (res) => {
        if (!alive || !res.ok) return;
        const body = (await res.json()) as { closes: number[] };
        if (Array.isArray(body.closes)) {
          cache.set(symbol, body.closes);
          setCloses(body.closes);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [symbol]);

  return closes;
}
