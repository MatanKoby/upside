// Debug routes — strictly auth-gated, no FE consumer.
//
// /api/debug/ib-passthrough: proxy a single read-only IB Client Portal call,
// returning the raw response. Used to capture real IB data shapes from the
// laptop without spinning up the local gateway. See Batch 13.2 in BUILD_QUEUE.md
// and docs/debug.md.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getIbContainerState } from '../services/ibContainer.js';
import { ibStatus, ibRawGet } from '../services/ibGateway.js';
import { allowedPathsForError, isAllowedIbPath } from '../services/ibPassthroughAllowlist.js';

const router = Router();

router.get('/ib-passthrough', requireAuth, async (req: Request, res: Response) => {
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  if (!path) {
    res.status(400).json({ error: 'missing_path', hint: 'pass ?path=/v1/api/...' });
    return;
  }
  if (!isAllowedIbPath(path)) {
    res.status(400).json({
      error: 'path_not_allowed',
      reason: 'path_not_allowed',
      allowed: allowedPathsForError(),
    });
    return;
  }

  // Confirm IBeam container is running before issuing the call. ibStatus
  // would fail with a noisy network error otherwise.
  const containerState = await getIbContainerState().catch(() => 'missing' as const);
  if (containerState !== 'running') {
    res.status(503).json({ error: 'ib_not_connected', reason: 'ib_not_connected', containerState });
    return;
  }
  const status = await ibStatus().catch(() => ({ authenticated: false, connected: false }));
  if (!status.authenticated || !status.connected) {
    res.status(503).json({
      error: 'ib_not_connected',
      reason: 'ib_not_connected',
      authenticated: status.authenticated,
      connected: status.connected,
    });
    return;
  }

  // Collect any remaining query params and forward them to IB. Strip our
  // `path` param so it doesn't get echoed into the IB call.
  const forwardedQuery: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (k === 'path') continue;
    if (typeof v === 'string') forwardedQuery[k] = v;
    else if (Array.isArray(v) && typeof v[0] === 'string') forwardedQuery[k] = v[0];
  }

  try {
    const out = await ibRawGet(path, forwardedQuery);
    res.status(out.status).type(out.contentType).send(out.data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(502).json({ error: 'passthrough_failed', message: msg });
  }
});

export default router;
