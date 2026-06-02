// jobsRetention — Batch S0.3.
//
// Background sweep: deletes `done` OR `failed` rows older than RETAIN_DAYS
// as a safety net. Producers should normally drain these on their own
// cycle; this catches anything that slips through (e.g. a producer
// disabled mid-cycle, an action no longer being scheduled). Daily cadence
// is plenty.

import { supabase } from '../services/supabase.js';
import { notifyError } from '../services/notify.js';

const CADENCE_MS = 24 * 60 * 60_000;
const RETAIN_DAYS = 7;

async function tick(): Promise<void> {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400_000).toISOString();
  const { data, error } = await supabase()
    .from('screener_jobs')
    .delete()
    .in('status', ['done', 'failed'])
    .lt('completed_at', cutoff)
    .select('id');
  if (error) {
    void notifyError('jobsRetention.tick', error.message);
    return;
  }
  if (data && data.length > 0) {
    console.log(`[jobsRetention] deleted ${data.length} rows older than ${RETAIN_DAYS}d`);
  }
}

export function startJobsRetention(): void {
  console.log('[jobsRetention] starting, 24h cadence');
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      void notifyError('jobsRetention.loop', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  // Run the first sweep ~5 min after boot to avoid racing other startup.
  setTimeout(loop, 5 * 60_000).unref();
}
