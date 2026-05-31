/**
 * One-shot kick for the Screener universe cron (Batch S1).
 *
 * Bypasses the 5-min boot delay + 24h cadence by directly running a single
 * nightly pass. Useful for: manual sweep after a migration applies, dry-run
 * after env changes, or just "I want fresh universe rows right now."
 *
 * Run:
 *   npm run cron:universe                              # via the npm script
 *   pnpm exec tsx scripts/runUniverseCron.ts           # direct
 *
 * Reads FINNHUB_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_KEY from .env at
 * repo root the same way the api does. Exits 0 on completion, 1 on failure
 * to start (env / network). Per-symbol failures inside the sweep are logged
 * + notified but don't fail the run (matches the cron's own error policy).
 */

import { __test as universeCron } from '../src/cron/universeCron.js';

async function main(): Promise<void> {
  const t0 = Date.now();
  await universeCron.nightlyPass();
  const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
  console.log(`\n[runUniverseCron] complete in ${elapsedMin}m`);
}

main().catch((e) => {
  console.error('[runUniverseCron] failed to start:', e);
  process.exit(1);
});
