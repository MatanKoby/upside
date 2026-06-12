import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';
import { pingSupabase } from '../services/supabase.js';
import { notifyCritical } from '../services/notify.js';

const TICKLE_INTERVAL_MS = 30_000;
const SUPABASE_PING_INTERVAL_MS = 4 * 60 * 60 * 1000;

let tickleTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;

export function startKeepalive(): void {
  if (!tickleTimer) {
    tickleTimer = setInterval(() => {
      // Tickle failures are expected when the IBeam container is stopped
      // (on-demand model) — don't notify. Only log silently.
      ibGateway.tickle().catch(() => undefined);
    }, TICKLE_INTERVAL_MS);
  }
  if (!pingTimer) {
    pingTimer = setInterval(() => {
      pingSupabase().catch((e) =>
        void notifyCritical('keepalive.supabasePing', 'Supabase ping failed', e),
      );
    }, SUPABASE_PING_INTERVAL_MS);
  }
  console.log('[keepalive] started — IB tickle 30s, Supabase ping 4h');
}

export function stopKeepalive(): void {
  if (tickleTimer) {
    clearInterval(tickleTimer);
    tickleTimer = null;
  }
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}
