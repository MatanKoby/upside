// TableModule for `risk_flags` — the SOLE server-side gatekeeper for the daily
// per-conid risk-flag rows (spec/signals/risk-flags.md). `riskFlags/engine.ts`
// (evaluateAndStore) is the single writer-owner; it's driven by both
// riskFlagsCron (nightly) and signalEngine (on-demand top-up). One reader: the
// prior-row `since`-carry lookup, also in the engine.
//
// Batch ARCH-3 (rollout slice 12). The module owns the column names + chunk-free
// I/O; the since-carry policy (a still-true flag keeps its first-seen date) and
// the compute live in the engine/domain. `flags` is a jsonb column, kept opaque
// here. Same SQL, no behavior change. See docs/arch/target-architecture.md.

import { TableModule } from './TableModule.js';

/** The prior-row slice the since-carry read consumes. `flags` is the raw jsonb
 *  payload (array of `{ key, since }`); the engine maps it to its keyed dates. */
export interface PrevFlagsRow {
  asofDate: string;
  flags: Array<{ key?: string; since?: string }>;
}

class RiskFlagsTableModule extends TableModule {
  constructor() {
    super('risk_flags');
  }

  /** Most-recent prior row (asof_date < asofDate) for a conid — the since-carry
   *  read. Null when the conid has no earlier row. */
  async getPrevRow(conid: number, asofDate: string): Promise<PrevFlagsRow | null> {
    const r = await this.run<{ asof_date: unknown; flags: unknown } | null>(
      'getPrevRow',
      this.from()
        .select('asof_date, flags')
        .eq('conid', conid)
        .lt('asof_date', asofDate)
        .order('asof_date', { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    if (!r) return null;
    return {
      asofDate: String(r.asof_date),
      flags: Array.isArray(r.flags) ? (r.flags as Array<{ key?: string; since?: string }>) : [],
    };
  }

  /** Delete the (conid, asof_date) row — the clean-ticker badge clear. */
  async deleteRow(conid: number, asofDate: string): Promise<void> {
    await this.run('deleteRow', this.from().delete().eq('conid', conid).eq('asof_date', asofDate));
  }

  /** Upsert the (conid, asof_date) flag row on its composite key. SOLE writer. */
  async upsertRow(
    conid: number,
    asofDate: string,
    flags: unknown,
    severity: string,
    computedAtIso: string,
  ): Promise<void> {
    await this.run(
      'upsertRow',
      this.from().upsert(
        { conid, asof_date: asofDate, flags, severity, computed_at: computedAtIso },
        { onConflict: 'conid,asof_date' },
      ),
    );
  }
}

export const riskFlagsTableModule = new RiskFlagsTableModule();
