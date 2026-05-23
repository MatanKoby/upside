import { useEffect, useState } from 'react';
import { apiFetch, supabase } from '../services/supabase';

// Polls /api/portfolio/summary for the MTD return that the Portfolio screen's
// SummaryStrip displays. MTD is computed BE-side from a Redis-anchored month
// start (see server/src/services/mtdCache.ts); refreshing whenever the
// underlying positions tick keeps the FE figure in sync without a per-row
// recompute.

interface SummaryResponse {
  totalValue: number;
  totalPnl: number;
  mtdAnchor: number | null;
  mtdReturn: number | null;
  mtdReturnPercent: number | null;
  updatedAt: string;
}

export interface PortfolioSummary {
  totalValue: number;
  totalPnl: number;
  mtdReturn: number | null;
  mtdReturnPercent: number | null;
}

const REFRESH_MS = 30_000;

export function usePortfolioSummary(): PortfolioSummary {
  const [summary, setSummary] = useState<PortfolioSummary>({
    totalValue: 0,
    totalPnl: 0,
    mtdReturn: null,
    mtdReturnPercent: null,
  });

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load(): Promise<void> {
      try {
        const res = await apiFetch('/api/portfolio/summary');
        if (!res.ok) return;
        const body = (await res.json()) as SummaryResponse;
        if (!alive) return;
        setSummary({
          totalValue: body.totalValue,
          totalPnl: body.totalPnl,
          mtdReturn: body.mtdReturn,
          mtdReturnPercent: body.mtdReturnPercent,
        });
      } catch {
        // Network errors are transient; next tick or Realtime nudge tries again.
      } finally {
        if (alive) timer = setTimeout(load, REFRESH_MS);
      }
    }

    void load();

    // Realtime: pump a refresh whenever positions change so MTD reflects the
    // latest portfolio value without waiting for the 30s tick.
    const channel = supabase
      .channel('portfolio-summary')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'positions' },
        () => void load(),
      )
      .subscribe();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, []);

  return summary;
}
