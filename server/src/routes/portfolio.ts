import { Router, type Request, type Response } from 'express';
import { supabase } from '../services/supabase.js';
import { quotesTableModule } from '../db/quotesTableModule.js';
import { requireAuth } from '../middleware/auth.js';
import { getMtdAnchor } from '../services/mtdCache.js';

const router = Router();
router.use(requireAuth);

router.get('/positions', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  // Price/P&L live in `quotes` now (Batch X5) — positions no longer carries
  // market_value to order by; the FE recomputes + sorts. Order by symbol here.
  const { data, error } = await supabase()
    .from('positions')
    .select('*')
    .eq('user_id', req.user.id)
    .order('symbol', { ascending: true });
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
  // Price SSOT (Batch X5): market value + P&L are recomputed from
  // `quotes.canonical_price` × shares (positions holds only holding facts).
  const { data, error } = await supabase()
    .from('positions')
    .select('conid, shares, avg_cost')
    .eq('user_id', req.user.id);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  const held = (data ?? []) as Array<{ conid: number | null; shares: number | string | null; avg_cost: number | string | null }>;
  const conids = held.map((p) => Number(p.conid)).filter((c) => Number.isFinite(c));
  const priceByConid = conids.length > 0
    ? await quotesTableModule.getCanonicalPrices(conids).catch(() => new Map<number, number>())
    : new Map<number, number>();
  let totalValue = 0;
  let totalPnl = 0;
  for (const p of held) {
    const price = priceByConid.get(Number(p.conid));
    if (price == null) continue;
    const shares = Number(p.shares ?? 0);
    const avgCost = Number(p.avg_cost ?? 0);
    totalValue += price * shares;
    totalPnl += (price - avgCost) * shares;
  }
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
