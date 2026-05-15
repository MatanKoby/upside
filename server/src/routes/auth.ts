import { Router, type Request, type Response } from 'express';
import { env } from '../env.js';
import { supabase } from '../services/supabase.js';
import { ibLogin, ibTickle, ibStatus, ibLogout } from '../services/ibGateway.js';
import { setWithTtl, get, del, ibSessionKey } from '../services/redis.js';
import { requireAuth } from '../middleware/auth.js';
import { marketPeriodAt } from '../utils/marketHours.js';

const router = Router();

// GET /api/auth/status — combined session + market period.
// Polled by the FE every 30s via useMarketSession hook.
router.get('/status', requireAuth, async (req: Request, res: Response) => {
  const sessionToken = req.user ? await get(ibSessionKey(req.user.id)) : null;
  let session: 'connected' | 'disconnected' | 'expired' = 'expired';
  if (sessionToken) {
    const status = await ibStatus().catch(() => ({ authenticated: false, connected: false }));
    session = status.authenticated && status.connected ? 'connected' : 'disconnected';
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

router.post('/ib/login', requireAuth, async (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    res.status(400).json({ error: 'username and password required' });
    return;
  }
  const result = await ibLogin(username, password);
  if (!result.ok) {
    res.status(502).json({ error: result.error ?? 'ib login failed' });
    return;
  }
  if (result.session && req.user) {
    await setWithTtl(ibSessionKey(req.user.id), result.session, 24 * 60 * 60);
  }
  res.json({ ok: true });
});

router.post('/ib/tickle', requireAuth, async (_req: Request, res: Response) => {
  const ok = await ibTickle();
  res.json({ ok });
});

router.get('/ib/status', requireAuth, async (req: Request, res: Response) => {
  const session = req.user ? await get(ibSessionKey(req.user.id)) : null;
  if (!session) {
    res.json({ session: 'expired' });
    return;
  }
  const status = await ibStatus();
  res.json({
    session: status.authenticated && status.connected ? 'connected' : 'disconnected',
    authenticated: status.authenticated,
    connected: status.connected,
  });
});

router.post('/ib/logout', requireAuth, async (req: Request, res: Response) => {
  await ibLogout();
  if (req.user) await del(ibSessionKey(req.user.id));
  res.json({ ok: true });
});

export default router;
