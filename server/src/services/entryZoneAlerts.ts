// Entry-zone hit detection (Batch A+, Batch C noise floor).
//
// Runs from `upsertQuote` on every canonical price transition. Fires a
// Discord alert when the current price enters the band around a computed
// entry zone, with a per-(conid, horizon) 24h cooldown anchored on
// `entry_zones.last_fired_at` (defense-in-depth on top of the transition gate).
//
// Three noise filters from the dip-buys channel audit:
//
//   1. **Confidence floor** (`MIN_CONFIDENCE_PCT`) — drop zones below 60%
//      conviction. Sub-60% historically meant 24%/8%/4% zones firing,
//      e.g. VLN at 8% (essentially "we made this up").
//
//   2. **Overshoot gate** (`OVERSHOOT_TOLERANCE_PCT`) — fire only if current
//      price is within 1% of the zone level on cross-down. Filters fires
//      where price plunged well below the zone in a single tick (alert is
//      stale; the trade opportunity already passed).
//
//   3. **Horizon collapse** — the engine produces three rows per ticker
//      (intraday + overnight + multiday) that often land within ~1% of each
//      other. Group survivors by approximate price level and fire only
//      the highest-confidence one per cluster, then stamp `last_fired_at`
//      on all horizons in the cluster so the suppressed ones don't fire
//      independently from a near-future transition.
//
// "Entering the band" still requires `prev > zone.price && curr <= zone.price`
// (mirrors the `at_or_below` marker logic — entry zones are by definition
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
const MIN_CONFIDENCE_PCT = 60;        // Filter sub-60% noise (audit, 2026-05-30).
const OVERSHOOT_TOLERANCE_PCT = 1.0;  // Allow up to 1% below zone before treating it as overshoot.
const CLUSTER_EPSILON_PCT = 1.0;      // Zones within 1% of each other collapse to one alert.

function cooldownPassed(lastFiredAt: string | null): boolean {
  if (!lastFiredAt) return true;
  return Date.now() - new Date(lastFiredAt).getTime() >= COOLDOWN_HOURS * 3600 * 1000;
}

function crossedDown(zonePrice: number, prev: number, curr: number): boolean {
  return prev > zonePrice && curr <= zonePrice;
}

function withinOvershootBand(zonePrice: number, curr: number): boolean {
  // Reject fires where curr is more than OVERSHOOT_TOLERANCE_PCT below the zone.
  const floor = zonePrice * (1 - OVERSHOOT_TOLERANCE_PCT / 100);
  return curr >= floor;
}

interface CandidateZone {
  row: ZoneRow;
  zonePrice: number;
}

/**
 * Group candidates by approximate price level — two zones within
 * CLUSTER_EPSILON_PCT of each other land in the same cluster. Sort by price
 * first so the greedy walk picks tight neighborhoods.
 */
function clusterByPrice(candidates: CandidateZone[]): CandidateZone[][] {
  if (candidates.length === 0) return [];
  const sorted = [...candidates].sort((a, b) => a.zonePrice - b.zonePrice);
  const clusters: CandidateZone[][] = [];
  let current: CandidateZone[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prevAnchor = current[0]!.zonePrice;
    const c = sorted[i]!;
    const within = Math.abs(c.zonePrice - prevAnchor) / prevAnchor * 100 <= CLUSTER_EPSILON_PCT;
    if (within) {
      current.push(c);
    } else {
      clusters.push(current);
      current = [c];
    }
  }
  clusters.push(current);
  return clusters;
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

  const candidates: CandidateZone[] = [];
  for (const r of (data ?? []) as ZoneRow[]) {
    const zonePrice = typeof r.price === 'number' ? r.price : Number(r.price);
    if (!Number.isFinite(zonePrice)) continue;
    if (r.confidence < MIN_CONFIDENCE_PCT) continue;
    if (!crossedDown(zonePrice, prev, curr)) continue;
    if (!withinOvershootBand(zonePrice, curr)) continue;
    if (!cooldownPassed(r.last_fired_at)) continue;
    candidates.push({ row: r, zonePrice });
  }

  if (candidates.length === 0) return;

  const clusters = clusterByPrice(candidates);
  const nowIso = new Date().toISOString();

  for (const cluster of clusters) {
    // Highest confidence wins the alert; ties broken by horizon (multiday > overnight > intraday).
    const horizonRank: Record<ZoneRow['horizon'], number> = { multiday: 3, overnight: 2, intraday: 1 };
    const best = cluster.reduce((acc, c) =>
      c.row.confidence > acc.row.confidence ||
      (c.row.confidence === acc.row.confidence && horizonRank[c.row.horizon] > horizonRank[acc.row.horizon])
        ? c : acc, cluster[0]!);

    try {
      await notifyEntryZoneHit({
        symbol,
        horizon: best.row.horizon,
        zonePrice: best.zonePrice,
        currentPrice: curr,
        reasoning: best.row.reasoning,
        confidence: best.row.confidence,
      });
    } catch (e) {
      void notifyError(
        'entryZoneAlerts.notify',
        `notify failed for ${symbol} ${best.row.horizon}: ${(e as Error).message}`,
        e,
      );
    }

    // Stamp last_fired_at on EVERY horizon in the cluster so suppressed ones
    // don't fire on their own from a near-future tick crossing the same level.
    const horizonsToStamp = cluster.map((c) => c.row.horizon);
    const upd = await supabase()
      .from('entry_zones')
      .update({ last_fired_at: nowIso })
      .eq('conid', conid)
      .in('horizon', horizonsToStamp);
    if (upd.error) {
      void notifyError('entryZoneAlerts.update', `last_fired_at update failed: ${upd.error.message}`);
    }
  }
}
