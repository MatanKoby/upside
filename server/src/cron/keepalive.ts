// IB tickle + Supabase keepalive (Batch ARCH-9: two defineCron handles).
//
// One file, two independent timers, so it becomes two crons. Each keeps its own
// error policy inside `run` — the base's `${name}.tick` backstop only fires on
// an uncaught throw, and neither body lets one through:
//   - tickle failures are expected when the IBeam container is stopped (on-demand
//     model), so they are swallowed silently — no Discord ping.
//   - the Supabase ping keeps its notifyCritical severity (the base backstop
//     would otherwise downgrade it to notifyError), so it catches internally.
// firstRunDelayMs = interval preserves the old setInterval timing (first tick at
// +interval, not at boot).

import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';
import { pingSupabase } from '../services/supabase.js';
import { notifyCritical } from '../services/notify.js';
import { defineCron } from '../kernel/scheduler.js';
import { detectIbReconnect } from './ibReconnect.js';

const TICKLE_INTERVAL_MS = 30_000;
const SUPABASE_PING_INTERVAL_MS = 4 * 60 * 60 * 1000;

const tickleCron = defineCron({
  name: 'keepalive.tickle',
  intervalMs: TICKLE_INTERVAL_MS,
  firstRunDelayMs: TICKLE_INTERVAL_MS,
  run: async () => {
    await ibGateway.tickle().catch(() => undefined);
    // Reuse the 30s IB heartbeat to detect a reconnect edge and fire the
    // staleness catch-up (Batch ARCH-10). Swallows its own errors.
    await detectIbReconnect().catch(() => undefined);
  },
});

const supabasePingCron = defineCron({
  name: 'keepalive.supabasePing',
  intervalMs: SUPABASE_PING_INTERVAL_MS,
  firstRunDelayMs: SUPABASE_PING_INTERVAL_MS,
  run: async () => {
    try {
      await pingSupabase();
    } catch (e) {
      void notifyCritical('keepalive.supabasePing', 'Supabase ping failed', e);
    }
  },
});

export function startKeepalive(): void {
  tickleCron.start();
  supabasePingCron.start();
  console.log('[keepalive] started — IB tickle 30s, Supabase ping 4h');
}
