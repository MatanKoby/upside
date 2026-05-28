// Entry-zone hit detection (Batch A+). Runs from `upsertQuote` on every
// canonical price transition. Fires a Discord alert when current price enters
// the band around a computed entry zone, with a per-(conid, horizon) 24h
// cooldown anchored on `entry_zones.last_fired_at` (defense-in-depth on top
// of the transition gate).
//
// "Entering the band" = `prev` was above zone.price and `curr` is at or below
// it (mirrors the marker `at_or_below` logic — entry zones are by definition
// support levels below price, so a crossing always goes down into them).

import { supabase } from './supabase.js';
import { notifyEntryZoneHit, notifyError } from './notify.js';

interface ZoneRow {
  conid: number;
  horizon: 'intraday' | 'overnight' | 'multiday';
  price: number | string;
  reasoning: string;
  confidence: number;
  last_fired_at: string | null;
}

const COOLDOWN_HOURS = 24;

function cooldownPassed(lastFiredAt: string | null): boolean {
  if (!lastFiredAt) return true;
  return Date.now() - new Date(lastFiredAt).getTime() >= COOLDOWN_HOURS * 3600 * 1000;
}

function crossedDown(zonePrice: number, prev: number, curr: number): boolean {
  return prev > zonePrice && curr <= zonePrice;
}

export async function checkEntryZonesForConid(
  conid: number,
  symbol: string,
  prev: number | null,
  curr: number,
): Promise<void> {
  if (prev == null || !Number.isFinite(curr)) return;
  if (prev === curr) return;

  const { data, error } = await supabase()
    .from('entry_zones')
    .select('conid, horizon, price, reasoning, confidence, last_fired_at')
    .eq('conid', conid);
  if (error) {
    void notifyError('entryZoneAlerts.query', `query failed for conid ${conid}: ${error.message}`);
    return;
  }

  for (const r of (data ?? []) as ZoneRow[]) {
    const zonePrice = typeof r.price === 'number' ? r.price : Number(r.price);
    if (!Number.isFinite(zonePrice)) continue;
    if (!crossedDown(zonePrice, prev, curr)) continue;
    if (!cooldownPassed(r.last_fired_at)) continue;

    try {
      await notifyEntryZoneHit({
        symbol,
        horizon: r.horizon,
        zonePrice,
        currentPrice: curr,
        reasoning: r.reasoning,
        confidence: r.confidence,
      });
    } catch (e) {
      void notifyError('entryZoneAlerts.notify', `notify failed for ${symbol} ${r.horizon}: ${(e as Error).message}`, e);
    }
    const upd = await supabase()
      .from('entry_zones')
      .update({ last_fired_at: new Date().toISOString() })
      .eq('conid', conid)
      .eq('horizon', r.horizon);
    if (upd.error) {
      void notifyError('entryZoneAlerts.update', `last_fired_at update failed: ${upd.error.message}`);
    }
  }
}
