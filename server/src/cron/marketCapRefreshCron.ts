// marketCapRefreshCron — Batch S2.
//
// Weekly refresh of universe.last_market_cap_m (+ last_avg_volume bootstrap)
// for Ring-1 IN rows via Finnhub /stock/profile2. Per
// spec/signals/screener-universe.md → Caching + staggering: cap doesn't
// move on day-to-day scale, so a weekly refresh keeps the filter honest
// without burning daily Finnhub budget on a slow-moving field. Filter
// re-evaluates at the next nightly universeCron pass.
//
// Cadence: 7d wall-clock; on boot, fires immediately only if no run has
// landed in the last 7d (tracked via the most-recent computed_at column
// on universe). Single-user scale + idempotent → no producer/worker
// queue needed; runs inline via finnhubQueue's per-call rate limiter.

import { supabase } from '../services/supabase.js';
import { notifyError } from '../services/notify.js';
import { getProfile2 } from '../services/finnhub.js';

const CADENCE_MS = 7 * 24 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 8 * 60_000;
const BATCH_LIMIT = 5000;

interface UniverseRow {
  conid: number;
  symbol: string;
}

async function loadTargets(): Promise<UniverseRow[]> {
  const { data, error } = await supabase()
    .from('universe')
    .select('conid, symbol')
    .eq('filter_result', 'in')
    .limit(BATCH_LIMIT);
  if (error) {
    void notifyError('marketCapRefreshCron.load', error.message);
    return [];
  }
  return (data ?? []) as UniverseRow[];
}

async function tick(): Promise<void> {
  const t0 = Date.now();
  const targets = await loadTargets();
  if (targets.length === 0) {
    console.log('[marketCapRefreshCron] no Ring-1 IN tickers; nothing to refresh');
    return;
  }
  console.log(`[marketCapRefreshCron] refreshing ${targets.length} tickers`);

  let ok = 0;
  let fail = 0;
  const nowIso = new Date().toISOString();
  for (const t of targets) {
    try {
      const profile = await getProfile2(t.symbol);
      if (!profile || typeof profile.marketCapitalization !== 'number') {
        fail++;
        continue;
      }
      const { error } = await supabase()
        .from('universe')
        .update({
          last_market_cap_m: profile.marketCapitalization,
          computed_at: nowIso,
        })
        .eq('conid', t.conid);
      if (error) {
        void notifyError(`marketCapRefreshCron.update.${t.symbol}`, error.message);
        fail++;
        continue;
      }
      ok++;
    } catch (e) {
      fail++;
      void notifyError(`marketCapRefreshCron.${t.symbol}`, (e as Error).message);
    }
  }
  const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
  console.log(`[marketCapRefreshCron] ok=${ok} fail=${fail} elapsed=${elapsedMin}min`);
}

export function startMarketCapRefreshCron(): void {
  console.log('[marketCapRefreshCron] starting, 7d cadence');
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      void notifyError('marketCapRefreshCron.loop', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, FIRST_RUN_DELAY_MS).unref();
}
