import { Router, type Request, type Response } from 'express';
import { analysesTableModule } from '../db/analysesTableModule.js';
import { analysisLocksTableModule } from '../db/analysisLocksTableModule.js';
import { requireAuth } from '../middleware/auth.js';
import { runAnalysis } from '../services/signalEngine.js';
import { getLlmCallsToday } from '../services/redis.js';
import { env } from '../env.js';

const router = Router();
router.use(requireAuth);

const RECENT_ANALYSIS_MS = 5 * 60 * 1000;

router.post('/analyze', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const { symbol, force } = req.body ?? {};
  if (!symbol || typeof symbol !== 'string') {
    res.status(400).json({ error: 'symbol required' });
    return;
  }
  const sym = symbol.toUpperCase();
  const userId = req.user.id;

  // Re-analyze soft-block: a completed analysis within the last 5 min returns
  // 429 unless the client opts in with { force: true }.
  if (!force) {
    const since = new Date(Date.now() - RECENT_ANALYSIS_MS).toISOString();
    const lastAnalyzedAt = await analysesTableModule.getRecentAnalyzedAt(userId, sym, since).catch(() => null);
    if (lastAnalyzedAt != null) {
      res.status(429).json({ reason: 'recent_analysis', lastAnalyzedAt });
      return;
    }
  }

  // Daily cost ceiling — each unified analysis counts as one call.
  const used = await getLlmCallsToday();
  if (used >= env.maxLlmCallsPerDay) {
    res.status(429).json({ reason: 'daily_limit_reached' });
    return;
  }

  // Concurrency: one running lock per (user, symbol).
  const runningLockId = await analysisLocksTableModule.getRunningLockId(userId, sym).catch(() => null);
  if (runningLockId != null) {
    res.status(409).json({ error: 'analysis_in_progress', lockId: runningLockId });
    return;
  }

  let lockId: string;
  try {
    lockId = await analysisLocksTableModule.insertRunningLock(userId, sym);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
    return;
  }

  // Fire-and-forget: the engine releases the lock in its own `finally` and the
  // FE detects completion via the `signals` / `analysis_locks` Realtime feeds.
  void runAnalysis({ userId, symbol: sym, lockId });

  res.status(202).json({ status: 'analyzing', lockId, symbol: sym });
});

export default router;
