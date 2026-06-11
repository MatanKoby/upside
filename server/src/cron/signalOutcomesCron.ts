// signalOutcomesCron — Batch X1.
//
// Every 5 minutes, fills the +30m / +2h / +1d / +3d outcome snapshot for each
// `signal_fires` row whose offset has elapsed and isn't yet recorded. Snapshot
// price = the canonical quote at cron time; return_pct vs price_at_fire. Generic
// across signal kinds — band-touch + marker fires plug into the same backbone
// once ported. Feeds the signal_hit_rate_30d view. Spec:
// spec/signals/dip-bounce-scorer.md → Forward-tracking.

import { quotesTableModule } from '../adapters/supabase/quotesTableModule.js';
import { signalFiresTableModule, type RecentFireRow } from '../adapters/supabase/signalFiresTableModule.js';
import { signalOutcomesTableModule, type OutcomeUpsert } from '../adapters/supabase/signalOutcomesTableModule.js';
import { notifyError } from '../services/notify.js';
import { OUTCOME_OFFSETS } from '../config/dipBounceScorer.js';

const CADENCE_MS = 5 * 60_000;
const FIRST_RUN_DELAY_MS = 120_000;
const LONGEST_MS = 3 * 24 * 3600 * 1000; // +3d

async function loadRecentFires(): Promise<RecentFireRow[]> {
  // A small buffer past +3d so a fire's last offset is still pickable on the
  // tick right after it elapses.
  const since = new Date(Date.now() - LONGEST_MS - 6 * 3600 * 1000).toISOString();
  try {
    return await signalFiresTableModule.getRecentSince(since);
  } catch (e) {
    void notifyError('signalOutcomesCron.loadFires', (e as Error).message);
    return [];
  }
}

async function loadExistingOutcomes(fireIds: string[]): Promise<Set<string>> {
  const out = new Set<string>(); // `${fireId}:${offset}`
  const pairs = await signalOutcomesTableModule.getExistingOffsets(fireIds).catch(() => []);
  for (const p of pairs) out.add(`${p.fireId}:${p.tOffset}`);
  return out;
}

async function loadPrices(conids: number[]): Promise<Map<number, number>> {
  return quotesTableModule.getCanonicalPrices(conids).catch(() => new Map<number, number>());
}

async function tick(): Promise<void> {
  const fires = await loadRecentFires();
  if (fires.length === 0) return;
  const existing = await loadExistingOutcomes(fires.map((f) => f.id));
  const now = Date.now();

  // Which (fire, offset) pairs are due + unrecorded?
  interface Due { fire: RecentFireRow; offset: string }
  const due: Due[] = [];
  for (const fire of fires) {
    for (const off of OUTCOME_OFFSETS) {
      if (now < fire.fireMs + off.ms) continue; // not elapsed yet
      if (existing.has(`${fire.id}:${off.label}`)) continue;
      due.push({ fire, offset: off.label });
    }
  }
  if (due.length === 0) return;

  const prices = await loadPrices(due.map((d) => d.fire.conid));
  const rows: OutcomeUpsert[] = [];
  for (const d of due) {
    const price = prices.get(d.fire.conid);
    if (price == null) continue; // no quote → try again next tick
    const returnPct =
      d.fire.priceAtFire != null && d.fire.priceAtFire > 0
        ? ((price - d.fire.priceAtFire) / d.fire.priceAtFire) * 100
        : null;
    rows.push({
      fireId: d.fire.id,
      tOffset: d.offset,
      snapshotTs: new Date(now).toISOString(),
      price,
      returnPct,
    });
  }
  if (rows.length === 0) return;

  try {
    await signalOutcomesTableModule.upsertOutcomes(rows);
  } catch (e) {
    void notifyError('signalOutcomesCron.write', (e as Error).message);
    return;
  }
  console.log(`[signalOutcomesCron] wrote ${rows.length} outcome snapshots`);
}

export function startSignalOutcomesCron(): void {
  console.log('[signalOutcomesCron] starting, 5-min cadence');
  const loop = async (): Promise<void> => {
    try {
      await tick();
    } catch (e) {
      void notifyError('signalOutcomesCron.tick', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, FIRST_RUN_DELAY_MS).unref();
}
