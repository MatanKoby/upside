// TableModule for `analysis_locks` — the SOLE server-side gatekeeper for the
// one-running-analysis-per-(user, symbol) concurrency lock (spec/signals/
// playbook.md → Concurrency lock). The /analyze route checks for a running lock
// and inserts one; signalEngine releases it in its `finally`; lockCleanup sweeps
// rows orphaned by an api crash (older than the 5-min TTL).
//
// Batch ARCH-3 (rollout slice 14 — the final pair, with analyses). The module
// owns the column names + I/O; the lock lifecycle policy stays in the route /
// engine / cleanup cron. Same SQL, no behavior change.

import { TableModule } from './TableModule.js';

class AnalysisLocksTableModule extends TableModule {
  constructor() {
    super('analysis_locks');
  }

  /** Id of the running lock for (user, symbol), or null — the 409 guard. */
  async getRunningLockId(userId: string, symbol: string): Promise<string | null> {
    const r = await this.run<{ id: unknown } | null>(
      'getRunningLockId',
      this.from()
        .select('id')
        .eq('symbol', symbol)
        .eq('user_id', userId)
        .eq('status', 'running')
        .maybeSingle(),
    );
    return r?.id == null ? null : String(r.id);
  }

  /** Insert a running lock for (user, symbol) → its id. */
  async insertRunningLock(userId: string, symbol: string): Promise<string> {
    const r = await this.run<{ id: unknown } | null>(
      'insertRunningLock',
      this.from().insert({ symbol, user_id: userId, status: 'running' }).select('id').single(),
    );
    if (!r) throw new Error('analysis_locks.insertRunningLock: no row returned');
    return String(r.id);
  }

  /** Release a lock by id — the engine's finally. */
  async deleteById(lockId: string): Promise<void> {
    await this.run('deleteById', this.from().delete().eq('id', lockId));
  }

  /** Sweep locks started before `cutoffIso` — the stale-lock cleanup. */
  async deleteStaleBefore(cutoffIso: string): Promise<void> {
    await this.run('deleteStaleBefore', this.from().delete().lt('started_at', cutoffIso));
  }
}

export const analysisLocksTableModule = new AnalysisLocksTableModule();
