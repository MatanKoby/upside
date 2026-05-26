// zoneGapCleanup — clears the per-trading-day "entered via gap" badge (Batch 14c).
//
// `entered_zone_via_gap` marks a zone entry that happened outside the regular
// session (pre-market / overnight), which the FE surfaces as a small "GAP"
// badge — meaningful only for the current trading day, since gap moves often
// fade at the open. Once the regular session is over for an ET day, clear the
// flag for all positions exactly once. Cheap, single-owner app, so no user
// filter is needed (an always-true predicate satisfies Supabase's update guard).

import { supabase } from '../services/supabase.js';
import { marketPeriodAt, etDateString } from '../utils/marketHours.js';
import { notifyError } from '../services/notify.js';

const CHECK_INTERVAL_MS = 10 * 60_000; // 10 min — coarse; the clear is idempotent.

let running = false;
let stopRequested = false;
let timer: NodeJS.Timeout | null = null;
let lastClearedEtDate: string | null = null;

async function tick(): Promise<void> {
  try {
    const period = marketPeriodAt();
    const today = etDateString();
    // After the regular session ends (after-hours / closed), clear once per ET
    // day. Also fires on weekends/holidays — a harmless no-op when nothing is set.
    if ((period === 'after-hours' || period === 'closed') && lastClearedEtDate !== today) {
      const { error } = await supabase()
        .from('positions')
        .update({ entered_zone_via_gap: false })
        .eq('entered_zone_via_gap', true);
      if (error) {
        void notifyError('zoneGapCleanup.update', error.message);
      } else {
        lastClearedEtDate = today;
      }
    }
  } catch (e) {
    void notifyError('zoneGapCleanup.tick', (e as Error).message ?? 'unknown', e);
  } finally {
    if (!stopRequested) {
      timer = setTimeout(tick, CHECK_INTERVAL_MS);
    }
  }
}

export function startZoneGapCleanup(): void {
  if (running) return;
  running = true;
  stopRequested = false;
  console.log(`[zoneGapCleanup] starting; ${CHECK_INTERVAL_MS / 60_000}min cadence`);
  void tick();
}

export function stopZoneGapCleanup(): void {
  stopRequested = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  running = false;
}
