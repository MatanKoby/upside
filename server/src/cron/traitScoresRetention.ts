// traitScoresRetention — Batch S2.
//
// Daily sweep that drops trait_scores rows past their shelf life per
// spec/signals/screener-universe.md:
//   - intraday_range_trader: 1 day (re-computed nightly, no need to carry forward)
//   - catalyst_reversal:     3 days
//   - post_earnings_drift:   5 days (matches the trait's signal window)
//
// Cadence: 24h, 7-min boot delay so the screener producers finish their
// first writes before retention starts trimming.

import { notifyError } from '../services/notify.js';
import { traitScoresTableModule, type TraitKind } from '../adapters/supabase/traitScoresTableModule.js';

const CADENCE_MS = 24 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 7 * 60_000;

const SHELF_LIFE_DAYS: Record<TraitKind, number> = {
  intraday_range_trader: 1,
  catalyst_reversal:     3,
  post_earnings_drift:   5,
};

function daysAgoIsoDate(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

async function tick(): Promise<void> {
  let totalDeleted = 0;
  for (const [trait, days] of Object.entries(SHELF_LIFE_DAYS) as Array<[TraitKind, number]>) {
    const cutoff = daysAgoIsoDate(days);
    let count: number;
    try {
      count = await traitScoresTableModule.purgeOlderThan(trait, cutoff);
    } catch (e) {
      void notifyError(`traitScoresRetention.${trait}`, (e as Error).message);
      continue;
    }
    if (count > 0) {
      totalDeleted += count;
      console.log(`[traitScoresRetention] ${trait}: deleted ${count} rows older than ${cutoff}`);
    }
  }
  if (totalDeleted === 0) {
    console.log('[traitScoresRetention] no rows past shelf life');
  }
}

export function startTraitScoresRetention(): void {
  console.log('[traitScoresRetention] starting, 24h cadence');
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      void notifyError('traitScoresRetention.loop', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, FIRST_RUN_DELAY_MS).unref();
}
