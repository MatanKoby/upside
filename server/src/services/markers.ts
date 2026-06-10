// Marker check (Batch A2) — runs on every `quotes` write. Given the old and
// new canonical_price for a conid, finds any enabled markers, applies the
// geometric transition rule (per condition), gates on the per-marker cooldown,
// and fires the appropriate Discord notifier.
//
// Today only `at_or_below` (dip-buys) has a wired channel; other conditions
// are accepted in schema for forward-compatibility but skipped here until
// their channels land.

import { watchlistMarkersTableModule, type MarkerRow } from '../db/watchlistMarkersTableModule.js';
import { notifyDipBuyMarkerHit, notifyError } from './notify.js';

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

  // Markers are now keyed directly by (user_id, conid) — see migration 016.
  // One query, no item-chain join. Service role bypasses RLS, so the poller
  // reads all users' markers in one pass (single-user MVP — revisit when
  // multi-user lands).
  let markers: MarkerRow[];
  try {
    markers = await watchlistMarkersTableModule.getEnabledByConid(conid);
  } catch (e) {
    void notifyError('markers.check', `query failed for conid ${conid}: ${(e as Error).message}`);
    return;
  }

  for (const m of markers) {
    const price = m.price;
    const cd = m.cooldownHours;
    if (price == null) continue;
    if (!crossed(m.condition, price, prev, curr)) continue;
    if (!cooldownPassed(cd, m.lastFiredAt)) continue;

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
    try {
      await watchlistMarkersTableModule.stampFired(m.id, now);
    } catch (e) {
      void notifyError('markers.update', `last_fired_at update failed for marker ${m.id}: ${(e as Error).message}`);
    }
  }
}
