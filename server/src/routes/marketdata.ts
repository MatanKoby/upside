import { Router, type Request, type Response } from 'express';
import { ibSnapshot, ibHistory } from '../services/ibGateway.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/snapshot/:symbol', async (req: Request, res: Response) => {
  const symbol = req.params.symbol?.toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol required' });
    return;
  }
  // TODO Batch 9: resolve symbol -> conid via IB contracts lookup, cache in Redis
  res.status(501).json({ error: 'snapshot resolution pending Batch 9', symbol, raw: await ibSnapshot([]) });
});

router.get('/history/:symbol', async (req: Request, res: Response) => {
  const symbol = req.params.symbol?.toUpperCase();
  const period = (req.query.period as string) ?? '7d';
  const bar = (req.query.bar as string) ?? '1d';
  if (!symbol) {
    res.status(400).json({ error: 'symbol required' });
    return;
  }
  // TODO Batch 9: symbol -> conid resolution
  res.status(501).json({ error: 'history resolution pending Batch 9', symbol, period, bar, raw: await ibHistory(0, period, bar) });
});

export default router;
