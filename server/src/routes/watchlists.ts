// /api/watchlists routes (Batch A1).
//
//   POST  /api/watchlists/sync          → import user_lists from IB (IB-gated)
//   PATCH /api/watchlists/:listId        → flip { active }
//
// Read access goes through Supabase Realtime + RLS — no GET endpoint here; the
// FE subscribes to `watchlist_lists` + `watchlist_items` directly. Spec:
// spec/flows.md → Watchlist Import Flow.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';
import { syncWatchlistsFromIb, setListActive } from '../services/watchlists.js';
import { notifyError } from '../services/notify.js';

const router = Router();
router.use(requireAuth);

// Sync: IB-gated. Returns 403 { reason: 'ib_required' } when IB isn't
// authenticated+connected, exactly like spec/signals/playbook.md → Freshness
// guard for analyses (consistent FE handling — the same "Connect IB" cue).
router.post('/sync', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const status = await ibGateway.status().catch(() => ({ authenticated: false, connected: false }));
  if (!status.authenticated || !status.connected) {
    res.status(403).json({ reason: 'ib_required' });
    return;
  }

  try {
    const result = await syncWatchlistsFromIb(req.user.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    void notifyError('watchlists.sync', `sync failed: ${(err as Error).message}`, err);
    res.status(502).json({ error: 'sync_failed', detail: (err as Error).message });
  }
});

// Flip active/hidden. Idempotent. RLS scopes by user_id in the service.
router.patch('/:listId', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const { active } = (req.body ?? {}) as { active?: unknown };
  if (typeof active !== 'boolean') {
    res.status(400).json({ error: 'active_boolean_required' });
    return;
  }
  const ok = await setListActive(req.user.id, req.params.listId!, active);
  if (!ok) {
    res.status(500).json({ error: 'update_failed' });
    return;
  }
  res.json({ ok: true, active });
});

export default router;
