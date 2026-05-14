import { supabase } from '../services/supabase.js';

const STALE_LOCK_SECONDS = 60;
const CLEANUP_INTERVAL_MS = 30_000;

let timer: NodeJS.Timeout | null = null;

async function cleanupStaleLocks(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_LOCK_SECONDS * 1000).toISOString();
  const { error } = await supabase()
    .from('analysis_locks')
    .delete()
    .lt('started_at', cutoff);
  if (error) console.error('[signalRunner] cleanup error:', error.message);
}

export function startSignalRunner(): void {
  if (timer) return;
  timer = setInterval(() => {
    void cleanupStaleLocks();
  }, CLEANUP_INTERVAL_MS);
  console.log('[signalRunner] stale-lock cleanup started (interval 30s, threshold 60s)');
}

export function stopSignalRunner(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
