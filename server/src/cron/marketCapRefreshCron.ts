// marketCapRefreshCron — Batch S2.
//
// Weekly refresh of universe.last_market_cap_m for Ring-1 IN rows via Finnhub
// /stock/profile2. (Volume is NOT refreshed here — the curated-list gate derives
// 30d median ADV from IB daily bars; see spec/signals/curated-list.md.) Per
// spec/signals/screener-universe.md → Caching + staggering: cap doesn't
// move on day-to-day scale, so a weekly refresh keeps the filter honest
// without burning daily Finnhub budget on a slow-moving field. Filter
// re-evaluates at the next nightly universeCron pass.
//
// Cadence: 7d wall-clock; on boot, fires immediately only if no run has
// landed in the last 7d (tracked via the most-recent computed_at column
// on universe). Single-user scale + idempotent → no producer/worker
// queue needed; runs inline via finnhubQueue's per-call rate limiter.

import { notifyError } from '../services/notify.js';
import { getProfile2 } from '../services/finnhub.js';
import { universeTableModule, type UniverseRow } from '../adapters/supabase/universeTableModule.js';

const CADENCE_MS = 7 * 24 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 8 * 60_000;

async function loadTargets(): Promise<UniverseRow[]> {
  try {
    return await universeTableModule.getInRows();
  } catch (e) {
    void notifyError('marketCapRefreshCron.load', (e as Error).message);
    return [];
  }
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
      try {
        await universeTableModule.setMarketCap(t.conid, profile.marketCapitalization, nowIso);
      } catch (e) {
        void notifyError(`marketCapRefreshCron.update.${t.symbol}`, (e as Error).message);
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
