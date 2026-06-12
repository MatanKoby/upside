// intradayStatsCron — Batch B.
//
// Runs once a day. For every conid in an active watchlist, pulls ~60 trading
// days of 5-min IB bars, runs `computeIntradayStats`, and upserts the per-
// symbol row in `intraday_stats`. Realtime then propagates to the FE.
//
// Cadence: once per 24h, kicked off ~5 min after api startup so it doesn't
// race the first quotes write. Schedule isn't pinned to a wall-clock time
// (overnight maintenance windows etc. would just defer it); it just runs and
// then sleeps 24h. Good enough for a single-user MVP; align to a specific
// hour later if needed.

import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';
import { activeWatchlistOnlyConids } from '../services/quotes.js';
import { computeIntradayStats, type IntradayBar } from '../services/intradayStats.js';
import { universeTableModule } from '../adapters/supabase/universeTableModule.js';
import { intradayStatsTableModule } from '../adapters/supabase/intradayStatsTableModule.js';
import { notifyError } from '../services/notify.js';
import type { RawIbHistory } from '../types/index.js';

const CADENCE_MS = 24 * 60 * 60_000;
const LOOKBACK_DAYS = 60;

function toIntradayBars(hist: RawIbHistory | null): IntradayBar[] {
  if (!hist?.data) return [];
  return hist.data.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

async function activeConidsToProcess(): Promise<Array<{ conid: number; symbol: string }>> {
  // Held conids aren't covered here (they don't get a stats-derived dip alert
  // — we already have zone-entry and marker alerts on positions). Watchlist
  // tickers that are also held still get stats — engine is direction-agnostic.
  return activeWatchlistOnlyConids(new Set());
}

// Batch S2 — staggered universe coverage. Each day refreshes 1/7 of the
// Ring-1 IN universe (the slice where `real_conid mod 7 = day_of_week`),
// so every universe ticker's intraday_stats is refreshed once per week
// on a rolling schedule. ~430 tickers/day × ~1 sec IB = ~7 min IB/day,
// fits inside the on-demand IBeam window. Spec:
// spec/signals/screener-universe.md → Caching + staggering.
async function staggeredUniverseConids(
  alreadyCovered: Set<number>,
): Promise<Array<{ conid: number; symbol: string }>> {
  const dow = new Date().getUTCDay();   // 0..6 — stable per UTC date
  let rows;
  try {
    rows = await universeTableModule.getResolvedInRows();
  } catch (e) {
    void notifyError('intradayStatsCron.loadUniverse', (e as Error).message);
    return [];
  }
  const out: Array<{ conid: number; symbol: string }> = [];
  for (const r of rows) {
    if (r.realConid == null) continue;
    if (r.realConid % 7 !== dow) continue;
    if (alreadyCovered.has(r.realConid)) continue;
    out.push({ conid: r.realConid, symbol: r.symbol });
  }
  return out;
}

async function tick(): Promise<void> {
  const status = await ibGateway.status().catch(() => ({ authenticated: false, connected: false }));
  if (!status.authenticated || !status.connected) {
    // Bars come from IB only (Track 9 unresolved). Skip silently; the next
    // 24h tick will catch up after the user reconnects.
    return;
  }

  const watchlistTargets = await activeConidsToProcess();
  const watchlistConidSet = new Set(watchlistTargets.map((t) => t.conid));
  const universeTargets = await staggeredUniverseConids(watchlistConidSet);
  const targets = [...watchlistTargets, ...universeTargets];
  if (targets.length === 0) return;
  console.log(
    `[intradayStatsCron] watchlist=${watchlistTargets.length} universe-slice=${universeTargets.length} total=${targets.length}`,
  );

  let okCount = 0;
  let failCount = 0;
  for (const { conid, symbol } of targets) {
    try {
      // IB period syntax: '2m' = 2 months (~60 trading days). bars at 5-min.
      const hist = await ibGateway.history(conid, '2m', '5mins');
      const bars = toIntradayBars(hist);
      if (bars.length === 0) {
        failCount++;
        continue;
      }
      const stats = computeIntradayStats({ bars, lookbackDays: LOOKBACK_DAYS });
      await intradayStatsTableModule.upsert(conid, symbol, stats);
      okCount++;
    } catch (e) {
      failCount++;
      void notifyError(`intradayStatsCron.${symbol}`, (e as Error).message, e);
    }
  }

  console.log(`[intradayStatsCron] ok=${okCount} fail=${failCount}`);
}

export function startIntradayStatsCron(): void {
  console.log('[intradayStatsCron] starting, 24h cadence');
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      void notifyError('intradayStatsCron.tick', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  // 5-min delay on first run so the api can stabilize after boot.
  setTimeout(loop, 5 * 60_000).unref();
}
