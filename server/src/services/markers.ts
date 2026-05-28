// Marker check (Batch A2) — runs on every `quotes` write. Given the old and
// new canonical_price for a conid, finds any enabled markers, applies the
// geometric transition rule (per condition), gates on the per-marker cooldown,
// and fires the appropriate Discord notifier.
//
// Today only `at_or_below` (dip-buys) has a wired channel; other conditions
// are accepted in schema for forward-compatibility but skipped here until
// their channels land.

import { supabase } from './supabase.js';
import { notifyDipBuyMarkerHit, notifyError } from './notify.js';

interface MarkerRow {
  id: string;
  item_id: string;
  label: string | null;
  price: number | string;
  condition: 'at_or_above' | 'at_or_below' | 'about';
  enabled: boolean;
  cooldown_hours: number | string;
  last_fired_at: string | null;
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

function cooldownPassed(cooldownHours: number, lastFiredAt: string | null): boolean {
  if (!lastFiredAt) return true;
  const sinceMs = Date.now() - new Date(lastFiredAt).getTime();
  return sinceMs >= cooldownHours * 3600 * 1000;
}

/**
 * Returns true if `curr` crossed `price` according to `condition`, given the
 * prior price `prev`. Transition-based — a sustained "already below" state
 * doesn't re-fire (the cooldown is a defense-in-depth on top of this).
 */
function crossed(condition: MarkerRow['condition'], price: number, prev: number, curr: number): boolean {
  switch (condition) {
    case 'at_or_below':
      return prev > price && curr <= price;
    case 'at_or_above':
      return prev < price && curr >= price;
    case 'about': {
      // Enter a ±0.5% band around the level (conservative magnitude; will tune
      // empirically). The "about" channel isn't wired yet, but we record the
      // transition logic so it's consistent when the channel lands.
      const band = Math.abs(price) * 0.005;
      const inBandPrev = Math.abs(prev - price) <= band;
      const inBandCurr = Math.abs(curr - price) <= band;
      return !inBandPrev && inBandCurr;
    }
  }
}

/**
 * Called from `upsertQuote` after the row is written. `prev` is null only on
 * the very first write for a conid — in that case we skip checks to avoid
 * a spurious fire when a marker happens to sit right where the first quote
 * lands.
 */
export async function checkMarkersForConid(
  conid: number,
  symbol: string,
  prev: number | null,
  curr: number,
): Promise<void> {
  if (prev == null || !Number.isFinite(curr)) return;
  if (prev === curr) return; // no transition possible

  // Find markers attached to any watchlist_items row with this conid. RLS
  // would scope to a user, but the poller runs with service_role and reads
  // across users. (Single-user MVP — sufficient for now; revisit when the
  // multi-user `ib-gateway` pattern lands.)
  const { data: items } = await supabase()
    .from('watchlist_items')
    .select('id')
    .eq('conid', conid);
  const itemIds = (items ?? []).map((r) => r.id as string);
  if (itemIds.length === 0) return;

  const { data, error } = await supabase()
    .from('watchlist_markers')
    .select('id, item_id, label, price, condition, enabled, cooldown_hours, last_fired_at')
    .in('item_id', itemIds)
    .eq('enabled', true);
  if (error) {
    void notifyError('markers.check', `query failed for conid ${conid}: ${error.message}`);
    return;
  }
  const markers = (data ?? []) as MarkerRow[];

  for (const m of markers) {
    const price = num(m.price);
    const cd = Number(m.cooldown_hours);
    if (price == null) continue;
    if (!crossed(m.condition, price, prev, curr)) continue;
    if (!cooldownPassed(cd, m.last_fired_at)) continue;

    // Fire BEFORE updating last_fired_at so a slow notify doesn't lose the
    // event on a transient DB hiccup. Idempotency is enforced by the
    // transition+cooldown gate above — two near-simultaneous calls can't
    // both pass because the second sees the updated last_fired_at on the
    // next cycle. (Within a single cycle they'd both fire; acceptable risk
    // until the poller iteration is serialized at a finer grain.)
    try {
      if (m.condition === 'at_or_below') {
        await notifyDipBuyMarkerHit({ symbol, markerPrice: price, currentPrice: curr, label: m.label });
      } else {
        // at_or_above and about — channels queued for follow-up batches.
        // Skip silently for now (the transition was recorded; we just don't
        // ping yet). Update last_fired_at anyway so when the channel lands,
        // we don't fire on the historical crossing.
      }
    } catch (e) {
      void notifyError('markers.notify', `dip-buy notify failed for ${symbol}: ${(e as Error).message}`, e);
    }
    const now = new Date().toISOString();
    const upd = await supabase()
      .from('watchlist_markers')
      .update({ last_fired_at: now })
      .eq('id', m.id);
    if (upd.error) {
      void notifyError('markers.update', `last_fired_at update failed for marker ${m.id}: ${upd.error.message}`);
    }
  }
}
