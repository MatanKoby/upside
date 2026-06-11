// 30-day retention sweep for external_api_metrics.
//
// The instrumentation tables fill up fast — pricePoller alone makes 3N+1
// IB calls per cycle (positions + per-position snapshot/history/contract),
// every 10s during market hours. Without retention, free-tier 500MB DB
// space gets eaten in a few months.
//
// Runs once a day (next-run scheduled relative to last run, not wall-clock
// time, so a long-running container still gets one sweep per day even if
// we miss UTC midnight). Deletes rows older than RETENTION_DAYS days.

import { externalApiMetricsTableModule } from '../adapters/supabase/externalApiMetricsTableModule.js';
import { notifyError } from '../services/notify.js';

const RETENTION_DAYS = 30;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 60_000; // run shortly after startup so we don't hammer on every restart

let timer: NodeJS.Timeout | null = null;

async function sweep(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const count = await externalApiMetricsTableModule.purgeOlderThan(cutoff);
    console.log(`[metricsRetention] deleted ${count} rows older than ${RETENTION_DAYS}d (cutoff ${cutoff})`);
  } catch (e: unknown) {
    void notifyError('metricsRetention.delete', e instanceof Error ? e.message : String(e));
  }
}

export function startMetricsRetention(): void {
  if (timer) return;
  // First sweep shortly after boot, then once every 24h.
  timer = setTimeout(function tick() {
    void sweep().finally(() => {
      timer = setTimeout(tick, SWEEP_INTERVAL_MS);
    });
  }, INITIAL_DELAY_MS);
  console.log(`[metricsRetention] starting — ${RETENTION_DAYS}d retention, first sweep in 60s, then every 24h`);
}

export function stopMetricsRetention(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
