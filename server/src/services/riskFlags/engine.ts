// Risk-flag persistence + orchestration (Batch R1).
//
// `evaluateAndStore` is the one entry point used by both riskFlagsCron (nightly
// over held + active-watchlist) and signalEngine (on-demand top-up at Analyze).
// It loads the prior day's `since` dates, computes, and writes the row (or
// deletes it when the ticker is clean). Spec: spec/signals/risk-flags.md.

import { supabase } from '../supabase.js';
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
  const { data } = await supabase()
    .from('risk_flags')
    .select('asof_date, flags')
    .eq('conid', conid)
    .lt('asof_date', asofDate)
    .order('asof_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const out: Partial<Record<RiskFlagKey, string>> = {};
  const flags = (data?.flags ?? []) as Array<{ key?: RiskFlagKey; since?: string }>;
  for (const f of flags) {
    if (f.key) out[f.key] = f.since ?? (data?.asof_date as string);
  }
  return out;
}

async function persist(conid: number, asofDate: string, row: RiskFlagRow | null): Promise<void> {
  const db = supabase();
  if (!row) {
    // Clean ticker → remove any stale row so the badge clears.
    await db.from('risk_flags').delete().eq('conid', conid).eq('asof_date', asofDate);
    return;
  }
  await db.from('risk_flags').upsert(
    {
      conid,
      asof_date: asofDate,
      flags: row.flags,
      severity: row.severity,
      computed_at: new Date().toISOString(),
    },
    { onConflict: 'conid,asof_date' },
  );
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
