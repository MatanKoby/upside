// TableModule for `user_preferences` — the SOLE server-side gatekeeper for the
// per-user settings row (risk-flag config, profit-zone threshold, and the
// signal-gen knobs read by the analyze engine). Writer: the /user/preferences
// route (validated partial upsert). Readers: riskFlagsCron, profitZone,
// signalEngine. Single-user app — `getAny()` serves the cron's "any row" read.
//
// The module owns I/O + snake↔camel mapping; validation/bounds + the
// resolve-with-defaults policy stay in the route/config. `riskFlagConfig` is
// an opaque jsonb payload (resolved by config/riskFlags).
//
// Batch ARCH-4 — finishes Phase 1 ("every table behind a module").
// See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';

/** Domain shape (camelCase). DB row is snake_case — see fromRow. */
export interface UserPreferences {
  riskFlagConfig: unknown; // opaque jsonb
  profitZoneThresholdPct: number | null;
  signalMinMarketValue: number | null;
  suppressedSymbols: string[];
}

/** The fields the write surface (the /user/preferences route) may set. */
export interface UserPreferencesPatch {
  riskFlagConfig?: unknown;
  profitZoneThresholdPct?: number;
}

interface UserPreferencesRow {
  risk_flag_config: unknown;
  profit_zone_threshold_pct: number | string | null;
  signal_min_market_value: number | string | null;
  suppressed_symbols: string[] | null;
}

const COLS = 'risk_flag_config, profit_zone_threshold_pct, signal_min_market_value, suppressed_symbols';

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function fromRow(r: UserPreferencesRow): UserPreferences {
  return {
    riskFlagConfig: r.risk_flag_config ?? null,
    profitZoneThresholdPct: numOrNull(r.profit_zone_threshold_pct),
    signalMinMarketValue: numOrNull(r.signal_min_market_value),
    suppressedSymbols: Array.isArray(r.suppressed_symbols) ? r.suppressed_symbols : [],
  };
}

class UserPreferencesTableModule extends TableModule {
  constructor() {
    super('user_preferences');
  }

  /** The preferences row for a user, or null when none has been saved. */
  async getByUserId(userId: string): Promise<UserPreferences | null> {
    const row = await this.run<UserPreferencesRow>(
      'getByUserId',
      this.from().select(COLS).eq('user_id', userId).maybeSingle(),
    );
    return row ? fromRow(row) : null;
  }

  /** First preferences row (single-user app) — the risk-flags cron reader. */
  async getAny(): Promise<UserPreferences | null> {
    const row = await this.run<UserPreferencesRow>(
      'getAny',
      this.from().select(COLS).limit(1).maybeSingle(),
    );
    return row ? fromRow(row) : null;
  }

  /** Validated partial upsert keyed on user_id (absent patch fields keep their
   *  stored value — a partial PUT is a partial override). Returns the saved row. */
  async upsert(userId: string, patch: UserPreferencesPatch): Promise<UserPreferences | null> {
    const row: Record<string, unknown> = {
      user_id: userId,
      updated_at: new Date().toISOString(),
    };
    if (patch.riskFlagConfig !== undefined) row.risk_flag_config = patch.riskFlagConfig;
    if (patch.profitZoneThresholdPct !== undefined) {
      row.profit_zone_threshold_pct = patch.profitZoneThresholdPct;
    }
    const saved = await this.run<UserPreferencesRow>(
      'upsert',
      this.from().upsert(row, { onConflict: 'user_id' }).select(COLS).single(),
    );
    return saved ? fromRow(saved) : null;
  }
}

export const userPreferencesTableModule = new UserPreferencesTableModule();
