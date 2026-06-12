// Stale analysis-lock cleanup (Batch 14a, renamed from signalRunner).
//
// An `analysis_locks` row is created when an analysis starts and deleted when
// it finishes (success or failure). If the api crashes mid-analysis the row is
// orphaned and would disable the Analyze button forever — so this sweeper
// deletes rows older than the 5-minute TTL (comfortably exceeds worst-case LLM
// response time; see signal-model.md → Concurrency lock).
//
// Batch ARCH-9: the hand-rolled setInterval is now a defineCron — no gates, and
// firstRunDelayMs = interval to preserve the setInterval semantics (first sweep
// at +60s, not at boot).

import { analysisLocksTableModule } from '../adapters/supabase/analysisLocksTableModule.js';
import { notifyError } from '../services/notify.js';
import { defineCron } from '../kernel/scheduler.js';

const STALE_LOCK_SECONDS = 5 * 60;
const CLEANUP_INTERVAL_MS = 60_000;

async function cleanupStaleLocks(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_LOCK_SECONDS * 1000).toISOString();
  try {
    await analysisLocksTableModule.deleteStaleBefore(cutoff);
  } catch (e) {
    void notifyError('lockCleanup.cleanup', (e as Error).message);
  }
}

const cron = defineCron({
  name: 'lockCleanup',
  intervalMs: CLEANUP_INTERVAL_MS,
  firstRunDelayMs: CLEANUP_INTERVAL_MS,
  run: cleanupStaleLocks,
});

export function startLockCleanup(): void {
  cron.start();
  console.log('[lockCleanup] stale-lock cleanup started (interval 60s, TTL 5min)');
}
