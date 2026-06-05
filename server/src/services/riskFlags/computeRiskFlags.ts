// Pure risk-flag computation (Batch R1).
//
// Inputs are pre-computed scalars (the cron + signalEngine assemble them from
// daily bars + Finnhub — see ./inputs.ts); this stays a pure function so it's
// trivially testable with simple fixtures. Returns null when no flag is active
// (the caller deletes any stale row → absence means clean). Spec:
// spec/signals/risk-flags.md.

import {
  severityFor,
  type RiskFlagConfig,
  type RiskFlagKey,
  type RiskSeverity,
} from '../../config/riskFlags.js';

export interface RiskFlagInputs {
  currentPrice: number | null;
  surgePct: number | null; // trailing N-session return %
  rsi14: number | null;
  relVolume: number | null; // today's volume / ~30d average
  high52w: number | null;
  marketCapUsd: number | null;
  earningsDays: number | null; // days until next earnings (>= 0), null if unknown
}

export interface ActiveFlag {
  key: RiskFlagKey;
  since: string; // YYYY-MM-DD — first day the condition held
  payload: Record<string, number | null>;
}

export interface RiskFlagRow {
  flags: ActiveFlag[];
  severity: RiskSeverity;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// prevSince: yesterday's active flags' `since` dates (by key) so a still-true
// flag keeps its original first-seen date rather than resetting each day.
export function computeRiskFlags(
  inputs: RiskFlagInputs,
  config: RiskFlagConfig,
  asofDate: string,
  prevSince: Partial<Record<RiskFlagKey, string>> = {},
): RiskFlagRow | null {
  const flags: ActiveFlag[] = [];
  const raise = (key: RiskFlagKey, payload: Record<string, number | null>): void => {
    flags.push({ key, since: prevSince[key] ?? asofDate, payload });
  };

  const { currentPrice, surgePct, rsi14, relVolume, high52w, marketCapUsd, earningsDays } = inputs;

  // price_surge — the spine: rose on momentum over the trailing window.
  const surging = surgePct != null && surgePct >= config.surgePct;
  if (surging) {
    raise('price_surge', { surge_pct: round(surgePct!), window: config.surgeWindowSessions });
  }

  // volume_spike — abnormal participation vs the trailing average.
  if (relVolume != null && relVolume >= config.volMult) {
    raise('volume_spike', { rel_volume: round(relVolume), threshold: config.volMult });
  }

  // rsi_overbought — momentum oscillator stretched.
  if (rsi14 != null && rsi14 > config.rsiZ) {
    raise('rsi_overbought', { rsi14: round(rsi14), threshold: config.rsiZ });
  }

  // near_52w_high_surge — compound: within W% of the 52w high AND surged to
  // get there ("bought at the peak"). A quiet name sitting near its high is
  // NOT flagged.
  if (high52w != null && high52w > 0 && currentPrice != null && surging) {
    const pctFromHigh = ((currentPrice - high52w) / high52w) * 100; // ≤ 0 below the high
    if (pctFromHigh >= -config.near52wHighPct) {
      raise('near_52w_high_surge', {
        pct_from_52w_high: round(pctFromHigh),
        threshold: config.near52wHighPct,
      });
    }
  }

  // micro_cap — thin liquidity / extreme-volatility risk profile.
  if (marketCapUsd != null && marketCapUsd > 0 && marketCapUsd < config.microCapUsd) {
    raise('micro_cap', { market_cap_usd: Math.round(marketCapUsd), threshold: config.microCapUsd });
  }

  // earnings_imminent — binary event + IV crush risk right before a report.
  if (earningsDays != null && earningsDays >= 0 && earningsDays < config.earningsDays) {
    raise('earnings_imminent', { days: round(earningsDays), threshold: config.earningsDays });
  }

  if (flags.length === 0) return null;
  return { flags, severity: severityFor(flags.map((f) => f.key)) };
}
