import { Router, type Request, type Response } from 'express';
import { env } from '../env.js';
import { supabase } from '../services/supabase.js';
import { ibTickle, ibStatus, ibLogout } from '../services/ibGateway.js';
import { requireAuth } from '../middleware/auth.js';
import { marketPeriodAt } from '../utils/marketHours.js';

const router = Router();

// GET /api/auth/status — combined IB session + market period.
// Polled by the FE every 30s via useMarketSession hook. The gateway holds the
// IB session itself (Batch 13 redesign: browser-mediated login via /ib-portal
// proxy, no Redis-stored token); we just ask the gateway whether it's
// authenticated.
router.get('/status', requireAuth, async (_req: Request, res: Response) => {
  const status = await ibStatus().catch(() => ({ authenticated: false, connected: false }));
  let session: 'connected' | 'disconnected' | 'expired';
  if (status.authenticated && status.connected) {
    session = 'connected';
  } else if (status.authenticated) {
    session = 'disconnected';
  } else {
    session = 'expired';
  }
  res.json({
    session,
    marketPeriod: marketPeriodAt(),
  });
});

router.post('/google/callback', async (req: Request, res: Response) => {
  const { accessToken } = req.body ?? {};
  if (!accessToken) {
    res.status(400).json({ error: 'accessToken required' });
    return;
  }
  const { data, error } = await supabase().auth.getUser(accessToken);
  if (error || !data?.user) {
    res.status(401).json({ error: 'invalid token' });
    return;
  }
  const email = (data.user.email ?? '').toLowerCase();
  const granted = !!email && env.allowedEmails.includes(email);

  const { error: insertErr } = await supabase().from('access_attempts').insert({
    email,
    granted,
    ip_address: req.ip ?? null,
    user_agent: req.header('user-agent') ?? null,
  });
  if (insertErr) {
    // Don't block the auth decision on logging failure — but make sure it's
    // visible. Silent failures here cost us a debugging round-trip in batch 12.
    console.error('[auth/google/callback] access_attempts insert failed:', insertErr.message);
  }

  if (!granted) {
    res.status(403).json({ error: 'not_whitelisted', redirect: 'https://google.com' });
    return;
  }
  res.json({ ok: true, user: { id: data.user.id, email } });
});

// IB session lives in the gateway itself, populated by the user logging in
// through /ib-portal/* (browser-mediated). We expose status and tickle/logout
// passthroughs; there is no /ib/login route — that route's implementation
// (programmatic credential POST) returned 401 from IB and was removed.

router.post('/ib/tickle', requireAuth, async (_req: Request, res: Response) => {
  const ok = await ibTickle();
  res.json({ ok });
});

router.get('/ib/status', requireAuth, async (_req: Request, res: Response) => {
  const status = await ibStatus();
  res.json({
    session: status.authenticated && status.connected ? 'connected' : 'disconnected',
    authenticated: status.authenticated,
    connected: status.connected,
  });
});

router.post('/ib/logout', requireAuth, async (_req: Request, res: Response) => {
  await ibLogout();
  res.json({ ok: true });
});

export default router;
