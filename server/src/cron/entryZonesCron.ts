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

import { ibHistory, ibStatus } from '../services/ibGateway.js';
import { activeWatchlistOnlyConids } from '../services/quotes.js';
import { computeEntryZones, type Horizon, type EntryZone } from '../services/entryZones.js';
import { supabase } from '../services/supabase.js';
import { notifyError } from '../services/notify.js';
import type { Bars } from '../services/technicals.js';
import type { RawIbHistory } from '../types/index.js';

const CADENCE_MS = 15 * 60_000;
const HORIZONS: Horizon[] = ['intraday', 'overnight', 'multiday'];

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

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
  const { data } = await supabase()
    .from('quotes')
    .select('canonical_price')
    .eq('conid', conid)
    .maybeSingle();
  return num(data?.canonical_price);
}

async function upsertZone(conid: number, horizon: Horizon, zone: EntryZone | null, trendRegime: string, overboughtTightened: boolean): Promise<void> {
  if (!zone) {
    // No candidate within this horizon's reachability band — wipe any stale
    // row so the FE doesn't show an out-of-date chip.
    await supabase().from('entry_zones').delete().eq('conid', conid).eq('horizon', horizon);
    return;
  }
  await supabase().from('entry_zones').upsert(
    {
      conid,
      horizon,
      price: zone.price,
      reasoning: zone.reasoning,
      confidence: zone.confidence,
      trend_regime: trendRegime,
      overbought_tightened: overboughtTightened,
      computed_at: new Date().toISOString(),
    },
    { onConflict: 'conid,horizon' },
  );
}

async function tick(): Promise<void> {
  const status = await ibStatus().catch(() => ({ authenticated: false, connected: false }));
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
      const daily = await ibHistory(conid, '1y', '1d');
      const intraday = await ibHistory(conid, '1d', '5min');
      const out = computeEntryZones({
        currentPrice,
        daily: toBars(daily),
        intraday: intraday ? toBars(intraday) : null,
      });
      for (const h of HORIZONS) {
        await upsertZone(conid, h, out.zones[h], out.trendRegime, out.overboughtTightened);
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
