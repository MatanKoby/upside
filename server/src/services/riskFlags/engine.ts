// Risk-flag persistence + orchestration (Batch R1).
//
// `evaluateAndStore` is the one entry point used by both riskFlagsCron (nightly
// over held + active-watchlist) and signalEngine (on-demand top-up at Analyze).
// It loads the prior day's `since` dates, computes, and writes the row (or
// deletes it when the ticker is clean). Spec: spec/signals/risk-flags.md.

import { riskFlagsTableModule } from '../../db/riskFlagsTableModule.js';
import { computeRiskFlags, type RiskFlagInputs, type RiskFlagRow } from './computeRiskFlags.js';
import type { RiskFlagConfig, RiskFlagKey } from '../../config/riskFlags.js';

// UTC calendar date — the daily-grain key for a risk_flags row.
export function riskFlagAsofDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// Most recent prior row's per-flag `since` dates, so a still-true flag keeps
// its original first-seen date instead of resetting each run.
async function loadPrevSince(
  conid: number,
  asofDate: string,
): Promise<Partial<Record<RiskFlagKey, string>>> {
  const prev = await riskFlagsTableModule.getPrevRow(conid, asofDate).catch(() => null);
  const out: Partial<Record<RiskFlagKey, string>> = {};
  for (const f of prev?.flags ?? []) {
    if (f.key) out[f.key as RiskFlagKey] = f.since ?? prev!.asofDate;
  }
  return out;
}

async function persist(conid: number, asofDate: string, row: RiskFlagRow | null): Promise<void> {
  if (!row) {
    // Clean ticker → remove any stale row so the badge clears. Best-effort
    // (the prior code swallowed write errors here too).
    await riskFlagsTableModule.deleteRow(conid, asofDate).catch(() => undefined);
    return;
  }
  await riskFlagsTableModule
    .upsertRow(conid, asofDate, row.flags, row.severity, new Date().toISOString())
    .catch(() => undefined);
}

export async function evaluateAndStore(
  conid: number,
  inputs: RiskFlagInputs,
  config: RiskFlagConfig,
  asofDate: string = riskFlagAsofDate(),
): Promise<RiskFlagRow | null> {
  const prevSince = await loadPrevSince(conid, asofDate);
  const row = computeRiskFlags(inputs, config, asofDate, prevSince);
  await persist(conid, asofDate, row);
  return row;
}
