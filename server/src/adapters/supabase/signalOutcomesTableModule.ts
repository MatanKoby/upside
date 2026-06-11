// TableModule for `signal_outcomes` — the SOLE server-side gatekeeper for the
// forward-tracking snapshots that grade each signal fire at +30m/+2h/+1d/+3d
// (spec/signals/dip-bounce-scorer.md → Forward-tracking; feeds the
// signal_hit_rate_30d view). signalOutcomesCron is the only writer and the only
// reader (its own dedup-of-already-recorded lookup).
//
// Batch ARCH-3 (rollout slice 11 — paired with signal_fires). The module owns
// the column names + snake↔camel mapping + chunking; the elapsed-offset / due
// math stays in the cron. Same SQL, no behavior change.

import { TableModule } from './TableModule.js';

/** One forward-tracking outcome snapshot (camelCase). */
export interface OutcomeUpsert {
  fireId: string;
  tOffset: string;
  snapshotTs: string;
  price: number;
  returnPct: number | null;
}

const READ_CHUNK = 900;

class SignalOutcomesTableModule extends TableModule {
  constructor() {
    super('signal_outcomes');
  }

  /** (fire_id, t_offset) pairs already recorded for a set of fire ids (chunked)
   *  — the "which offsets are done" dedup read. */
  async getExistingOffsets(fireIds: string[]): Promise<Array<{ fireId: string; tOffset: string }>> {
    const out: Array<{ fireId: string; tOffset: string }> = [];
    for (let i = 0; i < fireIds.length; i += READ_CHUNK) {
      const rows = await this.run<Array<{ fire_id: unknown; t_offset: unknown }>>(
        'getExistingOffsets',
        this.from().select('fire_id, t_offset').in('fire_id', fireIds.slice(i, i + READ_CHUNK)),
      );
      for (const r of rows ?? []) {
        out.push({ fireId: String(r.fire_id), tOffset: String(r.t_offset) });
      }
    }
    return out;
  }

  /** Upsert outcome snapshots on the (fire_id, t_offset) key. SOLE writer. */
  async upsertOutcomes(rows: OutcomeUpsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.run(
      'upsertOutcomes',
      this.from().upsert(
        rows.map((r) => ({
          fire_id: r.fireId,
          t_offset: r.tOffset,
          snapshot_ts: r.snapshotTs,
          price: r.price,
          return_pct: r.returnPct,
        })),
        { onConflict: 'fire_id,t_offset' },
      ),
    );
  }
}

export const signalOutcomesTableModule = new SignalOutcomesTableModule();
