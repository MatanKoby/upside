// Debug routes — strictly auth-gated, no FE consumer.
//
// /api/debug/ib-passthrough: proxy a single read-only IB Client Portal call,
// returning the raw response. Used to capture real IB data shapes from the
// laptop without spinning up the local gateway. See Batch 13.2 in BUILD_QUEUE.md
// and docs/debug.md.
//
//   GET  — read-only GET paths (isAllowedIbPath).      Extra ?query forwarded.
//   POST — read-only PA query paths (isAllowedIbPostPath). JSON body forwarded.
// Both share the same auth gate, IB-connected check, and response/error
// handling via passthroughHandler — the only differences are the allowlist and
// how the IB call is issued.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getIbContainerState } from '../services/ibContainer.js';
import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';
import type { IbRawResponse } from '../adapters/ib/port.js';
import {
  allowedPathsForError,
  isAllowedIbPath,
  allowedPostPathsForError,
  isAllowedIbPostPath,
  isForbiddenIbPath,
} from '../services/ibPassthroughAllowlist.js';

const router = Router();

// Confirm the IBeam container is running AND the session is authenticated
// before issuing a call (ibGateway.status would otherwise fail with a noisy network
// error). Writes the 503 itself and returns false when not ready.
async function ensureIbConnected(res: Response): Promise<boolean> {
  const containerState = await getIbContainerState().catch(() => 'missing' as const);
  if (containerState !== 'running') {
    res.status(503).json({ error: 'ib_not_connected', reason: 'ib_not_connected', containerState });
    return false;
  }
  const status = await ibGateway.status().catch(() => ({ authenticated: false, connected: false }));
  if (!status.authenticated || !status.connected) {
    res.status(503).json({
      error: 'ib_not_connected',
      reason: 'ib_not_connected',
      authenticated: status.authenticated,
      connected: status.connected,
    });
    return false;
  }
  return true;
}

// Builds a passthrough handler given a method-specific allowlist + IB call.
// Shared: path validation, allowlist rejection, IB-connected gate, raw response
// relay (status + content-type preserved), and 502-on-throw.
function passthroughHandler(opts: {
  isAllowed: (path: string) => boolean;
  allowedForError: () => readonly string[];
  call: (path: string, req: Request) => Promise<IbRawResponse>;
}) {
  return async (req: Request, res: Response): Promise<void> => {
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    if (!path) {
      res.status(400).json({ error: 'missing_path', hint: 'pass ?path=/v1/api/...' });
      return;
    }
    // Hard deny-gate first: trade-execution paths are rejected outright,
    // independent of (and ahead of) the positive allowlists — for GET and POST.
    if (isForbiddenIbPath(path)) {
      res.status(403).json({ error: 'forbidden_trade_path', reason: 'forbidden_trade_path' });
      return;
    }
    if (!opts.isAllowed(path)) {
      res.status(400).json({ error: 'path_not_allowed', reason: 'path_not_allowed', allowed: opts.allowedForError() });
      return;
    }
    if (!(await ensureIbConnected(res))) return;
    try {
      const out = await opts.call(path, req);
      res.status(out.status).type(out.contentType).send(out.data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(502).json({ error: 'passthrough_failed', message: msg });
    }
  };
}

router.get(
  '/ib-passthrough',
  requireAuth,
  passthroughHandler({
    isAllowed: isAllowedIbPath,
    allowedForError: allowedPathsForError,
    call: (path, req) => {
      // Forward any query params other than our own `path` to IB.
      const forwardedQuery: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (k === 'path') continue;
        if (typeof v === 'string') forwardedQuery[k] = v;
        else if (Array.isArray(v) && typeof v[0] === 'string') forwardedQuery[k] = v[0];
      }
      return ibGateway.rawGet(path, forwardedQuery);
    },
  }),
);

router.post(
  '/ib-passthrough',
  requireAuth,
  passthroughHandler({
    isAllowed: isAllowedIbPostPath,
    allowedForError: allowedPostPathsForError,
    call: (path, req) => ibGateway.rawPost(path, req.body ?? {}),
  }),
);

export default router;
