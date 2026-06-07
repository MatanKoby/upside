// /api/user/preferences — the user-preferences write path (Batch R2).
//
// Batch R2 introduces the first FE→BE write into `user_preferences`: the
// tunable risk-flag thresholds (Settings → Risk flags). Centralized validation
// lives here per spec/screens/settings.md; the engine reads the same column via
// resolveRiskFlagConfig (server/src/config/riskFlags.ts). supabase() is the
// service-role client (bypasses RLS), so we stamp user_id from the JWT.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabase } from '../services/supabase.js';
import {
  resolveRiskFlagConfig,
  RISK_FLAG_DEFAULTS,
  type RiskFlagConfig,
} from '../config/riskFlags.js';

const router = Router();
router.use(requireAuth);

// Sane bounds per field — keeps a fat-fingered value from silently disabling a
// flag (e.g. surge 0.01% would fire on everything; 9999% on nothing).
const BOUNDS: Record<keyof RiskFlagConfig, { min: number; max: number; int?: boolean }> = {
  surgePct: { min: 1, max: 500 },
  surgeWindowSessions: { min: 1, max: 60, int: true },
  volMult: { min: 1, max: 50 },
  rsiZ: { min: 50, max: 100 },
  near52wHighPct: { min: 0, max: 50 },
  microCapUsd: { min: 1_000_000, max: 100_000_000_000 },
  earningsDays: { min: 0, max: 60, int: true },
  newsBearishScore: { min: -1, max: 0 }, // Batch X7 — bad_news fires at/below this sentiment
};

const KEYS = Object.keys(BOUNDS) as (keyof RiskFlagConfig)[];

async function readStored(userId: string): Promise<unknown> {
  const { data } = await supabase()
    .from('user_preferences')
    .select('risk_flag_config')
    .eq('user_id', userId)
    .maybeSingle();
  return data?.risk_flag_config ?? null;
}

function body(resolved: RiskFlagConfig, isCustom: boolean) {
  return { riskFlagConfig: resolved, defaults: RISK_FLAG_DEFAULTS, isCustom };
}

router.get('/preferences', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'unauthorized' }); return; }
  const stored = await readStored(req.user.id);
  res.json(body(resolveRiskFlagConfig(stored), stored != null));
});

router.put('/preferences', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'unauthorized' }); return; }
  const incoming = (req.body ?? {}) as { riskFlagConfig?: unknown };
  const raw = incoming.riskFlagConfig;
  if (raw == null || typeof raw !== 'object') {
    res.status(400).json({ error: 'riskFlagConfig object required' });
    return;
  }
  const o = raw as Partial<Record<keyof RiskFlagConfig, unknown>>;

  // Validate every provided field; absent fields fall back to the current
  // effective value (so a partial PUT is a partial override, not a reset).
  const current = resolveRiskFlagConfig(await readStored(req.user.id));
  const next: RiskFlagConfig = { ...current };
  for (const key of KEYS) {
    if (!(key in o) || o[key] == null) continue;
    const v = typeof o[key] === 'number' ? (o[key] as number) : Number(o[key]);
    const b = BOUNDS[key];
    if (!Number.isFinite(v) || v < b.min || v > b.max || (b.int && !Number.isInteger(v))) {
      res.status(400).json({ error: `${key} must be ${b.int ? 'an integer ' : ''}in [${b.min}, ${b.max}]` });
      return;
    }
    next[key] = v;
  }

  const up = await supabase()
    .from('user_preferences')
    .upsert({ user_id: req.user.id, risk_flag_config: next, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    .select('risk_flag_config')
    .single();
  if (up.error) {
    res.status(500).json({ error: up.error.message });
    return;
  }
  res.json(body(resolveRiskFlagConfig(up.data?.risk_flag_config ?? next), true));
});

export default router;
