import { Router, type Request, type Response } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.post('/analyze', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const { symbol } = req.body ?? {};
  if (!symbol || typeof symbol !== 'string') {
    res.status(400).json({ error: 'symbol required' });
    return;
  }
  const sym = symbol.toUpperCase();

  const existing = await supabase()
    .from('analysis_locks')
    .select('id, started_at, status')
    .eq('symbol', sym)
    .eq('user_id', req.user.id)
    .eq('status', 'running')
    .maybeSingle();

  if (existing.data) {
    res.status(409).json({ error: 'analysis_in_progress', lockId: existing.data.id });
    return;
  }

  const lockInsert = await supabase()
    .from('analysis_locks')
    .insert({ symbol: sym, user_id: req.user.id, status: 'running' })
    .select('id')
    .single();

  if (lockInsert.error || !lockInsert.data) {
    res.status(500).json({ error: lockInsert.error?.message ?? 'could not create lock' });
    return;
  }

  const lockId = lockInsert.data.id;

  try {
    // TODO Batch 6+: fetch indicators, news, earnings; run LLM; insert signal row.
    res.status(501).json({ error: 'analyze pipeline pending', lockId, symbol: sym });
  } finally {
    await supabase().from('analysis_locks').delete().eq('id', lockId);
  }
});

export default router;
