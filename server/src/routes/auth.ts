import { Router, type Request, type Response } from 'express';
import { env } from '../env.js';
import { supabase } from '../services/supabase.js';
import { accessAttemptsTableModule } from '../db/accessAttemptsTableModule.js';
import { ibTickle, ibStatus, ibLogout } from '../services/ibGateway.js';
import { getIbContainerState, startIbContainer, stopIbContainer, restartIbContainer } from '../services/ibContainer.js';
import { notifyError } from '../services/notify.js';
import { requireAuth } from '../middleware/auth.js';
import { marketPeriodAt } from '../utils/marketHours.js';

const router = Router();

// GET /api/auth/status — combined IB session + market period.
// Polled by the FE via useMarketSession.
//
// Session states:
//   stopped      — ib-gateway container isn't running. User taps Connect to start.
//   connecting   — container is running but the gateway hasn't reported
//                  authenticated=true yet (login flow in progress / waiting 2FA).
//   connected    — gateway authenticated AND connected to IBKR's servers.
//   disconnected — gateway authenticated but currently not connected (transient).
//   expired      — container running but no session (rare; usually kicked by IBKR).
router.get('/status', requireAuth, async (_req: Request, res: Response) => {
  const containerState = await getIbContainerState().catch(() => 'missing' as const);
  if (containerState !== 'running') {
    res.json({ session: 'stopped', marketPeriod: marketPeriodAt() });
    return;
  }
  const status = await ibStatus().catch(() => ({ authenticated: false, connected: false }));
  let session: 'connecting' | 'connected' | 'disconnected' | 'expired';
  if (status.authenticated && status.connected) {
    session = 'connected';
  } else if (status.authenticated) {
    session = 'disconnected';
  } else {
    // Container is running but the gateway isn't authenticated yet — most
    // likely we're mid-login (IBeam selenium → 2FA push → user approval).
    // After ~2 minutes of being in this state with no auth, IBKR likely
    // expired the session — but for the FE's polling cadence (~3s during
    // connect, 30s steady state) "connecting" is the useful answer.
    session = 'connecting';
  }
  res.json({ session, marketPeriod: marketPeriodAt() });
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

  try {
    await accessAttemptsTableModule.record({
      email,
      granted,
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
  } catch (e: unknown) {
    // Don't block the auth decision on logging failure — but make sure it's
    // visible. Silent failures here cost us a debugging round-trip in batch 12.
    void notifyError('auth.access_attempts.insert', e instanceof Error ? e.message : String(e));
  }

  if (!granted) {
    res.status(403).json({ error: 'not_whitelisted', redirect: 'https://google.com' });
    return;
  }
  res.json({ ok: true, user: { id: data.user.id, email } });
});

// On-demand IBeam control routes. The container is profile-gated in
// docker-compose.yml so `docker compose up` doesn't auto-start it. Users
// toggle it from the FE; api uses the mounted Docker socket to start/stop.
// See UPSIDE_MVP_SPEC.md → "IB Authentication Flow".

router.post('/ib/connect', requireAuth, async (_req: Request, res: Response) => {
  try {
    await startIbContainer();
    res.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    void notifyError('auth.ib.connect', msg, e);
    res.status(502).json({ error: msg });
  }
});

router.post('/ib/disconnect', requireAuth, async (_req: Request, res: Response) => {
  try {
    await stopIbContainer();
    res.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    void notifyError('auth.ib.disconnect', msg, e);
    res.status(502).json({ error: msg });
  }
});

// Stop + start the IBeam container in one call. Used by the FE when the user
// missed a 2FA push — restarting kicks off a fresh login (and fresh 2FA push)
// without requiring a two-step disconnect-then-connect dance.
router.post('/ib/restart', requireAuth, async (_req: Request, res: Response) => {
  try {
    await restartIbContainer();
    res.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    void notifyError('auth.ib.restart', msg, e);
    res.status(502).json({ error: msg });
  }
});

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
