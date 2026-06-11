// jobsReaper — Batch S0.3.
//
// Flips `status='claimed' AND lease_expires_at < now()` rows to
// `status='failed' last_error='lease expired'` so the producer's normal
// drainFailed path picks them up. Covers: worker crashed mid-job, worker
// hung on a slow upstream past the lease, container restart mid-claim.

import { reapExpiredClaims } from '../services/jobs/queue.js';
import { notifyError } from '../services/notify.js';

const CADENCE_MS = 60_000;

async function tick(): Promise<void> {
  try {
    const reaped = await reapExpiredClaims();
    if (reaped > 0) {
      console.log(`[jobsReaper] reaped ${reaped} lease-expired claim(s)`);
    }
  } catch (e: unknown) {
    void notifyError('jobsReaper.tick', e instanceof Error ? e.message : String(e));
  }
}

export function startJobsReaper(): void {
  console.log('[jobsReaper] starting, 60s cadence');
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      void notifyError('jobsReaper.loop', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, CADENCE_MS).unref();
}
