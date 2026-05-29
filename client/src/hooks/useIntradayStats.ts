// useIntradayStats — single-symbol stats lookup for TickerDetail.
//
// The watchlist screen loads stats in bulk by conid (via useWatchlistData);
// TickerDetail only has a symbol in scope, so it queries by `symbol` (also
// indexed in migration 017). Realtime sub is kept so the panel updates after
// the nightly cron writes without a hard refresh.

import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';
import type { IntradayStatsRow } from './useWatchlistData';

interface State {
  loading: boolean;
  stats: IntradayStatsRow | null;
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

function normalize(r: IntradayStatsRow): IntradayStatsRow {
  return {
    ...r,
    open_fade_pct_mean: num(r.open_fade_pct_mean),
    open_fade_pct_p50: num(r.open_fade_pct_p50),
    open_fade_pct_p25: num(r.open_fade_pct_p25),
    close_fade_pct_mean: num(r.close_fade_pct_mean),
    close_fade_pct_p50: num(r.close_fade_pct_p50),
    close_fade_pct_p25: num(r.close_fade_pct_p25),
    intraday_low_pct_mean: num(r.intraday_low_pct_mean),
    intraday_low_pct_p50: num(r.intraday_low_pct_p50),
    intraday_low_pct_p75: num(r.intraday_low_pct_p75),
  };
}

export function useIntradayStats(symbol: string | undefined): State {
  const [state, setState] = useState<State>({ loading: true, stats: null });

  useEffect(() => {
    if (!symbol) {
      setState({ loading: false, stats: null });
      return;
    }
    let alive = true;

    async function load() {
      const { data } = await supabase
        .from('intraday_stats')
        .select(
          'conid, open_fade_pct_mean, open_fade_pct_p50, open_fade_pct_p25, ' +
          'close_fade_pct_mean, close_fade_pct_p50, close_fade_pct_p25, ' +
          'intraday_low_pct_mean, intraday_low_pct_p50, intraday_low_pct_p75, ' +
          'sample_size, lookback_days, computed_at',
        )
        .eq('symbol', symbol)
        .maybeSingle();
      if (!alive) return;
      setState({ loading: false, stats: data ? normalize(data as unknown as IntradayStatsRow) : null });
    }

    void load();

    const ch = supabase
      .channel(`stats-${symbol}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'intraday_stats' }, () => void load())
      .subscribe();

    return () => {
      alive = false;
      void supabase.removeChannel(ch);
    };
  }, [symbol]);

  return state;
}
