// Dip-bounce scorer weights + thresholds (Batch X1). All tunable from
// forward-tracked outcome data; the scorer functions carry no magic numbers.
// v1 values set by scripts/dip-bounce-backtest.mjs to ~1-3 fires/day per
// channel. See spec/signals/dip-bounce-scorer.md.

// ── Intraday scorer ──────────────────────────────────────────────────────────
export const INTRADAY_WEIGHTS = {
  IN_TYPICAL_BAND: 30, // drop from open in [p50, p75) — the character spine
  MEAN_REVERSION_REGIME: 25, // band_state.session_regime ∈ {mean_reversion, mixed}
  NOT_VOL_REGIME_SHIFT: 15, // band_state.vol_regime_shift = false
  ENTRY_ZONE_CONFLUENCE: 20, // intraday entry-zone row has confluence
  ENTRY_ZONE_TREND_OK: 10, // intraday entry-zone trend_regime ∈ {up, mixed}
} as const;

export const INTRADAY_FIRE_THRESHOLD = 70;
export const INTRADAY_COOLDOWN_HOURS = 4;

// ── Swing scorer ─────────────────────────────────────────────────────────────
export const SWING_WEIGHTS = {
  DAILY_TREND_OK: 30, // daily trend ∈ {up, mixed}
  NEAR_ENTRY_ZONE_SWING: 30, // within 1·ATR(daily) of overnight/multiday zone + confluence
  NOT_BEARISH_TODAY: 15, // today's session_regime ≠ bearish_trend
  RSI_PULLBACK: 15, // daily RSI(14) ≤ 40
  NOT_VOL_REGIME_SHIFT: 10, // band_state.vol_regime_shift = false
} as const;

export const SWING_FIRE_THRESHOLD = 70;
export const SWING_COOLDOWN_HOURS = 24;
export const SWING_RSI_PULLBACK_MAX = 40; // RSI at/below this counts as a pullback
export const SWING_NEAR_ZONE_ATR_MULT = 1; // within N·ATR(daily) of a swing entry-zone

// Outcome-snapshot offsets the signalOutcomesCron fills for every fire.
export const OUTCOME_OFFSETS = [
  { label: '+30m', ms: 30 * 60_000 },
  { label: '+2h', ms: 2 * 3600 * 1000 },
  { label: '+1d', ms: 24 * 3600 * 1000 },
  { label: '+3d', ms: 3 * 24 * 3600 * 1000 },
] as const;

export type OutcomeOffset = (typeof OUTCOME_OFFSETS)[number]['label'];
