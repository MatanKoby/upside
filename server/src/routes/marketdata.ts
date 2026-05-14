import { Router, type Request, type Response } from 'express';
import { ibSnapshot, ibHistory } from '../services/ibGateway.js';
import { ibHistoryToBundle } from '../services/ibMappers.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// FE timeframe label → IB (period, bar) tuple. Mirrors the timeframes in
// client/src/components/TickerDetail/TimeframeBar.tsx.
const TIMEFRAME_MAP: Record<string, { period: string; bar: string }> = {
  '30m':  { period: '1h',  bar: '1min'  },
  '2h':   { period: '2h',  bar: '5mins' },
  '1D':   { period: '1d',  bar: '5mins' },
  '2D':   { period: '2d',  bar: '15mins'},
  '1W':   { period: '1w',  bar: '1h'    },
  '1M':   { period: '1m',  bar: '1d'    },
  '3M':   { period: '3m',  bar: '1d'    },
  '1Y':   { period: '1y',  bar: '1d'    },
  '5Y':   { period: '5y',  bar: '1w'    },
  'All':  { period: 'max', bar: '1m'    },
};

// Sparkline default: 7 daily bars.
const SPARKLINE_PERIOD = '7d';
const SPARKLINE_BAR = '1d';

async function resolveConid(userId: string, symbol: string): Promise<number | null> {
  // MVP: only held symbols are charteable. Lookup conid from positions table.
  const { data, error } = await supabase()
    .from('positions')
    .select('conid')
    .eq('user_id', userId)
    .eq('symbol', symbol)
    .maybeSingle();
  if (error || !data?.conid) return null;
  return Number(data.conid);
}

router.get('/history/:symbol', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const symbol = req.params.symbol?.toUpperCase();
  const timeframe = (req.query.timeframe as string | undefined) ?? '1D';
  if (!symbol) {
    res.status(400).json({ error: 'symbol required' });
    return;
  }
  const conid = await resolveConid(req.user.id, symbol);
  if (!conid) {
    res.status(404).json({ error: 'symbol_not_held', symbol });
    return;
  }
  const mapping = TIMEFRAME_MAP[timeframe];
  if (!mapping) {
    res.status(400).json({ error: 'unknown_timeframe', timeframe, supported: Object.keys(TIMEFRAME_MAP) });
    return;
  }
  const raw = await ibHistory(conid, mapping.period, mapping.bar);
  if (!raw) {
    res.status(502).json({ error: 'ib_history_failed', symbol, timeframe });
    return;
  }
  const bundle = ibHistoryToBundle(raw);
  res.json(bundle);
});

// GET /api/marketdata/sparkline/:symbol — 7 daily closes for a held symbol.
// Returns simple { closes: number[] } for the Sparkline component.
router.get('/sparkline/:symbol', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const symbol = req.params.symbol?.toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol required' });
    return;
  }
  const conid = await resolveConid(req.user.id, symbol);
  if (!conid) {
    res.status(404).json({ error: 'symbol_not_held', symbol });
    return;
  }
  const raw = await ibHistory(conid, SPARKLINE_PERIOD, SPARKLINE_BAR);
  if (!raw || !Array.isArray(raw.data)) {
    res.status(502).json({ error: 'ib_history_failed', symbol });
    return;
  }
  res.json({ closes: raw.data.map((b) => b.c) });
});

// Snapshot route — currently unused by the FE (snapshots flow through Supabase
// positions writes). Kept as an authenticated escape hatch for ad-hoc debug.
router.get('/snapshot/:symbol', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const symbol = req.params.symbol?.toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol required' });
    return;
  }
  const conid = await resolveConid(req.user.id, symbol);
  if (!conid) {
    res.status(404).json({ error: 'symbol_not_held', symbol });
    return;
  }
  const snap = await ibSnapshot([conid]);
  res.json({ symbol, conid, snap });
});

export default router;
