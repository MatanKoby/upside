import { Router, type Request, type Response } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { getMtdAnchor } from '../services/mtdCache.js';

const router = Router();
router.use(requireAuth);

router.get('/positions', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const { data, error } = await supabase()
    .from('positions')
    .select('*')
    .eq('user_id', req.user.id)
    .order('market_value', { ascending: false });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ positions: data ?? [] });
});

router.get('/summary', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const { data, error } = await supabase()
    .from('positions')
    .select('market_value, unrealized_pnl')
    .eq('user_id', req.user.id);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  const totalValue = (data ?? []).reduce((acc, p) => acc + Number(p.market_value ?? 0), 0);
  const totalPnl = (data ?? []).reduce((acc, p) => acc + Number(p.unrealized_pnl ?? 0), 0);
  // MTD from the Redis-anchored month-start value (Batch 13.5). Null when the
  // api was offline at the first poll of the current month — FE renders "—".
  const mtdAnchor = await getMtdAnchor(req.user.id);
  const mtdReturn = mtdAnchor != null ? totalValue - mtdAnchor : null;
  const mtdReturnPercent = mtdAnchor != null && mtdAnchor > 0
    ? ((totalValue - mtdAnchor) / mtdAnchor) * 100
    : null;
  res.json({
    totalValue,
    totalPnl,
    mtdAnchor,
    mtdReturn,
    mtdReturnPercent,
    updatedAt: new Date().toISOString(),
  });
});

export default router;
