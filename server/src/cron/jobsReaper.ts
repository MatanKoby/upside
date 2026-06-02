// jobsReaper — Batch S0.3.
//
// Flips `status='claimed' AND lease_expires_at < now()` rows to
// `status='failed' last_error='lease expired'` so the producer's normal
// drainFailed path picks them up. Covers: worker crashed mid-job, worker
// hung on a slow upstream past the lease, container restart mid-claim.

import { supabase } from '../services/supabase.js';
import { notifyError } from '../services/notify.js';

const CADENCE_MS = 60_000;

async function tick(): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase()
    .from('screener_jobs')
    .update({
      status: 'failed',
      last_error: 'lease expired',
      completed_at: nowIso,
      updated_at: nowIso,
    })
    .eq('status', 'claimed')
    .lt('lease_expires_at', nowIso)
    .select('id');
  if (error) {
    void notifyError('jobsReaper.tick', error.message);
    return;
  }
  if (data && data.length > 0) {
    console.log(`[jobsReaper] reaped ${data.length} lease-expired claim(s)`);
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
