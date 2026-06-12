// entryZonesCron — periodically refreshes `entry_zones` for every conid in an
// active watchlist (Batch A+). Computes the LLM-free dynamic entry zones via
// services/entryZones.ts and upserts the per-horizon rows. Realtime then
// propagates to the FE chips.
//
// Cadence: 15 minutes. Entry zones aren't tick-level — the underlying levels
// (SMAs, pivots, swing lows) only change as new bars complete. 15 min keeps
// the IB-history calls modest (~3-4 per active conid per hour) without losing
// usefulness. Bars are fetched live each cycle; a per-cycle in-process cache
// dedups calls when the same conid would be hit twice (currently a no-op,
// since each conid is fetched once per tick).

import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';
import { activeWatchlistOnlyConids } from '../services/quotes.js';
import { computeEntryZones, type Horizon, type EntryZone } from '../services/entryZones.js';
import { quotesTableModule } from '../adapters/supabase/quotesTableModule.js';
import { notifyError } from '../services/notify.js';
import { entryZonesTableModule } from '../adapters/supabase/entryZonesTableModule.js';
import type { Bars } from '../services/technicals.js';
import type { RawIbHistory } from '../types/index.js';

const CADENCE_MS = 15 * 60_000;
const HORIZONS: Horizon[] = ['intraday', 'overnight', 'multiday'];

function toBars(hist: RawIbHistory | null): Bars {
  const d = hist?.data ?? [];
  return {
    o: d.map((b) => b.o),
    h: d.map((b) => b.h),
    l: d.map((b) => b.l),
    c: d.map((b) => b.c),
    v: d.map((b) => b.v),
  };
}

async function activeConidsToProcess(): Promise<Array<{ conid: number; symbol: string }>> {
  // Held conids don't get entry zones in this pass (those would be SELL
  // playbooks, not BUY entries — out of scope for the entry engine). Watchlist
  // tickers that are *also* held still get zones — the engine is direction-
  // agnostic and the chip is informational.
  const targets = await activeWatchlistOnlyConids(new Set());
  return targets;
}

async function priceForConid(conid: number): Promise<number | null> {
  return quotesTableModule.getCanonicalPrice(conid).catch(() => null);
}

async function upsertZone(conid: number, horizon: Horizon, zone: EntryZone | null, trendRegime: string, overboughtTightened: boolean): Promise<void> {
  if (!zone) {
    // No candidate within this horizon's reachability band — wipe any stale
    // row so the FE doesn't show an out-of-date chip.
    await entryZonesTableModule.deleteZone(conid, horizon);
    return;
  }
  await entryZonesTableModule.upsert({
    conid,
    horizon,
    price: zone.price,
    reasoning: zone.reasoning,
    confidence: zone.confidence,
    trendRegime,
    overboughtTightened,
  });
}

async function tick(): Promise<void> {
  const status = await ibGateway.status().catch(() => ({ authenticated: false, connected: false }));
  if (!status.authenticated || !status.connected) {
    // No IB → no bars → no engine input. Skip silently; the next tick after
    // reconnect picks things up. (The engine is IB-gated by the same rule
    // as the playbook engine — bars come from IB only.)
    return;
  }

  const targets = await activeConidsToProcess();
  if (targets.length === 0) return;

  for (const { conid, symbol } of targets) {
    const currentPrice = await priceForConid(conid);
    if (currentPrice == null) continue;
    try {
      const daily = await ibGateway.history(conid, '1y', '1d');
      const intraday = await ibGateway.history(conid, '1d', '5min');
      const dailyBars = toBars(daily);
      const out = computeEntryZones({
        currentPrice,
        daily: dailyBars,
        intraday: intraday ? toBars(intraday) : null,
      });
      for (const h of HORIZONS) {
        await upsertZone(conid, h, out.zones[h], out.trendRegime, out.overboughtTightened);
      }
      // Piggyback: write the last 7 daily closes as the sparkline payload. The
      // cron is the natural owner since it already pulled the full year of
      // bars; writing here avoids a per-cycle IB call from the pollers.
      const closes = dailyBars.c;
      if (closes.length >= 1) {
        await quotesTableModule.setSparkline(conid, closes.slice(-7));
      }
    } catch (e) {
      void notifyError(`entryZonesCron.${symbol}`, (e as Error).message, e);
    }
  }
}

export function startEntryZonesCron(): void {
  console.log('[entryZonesCron] starting, 15min cadence');
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      void notifyError('entryZonesCron.tick', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  // First run after the app warms up.
  setTimeout(loop, 30_000).unref();
}
