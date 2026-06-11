// /api/user/preferences — the user-preferences read/write path.
//
// Batch R2 introduced the first FE→BE write into `user_preferences`: the
// tunable risk-flag thresholds (Settings → Risk flags). Batch 15 adds the
// profit-taking zone threshold to the same validated path. The signal-
// generation knobs (signal_threshold / signal_min_market_value /
// suppressed_symbols) belong to the LLM-analysis track and live in
// spec/roadmap.md, not here. The engine reads each column directly
// (resolveRiskFlagConfig, the zone engine); this route is the write surface,
// not a cache. supabase() is the service-role client (bypasses RLS), so we
// stamp user_id from the JWT.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  userPreferencesTableModule,
  type UserPreferences,
  type UserPreferencesPatch,
} from '../adapters/supabase/userPreferencesTableModule.js';
import {
  resolveRiskFlagConfig,
  RISK_FLAG_DEFAULTS,
  type RiskFlagConfig,
} from '../config/riskFlags.js';

const router = Router();
router.use(requireAuth);

// Sane bounds per risk-flag field — keeps a fat-fingered value from silently
// disabling a flag (e.g. surge 0.01% would fire on everything; 9999% on none).
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

// General app-level prefs (Batch 15). Each maps a camelCase API field to its
// snake_case column + bounds.
interface GeneralPreferences {
  profitZoneThresholdPct: number;
}

const GENERAL_DEFAULTS: GeneralPreferences = {
  profitZoneThresholdPct: 2.0,
};

const NUMERIC_PREFS: Record<
  keyof GeneralPreferences,
  { min: number; max: number; int?: boolean }
> = {
  profitZoneThresholdPct: { min: 0.5, max: 10 },
};

const NUMERIC_KEYS = Object.keys(NUMERIC_PREFS) as (keyof GeneralPreferences)[];

async function readStored(userId: string): Promise<UserPreferences | null> {
  return userPreferencesTableModule.getByUserId(userId);
}

function resolveGeneral(row: UserPreferences | null): GeneralPreferences {
  return {
    profitZoneThresholdPct:
      row?.profitZoneThresholdPct ?? GENERAL_DEFAULTS.profitZoneThresholdPct,
  };
}

function body(row: UserPreferences | null) {
  return {
    riskFlagConfig: resolveRiskFlagConfig(row?.riskFlagConfig ?? null),
    defaults: RISK_FLAG_DEFAULTS,
    isCustom: row?.riskFlagConfig != null,
    preferences: resolveGeneral(row),
  };
}

router.get('/preferences', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'unauthorized' }); return; }
  res.json(body(await readStored(req.user.id)));
});

router.put('/preferences', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'unauthorized' }); return; }
  const incoming = (req.body ?? {}) as { riskFlagConfig?: unknown; preferences?: unknown };
  const hasRiskFlags = incoming.riskFlagConfig != null && typeof incoming.riskFlagConfig === 'object';
  const hasGeneral = incoming.preferences != null && typeof incoming.preferences === 'object';
  if (!hasRiskFlags && !hasGeneral) {
    res.status(400).json({ error: 'riskFlagConfig and/or preferences object required' });
    return;
  }

  const stored = await readStored(req.user.id);
  // Partial patch; absent fields keep their current stored value, so a partial
  // PUT is a partial override, not a reset (the module stamps user_id/updated_at).
  const patch: UserPreferencesPatch = {};

  if (hasRiskFlags) {
    const o = incoming.riskFlagConfig as Partial<Record<keyof RiskFlagConfig, unknown>>;
    const current = resolveRiskFlagConfig(stored?.riskFlagConfig ?? null);
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
    patch.riskFlagConfig = next;
  }

  if (hasGeneral) {
    const o = incoming.preferences as Partial<Record<string, unknown>>;
    for (const key of NUMERIC_KEYS) {
      if (!(key in o) || o[key] == null) continue;
      const v = typeof o[key] === 'number' ? (o[key] as number) : Number(o[key]);
      const b = NUMERIC_PREFS[key];
      if (!Number.isFinite(v) || v < b.min || v > b.max || (b.int && !Number.isInteger(v))) {
        res.status(400).json({ error: `${key} must be ${b.int ? 'an integer ' : ''}in [${b.min}, ${b.max}]` });
        return;
      }
      patch[key] = v;
    }
  }

  try {
    const saved = await userPreferencesTableModule.upsert(req.user.id, patch);
    res.json(body(saved ?? stored));
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
