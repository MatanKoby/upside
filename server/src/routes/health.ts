// GET /healthz — component-status response.
//
// Per Batch 13.1: return per-subsystem statuses (IB, Supabase, Redis,
// lastPricePoll) so the Discord notifier and ops dashboards can diagnose
// without SSH. Each sub-check is bounded to ~1s; the whole endpoint
// responds within ~3s even if a backend is down.
//
// `ok` becomes false only if Supabase or Redis is unreachable — those are
// hard prerequisites for the app to function. IB being `stopped` is normal
// (on-demand model from Batch 13) and does not mark the api unhealthy.

import { Router, type Request, type Response } from 'express';
import { env } from '../env.js';
import { getIbContainerState } from '../services/ibContainer.js';
import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';
import { pingSupabase } from '../services/supabase.js';
import { pingRedis } from '../services/redis.js';
import { getLastIbPricePollAt } from '../cron/ibPricePoller.js';

const router = Router();

const SUBCHECK_TIMEOUT_MS = 1_000;

type IbState = 'connected' | 'disconnected' | 'stopped' | 'unknown';
type Reachable = 'reachable' | 'unreachable';

async function withTimeout<T>(p: Promise<T>, fallback: T, ms = SUBCHECK_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function checkIb(): Promise<IbState> {
  const containerState = await withTimeout(getIbContainerState(), 'unknown' as const);
  if (containerState !== 'running') return containerState === 'missing' ? 'stopped' : 'stopped';
  const status = await withTimeout(ibGateway.status(), { authenticated: false, connected: false });
  if (status.authenticated && status.connected) return 'connected';
  return 'disconnected';
}

async function checkSupabase(): Promise<Reachable> {
  const ok = await withTimeout(pingSupabase(), false);
  return ok ? 'reachable' : 'unreachable';
}

async function checkRedis(): Promise<Reachable> {
  const ok = await withTimeout(pingRedis(), false);
  return ok ? 'reachable' : 'unreachable';
}

router.get('/', async (_req: Request, res: Response) => {
  // Run sub-checks in parallel; the outer endpoint bound is ~1s + overhead
  // because they all share the same timeout.
  const [ib, supabase, redis] = await Promise.all([
    checkIb(),
    checkSupabase(),
    checkRedis(),
  ]);

  const lastPricePollMs = getLastIbPricePollAt();
  const ok = supabase === 'reachable' && redis === 'reachable';

  res.status(ok ? 200 : 503).json({
    ok,
    env: env.nodeEnv,
    ib,
    supabase,
    redis,
    lastPricePoll: lastPricePollMs ? new Date(lastPricePollMs).toISOString() : null,
  });
});

export default router;
