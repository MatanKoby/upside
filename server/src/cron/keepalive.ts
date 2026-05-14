import { ibTickle } from '../services/ibGateway.js';
import { pingSupabase } from '../services/supabase.js';

const TICKLE_INTERVAL_MS = 30_000;
const SUPABASE_PING_INTERVAL_MS = 4 * 60 * 60 * 1000;

let tickleTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;

export function startKeepalive(): void {
  if (!tickleTimer) {
    tickleTimer = setInterval(() => {
      ibTickle().catch((e) => console.error('[keepalive] tickle error:', e));
    }, TICKLE_INTERVAL_MS);
  }
  if (!pingTimer) {
    pingTimer = setInterval(() => {
      pingSupabase().catch((e) => console.error('[keepalive] supabase ping error:', e));
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
