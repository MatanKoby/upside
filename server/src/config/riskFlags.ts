// Risk-flag thresholds + tier rules (Batch R1).
//
// Tunable seeds — the user overrides them via user_preferences.risk_flag_config
// (the Settings UI in Batch R2 writes that; R1 reads it). The v1 defaults are
// calibrated once against the SPCE / RGTI / MNTS cases — see
// server/scripts/risk-flags-calibrate.mjs. No magic numbers in the engine;
// every threshold + the WARNING/CRITICAL rule lives here. Spec:
// spec/signals/risk-flags.md.

export type RiskFlagKey =
  | 'price_surge'
  | 'volume_spike'
  | 'rsi_overbought'
  | 'near_52w_high_surge'
  | 'micro_cap'
  | 'earnings_imminent';

export type RiskSeverity = 'warning' | 'critical';

export interface RiskFlagConfig {
  surgePct: number; // X — % rise over the window that flags price_surge
  surgeWindowSessions: number; // N — trailing sessions for the surge window
  volMult: number; // Y — relative-volume multiple for volume_spike
  rsiZ: number; // Z — RSI-14 level for rsi_overbought
  near52wHighPct: number; // W — within this % of the 52w high for near_52w_high_surge
  microCapUsd: number; // C — market-cap floor (USD) for micro_cap
  earningsDays: number; // D — days-to-earnings ceiling for earnings_imminent
}

export const RISK_FLAG_DEFAULTS: RiskFlagConfig = {
  surgePct: 25,
  surgeWindowSessions: 5,
  volMult: 3,
  rsiZ: 78,
  near52wHighPct: 5,
  microCapUsd: 500_000_000,
  earningsDays: 5,
};

// Merge a partial user override (user_preferences.risk_flag_config) over the
// seed defaults. Unknown / non-numeric keys fall back to the default, so a
// malformed or partial config can never break the engine.
export function resolveRiskFlagConfig(override: unknown): RiskFlagConfig {
  const o = (override ?? {}) as Partial<Record<keyof RiskFlagConfig, unknown>>;
  const numOr = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : d;
  return {
    surgePct: numOr(o.surgePct, RISK_FLAG_DEFAULTS.surgePct),
    surgeWindowSessions: numOr(o.surgeWindowSessions, RISK_FLAG_DEFAULTS.surgeWindowSessions),
    volMult: numOr(o.volMult, RISK_FLAG_DEFAULTS.volMult),
    rsiZ: numOr(o.rsiZ, RISK_FLAG_DEFAULTS.rsiZ),
    near52wHighPct: numOr(o.near52wHighPct, RISK_FLAG_DEFAULTS.near52wHighPct),
    microCapUsd: numOr(o.microCapUsd, RISK_FLAG_DEFAULTS.microCapUsd),
    earningsDays: numOr(o.earningsDays, RISK_FLAG_DEFAULTS.earningsDays),
  };
}

// CRITICAL = a confirmed pump: price_surge AND ≥1 corroborating overheating
// flag; OR micro_cap escalated by any one corroborating flag (thin float
// amplifies a pump). Everything else with ≥1 flag is WARNING. Tunable as one
// block rather than scattered through the engine.
const CORROBORATING: RiskFlagKey[] = ['volume_spike', 'rsi_overbought', 'near_52w_high_surge'];

export function severityFor(active: RiskFlagKey[]): RiskSeverity {
  const has = (k: RiskFlagKey): boolean => active.includes(k);
  const corroborated = CORROBORATING.some(has);
  const pumpCritical = has('price_surge') && corroborated;
  const microCritical = has('micro_cap') && (has('price_surge') || corroborated);
  return pumpCritical || microCritical ? 'critical' : 'warning';
}

// A CRITICAL ticker clamps the LLM headline conviction to the "low" band,
// regardless of what the model returns — the structural backstop behind the
// prompt instruction (see spec/signals/playbook.md → Risk-flag context).
export const CRITICAL_QUALITY_CAP = 35;
